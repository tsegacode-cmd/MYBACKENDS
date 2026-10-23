import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { queryNeon, toPostgresPlaceholders, withNeonTransaction } from '../config/neonDatabase.js';

const createId = () => randomUUID();
const userId = req => String(req.user?.id ?? '');
const amountValue = value => Number(value);
const isValidAmount = value => Number.isFinite(value) && value > 0;
const transactionContext = new AsyncLocalStorage();

const normalizeResult = result => {
  for (const row of result.rows) {
    for (const field of result.fields) {
      const value = row[field.name];
      if (![20, 1700].includes(field.dataTypeID) || typeof value !== 'string') continue;
      const number = Number(value);
      if (Number.isFinite(number) && (field.dataTypeID === 1700 || Number.isSafeInteger(number))) {
        row[field.name] = number;
      }
    }
  }
  return result;
};

const executeQuery = async (sql, params) => {
  const client = transactionContext.getStore();
  const result = client
    ? client.query(toPostgresPlaceholders(sql), params)
    : queryNeon(sql, params);
  return normalizeResult(await result);
};

const db = {
  prepare(sql) {
    return {
      get: async (...params) => (await executeQuery(sql, params)).rows[0],
      all: async (...params) => (await executeQuery(sql, params)).rows,
      run: async (...params) => executeQuery(sql, params),
    };
  },
  transaction(callback) {
    return () => withNeonTransaction(client => transactionContext.run(client, callback));
  },
};
const getAgentDB = () => db;

const getUser = async id => await db
  .prepare('SELECT _id, username, email, full_name, role, phone, is_active FROM users WHERE CAST(_id AS TEXT) = ?')
  .get(String(id));

const getAgent = async id => await db
  .prepare(`
    SELECT u._id, u.username, u.email, u.full_name, u.role, u.phone, u.is_active,
           COALESCE(s.service_charge_percent, 0) AS service_charge_percent,
           COALESCE(s.reward_percent, 0) AS reward_percent,
           COALESCE(s.payment_details, '') AS payment_details
    FROM users u
    LEFT JOIN agent_settings s ON s.agent_user_id = CAST(u._id AS TEXT)
    WHERE CAST(u._id AS TEXT) = ? AND LOWER(u.role) = 'agent'
  `)
  .get(String(id));

const requireRoot = (req, res) => {
  if (req.user?.isRoot || ['root', 'admin'].includes(String(req.user?.role || '').toLowerCase())) return true;
  res.status(403).json({ success: false, message: 'Root access required' });
  return false;
};

const getAgentPackageBalance = async (db, agentId) => Number((await db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS balance
  FROM agent_package_ledger
  WHERE agent_user_id = ?
`).get(String(agentId))).balance);

const getPackagePoolBalance = async db => Number((await db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS balance
  FROM agent_package_pool_ledger
`).get()).balance);

