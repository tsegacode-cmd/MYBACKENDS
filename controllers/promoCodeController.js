import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { queryNeon, toPostgresPlaceholders, withNeonTransaction } from '../config/neonDatabase.js';

const transactionContext = new AsyncLocalStorage();
const query = async (sql, params = []) => {
  const client = transactionContext.getStore();
  return client
    ? client.query(toPostgresPlaceholders(sql), params)
    : queryNeon(sql, params);
};
const transaction = callback => withNeonTransaction(client =>
  transactionContext.run(client, callback));
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

const formatPromoCode = row => {
  if (!row) return null;
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
    totalClaims: Number(row.total_claims || 0),
    status: row.status || 'active',
    broadcastToAll: Boolean(Number(row.broadcast_to_all)),
    claimedByMe: Boolean(row.claimed_by_me),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const promoCodeSelect = `
  SELECT p.*,
    (SELECT COUNT(*) FROM promo_code_claims c WHERE c.code_id = p.code_id) AS total_claims,
    EXISTS (
      SELECT 1 FROM promo_code_claims c
      WHERE c.code_id = p.code_id AND c.user_id = ?
    ) AS claimed_by_me
  FROM promo_codes p
`;

const rewardWalletEntry = async (userId, amount, rewardType, codeLabel, description) => {
  const safeAmount = Number(amount || 0);
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) return false;
  const entryId = randomUUID();
  const reference = `promo-code:${codeLabel}:${Date.now()}:${entryId.slice(0, 8)}`;
  if (rewardType === 'coin') {
    if (!Number.isSafeInteger(safeAmount)) throw new Error('Coin rewards must be a whole number.');
    const result = await query(`
      INSERT INTO wallet_coin_ledger (entry_id, user_id, amount, entry_type, reference, description)
      VALUES (?, ?, ?, 'promo_code_reward', ?, ?)
    `, [entryId, String(userId), safeAmount, reference, description]);
    return result.rowCount === 1;
  }
  const balanceType = rewardType === 'real' ? 'real' : 'bonus';
  const result = await query(`
    INSERT INTO wallet_ledger (entry_id, user_id, amount, entry_type, reference, description, currency, balance_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [entryId, String(userId), safeAmount, 'promo_code_reward', reference, description, 'ETB', balanceType]);
  return result.rowCount === 1;
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

const notifyAllUsers = async (message, link) => {
  const users = await query('SELECT CAST(_id AS TEXT) AS user_id FROM users WHERE is_active = 1');
  for (const user of users.rows) {
    await query(`
      INSERT INTO social_notifications (notification_id, user_id, actor_id, type, message, link)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [randomUUID(), String(user.user_id), null, 'promo_code', message, link]);
  }
};

export const getRootPromoCodes = async (_req, res, next) => {
  try {
    await query(`
      UPDATE promo_codes
      SET status = 'expired', updated_at = CURRENT_TIMESTAMP::text
      WHERE status = 'active' AND expires_at IS NOT NULL
        AND expires_at::timestamptz <= CURRENT_TIMESTAMP
    `);
    const rows = await query(`
      ${promoCodeSelect}
      WHERE p.expires_at IS NULL OR p.expires_at::timestamptz > CURRENT_TIMESTAMP
      ORDER BY p.status DESC, p.created_at DESC
    `, ['']);
    json(res, { codes: rows.rows.map(formatPromoCode) });
  } catch (error) {
    next(error);
  }
};

export const createRootPromoCode = async (req, res, next) => {
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

    const saved = await transaction(async () => {
      const codeId = randomUUID();
      const now = new Date().toISOString();
      await query(`
        INSERT INTO promo_codes (
          code_id, code, title, description, amount, reward_type, expires_at, max_claims,
          broadcast_to_all, status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `, [
        codeId, code, title, description, amount, rewardType, expiresAt || null,
        maxClaims, isBroadcast ? 1 : 0, req.user?.id ? String(req.user.id) : null, now, now,
      ]);
      const result = await query(`${promoCodeSelect} WHERE p.code_id = ?`, ['', codeId]);
      if (isBroadcast) {
        await notifyAllUsers(`New REDSEA promo code available: ${code}. Claim it before it expires.`, '/feed?tab=promo-codes');
      }
      return result.rows[0];
    });

    json(res, { code: formatPromoCode(saved) }, 201);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'A promo code with that value already exists.' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  }
};

export const createRootPromoCodeBatch = async (req, res, next) => {
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
    const created = await transaction(async () => {
      const saved = [];
      const now = new Date().toISOString();
      for (const entry of normalizedEntries) {
        const codeId = randomUUID();
        await query(`
          INSERT INTO promo_codes (
            code_id, code, title, description, amount, reward_type, expires_at, max_claims,
            broadcast_to_all, status, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `, [
          codeId, entry.code, title, description, entry.amount, rewardType, expiresAt,
          maxClaims, isBroadcast ? 1 : 0, req.user?.id ? String(req.user.id) : null, now, now,
        ]);
        const result = await query(`${promoCodeSelect} WHERE p.code_id = ?`, ['', codeId]);
        saved.push(result.rows[0]);
      }
      if (isBroadcast) {
        const codesText = normalizedEntries.map(entry => entry.code).join(', ');
        const message = `New REDSEA promo codes are available: ${codesText}. Claim before they expire.`;
        await notifyAllUsers(message.slice(0, 2000), '/feed?tab=daily-claim');
      }
      return saved;
    });
    json(res, { codes: created.map(formatPromoCode), broadcastToAll: isBroadcast }, 201);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'One or more promo codes already exist.' });
    }
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    next(error);
  }
};

