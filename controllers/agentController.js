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
          `).run(createId(), request.user_
