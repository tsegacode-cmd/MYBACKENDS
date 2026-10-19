import { randomUUID } from 'crypto';
import { getRawSQLiteDB } from '../config/sqliteDatabase.js';

const db = () => getRawSQLiteDB();
const json = (res, data, status = 200) => res.status(status).json({ success: true, data });

const normalizeCode = value => {
  const normalized = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!normalized) return '';
  return normalized.length >= 6 ? normalized : '';
};

const ensureCodeText = value => {
  const normalized = normalizeCode(value);
  return normalized || `REDSEA-${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
};

const formatPromoCode = (row, userId = '') => {
  if (!row) return null;
  const claimedByMe = userId ? !!db().prepare(
    'SELECT 1 FROM promo_code_claims WHERE code_id = ? AND user_id = ?'
  ).get(String(row.code_id), String(userId)) : false;
  const totalClaims = Number(db().prepare(
    'SELECT COUNT(*) AS count FROM promo_code_claims WHERE code_id = ?'
  ).get(String(row.code_id))?.count || 0);
  return {
    id: row.code_id,
    code: row.code,
    title: row.title || 'Promo reward',
    description: row.description || '',
    amount: Number(row.amount || 0),
    rewardType: row.reward_type || 'bonus',
    rewardUnit: row.reward_type === 'coin' ? 'coins' : 'ETB',
    expiresAt: row.expires_at || null,
    maxClaims: Number(row.max_claims || 0),
    totalClaims,
    status: row.status || 'active',
    broadcastToAll: Boolean(row.broadcast_to_all),
    claimedByMe,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const rewardWalletEntry = (userId, amount, rewardType, codeLabel, description) => {
  const safeAmount = Number(amount || 0);
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) return false;
  const entryId = randomUUID();
  const reference = `promo-code:${codeLabel}:${Date.now()}:${entryId.slice(0, 8)}`;
  if (rewardType === 'coin') {
    if (!Number.isSafeInteger(safeAmount)) throw new Error('Coin rewards must be a whole number.');
    const result = db().prepare(`
      INSERT INTO wallet_coin_ledger (entry_id, user_id, amount, entry_type, reference, description)
      VALUES (?, ?, ?, 'promo_code_reward', ?, ?)
    `).run(entryId, String(userId), safeAmount, reference, description);
    return result.changes === 1;
  }
  const balanceType = rewardType === 'real' ? 'real' : 'bonus';
  const result = db().prepare(`
    INSERT INTO wallet_ledger (entry_id, user_id, amount, entry_type, reference, description, currency, balance_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(entryId, String(userId), safeAmount, 'promo_code_reward', reference, description, 'ETB', balanceType);
  return result.changes === 1;
};

const validateReward = (amount, rewardType) => {
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) {
    throw Object.assign(new Error('Enter a valid reward amount greater than zero.'), { statusCode: 400 });
  }
  if (!['real', 'bonus', 'coin'].includes(rewardType)) {
    throw Object.assign(new Error('Choose a valid reward type.'), { statusCode: 400 });
  }
  if (rewardType === 'coin' && !Number.isSafeInteger(amount)) {
    throw Object.assign(new Error('Coin rewards must be whole numbers.'), { statusCode: 400 });
  }
};

const expiresAtFromDuration = (seconds, value) => {
  if (seconds == null || seconds === '') return value || null;
  const durationSeconds = Number(seconds);
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 31536000) {
    throw Object.assign(new Error('Expiration duration must be between 1 second and 365 days.'), { statusCode: 400 });
  }
  return new Date(Date.now() + durationSeconds * 1000).toISOString();
};

