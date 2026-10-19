import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { getRawSQLiteDB } from '../config/databaseManager.js';

const createId = () => randomUUID();
const userId = req => String(req.user?.id ?? '');
const amountValue = value => Number(value);
const isValidAmount = value => Number.isFinite(value) && value > 0;

const getUser = id => getRawSQLiteDB()
  .prepare('SELECT _id, username, email, full_name, role, phone, is_active FROM users WHERE CAST(_id AS TEXT) = ?')
  .get(String(id));

const getAgent = id => getRawSQLiteDB()
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

const getAgentPackageBalance = (db, agentId) => db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS balance
  FROM agent_package_ledger
  WHERE agent_user_id = ?
`).get(String(agentId)).balance;

const getPackagePoolBalance = db => db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS balance
  FROM agent_package_pool_ledger
`).get().balance;

const recordPackageLedger = (db, agentId, amount, reference, description) => {
  db.prepare(`
    INSERT INTO agent_package_ledger
      (entry_id, agent_user_id, amount, reference, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(createId(), String(agentId), amount, reference, description);
};

const recordPoolLedger = (db, amount, agentId, reference, description, createdBy) => {
  db.prepare(`
    INSERT INTO agent_package_pool_ledger
      (entry_id, amount, agent_user_id, reference, description, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(createId(), amount, agentId == null ? null : String(agentId), reference, description, String(createdBy));
};

const getAvailableWalletBalance = (db, id, excludeAgentRequestId = '') => db.prepare(`
  SELECT COALESCE(SUM(l.amount), 0) -
    COALESCE((SELECT SUM(w.amount) FROM wallet_withdrawals w
      WHERE w.user_id = ? AND w.balance_type = 'real' AND w.status IN ('pending', 'approved')), 0) -
    COALESCE((SELECT SUM(r.amount) FROM agent_wallet_requests r
      WHERE r.user_id = ? AND r.request_type = 'withdrawal' AND r.status = 'pending'
        AND r.request_id != ?), 0) AS balance
  FROM wallet_ledger l
  WHERE l.user_id = ? AND l.balance_type = 'real'
`).get(String(id), String(id), String(excludeAgentRequestId), String(id)).balance;

export const getActiveAgents = async (req, res, next) => {
  try {
    const agents = getRawSQLiteDB().prepare(`
      SELECT CAST(u._id AS TEXT) AS id, u.username, u.full_name, u.phone,
             COALESCE(u.is_active, 1) AS account_active,
             EXISTS(
               SELECT 1 FROM social_presence p
               WHERE p.user_id = CAST(u._id AS TEXT)
                 AND p.last_seen >= datetime('now', '-90 seconds')
             ) AS is_online,
             COALESCE(s.service_charge_percent, 0) AS service_charge_percent,
             COALESCE(s.payment_details, '') AS payment_details
      FROM users u
      LEFT JOIN agent_settings s ON s.agent_user_id = CAST(u._id AS TEXT)
      WHERE LOWER(u.role) = 'agent' AND COALESCE(u.is_active, 1) = 1
      ORDER BY u.full_name COLLATE NOCASE, u.username COLLATE NOCASE
    `).all();
    res.json({ success: true, data: agents });
  } catch (error) {
    next(error);
  }
};

export const getMyAgentWalletRequests = async (req, res, next) => {
  try {
    const requests = getRawSQLiteDB().prepare(`
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
    const db = getRawSQLiteDB();
    const receipt = db.prepare(`
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
    const db = getRawSQLiteDB();
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

    const agent = getAgent(agentId);
    if (!agent || !agent.is_active) return res.status(404).json({ success: false, message: 'Active agent not found' });
    const actingAsAgent = String(req.user?.role || '').toLowerCase() === 'agent';
    const customerUserId = actingAsAgent ? String(body.customerUserId || '') : userId(req);
    if (actingAsAgent && agentId !== userId(req)) {
      return res.status(403).json({ success: false, message: 'Agents can only submit wallet requests for their own customers' });
    }
    const customer = actingAsAgent
      ? db.prepare(`
          SELECT _id, role, is_active FROM users
          WHERE CAST(_id AS TEXT) = ? AND created_by_user_id = ?
        `).get(customerUserId, userId(req))
      : getUser(customerUserId);
    if (!customer) return res.status(403).json({ success: false, message: 'This customer account is not managed by your agent account' });
    if (actingAsAgent && String(customer.role || '').toLowerCase() !== 'user') {
      return res.status(403).json({ success: false, message: 'Wallet requests can only be created for customer accounts' });
    }
    if (!customer.is_active) return res.status(403).json({ success: false, message: 'This customer account is inactive' });

    const settings = db.prepare(`
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
    const createRequest = db.transaction(() => {
      if (type === 'withdrawal' && amount > getAvailableWalletBalance(db, customerUserId)) {
        throw Object.assign(new Error('The user has insufficient available real wallet balance'), { status: 400 });
      }
      db.prepare(`
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
    createRequest();
    res.status(201).json({ success: true, data: { id: requestId, status: 'pending' } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    next(error);
  }
};

export const reviewAgentWalletRequest = async (req, res, next) => {
  try {
    const db = getRawSQLiteDB();
    const agent = getAgent(userId(req));
    if (!agent || !agent.is_active) return res.status(403).json({ success: false, message: 'An active agent account is required' });
    const status = String(req.body?.status || '').toLowerCase();
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be approved or rejected' });
    }
    const request = db.prepare('SELECT * FROM agent_wallet_requests WHERE request_id = ?')
      .get(String(req.params.requestId));
    if (!request) return res.status(404).json({ success: false, message: 'Wallet request not found' });
    if (request.agent_user_id !== userId(req)) {
      return res.status(403).json({ success: false, message: 'Only the assigned agent can review this request' });
    }
    if (request.status !== 'pending') {
      return res.status(409).json({ success: false, message: 'This request has already been reviewed' });
    }

    const applyReview = db.transaction(() => {
      if (status === 'approved') {
        if (request.request_type === 'withdrawal') {
          if (getAvailableWalletBalance(db, request.user_id, request.request_id) < Number(request.amount)) {
            throw Object.assign(new Error('The user has insufficient available real wallet balance'), { status: 400 });
          }
          if (getAgentPackageBalance(db, request.agent_user_id) < Number(request.net_amount)) {
            throw Object.assign(new Error('The agent package balance is insufficient'), { status: 400 });
          }
          db.prepare(`
            INSERT INTO wallet_ledger
              (entry_id, user_id, amount, entry_type, reference, description, balance_type)
            VALUES (?, ?, ?, 'agent_withdrawal', ?, ?, 'real')
          `).run(createId(), request.user_id, -Number(request.amount), `agent-wallet:${request.request_id}:user`, 'Agent wallet withdrawal');
          recordPackageLedger(
            db, request.agent_user_id, -Number(request.net_amount),
            `agent-wallet:${request.request_id}:agent`, 'Agent withdrawal payout'
          );
        } else {
          db.prepare(`
            INSERT INTO wallet_ledger
              (entry_id, user_id, amount, entry_type, reference, description, balance_type)
            VALUES (?, ?, ?, 'agent_deposit', ?, ?, 'real')
          `).run(createId(), request.user_id, Number(request.net_amount), `agent-wallet:${request.request_id}:user`, 'Agent wallet deposit');
        }
        if (Number(request.service_charge) > 0) {
          db.prepare(`
            INSERT INTO platform_service_charge_ledger
              (entry_id, amount, request_id, entry_type, reference, description)
            VALUES (?, ?, ?, 'service_charge', ?, ?)
          `).run(createId(), Number(request.service_charge), request.request_id, `agent-wallet:${request.request_id}:charge`, 'Agent wallet service charge');
        }
        if (Number(request.agent_reward) > 0) {
          db.prepare(`
            INSERT INTO platform_payout_ledger
              (payout_id, user_id, agent_user_id, amount, request_id, entry_type, reference, description)
            VALUES (?, ?, ?, ?, ?, 'agent_reward', ?, ?)
          `).run(createId(), request.user_id, request.agent_user_id, -Number(request.agent_reward), request.request_id, `agent-wallet:${request.request_id}:reward`, 'Agent wallet reward');
        }
      }
      db.prepare(`
        UPDATE agent_wallet_requests
        SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
        WHERE request_id = ? AND status = 'pending'
      `).run(status, userId(req), request.request_id);
    });
    applyReview();
    res.json({ success: true, data: { id: request.request_id, status } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    next(error);
  }
};

export const getAgentDashboard = async (req, res, next) => {
  try {
    const db = getRawSQLiteDB();
    const id = userId(req);
    const agent = getAgent(id);
    if (!agent || !agent.is_active) return res.status(403).json({ success: false, message: 'An active agent account is required' });
    const summary = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM agent_products WHERE agent_user_id = ?) +
        (SELECT COUNT(*) FROM service_catalog_products WHERE owner_user_id = ?) AS product_count,
        (SELECT COUNT(*) FROM agent_products WHERE agent_user_id = ? AND approval_status = 'pending') +
        (SELECT COUNT(*) FROM service_catalog_products WHERE owner_user_id = ? AND approval_status = 'pending') AS pending_products,
        (SELECT COUNT(*) FROM agent_wallet_requests WHERE agent_user_id = ? AND status = 'pending') AS pending_wallet_requests,
        (SELECT COUNT(*) FROM agent_package_requests WHERE agent_user_id = ? AND status = 'pending') AS pending_package_requests
    `).get(id, id, id, id, id, id);
    const teamMembers = db.prepare(`
      SELECT CAST(u._id AS TEXT) AS id, u.username, u.email, u.full_name, u.role,
             u.phone, u.is_active, u.created_at, u.last_login,
             EXISTS(
               SELECT 1 FROM social_presence p
               WHERE p.user_id = CAST(u._id AS TEXT)
                 AND p.last_seen >= datetime('now', '-90 seconds')
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
             MAX(
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
    const serviceProducts = db.prepare(`
      SELECT product_id AS id, service_key, product_json, published, approval_status, updated_at
      FROM service_catalog_products WHERE owner_user_id = ?
      ORDER BY updated_at DESC
    `).all(id).map(product => ({
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
    const earningsSummary = db.prepare(`
      SELECT
        COALESCE((SELECT SUM(amount) FROM wallet_ledger
                  WHERE user_id = ? AND entry_type = 'product_sale' AND amount > 0), 0) AS sale_commission_earned,
        COALESCE((SELECT SUM(amount) FROM wallet_ledger
                  WHERE user_id = ? AND entry_type = 'marketplace_sale' AND amount > 0), 0) AS service_product_sales_earned,
        COALESCE((SELECT SUM(-amount) FROM platform_payout_ledger
                  WHERE agent_user_id = ? AND entry_type = 'agent_reward' AND amount < 0), 0) AS wallet_request_rewards_earned
    `).get(id, id, id);
    const earnings = db.prepare(`
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
    const commissionRecords = db.prepare(`
      SELECT commission_id AS id, commission_type AS type, client_name, client_phone,
             asset_description, location, amount, commission_rate, commission_amount,
             status, notes, created_at
      FROM agent_commission_records
      WHERE agent_user_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `).all(id);
    const recordedCommissionTotals = db.prepare(`
      SELECT COUNT(*) AS completed_commission_count,
             COALESCE(SUM(commission_amount), 0) AS completed_commission_amount
      FROM agent_commission_records
      WHERE agent_user_id = ? AND status = 'completed'
    `).get(id);
    const products = db.prepare(`
      SELECT product_id AS id, title, description, price, status, approval_status, created_at, updated_at
      FROM agent_products WHERE agent_user_id = ? ORDER BY updated_at DESC
    `).all(id);
    const walletRequests = db.prepare(`
      SELECT r.request_id AS id, r.user_id, r.request_type AS type, r.amount, r.net_amount,
             r.payment_method, r.payment_reference, r.status, r.created_at, r.reviewed_at,
             CASE WHEN r.receipt_image IS NULL OR r.receipt_image = '' THEN 0 ELSE 1 END AS receipt_available,
             u.username AS user_username, u.full_name AS user_name
      FROM agent_wallet_requests r
      LEFT JOIN users u ON CAST(u._id AS TEXT) = r.user_id
      WHERE r.agent_user_id = ? ORDER BY r.created_at DESC LIMIT 100
    `).all(id);
    const packageRequests = db.prepare(`
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
        package_balance: getAgentPackageBalance(db, id),
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
    const db = getRawSQLiteDB();
    const id = userId(req);
    const agent = getAgent(id);
    if (!agent || !agent.is_active) return res.status(403).json({ success: false, message: 'An active agent account is required' });
    const products = db.prepare(`
      SELECT product_id AS id, status, approval_status, updated_at
      FROM agent_products WHERE agent_user_id = ?
    `).all(id);
    const serviceProducts = db.prepare(`
      SELECT product_id AS id, published, approval_status AS approvalStatus, updated_at
      FROM service_catalog_products WHERE owner_user_id = ?
    `).all(id);
    const walletRequests = db.prepare(`
      SELECT request_id AS id, status, reviewed_at FROM agent_wallet_requests
      WHERE agent_user_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(id);
    const packageRequests = db.prepare(`
      SELECT request_id AS id, status, reviewed_at FROM agent_package_requests
      WHERE agent_user_id = ? ORDER BY created_at DESC
    `).all(id);
    const summary = db.prepare(`
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
    const db = getRawSQLiteDB();
    const id = userId(req);
    const memberId = String(req.params.userId || '');
    const member = db.prepare(`
      SELECT CAST(_id AS TEXT) AS id, username, email, full_name, role, phone,
             is_active, created_at, last_login,
             COALESCE((SELECT SUM(l.amount) FROM wallet_ledger l
                       WHERE l.user_id = CAST(users._id AS TEXT) AND l.balance_type = 'real'), 0) AS real_balance,
             EXISTS(
               SELECT 1 FROM social_presence p
               WHERE p.user_id = CAST(users._id AS TEXT)
                 AND p.last_seen >= datetime('now', '-90 seconds')
             ) AS is_online
      FROM users
      WHERE CAST(_id AS TEXT) = ? AND created_by_user_id = ?
    `).get(memberId, id);
    if (!member) return res.status(404).json({ success: false, message: 'Managed account not found' });

    const activity = db.prepare(`
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
      )
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
    const db = getRawSQLiteDB();
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
    const agent = getAgent(agentId);
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
    db.prepare(`
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
    const db = getRawSQLiteDB();
    const id = userId(req);
    const agent = getAgent(id);
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
    const saveProduct = db.transaction(() => {
      db.prepare(`
        INSERT INTO agent_products (product_id, agent_user_id, title, description, price, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(productId, id, title, description, price, status);
      db.prepare(`
        INSERT INTO agent_product_history (history_id, product_id, agent_user_id, action, details)
        VALUES (?, ?, ?, 'created', ?)
      `).run(createId(), productId, id, JSON.stringify({ title, price, status }));
    });
    saveProduct();
    res.status(201).json({ success: true, data: { id: productId, approval_status: 'pending' } });
  } catch (error) {
    next(error);
  }
};

export const updateAgentProduct = async (req, res, next) => {
  try {
    const db = getRawSQLiteDB();
    const agent = getAgent(userId(req));
    if (!agent || !agent.is_active) return res.status(403).json({ success: false, message: 'An active agent account is required' });
    const productId = String(req.params.productId);
    const product = db.prepare('SELECT * FROM agent_products WHERE product_id = ?').get(productId);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    if (product.agent_user_id !== userId(req)) {
      return res.status(403).json({ success: false, message: 'You cannot update this product' });
    }
    const status = String(req.body?.status || '').toLowerCase();
    if (!['selling', 'buying', 'sold', 'bought'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid product status' });
    }
    const saveUpdate = db.transaction(() => {
      db.prepare(`
        UPDATE agent_products SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE product_id = ? AND agent_user_id = ?
      `).run(status, productId, userId(req));
      db.prepare(`
        INSERT INTO agent_product_history (history_id, product_id, agent_user_id, action, details)
        VALUES (?, ?, ?, 'status_updated', ?)
      `).run(createId(), productId, userId(req), JSON.stringify({ from: product.status, to: status }));
    });
    saveUpdate();
    res.json({ success: true, data: { id: productId, status } });
  } catch (error) {
    next(error);
  }
};

export const requestAgentPackageFunds = async (req, res, next) => {
  try {
    const db = getRawSQLiteDB();
    const amount = amountValue(req.body?.amount);
    const note = String(req.body?.note || '').trim();
    const agent = getAgent(userId(req));
    if (!agent || !agent.is_active) return res.status(403).json({ success: false, message: 'An active agent account is required' });
    if (!isValidAmount(amount) || note.length > 1000) {
      return res.status(400).json({ success: false, message: 'Provide a positive amount and a note of at most 1000 characters' });
    }
    const requestId = createId();
    db.prepare(`
      INSERT INTO agent_package_requests (request_id, agent_user_id, amount, note)
      VALUES (?, ?, ?, ?)
    `).run(requestId, userId(req), amount, note);
    res.status(201).json({ success: true, data: { id: requestId, status: 'pending' } });
  } catch (error) {
    next(error);
  }
};

export const createAgentChildAccount = async (req, res, next) => {
  try {
    const db = getRawSQLiteDB();
    const username = String(req.body?.username || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const fullName = String(req.body?.fullName || req.body?.full_name || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const password = String(req.body?.password || '');
    const role = String(req.body?.role || 'agent').trim().toLowerCase();
    const parent = getAgent(userId(req));
    if (!parent || !parent.is_active) return res.status(403).json({ success: false, message: 'An active agent account is required' });
    if (!['agent', 'user'].includes(role) || !/^[A-Za-z0-9_.-]{3,50}$/.test(username) || password.length < 8
      || !fullName || fullName.length > 100 || email.length > 100 || phone.length > 30) {
      return res.status(400).json({ success: false, message: 'Provide a valid account type, username, name, and password of at least 8 characters' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const result = db.prepare(`
      INSERT INTO users
        (username, email, password_hash, full_name, role, phone, is_active, created_by_user_id, created_by_role)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'agent')
    `).run(username, email || null, passwordHash, fullName, role, phone || null, userId(req));
    res.status(201).json({
      success: true,
      data: { id: String(result.lastInsertRowid), username, email: email || null, full_name: fullName, role },
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ success: false, message: 'Username or email is already in use' });
    }
    next(error);
  }
};

export const getRootAgentManagement = async (req, res, next) => {
  try {
    if (!requireRoot(req, res)) return;
    const db = getRawSQLiteDB();
    const agents = db.prepare(`
      SELECT CAST(u._id AS TEXT) AS id, u.username, u.email, u.full_name, u.phone, u.is_active,
             COALESCE(s.service_charge_percent, 0) AS service_charge_percent,
             COALESCE(s.reward_percent, 0) AS reward_percent,
             COALESCE(s.payment_details, '') AS payment_details,
             COALESCE((SELECT SUM(l.amount) FROM agent_package_ledger l WHERE l.agent_user_id = CAST(u._id AS TEXT)), 0) AS package_balance,
             COALESCE((SELECT SUM(l.amount) FROM wallet_ledger l WHERE l.user_id = CAST(u._id AS TEXT) AND l.balance_type = 'real'), 0) AS real_balance,
             COALESCE((SELECT SUM(l.amount) FROM wallet_ledger l WHERE l.user_id = CAST(u._id AS TEXT) AND l.balance_type = 'bonus'), 0) AS bonus_balance,
             COALESCE((SELECT SUM(l.amount) FROM wallet_coin_ledger l WHERE l.user_id = CAST(u._id AS TEXT)), 0) AS coin_balance,
             (SELECT COUNT(*) FROM agent_products p WHERE p.agent_user_id = CAST(u._id AS TEXT)) +
             (SELECT COUNT(*) FROM service_catalog_products p WHERE p.owner_user_id = CAST(u._id AS TEXT)) AS product_count,
             (SELECT COUNT(*) FROM agent_package_requests r WHERE r.agent_user_id = CAST(u._id AS TEXT) AND r.status = 'pending') AS pending_package_requests
      FROM users u
      LEFT JOIN agent_settings s ON s.agent_user_id = CAST(u._id AS TEXT)
      WHERE LOWER(u.role) = 'agent'
      ORDER BY u.created_at DESC
    `).all();
    const requests = db.prepare(`
      SELECT r.request_id AS id, r.agent_user_id AS agent_id, r.amount, r.note, r.status,
             r.created_at, u.full_name AS agent_name, u.username AS agent_username
      FROM agent_package_requests r
      LEFT JOIN users u ON CAST(u._id AS TEXT) = r.agent_user_id
      ORDER BY r.created_at DESC
    `).all();
    const createdAccounts = db.prepare(`
      SELECT CAST(u._id AS TEXT) AS id, u.username, u.email, u.full_name, u.role,
             u.phone, u.is_active, u.created_by_user_id AS agent_user_id,
             COALESCE((SELECT SUM(l.amount) FROM wallet_ledger l
                       WHERE l.user_id = CAST(u._id AS TEXT) AND l.amount > 0
                         AND l.entry_type IN ('product_sale', 'marketplace_sale')), 0)
             + COALESCE((SELECT SUM(-p.amount) FROM platform_payout_ledger p
                         WHERE p.agent_user_id = CAST(u._id AS TEXT)
                           AND p.entry_type = 'agent_reward' AND p.amount < 0), 0) AS total_earned,
             COALESCE((SELECT SUM(l.amount) FROM wallet_ledger l
                       WHERE l.user_id = CAST(u._id AS TEXT) AND l.balance_type = 'real'), 0) AS real_balance,
             (SELECT COUNT(*) FROM wallet_ledger l
              WHERE l.user_id = CAST(u._id AS TEXT)) +
             (SELECT COUNT(*) FROM agent_wallet_requests r
              WHERE r.user_id = CAST(u._id AS TEXT) OR r.agent_user_id = CAST(u._id AS TEXT)) +
             (SELECT COUNT(*) FROM agent_product_history h
              WHERE h.agent_user_id = CAST(u._id AS TEXT)) AS activity_count,
             COALESCE(u.created_at, CURRENT_TIMESTAMP) AS created_at,
             u.last_login
      FROM users u
      WHERE u.created_by_user_id IS NOT NULL
      ORDER BY u.created_at DESC
    `).all();
    res.json({ success: true, data: { agents, created_accounts: createdAccounts, package_requests: requests, package_pool_balance: getPackagePoolBalance(db) } });
  } catch (error) {
    next(error);
  }
};

export const getAgentPlatformAnalytics = async (req, res, next) => {
  try {
    if (!requireRoot(req, res)) return;
    const db = getRawSQLiteDB();
    const {
      period = 'all',
      search = '',
      role = '',
      userId = '',
      from = '',
      to = '',
      coinActivityPage = '0',
      userPage = '0',
    } = req.query;
    const periods = { '7d': '-7 days', '30d': '-30 days', '90d': '-90 days' };
    const validDate = value => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const date = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    };
    const startDate = String(from);
    const endDate = String(to);
    const searchTerm = String(search).trim();
    const roleFilter = String(role).trim();
    const selectedUserId = String(userId).trim();
    const coinPageValue = String(coinActivityPage);
    const usersPageValue = String(userPage);
    const coinPage = Number(coinPageValue);
    const usersPage = Number(usersPageValue);
    if (!['7d', '30d', '90d', 'all', 'custom'].includes(String(period)) ||
        searchTerm.length > 120 ||
        roleFilter.length > 40 ||
        selectedUserId.length > 100 ||
        (startDate && !validDate(startDate)) ||
        (endDate && !validDate(endDate)) ||
        (startDate && endDate && startDate > endDate) ||
        !/^\d+$/.test(coinPageValue) || !Number.isSafeInteger(coinPage) || coinPage > 100000 ||
        !/^\d+$/.test(usersPageValue) || !Number.isSafeInteger(usersPage) || usersPage > 100000) {
      return res.status(400).json({ success: false, message: 'Choose valid user, role, date, and page filters.' });
    }

    const pattern = `%${searchTerm.replace(/[\\%_]/g, '\\$&')}%`;
    const scope = `
      WITH filtered_users AS (
        SELECT CAST(_id AS TEXT) AS id, username,
               COALESCE(full_name, username) AS full_name,
               COALESCE(role, 'unknown') AS role
        FROM users
        WHERE (? = '' OR COALESCE(full_name, '') LIKE ? ESCAPE '\\'
          OR COALESCE(username, '') LIKE ? ESCAPE '\\'
          OR CAST(_id AS TEXT) = ?)
          AND (? = '' OR LOWER(COALESCE(role, 'unknown')) = LOWER(?))
          AND (? = '' OR CAST(_id AS TEXT) = ?)
      )
    `;
    const scopeParams = [
      searchTerm, pattern, pattern, searchTerm,
      roleFilter, roleFilter,
      selectedUserId, selectedUserId,
    ];
    const query = (sql, params = []) => db.prepare(`${scope} ${sql}`).get(...scopeParams, ...params);
    const dateConditions = [];
    const dateParams = [];
    if (startDate) {
      dateConditions.push('date(created_at) >= date(?)');
      dateParams.push(startDate);
    }
    if (endDate) {
      dateConditions.push('date(created_at) <= date(?)');
      dateParams.push(endDate);
    }
    if (!startDate && !endDate && periods[String(period)]) {
      dateConditions.push(`datetime(created_at) >= datetime('now', '${periods[String(period)]}')`);
    }
    const dateFilter = (column = 'created_at') => dateConditions.length
      ? ` AND ${dateConditions.map(condition => condition.replaceAll('created_at', column)).join(' AND ')}`
      : '';
    const hasUserFilter = Boolean(searchTerm || roleFilter || selectedUserId);
    const agentChargeFilter = hasUserFilter
      ? ` AND EXISTS (
          SELECT 1 FROM agent_wallet_requests r
          WHERE r.request_id = l.request_id
            AND r.agent_user_id IN (
              SELECT id FROM filtered_users WHERE LOWER(role) = 'agent'
            )
        )`
      : '';
    const payoutAgentFilter = hasUserFilter
      ? ` AND (l.agent_user_id IN (SELECT id FROM filtered_users WHERE LOWER(role) = 'agent')
        OR l.user_id IN (SELECT id FROM filtered_users))`
      : '';
    const metric = (sql, params = []) => Number(query(sql, params)?.value || 0);
    const userCount = Number(query('SELECT COUNT(*) AS value FROM filtered_users')?.value || 0);
    const agentCount = Number(query("SELECT COUNT(*) AS value FROM filtered_users WHERE LOWER(role) = 'agent'")?.value || 0);
    const revenue = metric(`
      SELECT COALESCE(SUM(l.amount), 0) AS value
      FROM platform_service_charge_ledger l
      WHERE l.entry_type = 'service_charge'${agentChargeFilter}${dateFilter()}
    `, dateParams);
    const platformPayouts = metric(`
      SELECT COALESCE(SUM(-l.amount), 0) AS value
      FROM platform_payout_ledger l
      WHERE 1 = 1${payoutAgentFilter}${dateFilter()}
    `, dateParams);
    const serviceChargeBalance = metric(`
      SELECT COALESCE(SUM(l.amount), 0) AS value
      FROM platform_service_charge_ledger l
      WHERE l.entry_type = 'service_charge'${hasUserFilter ? agentChargeFilter : ''}
    `);
    const allTimePayouts = metric(`
      SELECT COALESCE(SUM(-l.amount), 0) AS value
      FROM platform_payout_ledger l
      WHERE 1 = 1${hasUserFilter ? payoutAgentFilter : ''}
    `);
    const agentBalance = metric(`
      SELECT COALESCE(SUM(l.amount), 0) AS value
      FROM wallet_ledger l
      WHERE l.balance_type = 'real'
        AND l.user_id IN (SELECT id FROM filtered_users WHERE LOWER(role) = 'agent')
    `);
    const earnedBalance = metric(`
      SELECT
        COALESCE((SELECT SUM(l.amount) FROM wallet_ledger l
          WHERE l.user_id IN (SELECT id FROM filtered_users)
            AND l.amount > 0 AND l.entry_type IN ('product_sale', 'marketplace_sale')), 0)
        + COALESCE((SELECT SUM(-p.amount) FROM platform_payout_ledger p
          WHERE p.agent_user_id IN (SELECT id FROM filtered_users WHERE LOWER(role) = 'agent')
            AND p.entry_type = 'agent_reward' AND p.amount < 0), 0) AS value
    `);
    const agentPackageBalance = metric(`
      SELECT COALESCE(SUM(l.amount), 0) AS value
      FROM agent_package_ledger l
      WHERE l.agent_user_id IN (SELECT id FROM filtered_users WHERE LOWER(role) = 'agent')
    `);
    const userBalance = metric(`
      SELECT COALESCE(SUM(l.amount), 0) AS value
      FROM wallet_ledger l
      WHERE l.balance_type = 'real'
        AND l.user_id IN (SELECT id FROM filtered_users)
        AND l.user_id NOT IN (SELECT id FROM filtered_users WHERE LOWER(role) = 'agent')
    `);
    const totalDeposits = metric(`
      SELECT COALESCE(SUM(d.amount), 0) AS value
      FROM wallet_deposits d
      WHERE d.status = 'approved'
        AND d.user_id IN (SELECT id FROM filtered_users)${dateFilter('d.created_at')}
    `, dateParams);
    const totalWithdrawals = metric(`
      SELECT COALESCE(SUM(w.amount), 0) AS value
      FROM wallet_withdrawals w
      WHERE w.status = 'paid'
        AND w.user_id IN (SELECT id FROM filtered_users)${dateFilter('w.created_at')}
    `, dateParams);
    const virtualCoinBalance = metric(`
      SELECT COALESCE(SUM(l.amount), 0) AS value
      FROM wallet_coin_ledger l
      WHERE l.user_id IN (SELECT id FROM filtered_users)
    `);
    const totalCoinsGifted = metric(`
      SELECT COALESCE(SUM(-l.amount), 0) AS value
      FROM wallet_coin_ledger l
      WHERE l.entry_type = 'coin_gift_sent'
        AND l.user_id IN (SELECT id FROM filtered_users)${dateFilter('l.created_at')}
    `, dateParams);
    const roleSummary = db.prepare(`
      ${scope}
      SELECT u.role, COUNT(*) AS user_count,
             COALESCE(SUM((SELECT SUM(l.amount) FROM wallet_ledger l
               WHERE l.user_id = u.id AND l.balance_type = 'real')), 0) AS real_balance,
             COALESCE(SUM((SELECT SUM(l.amount) FROM wallet_ledger l
               WHERE l.user_id = u.id AND l.balance_type = 'bonus')), 0) AS bonus_balance,
             COALESCE(SUM((SELECT SUM(c.amount) FROM wallet_coin_ledger c
               WHERE c.user_id = u.id)), 0) AS coin_balance
      FROM filtered_users u
      GROUP BY u.role
      ORDER BY u.role COLLATE NOCASE
    `).all(...scopeParams);
    const roles = db.prepare(`
      SELECT DISTINCT COALESCE(role, 'unknown') AS role
      FROM users
      ORDER BY role COLLATE NOCASE
    `).all().map(item => item.role);
    const userFinanceCount = userCount;
    const userFinance = db.prepare(`
      ${scope}
      SELECT u.id AS user_id, u.username, u.full_name, u.role,
        COALESCE((SELECT SUM(l.amount) FROM wallet_ledger l
          WHERE l.user_id = u.id AND l.balance_type = 'real'), 0) AS real_balance,
        COALESCE((SELECT SUM(l.amount) FROM wallet_ledger l
          WHERE l.user_id = u.id AND l.balance_type = 'bonus'), 0) AS bonus_balance,
        COALESCE((SELECT SUM(c.amount) FROM wallet_coin_ledger c
          WHERE c.user_id = u.id), 0) AS coin_balance,
        COALESCE((SELECT SUM(d.amount) FROM wallet_deposits d
          WHERE d.user_id = u.id AND d.status = 'approved'${dateFilter('d.created_at')}), 0) AS total_deposits,
        COALESCE((SELECT SUM(w.amount) FROM wallet_withdrawals w
          WHERE w.user_id = u.id AND w.status = 'paid'${dateFilter('w.created_at')}), 0) AS total_withdrawals,
        COALESCE((SELECT SUM(l.amount) FROM wallet_ledger l
          WHERE l.user_id = u.id AND l.amount > 0
            AND l.entry_type IN ('product_sale', 'marketplace_sale')), 0)
        + COALESCE((SELECT SUM(-p.amount) FROM platform_payout_ledger p
          WHERE p.agent_user_id = u.id AND p.entry_type = 'agent_reward' AND p.amount < 0), 0) AS earned_balance
      FROM filtered_users u
      ORDER BY u.full_name COLLATE NOCASE, u.username COLLATE NOCASE
      LIMIT 100 OFFSET ?
    `).all(...scopeParams, ...dateParams, ...dateParams, usersPage * 100);
    const coinActivityCount = Number(query(`
      SELECT COUNT(*) AS value
      FROM wallet_coin_ledger l
      WHERE l.user_id IN (SELECT id FROM filtered_users)${dateFilter('l.created_at')}
    `, dateParams)?.value || 0);
    const coinActivity = db.prepare(`
      ${scope}
      SELECT l.entry_id, l.amount, l.entry_type, l.description, l.created_at,
             COALESCE(u.full_name, u.username, l.user_id) AS full_name, u.username,
             COALESCE(u.role, 'unknown') AS role, l.user_id
      FROM wallet_coin_ledger l
      LEFT JOIN users u ON CAST(u._id AS TEXT) = l.user_id
      WHERE l.user_id IN (SELECT id FROM filtered_users)${dateFilter('l.created_at')}
      ORDER BY l.created_at DESC, l.entry_id DESC
      LIMIT 100 OFFSET ?
    `).all(...scopeParams, ...dateParams, coinPage * 100);
    const legacyAgentAnalytics = query(`
      SELECT
        (SELECT COUNT(*) FROM agent_products p
          WHERE p.agent_user_id IN (SELECT id FROM filtered_users WHERE LOWER(role) = 'agent')) +
        (SELECT COUNT(*) FROM service_catalog_products p
          WHERE p.owner_user_id IN (SELECT id FROM filtered_users WHERE LOWER(role) = 'agent')) AS products,
        (SELECT COUNT(*) FROM agent_wallet_requests r
          WHERE r.agent_user_id IN (SELECT id FROM filtered_users WHERE LOWER(role) = 'agent')) AS wallet_requests,
        (SELECT COUNT(*) FROM agent_package_requests r
          WHERE r.status = 'pending'
            AND r.agent_user_id IN (SELECT id FROM filtered_users WHERE LOWER(role) = 'agent')) AS pending_package_requests
    `);
    const agentRewardsFilter = hasUserFilter
      ? ` AND (p.agent_user_id IN (SELECT id FROM filtered_users WHERE LOWER(role) = 'agent')
        OR p.user_id IN (SELECT id FROM filtered_users))`
      : '';
    const agentRewards = metric(`
      SELECT COALESCE(SUM(-p.amount), 0) AS value
      FROM platform_payout_ledger p
      WHERE p.entry_type = 'agent_reward' AND p.amount < 0${agentRewardsFilter}
    `);
    const recentWalletRequests = db.prepare(`
      ${scope}
      SELECT r.request_id AS id, r.request_type AS type, r.amount, r.status, r.created_at,
             u.full_name AS user_name, a.full_name AS agent_name
      FROM agent_wallet_requests r
      LEFT JOIN users u ON CAST(u._id AS TEXT) = r.user_id
      LEFT JOIN users a ON CAST(a._id AS TEXT) = r.agent_user_id
      WHERE r.agent_user_id IN (SELECT id FROM filtered_users WHERE LOWER(role) = 'agent')
         OR r.user_id IN (SELECT id FROM filtered_users)
      ORDER BY r.created_at DESC LIMIT 20
    `).all(...scopeParams);
    const recentWalletActivity = db.prepare(`
      ${scope}
      SELECT *
      FROM (
        SELECT d.deposit_id AS id, 'User deposit' AS type, d.amount, d.status,
               d.created_at,
               CASE WHEN d.status IN ('approved', 'rejected') THEN d.updated_at ELSE NULL END AS reviewed_at,
               COALESCE(u.full_name, u.username, d.user_id) AS account_name,
               COALESCE(u.username, '') AS username,
               '' AS agent_name,
               d.payment_method || ' · ' || d.payment_reference AS details
        FROM wallet_deposits d
        LEFT JOIN users u ON CAST(u._id AS TEXT) = d.user_id
        WHERE d.user_id IN (SELECT id FROM filtered_users)${dateFilter('d.created_at')}
        UNION ALL
        SELECT w.withdrawal_id AS id, 'User withdrawal' AS type, w.amount, w.status,
               w.created_at,
               CASE WHEN w.status IN ('paid', 'rejected') THEN w.updated_at ELSE NULL END AS reviewed_at,
               COALESCE(u.full_name, u.username, w.user_id) AS account_name,
               COALESCE(u.username, '') AS username,
               '' AS agent_name,
               w.payout_details AS details
        FROM wallet_withdrawals w
        LEFT JOIN users u ON CAST(u._id AS TEXT) = w.user_id
        WHERE w.user_id IN (SELECT id FROM filtered_users)${dateFilter('w.created_at')}
        UNION ALL
        SELECT r.request_id AS id,
               CASE WHEN r.request_type = 'deposit' THEN 'Agent-mediated deposit' ELSE 'Agent-mediated withdrawal' END AS type,
               r.amount, r.status, r.created_at, r.reviewed_at,
               COALESCE(u.full_name, u.username, r.user_id) AS account_name,
               COALESCE(u.username, '') AS username,
               COALESCE(a.full_name, a.username, '') AS agent_name,
               COALESCE(r.payment_method, '') || CASE
                 WHEN r.payment_reference IS NOT NULL AND r.payment_reference != ''
                 THEN ' · ' || r.payment_reference ELSE '' END AS details
        FROM agent_wallet_requests r
        LEFT JOIN users u ON CAST(u._id AS TEXT) = r.user_id
        LEFT JOIN users a ON CAST(a._id AS TEXT) = r.agent_user_id
        WHERE (r.user_id IN (SELECT id FROM filtered_users)
          OR r.agent_user_id IN (SELECT id FROM filtered_users))${dateFilter('r.created_at')}
      )
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT 100
    `).all(...scopeParams, ...dateParams, ...dateParams, ...dateParams);
    const recentPackageRequests = db.prepare(`
      ${scope}
      SELECT r.request_id AS id, r.amount, r.note, r.status, r.created_at,
             u.full_name AS agent_name, u.username AS agent_username
      FROM agent_package_requests r
      LEFT JOIN users u ON CAST(u._id AS TEXT) = r.agent_user_id
      WHERE r.agent_user_id IN (SELECT id FROM filtered_users WHERE LOWER(role) = 'agent')${dateFilter('r.created_at')}
      ORDER BY r.created_at DESC LIMIT 20
    `).all(...scopeParams, ...dateParams);

    res.json({
      success: true,
      data: {
        userCount,
        userFinanceCount,
        agentCount,
        agents: agentCount,
        products: Number(legacyAgentAnalytics?.products || 0),
        wallet_requests: Number(legacyAgentAnalytics?.wallet_requests || 0),
        pending_package_requests: Number(legacyAgentAnalytics?.pending_package_requests || 0),
        package_pool_balance: Number(getPackagePoolBalance(db) || 0),
        recent_package_requests: recentPackageRequests,
        recent_wallet_activity: recentWalletActivity,
        service_charges: revenue,
        agent_rewards: agentRewards,
        recent_wallet_requests: recentWalletRequests,
        revenue,
        platformPayouts,
        profit: revenue - platformPayouts,
        serviceChargeBalance: serviceChargeBalance - allTimePayouts,
        agentBalance,
        earnedBalance,
        agentPackageBalance,
        userBalance,
        totalDeposits,
        totalWithdrawals,
        virtualCoinBalance,
        giftBalance: 0,
        totalCoinsGifted,
        roles,
        roleSummary,
        userFinance,
        userPage: usersPage,
        userPageSize: 100,
        coinActivity,
        coinActivityCount,
        coinActivityPage: coinPage,
        coinActivityPageSize: 100,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getRootAgentDetails = async (req, res, next) => {
  try {
    if (!requireRoot(req, res)) return;
    const db = getRawSQLiteDB();
    const id = String(req.params.agentId);
    const agent = getAgent(id);
    if (!agent) return res.status(404).json({ success: false, message: 'Agent not found' });
    const walletBalances = db.prepare(`
      SELECT
        COALESCE((SELECT SUM(amount) FROM wallet_ledger WHERE user_id = ? AND balance_type = 'real'), 0) AS real_balance,
        COALESCE((SELECT SUM(amount) FROM wallet_ledger WHERE user_id = ? AND balance_type = 'bonus'), 0) AS bonus_balance,
        COALESCE((SELECT SUM(amount) FROM wallet_coin_ledger WHERE user_id = ?), 0) AS coin_balance
    `).get(id, id, id);
    const packageLedger = db.prepare(`
      SELECT entry_id AS id, amount, request_id, reference, description, created_at
      FROM agent_package_ledger WHERE agent_user_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(id);
    const products = db.prepare(`
      SELECT product_id AS id, title, description, price, status, approval_status, created_at, updated_at
      FROM agent_products WHERE agent_user_id = ? ORDER BY updated_at DESC
    `).all(id);
    const serviceProducts = db.prepare(`
      SELECT product_id AS id, service_key, product_json, published, approval_status, updated_at
      FROM service_catalog_products WHERE owner_user_id = ? ORDER BY updated_at DESC
    `).all(id).map(product => ({
      ...JSON.parse(product.product_json),
      id: product.id,
      service_key: product.service_key,
      published: Boolean(product.published),
      approval_status: product.approval_status || 'approved',
      updated_at: product.updated_at,
    }));
    const packageRequests = db.prepare(`
      SELECT request_id AS id, amount, note, status, created_at, reviewed_at
      FROM agent_package_requests WHERE agent_user_id = ? ORDER BY created_at DESC
    `).all(id);
    const walletRequests = db.prepare(`
      SELECT r.request_id AS id, r.user_id, u.username AS user_username,
             r.request_type AS type, r.amount, r.net_amount,
             r.service_charge, r.agent_reward, r.payment_method, r.payment_reference,
             r.payout_details, r.status, r.created_at, r.reviewed_at,
             CASE WHEN r.receipt_image IS NULL OR r.receipt_image = '' THEN 0 ELSE 1 END AS receipt_available
      FROM agent_wallet_requests r
      LEFT JOIN users u ON CAST(u._id AS TEXT) = r.user_id
      WHERE r.agent_user_id = ? ORDER BY r.created_at DESC LIMIT 100
    `).all(id);
    const transactionHistory = db.prepare(`
      SELECT id, type, amount, status, description, created_at
      FROM (
        SELECT l.entry_id AS id, l.entry_type AS type, l.amount, l.balance_type AS status,
               COALESCE(u.username, ?) || ' · ' || l.description AS description, l.created_at
        FROM wallet_ledger l
        LEFT JOIN users u ON CAST(u._id AS TEXT) = l.user_id
        WHERE l.user_id = ? OR u.created_by_user_id = ?
        UNION ALL
        SELECT entry_id AS id, 'package_fund' AS type, amount, 'posted' AS status,
               description, created_at
        FROM agent_package_ledger WHERE agent_user_id = ?
        UNION ALL
        SELECT r.request_id AS id, 'customer_' || r.request_type AS type, r.amount, r.status,
               COALESCE(u.username, 'Customer') || ' · ' || COALESCE(r.payment_reference, '') AS description, r.created_at
        FROM agent_wallet_requests r
        LEFT JOIN users u ON CAST(u._id AS TEXT) = r.user_id
        WHERE r.agent_user_id = ?
        UNION ALL
        SELECT payout_id AS id, entry_type AS type, -amount AS amount, 'posted' AS status,
               description, created_at
        FROM platform_payout_ledger WHERE agent_user_id = ?
        UNION ALL
        SELECT commission_id AS id, commission_type || '_commission' AS type,
               commission_amount AS amount, status, client_name || ' · ' || asset_description AS description,
               created_at
        FROM agent_commission_records WHERE agent_user_id = ?
        UNION ALL
        SELECT d.deposit_id AS id, 'customer_deposit_request' AS type, d.amount, d.status,
               COALESCE(u.username, 'Customer') || ' · ' || d.payment_method || ' · ' || d.payment_reference AS description,
               d.created_at
        FROM wallet_deposits d
        JOIN users u ON CAST(u._id AS TEXT) = d.user_id
        WHERE u.created_by_user_id = ?
        UNION ALL
        SELECT w.withdrawal_id AS id, 'customer_withdrawal_request' AS type, w.amount, w.status,
               COALESCE(u.username, 'Customer') || ' · ' || w.payout_details AS description,
               w.created_at
        FROM wallet_withdrawals w
        JOIN users u ON CAST(u._id AS TEXT) = w.user_id
        WHERE u.created_by_user_id = ?
      )
      ORDER BY created_at DESC
      LIMIT 200
    `).all(agent.username, id, id, id, id, id, id, id, id);
    const createdAccounts = db.prepare(`
      SELECT CAST(u._id AS TEXT) AS id, u.username, u.email, u.full_name, u.role,
             u.phone, u.is_active, u.created_at, u.last_login,
             EXISTS(
               SELECT 1 FROM social_presence p
               WHERE p.user_id = CAST(u._id AS TEXT)
                 AND p.last_seen >= datetime('now', '-90 seconds')
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
             MAX(
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
    res.json({
      success: true,
      data: {
        agent,
        settings: {
          service_charge_percent: agent.service_charge_percent,
          reward_percent: agent.reward_percent,
          payment_details: agent.payment_details,
        },
        package_balance: getAgentPackageBalance(db, id),
        wallet_balances: walletBalances,
        package_ledger: packageLedger,
        products,
        service_products: serviceProducts,
        package_requests: packageRequests,
        wallet_requests: walletRequests,
        transaction_history: transactionHistory,
        created_accounts: createdAccounts,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getRootAgentDetailsStatus = async (req, res, next) => {
  try {
    if (!requireRoot(req, res)) return;
    const db = getRawSQLiteDB();
    const id = String(req.params.agentId || '');
    if (!getAgent(id)) return res.status(404).json({ success: false, message: 'Agent not found' });
    const created_accounts = db.prepare(`
      SELECT CAST(u._id AS TEXT) AS id, u.is_active,
             EXISTS(
               SELECT 1 FROM social_presence p
               WHERE p.user_id = CAST(u._id AS TEXT)
                 AND p.last_seen >= datetime('now', '-90 seconds')
             ) AS is_online
      FROM users u WHERE u.created_by_user_id = ?
    `).all(id);
    const products = db.prepare(`
      SELECT product_id AS id, status, approval_status
      FROM agent_products WHERE agent_user_id = ?
    `).all(id);
    const service_products = db.prepare(`
      SELECT product_id AS id, published, approval_status
      FROM service_catalog_products WHERE owner_user_id = ?
    `).all(id);
    const package_requests = db.prepare(`
      SELECT request_id AS id, status FROM agent_package_requests WHERE agent_user_id = ?
    `).all(id);
    const wallet_requests = db.prepare(`
      SELECT request_id AS id, status FROM agent_wallet_requests WHERE agent_user_id = ?
    `).all(id);
    return res.json({
      success: true,
      data: { created_accounts, products, service_products, package_requests, wallet_requests },
    });
  } catch (error) {
    return next(error);
  }
};

export const updateAgentSettings = async (req, res, next) => {
  try {
    if (!requireRoot(req, res)) return;
    const db = getRawSQLiteDB();
    const id = String(req.params.agentId);
    if (!getAgent(id)) return res.status(404).json({ success: false, message: 'Agent not found' });
    const serviceCharge = Number(req.body?.service_charge_percent);
    const reward = Number(req.body?.reward_percent);
    const paymentDetails = String(req.body?.payment_details ?? '');
    if (!Number.isFinite(serviceCharge) || serviceCharge < 0 || serviceCharge > 100
      || !Number.isFinite(reward) || reward < 0 || reward > 100 || paymentDetails.length > 2000) {
      return res.status(400).json({ success: false, message: 'Invalid service charge, reward percentage, or payment details' });
    }
    db.prepare(`
      INSERT INTO agent_settings (agent_user_id, service_charge_percent, reward_percent, payment_details, updated_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(agent_user_id) DO UPDATE SET
        service_charge_percent = excluded.service_charge_percent,
        reward_percent = excluded.reward_percent,
        payment_details = excluded.payment_details,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(id, serviceCharge, reward, paymentDetails, userId(req));
    res.json({ success: true, data: { agent_id: id, service_charge_percent: serviceCharge, reward_percent: reward, payment_details: paymentDetails } });
  } catch (error) {
    next(error);
  }
};

export const fundAgentPackagePool = async (req, res, next) => {
  try {
    if (!requireRoot(req, res)) return;
    const db = getRawSQLiteDB();
    const amount = amountValue(req.body?.amount);
    const agentId = req.body?.agentId == null || req.body.agentId === '' ? null : String(req.body.agentId);
    const description = String(req.body?.description || 'Platform agent package pool funding').trim();
    if (!isValidAmount(amount) || description.length > 500) {
      return res.status(400).json({ success: false, message: 'Provide a positive funding amount and a valid description' });
    }
    if (agentId && !getAgent(agentId)) return res.status(404).json({ success: false, message: 'Agent not found' });
    const reference = `package-pool:${createId()}`;
    const insertFunding = db.transaction(() => {
      recordPoolLedger(db, amount, agentId, reference, description, userId(req));
      if (agentId) recordPackageLedger(db, agentId, amount, reference, description);
    });
    insertFunding();
    res.status(201).json({
      success: true,
      data: { amount, agent_id: agentId, package_pool_balance: getPackagePoolBalance(db) },
    });
  } catch (error) {
    next(error);
  }
};

export const adjustAgentPackageBalance = async (req, res, next) => {
  try {
    if (!requireRoot(req, res)) return;
    const db = getRawSQLiteDB();
    const id = String(req.params.agentId);
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || '').trim();
    if (!getAgent(id)) return res.status(404).json({ success: false, message: 'Agent not found' });
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000000
      || !description || description.length > 500) {
      return res.status(400).json({ success: false, message: 'Provide a non-zero adjustment and a description' });
    }
    const reference = `package-adjustment:${createId()}`;
    recordPackageLedger(db, id, amount, reference, description);
    res.json({ success: true, data: { agent_id: id, balance: getAgentPackageBalance(db, id) } });
  } catch (error) {
    next(error);
  }
};

export const adjustAgentWalletBalance = async (req, res, next) => {
  try {
    if (!requireRoot(req, res)) return;
    const db = getRawSQLiteDB();
    const id = String(req.params.agentId);
    const asset = String(req.body?.asset || '').trim().toLowerCase();
    const direction = String(req.body?.direction || '').trim().toLowerCase();
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || '').trim();
    if (!getAgent(id)) return res.status(404).json({ success: false, message: 'Agent not found' });
    if (!['real', 'bonus', 'coin'].includes(asset) || !['credit', 'debit'].includes(direction)
      || !Number.isFinite(amount) || amount <= 0 || amount > 100000000
      || (asset === 'coin' && !Number.isSafeInteger(amount))
      || !description || description.length > 500) {
      return res.status(400).json({ success: false, message: 'Provide a valid balance type, action, amount, and reason. Coin amounts must be whole numbers.' });
    }
    const signedAmount = direction === 'credit' ? amount : -amount;
    const reference = `root-agent-wallet:${asset}:${createId()}`;
    const adjust = db.transaction(() => {
      if (direction === 'debit') {
        const currentBalance = asset === 'coin'
          ? Number(db.prepare('SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_coin_ledger WHERE user_id = ?').get(id).balance)
          : Number(db.prepare(`
              SELECT COALESCE(SUM(amount), 0) AS balance
              FROM wallet_ledger WHERE user_id = ? AND balance_type = ?
            `).get(id, asset).balance);
        const reserved = asset === 'coin' ? 0 : Number(db.prepare(`
          SELECT COALESCE(SUM(amount), 0) AS balance
          FROM wallet_withdrawals
          WHERE user_id = ? AND balance_type = ? AND status IN ('pending', 'approved')
        `).get(id, asset).balance);
        if (amount > currentBalance - reserved) {
          throw Object.assign(new Error(`Cannot deduct more than the available ${asset} balance.`), { status: 400 });
        }
      }
      if (asset === 'coin') {
        db.prepare(`
          INSERT INTO wallet_coin_ledger (entry_id, user_id, amount, entry_type, reference, description)
          VALUES (?, ?, ?, 'root_agent_adjustment', ?, ?)
        `).run(createId(), id, signedAmount, reference, description);
      } else {
        db.prepare(`
          INSERT INTO wallet_ledger
            (entry_id, user_id, amount, entry_type, reference, description, balance_type)
          VALUES (?, ?, ?, 'root_agent_adjustment', ?, ?, ?)
        `).run(createId(), id, signedAmount, reference, description, asset);
      }
    });
    adjust();
    res.json({ success: true, data: { agent_id: id, asset, amount: signedAmount } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    next(error);
  }
};

export const reviewAgentPackageRequest = async (req, res, next) => {
  try {
    if (!requireRoot(req, res)) return;
    const db = getRawSQLiteDB();
    const requestId = String(req.params.requestId);
    const status = String(req.body?.status || '').toLowerCase();
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be approved or rejected' });
    }
    const request = db.prepare('SELECT * FROM agent_package_requests WHERE request_id = ?').get(requestId);
    if (!request) return res.status(404).json({ success: false, message: 'Package request not found' });
    if (request.status !== 'pending') return res.status(409).json({ success: false, message: 'This request has already been reviewed' });
    const agent = getAgent(request.agent_user_id);
    if (!agent) return res.status(404).json({ success: false, message: 'Request agent not found' });

    const review = db.transaction(() => {
      if (status === 'approved') {
        if (getPackagePoolBalance(db) < Number(request.amount)) {
          throw Object.assign(new Error('The platform package pool has insufficient funds'), { status: 400 });
        }
        recordPoolLedger(db, -Number(request.amount), request.agent_user_id, `package-request:${requestId}:pool`, `Approved package request ${requestId}`, userId(req));
        recordPackageLedger(db, request.agent_user_id, Number(request.amount), `package-request:${requestId}:agent`, 'Approved package funds');
      }
      db.prepare(`
        UPDATE agent_package_requests
        SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
        WHERE request_id = ? AND status = 'pending'
      `).run(status, userId(req), requestId);
    });
    review();
    res.json({ success: true, data: { id: requestId, status } });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    next(error);
  }
};

export const reviewAgentProduct = async (req, res, next) => {
  try {
    if (!requireRoot(req, res)) return;
    const db = getRawSQLiteDB();
    const productId = String(req.params.productId);
    const status = String(req.body?.status || '').toLowerCase();
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be approved or rejected' });
    }
    const product = db.prepare('SELECT * FROM agent_products WHERE product_id = ?').get(productId);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    if (product.approval_status !== 'pending') {
      return res.status(409).json({ success: false, message: 'This product has already been reviewed' });
    }
    const updateReview = db.transaction(() => {
      db.prepare(`
        UPDATE agent_products SET approval_status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE product_id = ?
      `).run(status, productId);
      db.prepare(`
        INSERT INTO agent_product_history (history_id, product_id, agent_user_id, action, details)
        VALUES (?, ?, ?, 'reviewed', ?)
      `).run(createId(), productId, product.agent_user_id, JSON.stringify({ status, reviewed_by: userId(req) }));
    });
    updateReview();
    res.json({ success: true, data: { id: productId, approval_status: status } });
  } catch (error) {
    next(error);
  }
};