const recordPackageLedger = async (db, agentId, amount, reference, description) => await db.prepare(`
    INSERT INTO agent_package_ledger
      (entry_id, agent_user_id, amount, reference, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(createId(), String(agentId), amount, reference, description);

const recordPoolLedger = async (db, amount, agentId, reference, description, createdBy) => await db.prepare(`
    INSERT INTO agent_package_pool_ledger
      (entry_id, amount, agent_user_id, reference, description, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(createId(), amount, agentId == null ? null : String(agentId), reference, description, String(createdBy));

const getAvailableWalletBalance = async (db, id, excludeAgentRequestId = '') => Number((await db.prepare(`
  SELECT COALESCE(SUM(l.amount), 0) -
    COALESCE((SELECT SUM(w.amount) FROM wallet_withdrawals w
      WHERE w.user_id = ? AND w.balance_type = 'real' AND w.status IN ('pending', 'approved')), 0) -
    COALESCE((SELECT SUM(r.amount) FROM agent_wallet_requests r
      WHERE r.user_id = ? AND r.request_type = 'withdrawal' AND r.status = 'pending'
        AND r.request_id != ?), 0) AS balance
  FROM wallet_ledger l
  WHERE l.user_id = ? AND l.balance_type = 'real'
`).get(String(id), String(id), String(excludeAgentRequestId), String(id))).balance);

export const getActiveAgents = async (req, res, next) => {
  try {
    const agents = await getAgentDB().prepare(`
      SELECT CAST(u._id AS TEXT) AS id, u.username, u.full_name, u.phone,
             COALESCE(u.is_active, 1) AS account_active,
             EXISTS(
               SELECT 1 FROM social_presence p
               WHERE p.user_id = CAST(u._id AS TEXT)
                 AND p.last_seen::timestamp >= CURRENT_TIMESTAMP - INTERVAL '90 seconds'
             ) AS is_online,
             COALESCE(s.service_charge_percent, 0) AS service_charge_percent,
             COALESCE(s.payment_details, '') AS payment_details
      FROM users u
      LEFT JOIN agent_settings s ON s.agent_user_id = CAST(u._id AS TEXT)
      WHERE LOWER(u.role) = 'agent' AND COALESCE(u.is_active, 1) = 1
      ORDER BY u.full_name, u.username
    `).all();
    res.json({ success: true, data: agents });
  } catch (error) {
    next(error);
  }
};

export const getMyAgentWalletRequests = async (req, res, next) => {
  try {
    const requests = await getAgentDB().prepare(`
      SELECT r.request_id AS id, r.agent_user_id AS agent_id, r.user_id,
             r.request_type AS type, r.amount, r.net_amount, r.service_charge,
             r.agent_reward, r.payment_method, r.payment_reference,
             r.payout_details, r.status, r.created_at, r.reviewed_at,
             u.full_name AS user_name, u.username AS user_username,
             a.full_name AS agent_name,
             CASE WHEN r.receipt_image IS NULL OR r.receipt_image = '' THEN 0 ELSE 1 END AS receipt_available
      FROM agent_wallet_requests r
      LEFT JOIN users u ON CAST(u._id AS TEXT) = r.user_id
      LEFT JOIN users a ON CAST(a._id AS TEXT) = r.agent_user_id
      WHERE r.user_id = ?
      ORDER BY r.created_at DESC
    `).all(userId(req));
    res.json({ success: true, data: requests });
  } catch (error) {
    next(error);
  }
};

export const getAgentWalletRequestReceipt = async (req, res, next) => {
  try {
    const db = getAgentDB();
    const receipt = await db.prepare(`
      SELECT request_id, user_id, agent_user_id, request_type, receipt_image
      FROM agent_wallet_requests
      WHERE request_id = ?
    `).get(String(req.params.requestId));
    if (!receipt) return res.status(404).json({ success: false, message: 'Wallet request not found' });

    const requesterId = userId(req);
    if (!req.user?.isRoot
      && !['root', 'admin'].includes(String(req.user?.role || '').toLowerCase())
      && receipt.user_id !== requesterId
      && receipt.agent_user_id !== requesterId) {
      return res.status(403).json({ success: false, message: 'You cannot view this receipt' });
    }
    if (!receipt.receipt_image) {
      return res.status(404).json({ success: false, message: 'Receipt not found' });
    }
    res.json({ success: true, data: { receiptImage: receipt.receipt_image, receiptFile: receipt.receipt_image } });
  } catch (error) {
    next(error);
  }
};

export const createAgentWalletRequest = async (req, res, next) => {
  try {
    const db = getAgentDB();
    const body = req.body || {};
    const agentId = String(body.agentId || '');
    const type = String(body.type || '').toLowerCase();
    const amount = amountValue(body.amount);
    const paymentMethod = String(body.paymentMethod || '').trim();
    const paymentReference = String(body.paymentReference || '').trim();
    const payoutDetails = String(body.payoutDetails || '').trim();
    const receiptImage = String(body.receiptImage || '');

    if (!agentId || !['deposit', 'withdrawal'].includes(type) || !isValidAmount(amount)
      || !paymentMethod || paymentMethod.length > 80
      || !paymentReference || paymentReference.length > 250) {
      return res.status(400).json({ success: false, message: 'Provide a valid agent, transfer type, amount, payment method, and reference' });
    }
    if (type === 'withdrawal' && (!payoutDetails || payoutDetails.length > 500)) {
      return res.status(400).json({ success: false, message: 'Valid payout details are required for withdrawals' });
    }
    if ((type === 'deposit' && !receiptImage)
      || (receiptImage && (!/^data:(?:image\/(?:png|jpeg|webp)|application\/pdf);base64,[A-Za-z0-9+/]+=*$/.test(receiptImage)
        || receiptImage.length > 8_000_000))) {
      return res.status(400).json({ success: false, message: 'Deposits require a PNG, JPEG, WebP, or PDF receipt; receipts must be no larger than 6 MB.' });
    }

    const agent = await getAgent(agentId);
    if (!agent || !agent.is_active) return res.status(404).json({ success: false, message: 'Active agent not found' });
    const actingAsAgent = String(req.user?.role || '').toLowerCase() === 'agent';
    const customerUserId = actingAsAgent ? String(body.customerUserId || '') : userId(req);
    if (actingAsAgent && agentId !== userId(req)) {
      return res.status(403).json({ success: false, message: 'Agents can only submit wallet requests for their own customers' });
    }
    const customer = actingAsAgent
      ? await db.prepare(`
          SELECT _id, role, is_active FROM users
          WHERE CAST(_id AS TEXT) = ? AND created_by_user_id = ?
        `).get(customerUserId, userId(req))
      : await getUser(customerUserId);
    if (!customer) return res.status(403).json({ success: false, message: 'This customer account is not managed by your agent account' });
    if (actingAsAgent && String(customer.role || '').toLowerCase() !== 'user') {
      return res.status(403).json({ success: false, message: 'Wallet requests can only be created for customer accounts' });
    }
    if (!customer.is_active) return res.status(403).json({ success: false, message: 'This customer account is inactive' });

    const settings = await db.prepare(`
      SELECT min_deposit, max_deposit, min_withdrawal, max_withdrawal
      FROM wallet_settings WHERE role = 'user'
    `).get() || { min_deposit: 0.01, max_deposit: 100000, min_withdrawal: 0.01, max_withdrawal: 100000 };
    const minimum = type === 'deposit' ? Number(settings.min_deposit) : Number(settings.min_withdrawal);
    const maximum = type === 'deposit' ? Number(settings.max_deposit) : Number(settings.max_withdrawal);
    if (amount < minimum || amount > maximum) {
      return res.status(400).json({ success: false, message: `Amount must be between ${minimum} and ${maximum} ETB` });
    }

    const serviceCharge = Math.round(amount * Number(agent.service_charge_percent || 0)) / 100;
    const netAmount = Math.max(0, amount - serviceCharge);
    const agentReward = Math.round(serviceCharge * Number(agent.reward_percent || 0)) / 100;
    const requestId = createId();
    const createRequest = db.transaction(async () => {
      if (type === 'withdrawal' && amount > await getAvailableWalletBalance(db, customerUserId)) {
        throw Object.assign(new Error('The user has insufficient available real wallet balance'), { status: 400 });
      }
      await db.prepare(`
        INSERT INTO agent_wallet_requests
          (request_id, agent_user_id, user_id, request_type, amount, net_amount,
           service_charge, agent_reward, payment_method, payment_reference,
           payout_details, receipt_image)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        requestId, agentId, customerUserId, type, amount, netAmount, serviceCharge,
        agentReward, paymentMethod, paymentReference, payoutDetails || '', receiptImage || null
      );
    });
    await createRequest();
    res.status(201).json({ success: true, data: { id: requestId, status: 'pending' } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    next(error);
  }
};

export const reviewAgentWalletRequest = async (req, res, next) => {
  try {
    const db = getAgentDB();
    const agent = await getAgent(userId(req));
    if (!agent || !agent.is_active) return res.status(403).json({ success: false, message: 'An active agent account is required' });
    const status = String(req.body?.status || '').toLowerCase();
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be approved or rejected' });
    }
    const request = await db.prepare('SELECT * FROM agent_wallet_requests WHERE request_id = ?')
      .get(String(req.params.requestId));
    if (!request) return res.status(404).json({ success: false, message: 'Wallet request not found' });
    if (request.agent_user_id !== userId(req)) {
      return res.status(403).json({ success: false, message: 'Only the assigned agent can review this request' });
    }
    if (request.status !== 'pending') {
      return res.status(409).json({ success: false, message: 'This request has already been reviewed' });
    }

    const applyReview = db.transaction(async () => {
      if (status === 'approved') {
        if (request.request_type === 'withdrawal') {
          if (await getAvailableWalletBalance(db, request.user_id, request.request_id) < Number(request.amount)) {
            throw Object.assign(new Error('The user has insufficient available real wallet balance'), { status: 400 });
          }
          if (await getAgentPackageBalance(db, request.agent_user_id) < Number(request.net_amount)) {
            throw Object.assign(new Error('The agent package balance is insufficient'), { status: 400 });
          }
          await db.prepare(`
            INSERT INTO wallet_ledger
              (entry_id, user_id, amount, entry_type, reference, description, balance_type)
            VALUES (?, ?, ?, 'agent_withdrawal', ?, ?, 'real')
          `).run(createId(), request.user_id, -Number(request.amount), `agent-wallet:${request.request_id}:user`, 'Agent wallet withdrawal');
          await recordPackageLedger(
            db, request.agent_user_id, -Number(request.net_amount),
            `agent-wallet:${request.request_id}:agent`, 'Agent withdrawal payout'
          );
        } else {
          await db.prepare(`
            INSERT INTO wallet_ledger
              (entry_id, user_id, amount, entry_type, reference, description, balance_type)
            VALUES (?, ?, ?, 'agent_deposit', ?, ?, 'real')
          `).run(createId(), request.user_id, Number(request.net_amount), `agent-wallet:${request.request_id}:user`, 'Agent wallet deposit');
        }
        if (Number(request.service_charge) > 0) {
          await db.prepare(`
            INSERT INTO platform_service_charge_ledger
              (entry_id, amount, request_id, entry_type, reference, description)
            VALUES (?, ?, ?, 'service_charge', ?, ?)
          `).run(createId(), Number(request.service_charge), request.request_id, `agent-wallet:${request.request_id}:charge`, 'Agent wallet service charge');
        }
        if (Number(request.agent_reward) > 0) {
          await db.prepare(`
            INSERT INTO platform_payout_ledger
              (payout_id, user_id, agent_user_id, amount, request_id, entry_type, reference, description)
            VALUES (?, ?, ?, ?, ?, 'agent_reward', ?, ?)
          `).run(createId(), request.user_id, request.agent_user_id, -Number(request.agent_reward), request.request_id, `agent-wallet:${request.request_id}:reward`, 'Agent wallet reward');
        }
      }
      await db.prepare(`
        UPDATE agent_wallet_requests
        SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP::text
        WHERE request_id = ? AND status = 'pending'
      `).run(status, userId(req), request.request_id);
    });
    await applyReview();
    res.json({ success: true, data: { id: request.request_id, status } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    next(error);
  }
};

export const getAgentDashboard = async (req, res, next) => {
  try {
    const db = getAgentDB();
    const id = userId(req);
    const agent = await getAgent(id);
    if (!agent || !agent.is_active) return res.status(403).json({ success: false, message: 'An active agent account is required' });
    const summary = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM agent_products WHERE agent_user_id = ?) +
        (SELECT COUNT(*) FROM service_catalog_products WHERE owner_user_id = ?) AS product_count,
        (SELECT COUNT(*) FROM agent_products WHERE agent_user_id = ? AND approval_status = 'pending') +
        (SELECT COUNT(*) FROM service_catalog_products WHERE owner_user_id = ? AND approval_status = 'pending') AS pending_products,
        (SELECT COUNT(*) FROM agent_wallet_requests WHERE agent_user_id = ? AND status = 'pending') AS pending_wallet_requests,
        (SELECT COUNT(*) FROM agent_package_requests WHERE agent_user_id = ? AND status = 'pending') AS pending_package_requests
    `).get(id, id, id, id, id, id);
    const teamMembers = await db.prepare(`
      SELECT CAST(u._id AS TEXT) AS id, u.username, u.email, u.full_name, u.role,
             u.phone, u.is_active, u.created_at, u.last_login,
             EXISTS(
               SELECT 1 FROM social_presence p
               WHERE p.user_id = CAST(u._id AS TEXT)
                 AND p.last_seen::timestamp >= CURRENT_TIMESTAMP - INTERVAL '90 seconds'
             ) AS is_online,
             (SELECT COUNT(*) FROM wallet_ledger l
              WHERE l.user_id = CAST(u._id AS TEXT)) +
             (SELECT COUNT(*) FROM agent_wallet_requests r
              WHERE r.user_id = CAST(u._id AS TEXT) OR r.agent_user_id = CAST(u._id AS TEXT)) +
             (SELECT COUNT(*) FROM agent_product_history h
              WHERE h.agent_user_id = CAST(u._id AS TEXT)) AS activity_count,
             COALESCE((SELECT SUM(l.amount) FROM wallet_ledger l
                       WHERE l.user_id = CAST(u._id AS TEXT) AND l.balance_type = 'real'), 0) AS real_balance,
             COALESCE((SELECT SUM(l.amount) FROM wallet_ledger l
                       WHERE l.user_id = CAST(u._id AS TEXT) AND l.amount > 0
                         AND l.entry_type IN ('product_sale', 'marketplace_sale')), 0)
             + COALESCE((SELECT SUM(-p.amount) FROM platform_payout_ledger p
                         WHERE p.agent_user_id = CAST(u._id AS TEXT)
                           AND p.entry_type = 'agent_reward' AND p.amount < 0), 0) AS total_earned,
             GREATEST(
               COALESCE(u.last_login, u.created_at),
               COALESCE((SELECT MAX(l.created_at) FROM wallet_ledger l
                         WHERE l.user_id = CAST(u._id AS TEXT)), u.created_at),
               COALESCE((SELECT MAX(r.created_at) FROM agent_wallet_requests r
                         WHERE r.user_id = CAST(u._id AS TEXT) OR r.agent_user_id = CAST(u._id AS TEXT)), u.created_at),
               COALESCE((SELECT MAX(h.created_at) FROM agent_product_history h
                         WHERE h.agent_user_id = CAST(u._id AS TEXT)), u.created_at)
             ) AS last_activity_at
      FROM users u
      WHERE u.created_by_user_id = ?
      ORDER BY u.created_at DESC
    `).all(id);
    const serviceProducts = (await db.prepare(`
      SELECT product_id AS id, service_key, product_json, published, approval_status, updated_at
      FROM service_catalog_products WHERE owner_user_id = ?
      ORDER BY updated_at DESC
    `).all(id)).map(product => ({
      ...JSON.parse(product.product_json),
      id: product.id,
      serviceKey: product.service_key,
      published: Boolean(product.published),
      approvalStatus: product.approval_status || 'approved',
      updatedAt: product.updated_at,
    }));
    const teamSummary = {
      team_member_count: teamMembers.length,
      active_team_member_count: teamMembers.filter(member => member.is_active).length,
      online_team_member_count: teamMembers.filter(member => member.is_online).length,
    };
    const earningsSummary = await db.prepare(`
      SELECT
        COALESCE((SELECT SUM(amount) FROM wallet_ledger
                  WHERE user_id = ? AND entry_type = 'product_sale' AND amount > 0), 0) AS sale_commission_earned,
        COALESCE((SELECT SUM(amount) FROM wallet_ledger
                  WHERE user_id = ? AND entry_type = 'marketplace_sale' AND amount > 0), 0) AS service_product_sales_earned,
        COALESCE((SELECT SUM(-amount) FROM platform_payout_ledger
                  WHERE agent_user_id = ? AND entry_type = 'agent_reward' AND amount < 0), 0) AS wallet_request_rewards_earned
    `).get(id, id, id);
    const earnings = await db.prepare(`
      SELECT entry_id AS id, 'Sale commission' AS source, amount, description, created_at
      FROM wallet_ledger
      WHERE user_id = ? AND entry_type = 'product_sale' AND amount > 0
      UNION ALL
      SELECT entry_id AS id, 'Service product sale' AS source, amount, description, created_at
      FROM wallet_ledger
      WHERE user_id = ? AND entry_type = 'marketplace_sale' AND amount > 0
      UNION ALL
      SELECT payout_id AS id, 'Wallet request reward' AS source, -amount AS amount, description, created_at
      FROM platform_payout_ledger
      WHERE agent_user_id = ? AND entry_type = 'agent_reward' AND amount < 0
      ORDER BY created_at DESC
      LIMIT 100
    `).all(id, id, id);
    const commissionRecords = await db.prepare(`
      SELECT commission_id AS id, commission_type AS type, client_name, client_phone,
             asset_description, location, amount, commission_rate, commission_amount,
             status, notes, created_at
      FROM agent_commission_records
      WHERE agent_user_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `).all(id);
    const recordedCommissionTotals = await db.prepare(`
      SELECT COUNT(*) AS completed_commission_count,
             COALESCE(SUM(commission_amount), 0) AS completed_commission_amount
      FROM agent_commission_records
      WHERE agent_user_id = ? AND status = 'completed'
    `).get(id);
    const products = await db.prepare(`
      SELECT product_id AS id, title, description, price, status, approval_status, created_at, updated_at
      FROM agent_products WHERE agent_user_id = ? ORDER BY updated_at DESC
    `).all(id);
    const walletRequests = await db.prepare(`
      SELECT r.request_id AS id, r.user_id, r.request_type AS type, r.amount, r.net_amount,
             r.payment_method, r.payment_reference, r.status, r.created_at, r.reviewed_at,
             CASE WHEN r.receipt_image IS NULL OR r.receipt_image = '' THEN 0 ELSE 1 END AS receipt_available,
             u.username AS user_username, u.full_name AS user_name
      FROM agent_wallet_requests r
      LEFT JOIN users u ON CAST(u._id AS TEXT) = r.user_id
      WHERE r.agent_user_id = ? ORDER BY r.created_at DESC LIMIT 100
    `).all(id);
    const packageRequests = await db.prepare(`
      SELECT request_id AS id, amount, note, status, created_at
      FROM agent_package_requests WHERE agent_user_id = ? ORDER BY created_at DESC
    `).all(id);
    res.json({
      success: true,
      data: {
        agent: { id, username: agent.username, full_name: agent.full_name },
        settings: {
          service_charge_percent: agent.service_charge_percent,
          reward_percent: agent.reward_percent,
          payment_details: agent.payment_details,
        },
        package_balance: await getAgentPackageBalance(db, id),
        summary: {
          ...summary,
          ...teamSummary,
          ...earningsSummary,
          ...recordedCommissionTotals,
          total_earned: Number(earningsSummary.sale_commission_earned)
            + Number(earningsSummary.service_product_sales_earned)
            + Number(earningsSummary.wallet_request_rewards_earned),
        },
        products,
        wallet_requests: walletRequests,
        package_requests: packageRequests,
        team_members: teamMembers,
        earnings,
        commission_records: commissionRecords,
        service_products: serviceProducts,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getAgentDashboardStatus = async (req, res, next) => {
  try {
    const db = getAgentDB();
    const id = userId(req);
    const agent = await getAgent(id);
    if (!agent || !agent.is_active) return res.status(403).json({ success: false, message: 'An active agent account is required' });
    const products = await db.prepare(`
      SELECT product_id AS id, status, approval_status, updated_at
      FROM agent_products WHERE agent_user_id = ?
    `).all(id);
    const serviceProducts = await db.prepare(`
      SELECT product_id AS id, published, approval_status AS approvalStatus, updated_at
      FROM service_catalog_products WHERE owner_user_id = ?
    `).all(id);
    const walletRequests = await db.prepare(`
      SELECT request_id AS id, status, reviewed_at FROM agent_wallet_requests
      WHERE agent_user_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(id);
    const packageRequests = await db.prepare(`
      SELECT request_id AS id, status, reviewed_at FROM agent_package_requests
      WHERE agent_user_id = ? ORDER BY created_at DESC
    `).all(id);
    const summary = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM agent_products WHERE agent_user_id = ?) +
        (SELECT COUNT(*) FROM service_catalog_products WHERE owner_user_id = ?) AS product_count,
        (SELECT COUNT(*) FROM agent_products WHERE agent_user_id = ? AND approval_status = 'pending') +
        (SELECT COUNT(*) FROM service_catalog_products WHERE owner_user_id = ? AND approval_status = 'pending') AS pending_products,
        (SELECT COUNT(*) FROM agent_wallet_requests WHERE agent_user_id = ? AND status = 'pending') AS pending_wallet_requests,
        (SELECT COUNT(*) FROM agent_package_requests WHERE agent_user_id = ? AND status = 'pending') AS pending_package_requests
    `).get(id, id, id, id, id, id);
    return res.json({
      success: true,
      data: { summary, products, service_products: serviceProducts, wallet_requests: walletRequests, package_requests: packageRequests },
    });
  } catch (error) {
    return next(error);
  }
};

export const getAgentTeamMemberActivity = async (req, res, next) => {
  try {
    const db = getAgentDB();
    const id = userId(req);
    const memberId = String(req.params.userId || '');
    const member = await db.prepare(`
      SELECT CAST(_id AS TEXT) AS id, username, email, full_name, role, phone,
             is_active, created_at, last_login,
             COALESCE((SELECT SUM(l.amount) FROM wallet_ledger l
                       WHERE l.user_id = CAST(users._id AS TEXT) AND l.balance_type = 'real'), 0) AS real_balance,
             EXISTS(
               SELECT 1 FROM social_presence p
               WHERE p.user_id = CAST(users._id AS TEXT)
                 AND p.last_seen::timestamp >= CURRENT_TIMESTAMP - INTERVAL '90 seconds'
             ) AS is_online
      FROM users
      WHERE CAST(_id AS TEXT) = ? AND created_by_user_id = ?
    `).get(memberId, id);
    if (!member) return res.status(404).json({ success: false, message: 'Managed account not found' });

    const activity = await db.prepare(`
      SELECT id, type, amount, status, description, reference, created_at, receipt_available
      FROM (
        SELECT entry_id AS id, entry_type AS type, amount, balance_type AS status,
               description, reference, created_at, 0 AS receipt_available
        FROM wallet_ledger WHERE user_id = ?
        UNION ALL
        SELECT request_id AS id, 'agent_' || request_type AS type, amount, status,
               payment_reference AS description, request_id AS reference, created_at,
               CASE WHEN request_type = 'deposit' AND receipt_image IS NOT NULL AND receipt_image != '' THEN 1 ELSE 0 END AS receipt_available
        FROM agent_wallet_requests WHERE user_id = ?
        UNION ALL
        SELECT deposit_id AS id, 'deposit_request' AS type, amount, status,
               payment_method || ' · ' || payment_reference AS description, payment_reference AS reference, created_at,
               0 AS receipt_available
        FROM wallet_deposits WHERE user_id = ?
        UNION ALL
        SELECT withdrawal_id AS id, 'withdrawal_request' AS type, amount, status,
               payout_details AS description, withdrawal_id AS reference, created_at,
               0 AS receipt_available
        FROM wallet_withdrawals WHERE user_id = ?
      ) sub
      ORDER BY created_at DESC
      LIMIT 100
    `).all(memberId, memberId, memberId, memberId);
    res.json({ success: true, data: { member, activity } });
  } catch (error) {
    next(error);
  }
};

export const createAgentCommissionRecord = async (req, res, next) => {
  try {
    const db = getAgentDB();
    const agentId = userId(req);
    const commissionType = String(req.body?.type || '').toLowerCase();
    const clientName = String(req.body?.clientName || '').trim();
    const clientPhone = String(req.body?.clientPhone || '').trim();
    const assetDescription = String(req.body?.assetDescription || '').trim();
    const location = String(req.body?.location || '').trim();
    const amount = amountValue(req.body?.amount || 0);
    const commissionRate = amountValue(req.body?.commissionRate || 0);
    const commissionAmount = amountValue(req.body?.commissionAmount);
    const status = String(req.body?.status || 'pending').toLowerCase();
    const notes = String(req.body?.notes || '').trim();
    const agent = await getAgent(agentId);
    if (!agent || !agent.is_active) return res.status(403).json({ success: false, message: 'An active agent account is required' });
    if (!['fixed', 'movable'].includes(commissionType) || !clientName || clientName.length > 160
      || clientPhone.length > 30 || !assetDescription || assetDescription.length > 500
      || location.length > 300 || !Number.isFinite(amount) || amount < 0
      || !Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate > 100
      || !Number.isFinite(commissionAmount) || commissionAmount < 0
      || !['pending', 'completed', 'cancelled'].includes(status) || notes.length > 2000) {
      return res.status(400).json({ success: false, message: 'Provide valid commission details and status' });
    }
    const commissionId = createId();
    await db.prepare(`
      INSERT INTO agent_commission_records
        (commission_id, agent_user_id, commission_type, client_name, client_phone,
         asset_description, location, amount, commission_rate, commission_amount, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      commissionId, agentId, commissionType, clientName, clientPhone, assetDescription,
      location, amount, commissionRate, commissionAmount, status, notes
    );
    res.status(201).json({ success: true, data: { id: commissionId } });
  } catch (error) {
    next(error);
  }
};

export const createAgentProduct = async (req, res, next) => {
  try {
    const db = getAgentDB();
    const id = userId(req);
    const agent = await getAgent(id);
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim();
    const price = amountValue(req.body?.price);
    const status = String(req.body?.status || 'selling').toLowerCase();
    if (!agent || !agent.is_active) return res.status(403).json({ success: false, message: 'An active agent account is required' });
    if (!title || title.length > 200 || description.length > 5000 || !isValidAmount(price)
      || !['selling', 'buying'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Provide a valid title, description, price, and product status' });
    }
    const productId = createId();
    const saveProduct = db.transaction(async () => {
      await db.prepare(`
        INSERT INTO agent_products (product_id, agent_user_id, title, description, price, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(productId, id, title, description, price, status);
    });
    await saveProduct();
    res.status(201).json({ success: true, data: { id: productId } });
  } catch (error) {
    next(error);
  }
};