const notifyAllUsers = (message, link) => {
  const users = db().prepare('SELECT CAST(_id AS TEXT) AS user_id FROM users WHERE is_active = 1').all();
  for (const user of users) {
    db().prepare(`
      INSERT INTO social_notifications (notification_id, user_id, actor_id, type, message, link)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), String(user.user_id), null, 'promo_code', message, link);
  }
};

export const getRootPromoCodes = (_req, res, next) => {
  try {
    db().prepare(`
      UPDATE promo_codes
      SET status = 'expired', updated_at = ?
      WHERE status = 'active' AND expires_at IS NOT NULL
        AND datetime(expires_at) <= datetime('now')
    `).run(new Date().toISOString());
    const rows = db().prepare(`
      SELECT * FROM promo_codes
      WHERE expires_at IS NULL OR datetime(expires_at) > datetime('now')
      ORDER BY status DESC, created_at DESC
    `).all();
    json(res, { codes: rows.map(row => formatPromoCode(row)) });
  } catch (error) {
    next(error);
  }
};

export const createRootPromoCode = (req, res, next) => {
  try {
    const body = req.body || {};
    const title = String(body.title || body.name || 'Promo reward').trim() || 'Promo reward';
    const description = String(body.description || '').trim();
    const amount = Number(body.amount ?? body.value ?? 0);
    const rewardType = ['real', 'bonus', 'coin'].includes(String(body.rewardType || body.reward_type || 'bonus'))
      ? String(body.rewardType || body.reward_type || 'bonus')
      : 'bonus';
    const expiresAt = expiresAtFromDuration(body.expiresInSeconds, body.expiresAt || body.expires_at || null);
    const maxClaims = Number(body.maxClaims ?? body.max_claims ?? 1);
    const isBroadcast = body.broadcastToAll === true || body.broadcast_to_all === true || body.broadcast === true;
    const code = ensureCodeText(body.code || body.promocode || body.promoCode);

    validateReward(amount, rewardType);
    if (!Number.isFinite(maxClaims) || maxClaims < 0 || maxClaims > 1000000) {
      return res.status(400).json({ success: false, message: 'Maximum claims must be zero or more, with a practical limit.' });
    }
    if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) {
      return res.status(400).json({ success: false, message: 'The expiration date must be a valid date.' });
    }

    const saved = db().transaction(() => {
      const existing = db().prepare('SELECT code_id FROM promo_codes WHERE code = ?').get(code);
      if (existing) {
        const error = new Error('A promo code with that value already exists.');
        error.statusCode = 409;
        throw error;
      }
      const codeId = randomUUID();
      const now = new Date().toISOString();
      db().prepare(`
        INSERT INTO promo_codes (
          code_id, code, title, description, amount, reward_type, expires_at, max_claims,
          broadcast_to_all, status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        codeId,
        code,
        title,
        description,
        amount,
        rewardType,
        expiresAt || null,
        maxClaims,
        isBroadcast ? 1 : 0,
        req.user?.id ? String(req.user.id) : null,
        now,
        now,
      );
      const row = db().prepare('SELECT * FROM promo_codes WHERE code_id = ?').get(codeId);
      if (isBroadcast) {
        notifyAllUsers(`New REDSEA promo code available: ${code}. Claim it before it expires.`, '/feed?tab=promo-codes');
      }
      return row;
    })();

    json(res, { code: formatPromoCode(saved) }, 201);
  } catch (error) {
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message || 'Could not create the promo code.' });
  }
};