export const getActivePromoCodes = async (req, res, next) => {
  try {
    const userId = req.user?.id ? String(req.user.id) : '';
    await query(`
      UPDATE promo_codes
      SET status = 'expired', updated_at = CURRENT_TIMESTAMP::text
      WHERE status = 'active' AND expires_at IS NOT NULL
        AND expires_at::timestamptz <= CURRENT_TIMESTAMP
    `);
    const rows = await query(`
      ${promoCodeSelect}
      WHERE p.status = 'active'
        AND (p.expires_at IS NULL OR p.expires_at::timestamptz > CURRENT_TIMESTAMP)
        AND (
          p.max_claims <= 0
          OR (SELECT COUNT(*) FROM promo_code_claims c WHERE c.code_id = p.code_id) < p.max_claims
          OR EXISTS (
            SELECT 1 FROM promo_code_claims c
            WHERE c.code_id = p.code_id AND c.user_id = ?
          )
        )
      ORDER BY p.created_at DESC
    `, [userId, userId]);
    json(res, { codes: rows.rows.map(formatPromoCode) });
  } catch (error) {
    next(error);
  }
};

export const claimPromoCode = async (req, res, next) => {
  try {
    const userId = req.user?.id ? String(req.user.id) : '';
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Sign in to claim a promo code.' });
    }
    const code = normalizeCode(req.body?.code || req.body?.promoCode || req.body?.promocode);
    if (!code) {
      return res.status(400).json({ success: false, message: 'Enter a valid promo code to claim.' });
    }

    const outcome = await transaction(async () => {
      const selected = await query('SELECT * FROM promo_codes WHERE code = ? FOR UPDATE', [code]);
      const row = selected.rows[0];
      if (!row) return { error: { statusCode: 404, message: 'That promo code does not exist or is no longer active.' } };
      if (row.status !== 'active') return { error: { statusCode: 400, message: 'This promo code is no longer active.' } };
      if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
        await query("UPDATE promo_codes SET status = 'expired', updated_at = CURRENT_TIMESTAMP::text WHERE code_id = ?", [row.code_id]);
        return { error: { statusCode: 410, message: 'This promo code has expired.' } };
      }
      const alreadyClaimed = await query(
        'SELECT 1 FROM promo_code_claims WHERE code_id = ? AND user_id = ?',
        [String(row.code_id), userId],
      );
      if (alreadyClaimed.rowCount > 0) {
        return { error: { statusCode: 409, message: 'You already claimed this code.' } };
      }
      const claimCount = await query(
        'SELECT COUNT(*) AS count FROM promo_code_claims WHERE code_id = ?',
        [String(row.code_id)],
      );
      const totalClaims = Number(claimCount.rows[0]?.count || 0);
      const maxClaims = Number(row.max_claims || 0);
      if (maxClaims > 0 && totalClaims >= maxClaims) {
        await query("UPDATE promo_codes SET status = 'expired', updated_at = CURRENT_TIMESTAMP::text WHERE code_id = ?", [row.code_id]);
        return { error: { statusCode: 409, message: 'This promo code has reached its maximum number of claims.' } };
      }

      const amount = Number(row.amount || 0);
      const rewardType = String(row.reward_type || 'bonus');
      const claimId = randomUUID();
      const claimedAt = new Date().toISOString();
      await query(`
        INSERT INTO promo_code_claims (claim_id, code_id, user_id, code, amount, reward_type, claimed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [claimId, row.code_id, userId, row.code, amount, rewardType, claimedAt]);
      if (!await rewardWalletEntry(userId, amount, rewardType, row.code, row.title ? `${row.title} reward` : 'Promo code reward')) {
        throw new Error('The promo reward could not be recorded.');
      }
      return {
        result: {
          id: claimId,
          code: row.code,
          title: row.title || 'Promo reward',
          amount,
          rewardType,
          claimedAt,
        },
      };
    });
    if (outcome.error) {
      return res.status(outcome.error.statusCode).json({ success: false, message: outcome.error.message });
    }

    const result = outcome.result;
    const rewardLabel = result.rewardType === 'coin'
      ? `${Number(result.amount).toLocaleString()} coins`
      : `ETB ${Number(result.amount || 0).toFixed(2)}`;
    json(res, {
      claimed: result,
      message: result.rewardType === 'coin'
        ? `Promo code ${result.code} accepted. You received ${rewardLabel}.`
        : `Promo code ${result.code} accepted. You received ${rewardLabel} in your ${result.rewardType === 'real' ? 'real' : 'bonus'} wallet.`,
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'You already claimed this code.' });
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  }
};