export const createRootPromoCodeBatch = (req, res, next) => {
  try {
    const body = req.body || {};
    const entries = Array.isArray(body.codes) ? body.codes : [];
    const title = String(body.title || 'Promo reward').trim() || 'Promo reward';
    const description = String(body.description || '').trim();
    const rewardType = String(body.rewardType || 'bonus');
    const expiresAt = expiresAtFromDuration(body.expiresInSeconds, null);
    const maxClaims = Number(body.maxClaims ?? 1);
    const isBroadcast = body.broadcastToAll === true;
    if (!entries.length || entries.length > 100) {
      return res.status(400).json({ success: false, message: 'Generate between 1 and 100 promo codes per batch.' });
    }
    if (!['real', 'bonus', 'coin'].includes(rewardType)) {
      return res.status(400).json({ success: false, message: 'Choose a valid reward type.' });
    }
    if (!Number.isSafeInteger(maxClaims) || maxClaims < 1 || maxClaims > 1000000) {
      return res.status(400).json({ success: false, message: 'Each promo code must allow at least one claim.' });
    }
    if (title.length > 100 || description.length > 500) {
      return res.status(400).json({ success: false, message: 'Title or description is too long.' });
    }
    const normalizedEntries = entries.map(entry => {
      const code = normalizeCode(entry?.code);
      const amount = Number(entry?.amount);
      if (!code || code.length > 40) throw Object.assign(new Error('Every generated code must be valid and no longer than 40 characters.'), { statusCode: 400 });
      validateReward(amount, rewardType);
      return { code, amount };
    });
    const uniqueCodes = new Set(normalizedEntries.map(entry => entry.code));
    if (uniqueCodes.size !== normalizedEntries.length) {
      return res.status(400).json({ success: false, message: 'Generated codes must be unique within the batch.' });
    }
    const created = db().transaction(() => {
      const saved = [];
      const insertCode = db().prepare(`
        INSERT INTO promo_codes (
          code_id, code, title, description, amount, reward_type, expires_at, max_claims,
          broadcast_to_all, status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const entry of normalizedEntries) {
        if (db().prepare('SELECT 1 FROM promo_codes WHERE code = ?').get(entry.code)) {
          throw Object.assign(new Error(`Promo code ${entry.code} already exists.`), { statusCode: 409 });
        }
        const codeId = randomUUID();
        insertCode.run(
          codeId, entry.code, title, description, entry.amount, rewardType, expiresAt,
          maxClaims, isBroadcast ? 1 : 0, req.user?.id ? String(req.user.id) : null, now, now
        );
        saved.push(db().prepare('SELECT * FROM promo_codes WHERE code_id = ?').get(codeId));
      }
      if (isBroadcast) {
        const codesText = normalizedEntries.map(entry => entry.code).join(', ');
        const message = `New REDSEA promo codes are available: ${codesText}. Claim before they expire.`;
        notifyAllUsers(message.slice(0, 2000), '/feed?tab=daily-claim');
      }
      return saved;
    })();
    json(res, { codes: created.map(row => formatPromoCode(row)), broadcastToAll: isBroadcast }, 201);
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    next(error);
  }
};

export const getActivePromoCodes = (req, res, next) => {
  try {
    const userId = req.user?.id ? String(req.user.id) : '';
    db().prepare(`
      UPDATE promo_codes
      SET status = 'expired', updated_at = ?
      WHERE status = 'active' AND expires_at IS NOT NULL
        AND datetime(expires_at) <= datetime('now')
    `).run(new Date().toISOString());
    const rows = db().prepare(`
      SELECT * FROM promo_codes
      WHERE status = 'active'
        AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
        AND (
          max_claims <= 0
          OR (SELECT COUNT(*) FROM promo_code_claims WHERE code_id = promo_codes.code_id) < max_claims
          OR EXISTS (
            SELECT 1 FROM promo_code_claims
            WHERE code_id = promo_codes.code_id AND user_id = ?
          )
        )
      ORDER BY created_at DESC
    `).all(userId);
    json(res, { codes: rows.map(row => formatPromoCode(row, userId)) });
  } catch (error) {
    next(error);
  }
};

export const claimPromoCode = (req, res, next) => {
  try {
    const userId = req.user?.id ? String(req.user.id) : '';
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Sign in to claim a promo code.' });
    }
    const code = normalizeCode(req.body?.code || req.body?.promoCode || req.body?.promocode);
    if (!code) {
      return res.status(400).json({ success: false, message: 'Enter a valid promo code to claim.' });
    }

    const result = db().transaction(() => {
      const row = db().prepare('SELECT * FROM promo_codes WHERE code = ?').get(code);
      if (!row) {
        const error = new Error('That promo code does not exist or is no longer active.');
        error.statusCode = 404;
        throw error;
      }
      if (row.status !== 'active') {
        const error = new Error('This promo code is no longer active.');
        error.statusCode = 400;
        throw error;
      }
      if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
        db().prepare('UPDATE promo_codes SET status = ? WHERE code_id = ?').run('expired', row.code_id);
        const error = new Error('This promo code has expired.');
        error.statusCode = 410;
        throw error;
      }
      const alreadyClaimed = db().prepare(
        'SELECT 1 FROM promo_code_claims WHERE code_id = ? AND user_id = ?'
      ).get(String(row.code_id), userId);
      if (alreadyClaimed) {
        const error = new Error('You already claimed this code.');
        error.statusCode = 409;
        throw error;
      }
      const totalClaims = Number(db().prepare(
        'SELECT COUNT(*) AS count FROM promo_code_claims WHERE code_id = ?'
      ).get(String(row.code_id))?.count || 0);
      const maxClaims = Number(row.max_claims || 0);
      if (maxClaims > 0 && totalClaims >= maxClaims) {
        db().prepare('UPDATE promo_codes SET status = ? WHERE code_id = ?').run('expired', row.code_id);
        const error = new Error('This promo code has reached its maximum number of claims.');
        error.statusCode = 409;
        throw error;
      }

      const amount = Number(row.amount || 0);
      const rewardType = String(row.reward_type || 'bonus');
      const claimId = randomUUID();
      const claimedAt = new Date().toISOString();
      db().prepare(`
        INSERT INTO promo_code_claims (claim_id, code_id, user_id, code, amount, reward_type, claimed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(claimId, row.code_id, userId, row.code, amount, rewardType, claimedAt);
      rewardWalletEntry(userId, amount, rewardType, row.code, row.title ? `${row.title} reward` : 'Promo code reward');
      return {
        id: claimId,
        code: row.code,
        title: row.title || 'Promo reward',
        amount,
        rewardType,
        claimedAt,
      };
    })();

    const rewardLabel = result.rewardType === 'coin' ? `${Number(result.amount).toLocaleString()} coins` : `ETB ${Number(result.amount || 0).toFixed(2)}`;
    json(res, {
      claimed: result,
      message: result.rewardType === 'coin'
        ? `Promo code ${result.code} accepted. You received ${rewardLabel}.`
        : `Promo code ${result.code} accepted. You received ${rewardLabel} in your ${result.rewardType === 'real' ? 'real' : 'bonus'} wallet.`,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message || 'Your promo code could not be claimed.' });
  }
};
