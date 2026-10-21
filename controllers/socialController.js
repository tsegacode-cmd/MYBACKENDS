import { randomBytes, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getRawSQLiteDB } from '../config/sqliteDatabase.js';
import { recordPlatformPayout } from '../utils/platformFinance.js';

const db = () => getRawSQLiteDB();
const PHONE_SQL = "replace(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '')";
const currentId = req => String(req.user.id);
const isRoot = user => user?.isRoot || ['root', 'admin'].includes(String(user?.role || '').toLowerCase());
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const normalizeJsonList = value => {
  if (Array.isArray(value)) return value.filter(item => item != null).map(item => String(item).trim()).filter(Boolean).slice(0, 25);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter(item => item != null).map(item => String(item).trim()).filter(Boolean).slice(0, 25);
    }
    if (typeof parsed === 'string') {
      return parsed.split(',').map(item => item.trim()).filter(Boolean).slice(0, 25);
    }
    return [];
  } catch {
    return trimmed
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 25);
  }
};
const parseStoredList = value => {
  if (Array.isArray(value)) return normalizeJsonList(value);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null') return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? normalizeJsonList(parsed) : normalizeJsonList(trimmed);
  } catch {
    return normalizeJsonList(trimmed);
  }
};
const extractMentions = text => [...new Set((String(text || '').match(/@([A-Za-z0-9_.-]+)/g) || []).map(item => item.slice(1).trim()).filter(Boolean))];
const extractHashtags = text => [...new Set((String(text || '').match(/#([A-Za-z0-9_.-]+)/g) || []).map(item => item.slice(1).trim()).filter(Boolean))];
const normalizeTagList = value => normalizeJsonList(value)
  .map(item => String(item).replace(/^@/, '').replace(/^#/, '').trim())
  .filter(Boolean)
  .slice(0, 25);
const resolveUserIdsByUsernames = usernames => {
  const uniqueNames = [...new Set(usernames.map(name => String(name).trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
  if (!uniqueNames.length) return [];
  const placeholders = uniqueNames.map(() => '?').join(', ');
  const rows = db().prepare(`
    SELECT CAST(_id AS TEXT) AS user_id, LOWER(username) AS username
    FROM users
    WHERE LOWER(username) IN (${placeholders}) AND is_active = 1
  `).all(...uniqueNames);
  return rows.map(row => row.user_id);
};
const notifyMentionTargets = (actorId, targetUserIds, postId, defaultType = 'mention') => {
  const actorName = db().prepare('SELECT COALESCE(full_name, username, "Member") AS name FROM users WHERE CAST(_id AS TEXT) = ?').get(String(actorId))?.name || 'Someone';
  const seen = new Set();
  targetUserIds.forEach(targetUserId => {
    const id = String(targetUserId);
    if (!id || id === String(actorId) || seen.has(id)) return;
    seen.add(id);
    const type = defaultType === 'tagged_friend' ? 'tagged_friend' : 'mention';
    const actionText = type === 'tagged_friend' ? 'tagged you in a post.' : 'mentioned you in a post.';
    notify(id, actorId, type, `${actorName} ${actionText}`, `/feed?post=${encodeURIComponent(postId)}`);
  });
};
const socialWriteError = userId => {
  const user = db().prepare(`
    SELECT is_active, social_restricted, social_restriction_reason, social_banned, social_ban_reason
    FROM users WHERE CAST(_id AS TEXT) = ?
  `).get(String(userId));
  if (!user) return 'This account is not permitted to publish social content.';
  if (user.social_banned) return `This account is banned${user.social_ban_reason ? `: ${user.social_ban_reason}` : '.'}`;
  if (!user.is_active) return 'This account is not permitted to publish social content.';
  if (user.social_restricted) {
    return `This account is restricted from publishing social content${user.social_restriction_reason ? `: ${user.social_restriction_reason}` : '.'}`;
  }
  return '';
};
const isValidCallSignal = (type, body) => {
  try {
    const signal = JSON.parse(body);
    if (typeof signal?.callId !== 'string' || !signal.callId) return false;
    if (type === 'call-end') return signal.ended === true;
    const expectedDescriptionType = type === 'call-offer' ? 'offer' : 'answer';
    return ['audio', 'video'].includes(signal?.mediaType) &&
      signal.description?.type === expectedDescriptionType &&
      typeof signal.description.sdp === 'string' &&
      signal.description.sdp.length > 0;
  } catch {
    return false;
  }
};
const json = (res, data, status = 200) => res.status(status).json({ success: true, data });
const areFriends = (userId, otherUserId) => String(userId) === String(otherUserId) || !!db().prepare(`
  SELECT 1 FROM social_follows mine
  JOIN social_follows theirs ON theirs.follower_id = mine.followed_id AND theirs.followed_id = mine.follower_id
  WHERE mine.follower_id = ? AND mine.followed_id = ?
`).get(String(userId), String(otherUserId));
const hasFollowConnection = (userId, otherUserId) => !!db().prepare(`
  SELECT 1 FROM social_follows
  WHERE (follower_id = ? AND followed_id = ?)
     OR (follower_id = ? AND followed_id = ?)
`).get(String(userId), String(otherUserId), String(otherUserId), String(userId));
const canViewPost = (userId, post) => {
  if (!post) return false;
  const moderation = db().prepare(`
    SELECT p.moderation_status, COALESCE(u.social_banned, 0) AS social_banned
    FROM social_posts p LEFT JOIN users u ON CAST(u._id AS TEXT) = p.user_id
    WHERE p.post_id = ?
  `).get(post.post_id);
  if (!moderation || moderation.moderation_status !== 'active' || moderation.social_banned) return false;
  if (post.visibility === 'private' && post.user_id !== String(userId)) return false;
  if (post.user_id !== String(userId) && post.visibility === 'friends' && !areFriends(userId, post.user_id)) return false;
  if (post.repost_of) {
    const original = db().prepare('SELECT user_id, visibility, repost_of FROM social_posts WHERE post_id = ?').get(post.repost_of);
    return original ? canViewPost(userId, original) : false;
  }
  return true;
};

const notify = (userId, actorId, type, message, link = null) => {
  db().prepare(`
    INSERT INTO social_notifications (notification_id, user_id, actor_id, type, message, link)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), String(userId), actorId == null ? null : String(actorId), type, message, link);
};

const roleRates = role => {
  const normalizedRole = String(role || 'user').toLowerCase();
  db().prepare('INSERT OR IGNORE INTO wallet_settings (role) VALUES (?)').run(normalizedRole);
  return db().prepare('SELECT * FROM wallet_settings WHERE role = ?').get(normalizedRole);
};

const resolveWalletBalanceType = (type, requestedBalanceType = '') => {
  const normalizedType = String(type || '').toLowerCase().trim();
  const normalizedRequestedType = String(requestedBalanceType || '').toLowerCase().trim();
  if (['real', 'bonus'].includes(normalizedRequestedType)) return normalizedRequestedType;

  const realTypes = new Set([
    'deposit',
    'withdrawal',
    'coin_conversion',
    'etb_to_coin',
    'marketplace_sale',
    'product_sale',
    'sale_commission',
    'agent_transfer',
    'agent_wallet_transfer',
    'agent_deposit',
    'agent_withdrawal',
    'payment_received',
    'manual_real_adjustment',
    'admin_adjustment',
    'wallet_transfer',
    'account_top_up',
    'approved_purchase',
    'purchase_settlement',
    'payout'
  ]);
  const bonusTypes = new Set([
    'signup_bonus',
    'invite_reward',
    'share_reward',
    'daily_login_reward',
    'coin_daily_login',
    'coin_invite_reward',
    'coin_purchase_reward',
    'coin_gift_receive_reward',
    'coin_gift_bonus',
    'bonus_reward',
    'bonus',
    'gift_bonus',
    'referral_bonus',
    'reward'
  ]);

  if (realTypes.has(normalizedType)) return 'real';
  if (bonusTypes.has(normalizedType)) return 'bonus';
  if (normalizedType.includes('bonus') || normalizedType.includes('reward') || normalizedType.includes('gift') || normalizedType.includes('referral') || normalizedType.includes('share') || normalizedType.includes('login')) {
    return 'bonus';
  }
  if (normalizedType.includes('sale') || normalizedType.includes('payment') || normalizedType.includes('deposit') || normalizedType.includes('withdrawal') || normalizedType.includes('transfer') || normalizedType.includes('adjustment')) {
    return 'real';
  }
  return 'real';
};

const creditWallet = (userId, amount, type, reference, description, requestedBalanceType = '') => {
  const value = Number(amount);
  if (!Number.isFinite(value) || value === 0 || (value < 0 && !['withdrawal', 'admin_adjustment', 'coin_conversion', 'etb_to_coin', 'bonus_to_real_conversion'].includes(String(type || '').toLowerCase()))) return false;
  const roundedValue = Math.round(value * 100) / 100;
  if (roundedValue === 0) return false;
  const userRole = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(userId))?.role;
  const currency = roleRates(userRole).currency;
  const balanceType = resolveWalletBalanceType(type, requestedBalanceType);
  const result = db().prepare(`
    INSERT OR IGNORE INTO wallet_ledger (entry_id, user_id, amount, entry_type, reference, description, currency, balance_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), String(userId), roundedValue, type, reference, description, currency, balanceType);
  return result.changes === 1;
};

const creditPlatformReward = (userId, amount, type, reference, description, agentUserId = null, requestedBalanceType = 'bonus') => {
  const payReward = db().transaction(() => {
    const credited = creditWallet(userId, amount, type, reference, description, requestedBalanceType);
    if (!credited) return false;
    recordPlatformPayout({
      userId,
      agentUserId,
      amount,
      requestId: reference,
      entryType: type,
      reference: `platform-payout:${reference}`,
      description,
    });
    return true;
  });
  return payReward();
};

const creditCoins = (userId, amount, type, reference, description) => {
  const value = Number(amount);
  if (!Number.isSafeInteger(value) || value === 0) return false;
  const record = db().transaction(() => {
    const result = db().prepare(`
      INSERT OR IGNORE INTO wallet_coin_ledger (entry_id, user_id, amount, entry_type, reference, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), String(userId), value, type, reference, description);
    if (result.changes === 1 && value > 0 &&
        !['coin_purchase', 'coin_savings_return', 'coin_admin_adjustment'].includes(String(type))) {
      awardReachedCoinLevels(userId);
    }
    return result.changes === 1;
  });
  return record();
};

export const creditUserCoins = (userId, amount, type, reference, description) =>
  creditCoins(userId, amount, type, reference, description);
export const getUserCoinBalance = userId => coinBalance(userId);

const coinBalance = userId => {
  settleMaturedCoinSavings(userId);
  return Number(db().prepare(
    'SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_coin_ledger WHERE user_id = ?'
  ).get(String(userId)).balance);
};

const COIN_EARNED_EXCLUDED_TYPES = ['coin_purchase', 'coin_savings_return', 'coin_admin_adjustment'];
const getLifetimeEarnedCoins = userId => Number(db().prepare(`
  SELECT COALESCE(SUM(amount), 0) AS earned
  FROM wallet_coin_ledger
  WHERE user_id = ? AND amount > 0
    AND entry_type NOT IN (?, ?, ?)
`).get(String(userId), ...COIN_EARNED_EXCLUDED_TYPES).earned);

const getCoinLevelRules = () => db().prepare(
  'SELECT level, required_coins, reward_etb FROM wallet_coin_level_rules ORDER BY level'
).all();

const awardReachedCoinLevels = userId => {
  const earnedCoins = getLifetimeEarnedCoins(userId);
  if (earnedCoins <= 0) return;
  const rules = getCoinLevelRules();
  for (const rule of rules) {
    if (earnedCoins < rule.required_coins) continue;
    if (db().prepare('SELECT 1 FROM wallet_coin_level_history WHERE user_id = ? AND level = ?')
      .get(String(userId), rule.level)) continue;

    const reward = Math.round(Number(rule.reward_etb) * 100) / 100;
    const reference = `coin-level-reward:${userId}:${rule.level}`;
    if (reward > 0 && !creditPlatformReward(
      userId,
      reward,
      'coin_level_reward',
      reference,
      `ETB bonus for reaching coin level ${rule.level}`,
      null,
      'bonus'
    ) && !db().prepare('SELECT 1 FROM wallet_ledger WHERE reference = ?').get(reference)) {
      throw new Error(`Could not credit the level ${rule.level} ETB reward.`);
    }
    db().prepare(`
      INSERT INTO wallet_coin_level_history (achievement_id, user_id, level, earned_coins, reward_etb)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), String(userId), rule.level, earnedCoins, reward);
    notify(
      userId,
      null,
      'coin_level_reward',
      reward > 0
        ? `Congratulations! You reached coin level ${rule.level} and earned ETB ${reward.toFixed(2)} bonus.`
        : `Congratulations! You reached coin level ${rule.level}.`,
      '/wallet'
    );
  }
};

const getCoinLevelProgress = userId => {
  const earnedCoins = getLifetimeEarnedCoins(userId);
  const rules = getCoinLevelRules();
  const current = rules.filter(rule => earnedCoins >= rule.required_coins).at(-1) || null;
  const next = rules.find(rule => rule.level > (current?.level || 0)) || null;
  const totalRewardEtb = Number(db().prepare(
    'SELECT COALESCE(SUM(reward_etb), 0) AS total FROM wallet_coin_level_history WHERE user_id = ?'
  ).get(String(userId)).total);
  return {
    earnedCoins,
    currentLevel: current?.level || 0,
    currentThreshold: current?.required_coins || 0,
    nextLevel: next?.level || null,
    nextThreshold: next?.required_coins || null,
    totalRewardEtb,
    rules,
    history: db().prepare(`
      SELECT level, earned_coins, reward_etb, created_at
      FROM wallet_coin_level_history WHERE user_id = ? ORDER BY level DESC
    `).all(String(userId)),
  };
};

const settleMaturedCoinSavings = userId => {
  const settle = db().transaction(() => {
    const matured = db().prepare(`
      SELECT * FROM wallet_coin_savings
      WHERE user_id = ? AND status = 'active' AND datetime(maturity_at) <= CURRENT_TIMESTAMP
      ORDER BY maturity_at ASC
    `).all(String(userId));
    for (const deposit of matured) {
      if (!creditCoins(
        userId,
        deposit.principal,
        'coin_savings_return',
        `coin-savings:${deposit.deposit_id}:principal-return`,
        `Returned ${deposit.principal} coins from matured savings`
      )) throw new Error(`Could not return the principal for savings deposit ${deposit.deposit_id}.`);
      if (deposit.expected_interest > 0 && !creditCoins(
        userId,
        deposit.expected_interest,
        'coin_savings_interest',
        `coin-savings:${deposit.deposit_id}:interest`,
        `Interest earned on ${deposit.principal} coins over ${deposit.duration_days} days`
      )) throw new Error(`Could not credit interest for savings deposit ${deposit.deposit_id}.`);
      db().prepare(`
        UPDATE wallet_coin_savings SET status = 'matured', settled_at = CURRENT_TIMESTAMP
        WHERE deposit_id = ? AND status = 'active'
      `).run(deposit.deposit_id);
    }
    return matured.length;
  });
  return settle();
};

export const awardDailyLoginCoins = userId => {
  const user = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(userId));
  if (!user) return false;
  const rates = roleRates(user.role);
  const amount = Number(rates.coin_login_reward);
  const day = new Date().toISOString().slice(0, 10);
  const rewarded = creditCoins(
    userId,
    amount,
    'coin_daily_login',
    `daily-login:${userId}:${day}`,
    'Daily active login coin reward'
  );
  if (rewarded) notify(userId, null, 'coin_reward', `🎉 You received ${amount} daily login coins.`, '/wallet');
  return rewarded;
};

export const ensureReferralCode = userId => {
  const found = db().prepare('SELECT referral_code FROM social_referrals WHERE owner_user_id = ?').get(String(userId));
  if (found) return found.referral_code;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomBytes(5).toString('hex').toUpperCase();
    try {
      db().prepare('INSERT INTO social_referrals (referral_code, owner_user_id) VALUES (?, ?)').run(code, String(userId));
      return code;
    } catch (error) {
      if (!String(error.message).includes('UNIQUE')) throw error;
    }
  }
  throw new Error('Could not create an invite code.');
};

export const registerReferredUser = (userId, referralCode) => {
  const newUser = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(userId));
  if (!newUser) return;
  const config = roleRates(newUser.role);
  const inviter = referralCode
    ? db().prepare('SELECT owner_user_id FROM social_referrals WHERE referral_code = ?').get(String(referralCode).trim().toUpperCase())
    : null;
  const validInviter = inviter && String(inviter.owner_user_id) !== String(userId) ? inviter : null;
  const signupBonusPaid = creditPlatformReward(userId, config.signup_bonus, 'signup_bonus', `signup:${userId}`, 'Account welcome bonus');
  if (signupBonusPaid) notify(userId, null, 'signup_bonus', `Your ${config.signup_bonus.toFixed(2)} welcome bonus was added to your wallet.`, '/wallet');
  if (validInviter) {
    const inviterId = String(validInviter.owner_user_id);
    const inviterUser = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(inviterId));
    const inviterConfig = roleRates(inviterUser?.role);
    const join = db().prepare('INSERT OR IGNORE INTO social_referral_joins (new_user_id, inviter_user_id, referral_code) VALUES (?, ?, ?)')
      .run(String(userId), inviterId, String(referralCode).trim().toUpperCase());
    if (join.changes === 1) {
      db().prepare('INSERT OR IGNORE INTO social_follows (follower_id, followed_id) VALUES (?, ?)').run(String(userId), inviterId);
      const newUsername = db().prepare('SELECT username FROM users WHERE _id = ?').get(Number(userId))?.username || 'new member';
      if (inviterConfig.invite_reward_trigger === 'registration' || inviterConfig.invite_reward_trigger === 'both') {
        creditPlatformReward(inviterId, inviterConfig.invite_reward, 'invite_reward', `invite:${userId}`, `Invite bonus for ${newUsername}`);
        creditCoins(inviterId, inviterConfig.coin_invite_reward, 'coin_invite_reward', `coin-invite:${userId}`, `Invite coins for ${newUsername}`);
      }
      notify(inviterId, userId, 'invite', `${newUsername} joined using your invite link.`, '/friends');
      notify(userId, inviterId, 'follow', 'You are now following your inviter.', '/friends');
    }
  }
};

export const registerAccount = async (req, res, next) => {
  try {
    const { username, email, password, full_name, phone, position, referralCode, registrationChallengeId, telegramChatId } = req.body || {};
    const cleanUsername = String(username || '').trim();
    const submittedTelegramChatId = String(telegramChatId || '').trim();
    if (!/^[A-Za-z0-9_.-]{3,40}$/.test(cleanUsername) || typeof password !== 'string' || password.length < 6 || password.length > 128) {
      return res.status(400).json({ success: false, message: 'Enter a valid username and a password of at least 6 characters.' });
    }
    if (typeof registrationChallengeId !== 'string' || !registrationChallengeId) {
      return res.status(403).json({ success: false, message: 'Verify your phone or email by OTP before creating an account.' });
    }
    const submittedPhone = String(phone || '').trim();
    const normalizedPhone = submittedPhone.replace(/\D/g, '');
    if (!/^[+\d\s()-]{7,24}$/.test(submittedPhone) || !/^\d{7,15}$/.test(normalizedPhone)) {
      return res.status(400).json({ success: false, message: 'Enter a valid phone number.' });
    }
    if (email && (typeof email !== 'string' || email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    }
    const cleanReferralCode = String(referralCode || '').trim().toUpperCase();
    if (cleanReferralCode && !db().prepare('SELECT 1 FROM social_referrals WHERE referral_code = ?').get(cleanReferralCode)) {
      return res.status(400).json({ success: false, message: 'The invite link is invalid or expired.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const create = db().transaction(() => {
      const ticket = db().prepare(`
        SELECT contact_type, contact, phone FROM registration_otp_tickets
        WHERE challenge_id = ? AND used_at IS NULL AND created_at >= datetime('now', '-10 minutes')
      `).get(registrationChallengeId);
      const submittedContact = ticket?.contact_type === 'telegram'
        ? submittedTelegramChatId
        : ticket?.contact_type === 'email'
          ? String(email || '').trim().toLowerCase()
          : normalizedPhone;
      if (!ticket || ticket.contact !== submittedContact || ticket.phone !== normalizedPhone) {
        const error = new Error('The OTP verification is missing, expired, or does not match the registered contact.');
        error.status = 403;
        throw error;
      }
      if (ticket.contact_type === 'telegram' && db().prepare('SELECT 1 FROM users WHERE telegram_chat_id = ?').get(ticket.contact)) {
        const error = new Error('This Telegram account is already linked to an account. Try logging in instead.');
        error.status = 409;
        throw error;
      }
      const userEmail = email ? String(email).trim().toLowerCase() : null;
      const userPhone = submittedPhone;
      if (userEmail && db().prepare('SELECT 1 FROM users WHERE lower(trim(email)) = ?').get(userEmail)) {
        const error = new Error('That email address is already registered.');
        error.status = 409;
        throw error;
      }
      if (db().prepare(`SELECT 1 FROM users WHERE ${PHONE_SQL} = ?`).get(normalizedPhone)) {
        const error = new Error('That phone number is already registered.');
        error.status = 409;
        throw error;
      }
      const consumeTicket = db().prepare(`
        UPDATE registration_otp_tickets SET used_at = datetime('now')
        WHERE challenge_id = ? AND used_at IS NULL
      `).run(registrationChallengeId);
      if (consumeTicket.changes !== 1) {
        const error = new Error('This OTP verification has already been used.');
        error.status = 403;
        throw error;
      }
      const result = db().prepare(`
        INSERT INTO users (username, email, password_hash, full_name, role, position, phone, telegram_chat_id, is_active, created_by_role)
        VALUES (?, ?, ?, ?, 'user', ?, ?, ?, 1, 'self')
      `).run(cleanUsername, userEmail, passwordHash, String(full_name || '').trim() || null, null, userPhone, ticket.contact_type === 'telegram' ? ticket.contact : null);
      registerReferredUser(result.lastInsertRowid, cleanReferralCode);
      awardDailyLoginCoins(result.lastInsertRowid);
      ensureReferralCode(result.lastInsertRowid);
      return result.lastInsertRowid;
    });
    const userId = create();
    const user = db().prepare('SELECT _id AS id, username, email, full_name, role, position, phone, is_active FROM users WHERE _id = ?').get(userId);
    const token = jwt.sign(
      { id: String(user.id), email: user.email, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    json(res, { user, token }, 201);
  } catch (error) {
    if ([400, 403, 409].includes(error.status)) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    if (String(error.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ success: false, message: 'That username or email is already registered.' });
    }
    next(error);
  }
};

export const getFeed = (req, res, next) => {
  try {
    const userId = currentId(req);
    const posts = db().prepare(`
      SELECT p.post_id, p.user_id, p.content, p.product_name, p.product_price, p.product_url, p.product_image,
        p.location, p.mentions, p.hashtags, p.tagged_friends, p.repost_of, p.visibility, p.created_at,
        original.content AS original_content, original.product_name AS original_product_name,
        original.product_price AS original_product_price, original.product_url AS original_product_url,
        original.product_image AS original_product_image,
        original_user.username AS original_username,
        COALESCE(u.username, 'Member') AS username, COALESCE(u.full_name, u.username, 'Member') AS full_name,
        u.position, u.role,
        EXISTS(SELECT 1 FROM social_presence presence
          WHERE presence.user_id = CAST(u._id AS TEXT)
            AND presence.last_seen >= datetime('now', '-90 seconds')) AS is_online,
        (SELECT COUNT(*) FROM social_post_likes l WHERE l.post_id = p.post_id) AS likes,
        EXISTS(SELECT 1 FROM social_post_likes l WHERE l.post_id = p.post_id AND l.user_id = ?) AS liked,
        (SELECT COUNT(*) FROM social_post_shares s WHERE s.post_id = p.post_id) AS shares,
        (SELECT COUNT(*) FROM social_post_comments c WHERE c.post_id = p.post_id) AS comments,
        (SELECT COUNT(*) FROM social_follows f WHERE f.follower_id = ? AND f.followed_id = p.user_id) AS following,
        EXISTS(SELECT 1 FROM boost_requests b WHERE b.post_id = p.post_id AND b.status = 'approved') AS boosted
      FROM social_posts p LEFT JOIN users u ON CAST(u._id AS TEXT) = p.user_id
      LEFT JOIN social_posts original ON original.post_id = p.repost_of
      LEFT JOIN users original_user ON CAST(original_user._id AS TEXT) = original.user_id
      WHERE (p.user_id = ? OR p.visibility = 'public' OR p.visibility = 'friends' AND EXISTS (
        SELECT 1 FROM social_follows mine
        JOIN social_follows theirs ON theirs.follower_id = mine.followed_id AND theirs.followed_id = mine.follower_id
        WHERE mine.follower_id = ? AND mine.followed_id = p.user_id
      ))
      AND p.moderation_status = 'active' AND COALESCE(u.social_banned, 0) = 0
      AND (p.repost_of IS NULL OR original.post_id IS NOT NULL AND (
        original.moderation_status = 'active' AND COALESCE(original_user.social_banned, 0) = 0
        AND (original.user_id = ? OR original.visibility = 'public' OR original.visibility = 'friends' AND EXISTS (
          SELECT 1 FROM social_follows mine
          JOIN social_follows theirs ON theirs.follower_id = mine.followed_id AND theirs.followed_id = mine.follower_id
          WHERE mine.follower_id = ? AND mine.followed_id = original.user_id
        ))
      ))
      ORDER BY boosted DESC, p.created_at DESC LIMIT 100
    `).all(userId, userId, userId, userId, userId, userId);
    json(res, posts);
  } catch (error) { next(error); }
};

export const getRootFeedManagement = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const posts = db().prepare(`
      SELECT p.post_id, p.user_id, p.content, p.product_name, p.product_price, p.product_url, p.product_image,
        p.location, p.mentions, p.hashtags, p.tagged_friends, p.repost_of, p.visibility, p.moderation_status, p.moderation_reason, p.moderated_at, p.created_at,
        COALESCE(u.username, 'Unavailable account') AS username,
        COALESCE(u.full_name, u.username, 'Unavailable account') AS full_name,
        u.email, u.role, u.position, u.is_active, u.social_restricted, u.social_restriction_reason,
        u.social_banned, u.social_ban_reason,
        (SELECT COUNT(*) FROM social_post_reports r WHERE r.post_id = p.post_id AND r.status = 'open') AS open_report_count,
        (SELECT COUNT(*) FROM social_post_likes l WHERE l.post_id = p.post_id) AS likes,
        (SELECT COUNT(*) FROM social_post_comments c WHERE c.post_id = p.post_id) AS comments
      FROM social_posts p
      LEFT JOIN users u ON CAST(u._id AS TEXT) = p.user_id
      ORDER BY CASE WHEN p.moderation_status = 'hidden' THEN 0 ELSE 1 END, p.created_at DESC
      LIMIT 200
    `).all();
    const reports = db().prepare(`
      SELECT r.report_id, r.post_id, r.reporter_user_id, r.reason, r.details, r.status,
        r.review_reason, r.reviewed_at, r.created_at,
        reporter.username AS reporter_username,
        COALESCE(reporter.full_name, reporter.username, 'Unavailable account') AS reporter_name,
        p.user_id AS poster_user_id, COALESCE(poster.username, 'Unavailable account') AS poster_username,
        COALESCE(poster.full_name, poster.username, 'Unavailable account') AS poster_name,
        p.content, p.product_name, p.moderation_status
      FROM social_post_reports r
      LEFT JOIN social_posts p ON p.post_id = r.post_id
      LEFT JOIN users reporter ON CAST(reporter._id AS TEXT) = r.reporter_user_id
      LEFT JOIN users poster ON CAST(poster._id AS TEXT) = p.user_id
      ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC
      LIMIT 500
    `).all();
    json(res, { posts, reports });
  } catch (error) { next(error); }
};

export const getRootStories = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const stories = db().prepare(`
      SELECT s.story_id, s.user_id, s.body, s.image_data, s.cover_color, s.created_at, s.expires_at,
        COALESCE(u.username, 'Unavailable account') AS username,
        COALESCE(u.full_name, u.username, 'Unavailable account') AS full_name,
        (SELECT COUNT(*) FROM social_story_likes l WHERE l.story_id = s.story_id) AS likes,
        (SELECT COUNT(*) FROM social_story_comments c WHERE c.story_id = s.story_id) AS comments,
        (SELECT COUNT(*) FROM social_story_shares sh WHERE sh.story_id = s.story_id) AS shares
      FROM social_stories s
      LEFT JOIN users u ON CAST(u._id AS TEXT) = s.user_id
      WHERE s.expires_at > CURRENT_TIMESTAMP
      ORDER BY s.created_at DESC
      LIMIT 200
    `).all();
    json(res, stories);
  } catch (error) { next(error); }
};

export const removeRootStory = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const storyId = String(req.params.storyId || '');
    const reason = String(req.body?.reason || '').trim();
    if (!validText(reason, 500)) {
      return res.status(400).json({ success: false, message: 'Provide a removal reason of up to 500 characters.' });
    }
    const story = db().prepare('SELECT story_id, user_id FROM social_stories WHERE story_id = ?').get(storyId);
    if (!story) return res.status(404).json({ success: false, message: 'Story not found.' });

    const remove = db().transaction(() => {
      for (const table of ['social_story_likes', 'social_story_comments', 'social_story_shares']) {
        db().prepare(`DELETE FROM ${table} WHERE story_id = ?`).run(storyId);
      }
      const result = db().prepare('DELETE FROM social_stories WHERE story_id = ?').run(storyId);
      if (result.changes !== 1) return false;
      db().prepare(`
        INSERT INTO social_story_moderation_log
          (moderation_id, story_id, target_user_id, moderator_user_id, action, reason)
        VALUES (?, ?, ?, ?, 'remove', ?)
      `).run(randomUUID(), storyId, story.user_id, currentId(req), reason);
      notify(story.user_id, currentId(req), 'content_moderation', `Your story was removed. Reason: ${reason}`, '/feed');
      return true;
    });
    if (!remove()) return res.status(404).json({ success: false, message: 'Story not found.' });
    json(res, { storyId, action: 'remove', reason });
  } catch (error) { next(error); }
};

export const reportPost = (req, res, next) => {
  try {
    const postId = String(req.params.postId || '');
    const reporterId = currentId(req);
    const reason = String(req.body?.reason || '').trim();
    const details = String(req.body?.details || '').trim();
    const allowedReasons = ['spam', 'harassment', 'hate', 'scam', 'misinformation', 'inappropriate', 'other'];
    const post = db().prepare('SELECT post_id, user_id, visibility, repost_of FROM social_posts WHERE post_id = ?').get(postId);
    if (!post || !canViewPost(reporterId, post)) {
      return res.status(404).json({ success: false, message: 'Post not found.' });
    }
    if (post.user_id === reporterId) {
      return res.status(400).json({ success: false, message: 'You cannot report your own post.' });
    }
    if (!allowedReasons.includes(reason) || details.length > 500) {
      return res.status(400).json({ success: false, message: 'Choose a report reason and keep additional details under 500 characters.' });
    }
    const reportId = randomUUID();
    try {
      db().prepare(`
        INSERT INTO social_post_reports (report_id, post_id, reporter_user_id, reason, details)
        VALUES (?, ?, ?, ?, ?)
      `).run(reportId, postId, reporterId, reason, details || null);
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) {
        return res.status(409).json({ success: false, message: 'You have already reported this post.' });
      }
      throw error;
    }
    json(res, { reportId, status: 'open' }, 201);
  } catch (error) { next(error); }
};

export const moderateRootPost = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const postId = String(req.params.postId || '');
    const action = String(req.body?.action || '');
    const reason = String(req.body?.reason || '').trim();
    const allowedActions = ['hide', 'restore', 'restrict', 'unrestrict', 'ban', 'unban'];
    if (!allowedActions.includes(action) || !validText(reason, 500)) {
      return res.status(400).json({ success: false, message: 'Choose a valid moderation action and provide a reason of up to 500 characters.' });
    }
    const post = db().prepare(`
      SELECT p.post_id, p.user_id, p.moderation_status, u.username, u.is_active, u.social_restricted, u.social_banned,
        u.social_ban_previous_active
      FROM social_posts p LEFT JOIN users u ON CAST(u._id AS TEXT) = p.user_id
      WHERE p.post_id = ?
    `).get(postId);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });
    if (['restrict', 'unrestrict', 'ban', 'unban'].includes(action) && !post.username) {
      return res.status(404).json({ success: false, message: 'The poster account could not be found.' });
    }
    if ((action === 'hide' && post.moderation_status === 'hidden') ||
        (action === 'restore' && post.moderation_status !== 'hidden') ||
        (action === 'restrict' && post.social_restricted) ||
        (action === 'unrestrict' && !post.social_restricted) ||
        (action === 'ban' && post.social_banned) ||
        (action === 'unban' && !post.social_banned)) {
      return res.status(409).json({ success: false, message: 'That moderation action does not match the current post or account status.' });
    }

    const moderatorId = currentId(req);
    const moderationId = randomUUID();
    const update = db().transaction(() => {
      if (action === 'hide' || action === 'restore') {
        db().prepare(`
          UPDATE social_posts
          SET moderation_status = ?, moderation_reason = ?, moderated_by = ?, moderated_at = CURRENT_TIMESTAMP
          WHERE post_id = ?
        `).run(action === 'hide' ? 'hidden' : 'active', action === 'hide' ? reason : null,
          moderatorId, postId);
      } else if (action === 'restrict') {
        db().prepare(`
          UPDATE users SET social_restricted = 1, social_restriction_reason = ?, updated_at = CURRENT_TIMESTAMP
          WHERE CAST(_id AS TEXT) = ?
        `).run(reason, post.user_id);
      } else if (action === 'unrestrict') {
        db().prepare(`
          UPDATE users SET social_restricted = 0, social_restriction_reason = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE CAST(_id AS TEXT) = ?
        `).run(post.user_id);
      } else if (action === 'ban') {
        db().prepare(`
          UPDATE users
          SET social_banned = 1, social_ban_reason = ?, social_ban_previous_active = is_active,
            is_active = 0, updated_at = CURRENT_TIMESTAMP
          WHERE CAST(_id AS TEXT) = ?
        `).run(reason, post.user_id);
      } else {
        db().prepare(`
          UPDATE users
          SET social_banned = 0, social_ban_reason = NULL, is_active = social_ban_previous_active,
            social_ban_previous_active = 1, updated_at = CURRENT_TIMESTAMP
          WHERE CAST(_id AS TEXT) = ?
        `).run(post.user_id);
      }

      db().prepare(`
        INSERT INTO social_moderation_log (moderation_id, post_id, target_user_id, moderator_user_id, action, reason)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(moderationId, postId, post.user_id, moderatorId, action, reason);

      if (['hide', 'restrict', 'ban'].includes(action)) {
        db().prepare(`
          UPDATE social_post_reports
          SET status = 'actioned', reviewed_by = ?, review_reason = ?, reviewed_at = CURRENT_TIMESTAMP
          WHERE post_id = ? AND status = 'open'
        `).run(moderatorId, reason, postId);
      }
      const actionLabel = {
        hide: 'hidden', restore: 'restored', restrict: 'restricted from social publishing',
        unrestrict: 'restored to social publishing', ban: 'banned', unban: 'unbanned'
      }[action];
      notify(post.user_id, moderatorId, 'content_moderation', `Your post/account was ${actionLabel}. Reason: ${reason}`, '/feed');
    });
    update();
    json(res, { postId, userId: post.user_id, action, reason });
  } catch (error) { next(error); }
};

export const updateRootPostReport = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const status = String(req.body?.status || '');
    const reason = String(req.body?.reason || '').trim();
    if (!['actioned', 'dismissed'].includes(status) || !validText(reason, 500)) {
      return res.status(400).json({ success: false, message: 'Choose actioned or dismissed and provide a review reason of up to 500 characters.' });
    }
    const result = db().prepare(`
      UPDATE social_post_reports
      SET status = ?, reviewed_by = ?, review_reason = ?, reviewed_at = CURRENT_TIMESTAMP
      WHERE report_id = ? AND status = 'open'
    `).run(status, currentId(req), reason, String(req.params.reportId || ''));
    if (result.changes !== 1) return res.status(404).json({ success: false, message: 'Open report not found.' });
    json(res, { reportId: req.params.reportId, status, reason });
  } catch (error) { next(error); }
};

export const createPost = (req, res, next) => {
  try {
    const userId = currentId(req);
    const writeError = socialWriteError(userId);
    if (writeError) return res.status(403).json({ success: false, message: writeError });
    const content = String(req.body?.content || '').trim();
    const productName = String(req.body?.productName || '').trim();
    const productUrl = String(req.body?.productUrl || '').trim();
    const productImage = req.body?.productImage == null || req.body.productImage === '' ? null : req.body.productImage;
    const price = req.body?.productPrice == null || req.body.productPrice === '' ? null : Number(req.body.productPrice);
    const visibility = req.body?.visibility || 'public';
    const location = String(req.body?.location || '').trim().slice(0, 160);
    const rawMentions = Array.isArray(req.body?.mentions) ? req.body.mentions : normalizeJsonList(String(req.body?.mentions || ''));
    const rawHashtags = Array.isArray(req.body?.hashtags) ? req.body.hashtags : normalizeJsonList(String(req.body?.hashtags || ''));
    const rawTaggedFriends = Array.isArray(req.body?.taggedFriends) ? req.body.taggedFriends : normalizeJsonList(String(req.body?.taggedFriends || ''));
    const mentions = normalizeTagList(rawMentions).map(name => name.replace(/^@/, '').trim()).filter(Boolean).slice(0, 25);
    const hashtags = normalizeTagList(rawHashtags).map(tag => tag.replace(/^#/, '').trim()).filter(Boolean).slice(0, 25);
    const taggedFriends = normalizeTagList(rawTaggedFriends).map(value => value.replace(/^@/, '').trim()).filter(Boolean).slice(0, 25);
    const mentionFromContent = extractMentions(content);
    const hashtagFromContent = extractHashtags(content);
    const effectiveMentions = [...new Set([...mentions, ...mentionFromContent])].slice(0, 25);
    const effectiveHashtags = [...new Set([...hashtags, ...hashtagFromContent])].slice(0, 25);
    const mentionUserIds = resolveUserIdsByUsernames(effectiveMentions);
    const taggedFriendIds = resolveUserIdsByUsernames(taggedFriends);
    if ((!content && !productName) || content.length > 2000 || productName.length > 160 ||
        location.length > 160 ||
        (price !== null && (!Number.isFinite(price) || price < 0)) || productUrl.length > 500 ||
        (productUrl && !/^https?:\/\//i.test(productUrl)) ||
        (productImage !== null && (typeof productImage !== 'string' || productImage.length > 1800000 ||
          !/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(productImage))) ||
        !['public', 'friends', 'private'].includes(visibility)) {
      return res.status(400).json({ success: false, message: 'Enter a post or product with valid details.' });
    }
    const postId = randomUUID();
    const create = db().transaction(() => {
      db().prepare(`
      INSERT INTO social_posts (post_id, user_id, content, product_name, product_price, product_url, product_image, location, mentions, hashtags, tagged_friends, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(postId, userId, content, productName || null, price, productUrl || null, productImage, location, JSON.stringify(effectiveMentions), JSON.stringify(effectiveHashtags), JSON.stringify(taggedFriends), visibility);
      const followers = db().prepare(`
        SELECT f.follower_id FROM social_follows f
        WHERE f.followed_id = ? AND (? = 'public' OR ? = 'friends' AND EXISTS (
          SELECT 1 FROM social_follows reciprocal
          WHERE reciprocal.follower_id = ? AND reciprocal.followed_id = f.follower_id
        ))
      `).all(userId, visibility, visibility, userId);
      followers.forEach(follower => notify(follower.follower_id, userId, 'new_post', 'Someone you follow published a post.', '/feed'));
      notifyMentionTargets(userId, mentionUserIds, postId, 'mention');
      notifyMentionTargets(userId, taggedFriendIds, postId, 'tagged_friend');
    });
    create();
    const created = db().prepare('SELECT * FROM social_posts WHERE post_id = ?').get(postId);
    json(res, created, 201);
  } catch (error) { next(error); }
};

export const deletePost = (req, res, next) => {
  try {
    const postId = req.params.postId;
    const userId = currentId(req);
    const post = db().prepare('SELECT post_id, user_id FROM social_posts WHERE post_id = ?').get(postId);
    if (!post || post.user_id !== userId) {
      return res.status(404).json({ success: false, message: 'Post not found.' });
    }

    const deleteTree = db().transaction(() => {
      const postIds = db().prepare(`
        WITH RECURSIVE post_tree(post_id) AS (
          SELECT post_id FROM social_posts WHERE post_id = ?
          UNION ALL
          SELECT child.post_id FROM social_posts child
          JOIN post_tree parent ON child.repost_of = parent.post_id
        )
        SELECT post_id FROM post_tree
      `).all(postId).map(item => item.post_id);
      const placeholders = postIds.map(() => '?').join(', ');
      for (const table of ['social_post_likes', 'social_post_shares', 'social_post_comments']) {
        db().prepare(`DELETE FROM ${table} WHERE post_id IN (${placeholders})`).run(...postIds);
      }
      db().prepare(`DELETE FROM social_posts WHERE post_id IN (${placeholders})`).run(...postIds);
      return postIds;
    });
    const deletedPostIds = deleteTree();
    json(res, { deleted: true, postIds: deletedPostIds });
  } catch (error) { next(error); }
};

export const likePost = (req, res, next) => {
  try {
    const { postId } = req.params;
    const userId = currentId(req);
    const post = db().prepare('SELECT post_id, user_id, visibility, repost_of FROM social_posts WHERE post_id = ?').get(postId);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });
    if (!canViewPost(userId, post)) return res.status(404).json({ success: false, message: 'Post not found.' });
    const exists = db().prepare('SELECT 1 FROM social_post_likes WHERE post_id = ? AND user_id = ?').get(postId, userId);
    if (exists) db().prepare('DELETE FROM social_post_likes WHERE post_id = ? AND user_id = ?').run(postId, userId);
    else {
      db().prepare('INSERT INTO social_post_likes (post_id, user_id) VALUES (?, ?)').run(postId, userId);
      if (post.user_id !== userId) notify(post.user_id, userId, 'like', 'Someone liked your post.', '/feed');
    }
    const likes = db().prepare('SELECT COUNT(*) AS count FROM social_post_likes WHERE post_id = ?').get(postId).count;
    json(res, { liked: !exists, likes });
  } catch (error) { next(error); }
};

export const getPostComments = (req, res, next) => {
  try {
    const post = db().prepare('SELECT post_id, user_id, visibility, repost_of FROM social_posts WHERE post_id = ?').get(req.params.postId);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });
    if (!canViewPost(currentId(req), post)) return res.status(404).json({ success: false, message: 'Post not found.' });
    const comments = db().prepare(`
      SELECT c.comment_id, c.post_id, c.user_id, c.body, c.created_at,
        COALESCE(u.username, 'Member') AS username,
        COALESCE(u.full_name, u.username, 'Member') AS full_name
      FROM social_post_comments c
      LEFT JOIN users u ON CAST(u._id AS TEXT) = c.user_id
      WHERE c.post_id = ?
      ORDER BY c.created_at ASC LIMIT 200
    `).all(req.params.postId);
    json(res, comments);
  } catch (error) { next(error); }
};

export const createPostComment = (req, res, next) => {
  try {
    const writeError = socialWriteError(currentId(req));
    if (writeError) return res.status(403).json({ success: false, message: writeError });
    const post = db().prepare('SELECT post_id, user_id, visibility, repost_of FROM social_posts WHERE post_id = ?').get(req.params.postId);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });
    if (!canViewPost(currentId(req), post)) return res.status(404).json({ success: false, message: 'Post not found.' });
    const body = String(req.body?.body || '').trim();
    if (!validText(body, 1000)) return res.status(400).json({ success: false, message: 'Comments must contain up to 1,000 characters.' });
    const commentId = randomUUID();
    db().prepare('INSERT INTO social_post_comments (comment_id, post_id, user_id, body) VALUES (?, ?, ?, ?)')
      .run(commentId, post.post_id, currentId(req), body);
    if (post.user_id !== currentId(req)) {
      notify(post.user_id, currentId(req), 'comment', 'Someone commented on your post.', `/feed?post=${encodeURIComponent(post.post_id)}`);
    }
    const comment = db().prepare(`
      SELECT c.comment_id, c.post_id, c.user_id, c.body, c.created_at,
        COALESCE(u.username, 'Member') AS username,
        COALESCE(u.full_name, u.username, 'Member') AS full_name
      FROM social_post_comments c LEFT JOIN users u ON CAST(u._id AS TEXT) = c.user_id
      WHERE c.comment_id = ?
    `).get(commentId);
    json(res, comment, 201);
  } catch (error) { next(error); }
};

export const sharePost = (req, res, next) => {
  try {
    const userId = currentId(req);
    const { postId } = req.params;
    const post = db().prepare('SELECT post_id, user_id, visibility, repost_of FROM social_posts WHERE post_id = ?').get(postId);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });
    if (!canViewPost(userId, post)) return res.status(404).json({ success: false, message: 'Post not found.' });
    const transaction = db().transaction(() => {
      const shared = db().prepare('INSERT OR IGNORE INTO social_post_shares (post_id, user_id) VALUES (?, ?)').run(postId, userId);
      const role = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(userId))?.role;
      const rates = roleRates(role);
      if (shared.changes === 1) {
        const rewarded = creditPlatformReward(userId, rates.share_reward, 'share_reward', `share:${postId}:${userId}`, 'Reward for sharing a post');
        if (rewarded) notify(userId, null, 'share_reward', `Your ${rates.share_reward.toFixed(2)} post-share reward was added to your wallet.`, '/wallet');
        const coinRewarded = creditCoins(userId, rates.coin_share_reward, 'coin_share_reward', `coin-share:${postId}:${userId}`, 'Coins for sharing a post');
        if (coinRewarded) notify(userId, null, 'coin_reward', `🎉 You received ${rates.coin_share_reward} coins for sharing a post.`, '/wallet');
        if (post.user_id !== userId) notify(post.user_id, userId, 'share', 'Someone shared your post.', '/feed');
      }
      return shared.changes === 1;
    });
    json(res, { shared: transaction() });
  } catch (error) { next(error); }
};

export const getStories = (req, res, next) => {
  try {
    const userId = currentId(req);
    const stories = db().prepare(`
      SELECT s.story_id, s.user_id, s.body, s.image_data, s.cover_color, s.created_at, s.expires_at,
        COALESCE(u.username, 'Member') AS username,
        COALESCE(u.full_name, u.username, 'Member') AS full_name,
        (SELECT COUNT(*) FROM social_story_likes l WHERE l.story_id = s.story_id) AS likes,
        EXISTS(SELECT 1 FROM social_story_likes l WHERE l.story_id = s.story_id AND l.user_id = ?) AS liked,
        (SELECT COUNT(*) FROM social_story_comments c WHERE c.story_id = s.story_id) AS comments,
        (SELECT COUNT(*) FROM social_story_shares sh WHERE sh.story_id = s.story_id) AS shares
      FROM social_stories s
      LEFT JOIN users u ON CAST(u._id AS TEXT) = s.user_id
      WHERE s.expires_at > CURRENT_TIMESTAMP AND COALESCE(u.social_banned, 0) = 0
      ORDER BY s.created_at DESC LIMIT 100
    `).all(userId);
    json(res, stories);
  } catch (error) { next(error); }
};

export const createStory = (req, res, next) => {
  try {
    const writeError = socialWriteError(currentId(req));
    if (writeError) return res.status(403).json({ success: false, message: writeError });
    const body = String(req.body?.body || '').trim();
    const coverColor = String(req.body?.coverColor || '#8b0000');
    const imageData = req.body?.imageData || null;
    if (body.length > 500 || (!body && !imageData)) {
      return res.status(400).json({ success: false, message: 'Add story text or a cover photo (up to 500 characters).' });
    }
    if (!/^#[0-9a-f]{6}$/i.test(coverColor)) {
      return res.status(400).json({ success: false, message: 'Choose a valid story background color.' });
    }
    if (imageData !== null && (
      typeof imageData !== 'string' ||
      imageData.length > 1800000 ||
      !/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i.test(imageData)
    )) {
      return res.status(400).json({ success: false, message: 'Choose a valid image smaller than 1.3 MB.' });
    }
    const storyId = randomUUID();
    db().prepare(`
      INSERT INTO social_stories (story_id, user_id, body, image_data, cover_color, expires_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+24 hours'))
    `).run(storyId, currentId(req), body, imageData, coverColor);
    const story = db().prepare(`
      SELECT s.story_id, s.user_id, s.body, s.image_data, s.cover_color, s.created_at, s.expires_at,
        COALESCE(u.username, 'Member') AS username,
        COALESCE(u.full_name, u.username, 'Member') AS full_name,
        0 AS likes, 0 AS liked, 0 AS comments, 0 AS shares
      FROM social_stories s LEFT JOIN users u ON CAST(u._id AS TEXT) = s.user_id
      WHERE s.story_id = ?
    `).get(storyId);
    json(res, story, 201);
  } catch (error) { next(error); }
};

export const likeStory = (req, res, next) => {
  try {
    const story = db().prepare('SELECT story_id, user_id FROM social_stories WHERE story_id = ? AND expires_at > CURRENT_TIMESTAMP')
      .get(req.params.storyId);
    if (!story) return res.status(404).json({ success: false, message: 'Story not found or expired.' });
    const userId = currentId(req);
    const exists = db().prepare('SELECT 1 FROM social_story_likes WHERE story_id = ? AND user_id = ?')
      .get(story.story_id, userId);
    if (exists) db().prepare('DELETE FROM social_story_likes WHERE story_id = ? AND user_id = ?').run(story.story_id, userId);
    else {
      db().prepare('INSERT INTO social_story_likes (story_id, user_id) VALUES (?, ?)').run(story.story_id, userId);
      if (story.user_id !== userId) notify(story.user_id, userId, 'story_like', 'Someone liked your story.', '/feed');
    }
    const likes = db().prepare('SELECT COUNT(*) AS count FROM social_story_likes WHERE story_id = ?').get(story.story_id).count;
    json(res, { liked: !exists, likes });
  } catch (error) { next(error); }
};

export const getStoryComments = (req, res, next) => {
  try {
    const story = db().prepare('SELECT story_id FROM social_stories WHERE story_id = ? AND expires_at > CURRENT_TIMESTAMP')
      .get(req.params.storyId);
    if (!story) return res.status(404).json({ success: false, message: 'Story not found or expired.' });
    const comments = db().prepare(`
      SELECT c.comment_id, c.story_id, c.user_id, c.body, c.created_at,
        COALESCE(u.username, 'Member') AS username,
        COALESCE(u.full_name, u.username, 'Member') AS full_name
      FROM social_story_comments c LEFT JOIN users u ON CAST(u._id AS TEXT) = c.user_id
      WHERE c.story_id = ? ORDER BY c.created_at ASC LIMIT 200
    `).all(story.story_id);
    json(res, comments);
  } catch (error) { next(error); }
};

export const createStoryComment = (req, res, next) => {
  try {
    const writeError = socialWriteError(currentId(req));
    if (writeError) return res.status(403).json({ success: false, message: writeError });
    const story = db().prepare('SELECT story_id, user_id FROM social_stories WHERE story_id = ? AND expires_at > CURRENT_TIMESTAMP')
      .get(req.params.storyId);
    if (!story) return res.status(404).json({ success: false, message: 'Story not found or expired.' });
    const body = String(req.body?.body || '').trim();
    if (!validText(body, 1000)) return res.status(400).json({ success: false, message: 'Comments must contain up to 1,000 characters.' });
    const commentId = randomUUID();
    db().prepare('INSERT INTO social_story_comments (comment_id, story_id, user_id, body) VALUES (?, ?, ?, ?)')
      .run(commentId, story.story_id, currentId(req), body);
    if (story.user_id !== currentId(req)) notify(story.user_id, currentId(req), 'story_comment', 'Someone commented on your story.', '/feed');
    const comment = db().prepare(`
      SELECT c.comment_id, c.story_id, c.user_id, c.body, c.created_at,
        COALESCE(u.username, 'Member') AS username,
        COALESCE(u.full_name, u.username, 'Member') AS full_name
      FROM social_story_comments c LEFT JOIN users u ON CAST(u._id AS TEXT) = c.user_id
      WHERE c.comment_id = ?
    `).get(commentId);
    json(res, comment, 201);
  } catch (error) { next(error); }
};

export const shareStory = (req, res, next) => {
  try {
    const story = db().prepare('SELECT story_id, user_id FROM social_stories WHERE story_id = ? AND expires_at > CURRENT_TIMESTAMP')
      .get(req.params.storyId);
    if (!story) return res.status(404).json({ success: false, message: 'Story not found or expired.' });
    const result = db().prepare('INSERT OR IGNORE INTO social_story_shares (story_id, user_id) VALUES (?, ?)')
      .run(story.story_id, currentId(req));
    if (result.changes && story.user_id !== currentId(req)) {
      notify(story.user_id, currentId(req), 'story_share', 'Someone shared your story.', '/feed');
    }
    json(res, { shared: true });
  } catch (error) { next(error); }
};

export const repostPost = (req, res, next) => {
  try {
    const writeError = socialWriteError(currentId(req));
    if (writeError) return res.status(403).json({ success: false, message: writeError });
    const sourceId = req.params.postId;
    const source = db().prepare('SELECT * FROM social_posts WHERE post_id = ?').get(sourceId);
    if (!source) return res.status(404).json({ success: false, message: 'Post not found.' });
    const userId = currentId(req);
    if (!canViewPost(userId, source)) return res.status(404).json({ success: false, message: 'Post not found.' });
    if (source.visibility !== 'public') {
      return res.status(403).json({ success: false, message: 'Only public posts can be reposted.' });
    }
    const repostId = randomUUID();
    db().prepare(`
      INSERT INTO social_posts (post_id, user_id, content, repost_of, visibility)
      VALUES (?, ?, ?, ?, ?)
    `).run(repostId, userId, String(req.body?.comment || '').trim().slice(0, 1000), sourceId, source.visibility);
    notify(source.user_id, userId, 'repost', 'Someone reposted your post.', '/feed');
    json(res, { postId: repostId }, 201);
  } catch (error) { next(error); }
};

export const getPersonProfile = (req, res, next) => {
  try {
    const viewerId = currentId(req);
    const numericUserId = Number(req.params.userId);
    if (!Number.isSafeInteger(numericUserId) || numericUserId < 1) {
      return res.status(404).json({ success: false, message: 'Profile not found.' });
    }
    const profile = db().prepare(`
      SELECT CAST(u._id AS TEXT) AS user_id, u.username, COALESCE(u.full_name, u.username) AS full_name,
        u.position, u.role, u.created_at,
        EXISTS(SELECT 1 FROM social_presence presence
          WHERE presence.user_id = CAST(u._id AS TEXT)
            AND presence.last_seen >= datetime('now', '-90 seconds')) AS is_online,
        (SELECT COUNT(*) FROM social_posts p WHERE p.user_id = CAST(u._id AS TEXT)) AS post_count,
        (SELECT COUNT(*) FROM social_follows f
          WHERE f.followed_id = CAST(u._id AS TEXT)
            AND EXISTS (SELECT 1 FROM social_follows reciprocal
              WHERE reciprocal.follower_id = CAST(u._id AS TEXT) AND reciprocal.followed_id = f.follower_id)
        ) AS friend_count,
        EXISTS(SELECT 1 FROM social_follows f WHERE f.follower_id = ? AND f.followed_id = CAST(u._id AS TEXT)) AS following,
        EXISTS(SELECT 1 FROM social_follows mine
          JOIN social_follows theirs ON theirs.follower_id = mine.followed_id AND theirs.followed_id = mine.follower_id
          WHERE mine.follower_id = ? AND mine.followed_id = CAST(u._id AS TEXT)) AS is_friend
      FROM users u WHERE u._id = ? AND u.is_active = 1
    `).get(viewerId, viewerId, numericUserId);
    if (!profile) return res.status(404).json({ success: false, message: 'Profile not found.' });
    const posts = db().prepare(`
      SELECT p.post_id, p.user_id, p.content, p.product_name, p.product_price, p.product_url, p.product_image,
        p.location, p.mentions, p.hashtags, p.tagged_friends, p.repost_of, p.visibility, p.created_at,
        original.content AS original_content, original.product_name AS original_product_name,
        original.product_image AS original_product_image, original_user.username AS original_username,
        COALESCE(u.username, 'Member') AS username, COALESCE(u.full_name, u.username, 'Member') AS full_name,
        u.position, u.role,
        EXISTS(SELECT 1 FROM social_presence presence
          WHERE presence.user_id = CAST(u._id AS TEXT)
            AND presence.last_seen >= datetime('now', '-90 seconds')) AS is_online,
        (SELECT COUNT(*) FROM social_post_likes l WHERE l.post_id = p.post_id) AS likes,
        EXISTS(SELECT 1 FROM social_post_likes l WHERE l.post_id = p.post_id AND l.user_id = ?) AS liked,
        (SELECT COUNT(*) FROM social_post_shares s WHERE s.post_id = p.post_id) AS shares,
        (SELECT COUNT(*) FROM social_post_comments c WHERE c.post_id = p.post_id) AS comments,
        (SELECT COUNT(*) FROM social_follows f WHERE f.follower_id = ? AND f.followed_id = p.user_id) AS following,
        EXISTS(SELECT 1 FROM boost_requests b WHERE b.post_id = p.post_id AND b.status = 'approved') AS boosted
      FROM social_posts p
      LEFT JOIN users u ON CAST(u._id AS TEXT) = p.user_id
      LEFT JOIN social_posts original ON original.post_id = p.repost_of
      LEFT JOIN users original_user ON CAST(original_user._id AS TEXT) = original.user_id
      WHERE p.user_id = ?
        AND (p.user_id = ? OR p.visibility = 'public' OR p.visibility = 'friends' AND EXISTS (
          SELECT 1 FROM social_follows mine
          JOIN social_follows theirs ON theirs.follower_id = mine.followed_id AND theirs.followed_id = mine.follower_id
          WHERE mine.follower_id = ? AND mine.followed_id = p.user_id
        ))
        AND p.moderation_status = 'active' AND COALESCE(u.social_banned, 0) = 0
        AND (p.repost_of IS NULL OR original.post_id IS NOT NULL AND (
          original.moderation_status = 'active' AND COALESCE(original_user.social_banned, 0) = 0
          AND (original.user_id = ? OR original.visibility = 'public' OR original.visibility = 'friends' AND EXISTS (
            SELECT 1 FROM social_follows mine
            JOIN social_follows theirs ON theirs.follower_id = mine.followed_id AND theirs.followed_id = mine.follower_id
            WHERE mine.follower_id = ? AND mine.followed_id = original.user_id
          ))
        ))
      ORDER BY p.created_at DESC
      LIMIT 50
    `).all(viewerId, viewerId, profile.user_id, viewerId, viewerId, viewerId, viewerId);
    json(res, { ...profile, posts });
  } catch (error) { next(error); }
};

export const getPeople = (req, res, next) => {
  try {
    const userId = currentId(req);
    const query = String(req.query.q || '').trim().slice(0, 80);
    const people = db().prepare(`
      SELECT CAST(u._id AS TEXT) AS user_id, u.username, COALESCE(u.full_name, u.username) AS full_name,
        COALESCE(NULLIF(TRIM(u.role), ''), 'user') AS role,
        u.is_active, u.created_at,
        EXISTS(SELECT 1 FROM social_presence presence
          WHERE presence.user_id = CAST(u._id AS TEXT)
            AND presence.last_seen >= datetime('now', '-90 seconds')) AS is_online,
        EXISTS(SELECT 1 FROM social_follows f WHERE f.follower_id = ? AND f.followed_id = CAST(u._id AS TEXT)) AS following,
        (SELECT status FROM social_friend_requests r WHERE r.requester_id = ? AND r.recipient_id = CAST(u._id AS TEXT)) AS sent_request,
        (SELECT status FROM social_friend_requests r WHERE r.requester_id = CAST(u._id AS TEXT) AND r.recipient_id = ?) AS received_request
      FROM users u WHERE CAST(u._id AS TEXT) <> ?
        AND (? = '' OR u.username LIKE ? OR COALESCE(u.full_name, '') LIKE ?
          OR COALESCE(NULLIF(TRIM(u.role), ''), 'user') LIKE ?)
      ORDER BY u.username
    `).all(
      userId, userId, userId, userId, query,
      `%${query}%`, `%${query}%`, `%${query}%`
    );
    json(res, people);
  } catch (error) { next(error); }
};

export const followPerson = (req, res, next) => {
  try {
    const follower = currentId(req);
    const followed = String(req.params.userId);
    if (follower === followed) return res.status(400).json({ success: false, message: 'You cannot follow your own account.' });
    const user = db().prepare('SELECT username FROM users WHERE _id = ? AND is_active = 1').get(Number(followed));
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });
    const followedResult = db().prepare('INSERT OR IGNORE INTO social_follows (follower_id, followed_id) VALUES (?, ?)').run(follower, followed);
    if (followedResult.changes === 1) notify(followed, follower, 'follow', 'Someone started following you.', '/friends');
    json(res, { following: true });
  } catch (error) { next(error); }
};

export const unfollowPerson = (req, res, next) => {
  try {
    db().prepare('DELETE FROM social_follows WHERE follower_id = ? AND followed_id = ?').run(currentId(req), String(req.params.userId));
    json(res, { following: false });
  } catch (error) { next(error); }
};

export const getFriends = (req, res, next) => {
  try {
    const userId = currentId(req);
    const following = db().prepare(`
      SELECT f.followed_id AS user_id, u.username, COALESCE(u.full_name, u.username) AS full_name, u.role,
        EXISTS(SELECT 1 FROM social_presence presence
          WHERE presence.user_id = f.followed_id
            AND presence.last_seen >= datetime('now', '-90 seconds')) AS is_online
      FROM social_follows f JOIN users u ON CAST(u._id AS TEXT) = f.followed_id
      WHERE f.follower_id = ? ORDER BY u.username
    `).all(userId);
    const followers = db().prepare(`
      SELECT f.follower_id AS user_id, u.username, COALESCE(u.full_name, u.username) AS full_name, u.role,
        EXISTS(SELECT 1 FROM social_presence presence
          WHERE presence.user_id = f.follower_id
            AND presence.last_seen >= datetime('now', '-90 seconds')) AS is_online
      FROM social_follows f JOIN users u ON CAST(u._id AS TEXT) = f.follower_id
      WHERE f.followed_id = ? ORDER BY u.username
    `).all(userId);
    const requests = db().prepare(`
      SELECT r.request_id, r.requester_id AS user_id, u.username, COALESCE(u.full_name, u.username) AS full_name,
        u.role, r.created_at,
        EXISTS(SELECT 1 FROM social_presence presence
          WHERE presence.user_id = r.requester_id
            AND presence.last_seen >= datetime('now', '-90 seconds')) AS is_online
      FROM social_friend_requests r JOIN users u ON CAST(u._id AS TEXT) = r.requester_id
      WHERE r.recipient_id = ? AND r.status = 'pending' ORDER BY r.created_at DESC
    `).all(userId);
    const sent = db().prepare(`
      SELECT r.request_id, r.recipient_id AS user_id, u.username, COALESCE(u.full_name, u.username) AS full_name,
        u.role, r.status,
        EXISTS(SELECT 1 FROM social_presence presence
          WHERE presence.user_id = r.recipient_id
            AND presence.last_seen >= datetime('now', '-90 seconds')) AS is_online
      FROM social_friend_requests r JOIN users u ON CAST(u._id AS TEXT) = r.recipient_id
      WHERE r.requester_id = ? AND r.status = 'pending' ORDER BY r.created_at DESC
    `).all(userId);
    json(res, { following, followers, requests, sent });
  } catch (error) { next(error); }
};

export const requestFriend = (req, res, next) => {
  try {
    const requester = currentId(req);
    const recipient = String(req.params.userId);
    if (requester === recipient) return res.status(400).json({ success: false, message: 'You cannot add yourself.' });
    const recipientUser = db().prepare('SELECT username FROM users WHERE _id = ? AND is_active = 1').get(Number(recipient));
    if (!recipientUser) return res.status(404).json({ success: false, message: 'Account not found.' });
    const friendRequest = {
      requestId: randomUUID(),
      requester,
      recipient,
      status: 'pending',
    };
    db().prepare(`
      INSERT INTO social_friend_requests (request_id, requester_id, recipient_id, status)
      VALUES (?, ?, ?, 'pending')
      ON CONFLICT(requester_id, recipient_id) DO UPDATE SET request_id = excluded.request_id, status = 'pending', updated_at = CURRENT_TIMESTAMP
    `).run(friendRequest.requestId, requester, recipient);
    notify(recipient, requester, 'friend_request', 'You received a friend request.', '/friends');
    json(res, { sent: true }, 201);
  } catch (error) { next(error); }
};

export const respondFriendRequest = (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!['accepted', 'declined'].includes(status)) return res.status(400).json({ success: false, message: 'Choose accepted or declined.' });
    const request = db().prepare('SELECT * FROM social_friend_requests WHERE request_id = ? AND recipient_id = ? AND status = ?')
      .get(req.params.requestId, currentId(req), 'pending');
    if (!request) return res.status(404).json({ success: false, message: 'Friend request not found.' });
    const transaction = db().transaction(() => {
      db().prepare('UPDATE social_friend_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE request_id = ?')
        .run(status, request.request_id);
      if (status === 'accepted') {
        db().prepare('INSERT OR IGNORE INTO social_follows (follower_id, followed_id) VALUES (?, ?), (?, ?)')
          .run(request.requester_id, request.recipient_id, request.recipient_id, request.requester_id);
        notify(request.requester_id, request.recipient_id, 'friend_accepted', 'Your friend request was accepted.', '/friends');
      }
    });
    transaction();
    json(res, { status });
  } catch (error) { next(error); }
};

export const getMessages = (req, res, next) => {
  try {
    const me = currentId(req);
    const other = String(req.query.userId || '');
    if (!other || other === me) return res.status(400).json({ success: false, message: 'Choose another account to message.' });
    const isFollowing = db().prepare('SELECT 1 FROM social_follows WHERE follower_id = ? AND followed_id = ?').get(me, other);
    const isFollowed = db().prepare('SELECT 1 FROM social_follows WHERE follower_id = ? AND followed_id = ?').get(other, me);
    const existingConversation = db().prepare(`
      SELECT 1 FROM social_messages
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
      LIMIT 1
    `).get(me, other, other, me);
    if (!isRoot(req.user) && !isFollowing && !isFollowed && !existingConversation) {
      return res.status(403).json({ success: false, message: 'Follow this account before messaging.' });
    }
    const queryMessages = (afterMessage = null) => db().prepare(`
      SELECT m.rowid AS message_order, m.message_id, m.sender_id, m.recipient_id,
        CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body,
        m.caption, m.type, m.created_at, m.read_at, m.edited_at, m.deleted_at,
        m.reply_to_message_id, m.forwarded_from_message_id,
        reply.sender_id AS reply_sender_id,
        CASE WHEN reply.deleted_at IS NULL THEN reply.body ELSE '' END AS reply_body,
        reply.type AS reply_type, reply.caption AS reply_caption, reply.deleted_at AS reply_deleted_at,
        COALESCE(reply_user.full_name, reply_user.username, 'Member') AS reply_sender_name,
        COALESCE(forward_user.full_name, forward_user.username, 'Member') AS forwarded_from_name,
        COALESCE(u.username, 'Member') AS sender_name
      FROM social_messages m
      LEFT JOIN users u ON CAST(u._id AS TEXT) = m.sender_id
      LEFT JOIN social_messages reply ON reply.message_id = m.reply_to_message_id
      LEFT JOIN users reply_user ON CAST(reply_user._id AS TEXT) = reply.sender_id
      LEFT JOIN social_messages forwarded ON forwarded.message_id = m.forwarded_from_message_id
      LEFT JOIN users forward_user ON CAST(forward_user._id AS TEXT) = forwarded.sender_id
      WHERE ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
        AND (? IS NULL OR m.rowid > ?)
      ORDER BY m.rowid DESC LIMIT 200
    `).all(
      me, other, other, me,
      afterMessage?.message_order || null,
      afterMessage?.message_order || null,
    ).reverse();
    const afterId = String(req.query.after || '');
    const afterMessage = afterId
      ? db().prepare(`
        SELECT rowid AS message_order FROM social_messages
        WHERE message_id = ?
          AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
      `).get(afterId, me, other, other, me) || null
      : null;
    const conversation = queryMessages(afterMessage);
    db().prepare('UPDATE social_messages SET read_at = CURRENT_TIMESTAMP WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL')
      .run(other, me);
    json(res, conversation);
  } catch (error) { next(error); }
};

export const sendMessage = (req, res, next) => {
  try {
    const sender = currentId(req);
    const recipient = String(req.body?.recipientId || '');
    const type = req.body?.type || 'text';
    const rawBody = typeof req.body?.body === 'string' ? req.body.body : '';
    const body = type === 'text' ? rawBody.trim() : rawBody;
    const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim() : '';
    const replyToMessageId = typeof req.body?.replyToMessageId === 'string' ? req.body.replyToMessageId : null;
    const allowedTypes = ['text', 'image', 'voice', 'call-offer', 'call-answer', 'call-end'];
    const validBody = type === 'text'
      ? validText(body, 2000)
      : type === 'image'
        ? /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(body) &&
          body.length <= 8 * 1024 * 1024 && caption.length <= 1000
      : type === 'voice'
        ? /^data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(body) && body.length <= 8 * 1024 * 1024
        : ['call-offer', 'call-answer', 'call-end'].includes(type) &&
          body.length <= 100000 && isValidCallSignal(type, body);
    if (!recipient || recipient === sender || !allowedTypes.includes(type) || !validBody ||
      (type !== 'image' && caption) || (replyToMessageId && !db().prepare(`
        SELECT 1 FROM social_messages
        WHERE message_id = ? AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
      `).get(replyToMessageId, sender, recipient, recipient, sender))) {
      return res.status(400).json({ success: false, message: 'Enter a valid text, image, voice, or call message.' });
    }
    const canMessage = db().prepare(`
      SELECT 1 FROM social_follows WHERE (follower_id = ? AND followed_id = ?) OR (follower_id = ? AND followed_id = ?)
    `).get(sender, recipient, recipient, sender);
    const existingConversation = db().prepare(`
      SELECT 1 FROM social_messages
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
      LIMIT 1
    `).get(sender, recipient, recipient, sender);
    if (!isRoot(req.user) && !canMessage && !existingConversation) {
      return res.status(403).json({ success: false, message: 'Follow this account before messaging.' });
    }
    if (type !== 'text') {
      const recipientExists = db().prepare('SELECT 1 FROM users WHERE CAST(_id AS TEXT) = ? AND is_active = 1').get(recipient);
      if (!recipientExists) return res.status(404).json({ success: false, message: 'Account not found.' });
    }
    const messageId = randomUUID();
    db().prepare(`INSERT INTO social_messages
      (message_id, sender_id, recipient_id, body, type, caption, reply_to_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(messageId, sender, recipient, body, type, type === 'image' ? caption : null, replyToMessageId);
    if (type === 'text' || type === 'image' || type === 'voice' || type === 'call-offer') {
      const notification = type === 'voice'
        ? 'You received a voice message.'
        : type === 'image'
          ? 'You received an image message.'
        : type === 'call-offer'
          ? 'You received an incoming call.'
          : 'You received a new message.';
      notify(recipient, sender, 'message', notification, '/friends');
    }
    json(res, { messageId }, 201);
  } catch (error) { next(error); }
};

export const updateMessage = (req, res, next) => {
  try {
    const messageId = String(req.params.messageId || '');
    const sender = currentId(req);
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim() : '';
    const message = db().prepare(`
      SELECT message_id, type, body, caption, created_at, deleted_at
      FROM social_messages WHERE message_id = ? AND sender_id = ?
    `).get(messageId, sender);
    if (!message || message.deleted_at) {
      return res.status(404).json({ success: false, message: 'Message not found.' });
    }
    const ageDays = db().prepare(`SELECT julianday('now') - julianday(?) AS ageDays`).get(message.created_at).ageDays;
    if (ageDays < 0 || ageDays > 15) {
      return res.status(403).json({ success: false, message: 'Messages can only be edited within 15 days of sending.' });
    }
    if (message.type === 'text' && !validText(body, 2000)) {
      return res.status(400).json({ success: false, message: 'Text messages must contain up to 2,000 characters.' });
    }
    if (message.type === 'image' && caption.length > 1000) {
      return res.status(400).json({ success: false, message: 'Image captions must be 1,000 characters or fewer.' });
    }
    if (!['text', 'image'].includes(message.type)) {
      return res.status(400).json({ success: false, message: 'Only text and image captions can be edited.' });
    }
    db().prepare('UPDATE social_messages SET body = ?, caption = ?, edited_at = CURRENT_TIMESTAMP WHERE message_id = ?')
      .run(message.type === 'text' ? body : message.body, message.type === 'image' ? caption : null, messageId);
    json(res, { updated: true });
  } catch (error) { next(error); }
};

export const deleteMessage = (req, res, next) => {
  try {
    const messageId = String(req.params.messageId || '');
    const result = db().prepare(`
      UPDATE social_messages SET deleted_at = CURRENT_TIMESTAMP, body = '', caption = NULL
      WHERE message_id = ? AND sender_id = ? AND deleted_at IS NULL AND type != 'coin-gift'
    `).run(messageId, currentId(req));
    if (!result.changes) return res.status(404).json({ success: false, message: 'Message not found.' });
    json(res, { deleted: true });
  } catch (error) { next(error); }
};

export const forwardMessage = (req, res, next) => {
  try {
    const sender = currentId(req);
    const recipient = String(req.body?.recipientId || '');
    const sourceId = String(req.params.messageId || '');
    if (!recipient || recipient === sender) {
      return res.status(400).json({ success: false, message: 'Choose another account to receive the forwarded message.' });
    }
    const source = db().prepare(`
      SELECT message_id, body, type, caption, deleted_at FROM social_messages
      WHERE message_id = ? AND (sender_id = ? OR recipient_id = ?)
    `).get(sourceId, sender, sender);
    if (!source || source.deleted_at || !['text', 'image', 'voice'].includes(source.type)) {
      return res.status(404).json({ success: false, message: 'That message cannot be forwarded.' });
    }
    const allowed = isRoot(req.user) || db().prepare(`
      SELECT 1 FROM social_follows WHERE (follower_id = ? AND followed_id = ?) OR (follower_id = ? AND followed_id = ?)
    `).get(sender, recipient, recipient, sender) || db().prepare(`
      SELECT 1 FROM social_messages
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    `).get(sender, recipient, recipient, sender);
    if (!allowed) return res.status(403).json({ success: false, message: 'Follow this account before messaging.' });
    const messageId = randomUUID();
    db().prepare(`INSERT INTO social_messages
      (message_id, sender_id, recipient_id, body, type, caption, forwarded_from_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(messageId, sender, recipient, source.body, source.type, source.caption, source.message_id);
    notify(recipient, sender, 'message', 'You received a forwarded message.', '/friends');
    json(res, { messageId }, 201);
  } catch (error) { next(error); }
};

export const updatePresence = (req, res, next) => {
  try {
    db().prepare(`
      INSERT INTO social_presence (user_id, last_seen) VALUES (?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET last_seen = CURRENT_TIMESTAMP
    `).run(currentId(req));
    json(res, { online: true });
  } catch (error) { next(error); }
};

export const getSupportPresence = (req, res, next) => {
  try {
    const online = !!db().prepare(`
      SELECT 1 FROM social_presence presence
      JOIN users u ON CAST(u._id AS TEXT) = presence.user_id
      WHERE LOWER(u.role) IN ('admin', 'root')
        AND u.is_active = 1
        AND presence.last_seen >= datetime('now', '-90 seconds')
      LIMIT 1
    `).get();
    json(res, { online });
  } catch (error) { next(error); }
};

export const getRootMessageUsers = (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim().slice(0, 80);
    const role = String(req.query.role || '').trim().toLowerCase().slice(0, 40);
    const users = db().prepare(`
      SELECT CAST(u._id AS TEXT) AS user_id, u.username,
        COALESCE(u.full_name, u.username) AS full_name, u.role,
        EXISTS(SELECT 1 FROM social_presence presence
          WHERE presence.user_id = CAST(u._id AS TEXT)
            AND presence.last_seen >= datetime('now', '-90 seconds')) AS is_online
      FROM users u
      WHERE u.is_active = 1
        AND CAST(u._id AS TEXT) <> ?
        AND (? = '' OR u.username LIKE ? OR u.full_name LIKE ? OR u.email LIKE ?)
        AND (? = '' OR LOWER(u.role) LIKE ?)
      ORDER BY u.username LIMIT 100
    `).all(currentId(req), query, `%${query}%`, `%${query}%`, `%${query}%`, role, `%${role}%`);
    json(res, users);
  } catch (error) { next(error); }
};

export const getRootUserThreads = (req, res, next) => {
  try {
    const userId = String(req.params.userId || '');
    if (!/^\d+$/.test(userId)) return res.status(400).json({ success: false, message: 'Choose a valid account.' });
    const threads = db().prepare(`
      SELECT CAST(other._id AS TEXT) AS user_id, other.username,
        COALESCE(other.full_name, other.username) AS full_name, other.role,
        (SELECT CASE
            WHEN latest.type = 'voice' THEN 'Voice message'
            WHEN latest.type LIKE 'call-%' THEN 'Call'
            ELSE latest.body
          END FROM social_messages latest
          WHERE ((latest.sender_id = ? AND latest.recipient_id = CAST(other._id AS TEXT))
            OR (latest.sender_id = CAST(other._id AS TEXT) AND latest.recipient_id = ?))
          ORDER BY latest.created_at DESC LIMIT 1) AS last_message,
        (SELECT MAX(created_at) FROM social_messages latest
          WHERE (latest.sender_id = ? AND latest.recipient_id = CAST(other._id AS TEXT))
            OR (latest.sender_id = CAST(other._id AS TEXT) AND latest.recipient_id = ?)) AS updated_at,
        EXISTS(SELECT 1 FROM social_presence presence
          WHERE presence.user_id = CAST(other._id AS TEXT)
            AND presence.last_seen >= datetime('now', '-90 seconds')) AS is_online
      FROM users other
      WHERE other.is_active = 1 AND CAST(other._id AS TEXT) <> ?
        AND (
          EXISTS(SELECT 1 FROM social_messages m
            WHERE (m.sender_id = ? AND m.recipient_id = CAST(other._id AS TEXT))
               OR (m.sender_id = CAST(other._id AS TEXT) AND m.recipient_id = ?))
          OR EXISTS(SELECT 1 FROM social_follows f
            WHERE (f.follower_id = ? AND f.followed_id = CAST(other._id AS TEXT))
               OR (f.follower_id = CAST(other._id AS TEXT) AND f.followed_id = ?))
        )
      ORDER BY updated_at DESC LIMIT 100
    `).all(userId, userId, userId, userId, userId, userId, userId, userId, userId);
    json(res, threads);
  } catch (error) { next(error); }
};

export const getRootMessageConversation = (req, res, next) => {
  try {
    const userId = String(req.query.userId || '');
    const otherUserId = String(req.query.otherUserId || '');
    if (!/^\d+$/.test(userId) || !/^\d+$/.test(otherUserId) || userId === otherUserId) {
      return res.status(400).json({ success: false, message: 'Choose two valid accounts.' });
    }
    const messages = db().prepare(`
      SELECT m.message_id, m.sender_id, m.recipient_id, m.body, m.type, m.created_at, m.read_at,
        COALESCE(sender.username, 'Member') AS sender_name
      FROM social_messages m
      LEFT JOIN users sender ON CAST(sender._id AS TEXT) = m.sender_id
      WHERE (m.sender_id = ? AND m.recipient_id = ?)
         OR (m.sender_id = ? AND m.recipient_id = ?)
      ORDER BY m.created_at ASC LIMIT 200
    `).all(userId, otherUserId, otherUserId, userId);
    json(res, messages);
  } catch (error) { next(error); }
};

export const sendRootMessage = (req, res, next) => {
  try {
    const sender = currentId(req);
    const recipient = String(req.body?.recipientId || '');
    const body = String(req.body?.body || '').trim();
    if (!/^\d+$/.test(recipient) || recipient === sender || !validText(body, 2000)) {
      return res.status(400).json({ success: false, message: 'Enter a recipient and message (up to 2,000 characters).' });
    }
    const user = db().prepare('SELECT 1 FROM users WHERE _id = ? AND is_active = 1').get(Number(recipient));
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });
    const messageId = randomUUID();
    db().prepare('INSERT INTO social_messages (message_id, sender_id, recipient_id, body) VALUES (?, ?, ?, ?)')
      .run(messageId, sender, recipient, body);
    notify(recipient, sender, 'message', 'You received a new message from support.', '/friends');
    json(res, { messageId }, 201);
  } catch (error) { next(error); }
};

export const getInbox = (req, res, next) => {
  try {
    const userId = currentId(req);
    const inbox = db().prepare(`
      SELECT m.message_id, m.sender_id, m.recipient_id,
        CASE WHEN m.deleted_at IS NOT NULL THEN 'This message was deleted.'
             WHEN m.type = 'voice' THEN 'Voice message'
             WHEN m.type = 'image' THEN COALESCE(NULLIF(m.caption, ''), 'Image')
             WHEN m.type = 'coin-gift' THEN '🎁 Coin gift'
             ELSE m.body END AS body,
        m.type, m.created_at, m.read_at,
        CASE WHEN m.type = 'coin-gift' THEN m.body END AS gift_details,
        COALESCE(u.username, 'Member') AS sender_name
      FROM social_messages m LEFT JOIN users u ON CAST(u._id AS TEXT) = m.sender_id
      WHERE m.recipient_id = ? ORDER BY m.created_at DESC LIMIT 100
    `).all(userId);
    json(res, inbox);
  } catch (error) { next(error); }
};

export const getSocialUnreadCounts = (req, res, next) => {
  try {
    const userId = currentId(req);
    const unreadMessages = db().prepare(
      'SELECT COUNT(*) AS count FROM social_messages WHERE recipient_id = ? AND read_at IS NULL'
    ).get(userId).count;
    const unreadNotifications = db().prepare(
      'SELECT COUNT(*) AS count FROM social_notifications WHERE user_id = ? AND read_at IS NULL'
    ).get(userId).count;
    json(res, { messages: Number(unreadMessages), notifications: Number(unreadNotifications) });
  } catch (error) { next(error); }
};

export const getNotifications = (req, res, next) => {
  try {
    const userId = currentId(req);
    const notifications = db().prepare(`
      SELECT n.notification_id, n.actor_id, n.type, n.message, n.link, n.created_at, n.read_at,
        COALESCE(u.username, 'REDSEA') AS actor_name
      FROM social_notifications n LEFT JOIN users u ON CAST(u._id AS TEXT) = n.actor_id
      WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100
    `).all(userId);
    json(res, notifications);
  } catch (error) { next(error); }
};

export const markNotificationsRead = (req, res, next) => {
  try {
    db().prepare('UPDATE social_notifications SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL').run(currentId(req));
    json(res, { read: true });
  } catch (error) { next(error); }
};

export const getWallet = (req, res, next) => {
  try {
    const userId = currentId(req);
    const user = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(userId));
    const rates = roleRates(user?.role);
    awardDailyLoginCoins(userId);
    settleMaturedCoinSavings(userId);
    const rows = db().prepare('SELECT * FROM wallet_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId);
    const balances = db().prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN balance_type = 'real' THEN amount ELSE 0 END), 0) AS realBalance,
        COALESCE(SUM(CASE WHEN balance_type = 'bonus' THEN amount ELSE 0 END), 0) AS bonusBalance
      FROM wallet_ledger WHERE user_id = ?
    `).get(userId);
    const coinRows = db().prepare('SELECT * FROM wallet_coin_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId);
    const withdrawals = db().prepare(`
      SELECT withdrawal_id, user_id, amount, payout_details, balance_type,
             transaction_reference, status, created_at, updated_at,
             CASE WHEN receipt_file IS NULL OR receipt_file = '' THEN 0 ELSE 1 END AS receipt_available
      FROM wallet_withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 30
    `).all(userId);
    const pendingWithdrawals = db().prepare("SELECT COALESCE(SUM(amount), 0) AS amount FROM wallet_withdrawals WHERE user_id = ? AND balance_type = 'real' AND status IN ('pending', 'approved')").get(userId).amount;
    const pendingAgentWithdrawals = db().prepare("SELECT COALESCE(SUM(amount), 0) AS amount FROM agent_wallet_requests WHERE user_id = ? AND request_type = 'withdrawal' AND status = 'pending'").get(userId).amount;
    const pendingBonusWithdrawals = db().prepare("SELECT COALESCE(SUM(amount), 0) AS amount FROM wallet_withdrawals WHERE user_id = ? AND balance_type = 'bonus' AND status IN ('pending', 'approved')").get(userId).amount;
    const deposits = db().prepare('SELECT * FROM wallet_deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(userId);
    const coinSavings = db().prepare(`
      SELECT deposit_id, principal, daily_rate_percent, duration_days, expected_interest,
        maturity_at, status, created_at, settled_at
      FROM wallet_coin_savings WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(userId);
    json(res, {
      balance: balances.realBalance + balances.bonusBalance,
      realBalance: balances.realBalance,
      bonusBalance: balances.bonusBalance,
      coinBalance: coinBalance(userId),
      availableBalance: Math.max(0, balances.realBalance - pendingWithdrawals - pendingAgentWithdrawals),
      availableBonusBalance: Math.max(0, balances.bonusBalance - pendingBonusWithdrawals),
      currency: rates.currency,
      entries: rows,
      coinEntries: coinRows,
      settings: rates,
      withdrawals,
      deposits,
      coinSavings,
      referralCode: ensureReferralCode(userId)
    });
  } catch (error) { next(error); }
};

export const createCoinSavings = (req, res, next) => {
  try {
    const userId = currentId(req);
    const user = db().prepare('SELECT role FROM users WHERE CAST(_id AS TEXT) = ?').get(userId);
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });
    const rates = roleRates(user.role);
    const amount = Number(req.body?.amount);
    const durationDays = Number(req.body?.durationDays);
    const allowedDurations = new Set([1, 7, 30, 90, 180, 365]);
    if (!Number.isSafeInteger(amount) || amount < rates.min_coin_savings_deposit ||
      amount > rates.max_coin_savings_deposit || !allowedDurations.has(durationDays)) {
      return res.status(400).json({ success: false, message: `Enter a whole-coin amount from ${rates.min_coin_savings_deposit} to ${rates.max_coin_savings_deposit} and choose a supported savings term.` });
    }
    if (!(Number(rates.coin_savings_daily_rate) > 0)) {
      return res.status(403).json({ success: false, message: 'Coin savings is not enabled for your account role.' });
    }

    const depositId = randomUUID();
    const dailyRate = Number(rates.coin_savings_daily_rate);
    const expectedInterest = Math.floor(amount * dailyRate / 100 * durationDays + Number.EPSILON);
    if (!Number.isSafeInteger(expectedInterest) || !Number.isSafeInteger(amount + expectedInterest)) {
      return res.status(400).json({ success: false, message: 'The requested deposit and interest exceed the supported coin balance.' });
    }
    const maturityAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    const create = db().transaction(() => {
      if (coinBalance(userId) < amount) return false;
      if (!creditCoins(
        userId,
        -amount,
        'coin_savings_deposit',
        `coin-savings:${depositId}:principal-lock`,
        `Locked ${amount} coins for ${durationDays} days`
      )) throw new Error('Could not lock coins for this savings deposit.');
      db().prepare(`
        INSERT INTO wallet_coin_savings (
          deposit_id, user_id, principal, daily_rate_percent, duration_days, expected_interest, maturity_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(depositId, userId, amount, dailyRate, durationDays, expectedInterest, maturityAt);
      return true;
    });
    if (!create()) return res.status(409).json({ success: false, message: 'Your available coin balance is too low for this deposit.' });
    json(res, db().prepare('SELECT * FROM wallet_coin_savings WHERE deposit_id = ?').get(depositId), 201);
  } catch (error) { next(error); }
};

export const getMyWalletActivity = (req, res, next) => {
  try {
    const userId = currentId(req);
    awardDailyLoginCoins(userId);
    const asset = String(req.query?.asset || 'all');
    const search = String(req.query?.search || '').trim();
    const page = Number.parseInt(req.query?.page, 10) || 1;
    const pageSize = 25;
    if (!['all', 'real', 'bonus', 'coin'].includes(asset) ||
      search.length > 120 || !Number.isSafeInteger(page) || page < 1 || page > 100000) {
      return res.status(400).json({ success: false, message: 'Choose a valid activity filter and page.' });
    }
    const conditions = ['user_id = ?'];
    const params = [userId];
    if (asset === 'coin') conditions.push("asset = 'coin'");
    else if (asset === 'real' || asset === 'bonus') {
      conditions.push("asset = 'ETB' AND bucket = ?");
      params.push(asset);
    }
    if (search) {
      const term = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push("(entry_type LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      params.push(term, term);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const activity = `
      WITH activity AS (
        SELECT entry_id AS id, user_id, amount, 'ETB' AS asset, balance_type AS bucket,
          currency, entry_type, description, created_at
        FROM wallet_ledger WHERE user_id = ?
        UNION ALL
        SELECT entry_id AS id, user_id, amount, 'coin' AS asset, 'coin' AS bucket,
          'COIN' AS currency, entry_type, description, created_at
        FROM wallet_coin_ledger WHERE user_id = ?
      )
    `;
    const allParams = [userId, userId, ...params];
    const total = db().prepare(`${activity} SELECT COUNT(*) AS total FROM activity ${where}`)
      .get(...allParams).total;
    const summary = db().prepare(`
      ${activity}
      SELECT COUNT(*) AS transaction_count,
        COALESCE(SUM(CASE WHEN asset = 'coin' AND amount > 0 THEN amount ELSE 0 END), 0) AS coins_earned,
        COALESCE(SUM(CASE WHEN asset = 'coin' AND amount < 0 THEN -amount ELSE 0 END), 0) AS coins_spent,
        COALESCE(SUM(CASE WHEN asset = 'ETB' AND amount > 0 THEN amount ELSE 0 END), 0) AS etb_credited,
        COALESCE(SUM(CASE WHEN asset = 'ETB' AND amount < 0 THEN -amount ELSE 0 END), 0) AS etb_debited,
        COALESCE(SUM(CASE WHEN asset = 'ETB' AND bucket = 'bonus' AND amount > 0 THEN amount ELSE 0 END), 0) AS bonus_earned,
        COALESCE(SUM(CASE WHEN asset = 'ETB' AND bucket = 'real' AND amount > 0 THEN amount ELSE 0 END), 0) AS real_credited
      FROM activity ${where}
    `).get(...allParams);
    const entries = db().prepare(`
      ${activity}
      SELECT * FROM activity ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...allParams, pageSize, (page - 1) * pageSize);
    json(res, { entries, total, page, pageSize, summary });
  } catch (error) { next(error); }
};

export const createDeposit = (req, res, next) => {
  try {
    const userId = currentId(req);
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const paymentMethod = String(req.body?.paymentMethod || '').trim();
    const paymentReference = String(req.body?.paymentReference || '').trim();
    const role = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(userId))?.role;
    const settings = roleRates(role);
    if (!Number.isFinite(amount) || amount < settings.min_deposit || amount > settings.max_deposit ||
        !validText(paymentMethod, 80) || !validText(paymentReference, 250)) {
      return res.status(400).json({ success: false, message: `Enter a deposit between ${settings.min_deposit} and ${settings.max_deposit} ${settings.currency}, with a payment method and transaction reference.` });
    }
    const depositId = randomUUID();
    db().prepare(`
      INSERT INTO wallet_deposits (deposit_id, user_id, amount, payment_method, payment_reference)
      VALUES (?, ?, ?, ?, ?)
    `).run(depositId, userId, amount, paymentMethod, paymentReference);
    json(res, { depositId, amount, status: 'pending' }, 201);
  } catch (error) { next(error); }
};

export const createWithdrawal = (req, res, next) => {
  try {
    const userId = currentId(req);
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const payoutDetails = String(req.body?.payoutDetails || '').trim();
    const transactionReference = String(req.body?.transactionReference || '').trim();
    const receiptFile = String(req.body?.receiptFile || '');
    const balanceType = String(req.body?.balanceType || 'real');
    const role = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(userId))?.role;
    const settings = roleRates(role);
    const minimum = balanceType === 'bonus' ? settings.min_bonus_withdrawal : settings.min_withdrawal;
    const maximum = balanceType === 'bonus' ? settings.max_bonus_withdrawal : settings.max_withdrawal;
    const withdrawalId = randomUUID();
    if (!['real', 'bonus'].includes(balanceType) || !Number.isFinite(amount) || amount <= 0 || amount < minimum || amount > maximum ||
        !validText(payoutDetails, 500) || !validText(transactionReference, 250)) {
      return res.status(400).json({ success: false, message: `Enter a ${balanceType === 'bonus' ? 'bonus' : 'real'}-balance withdrawal between ${minimum} and ${maximum} ${settings.currency}, with payout details and a transaction ID.` });
    }
    if (receiptFile && (!/^data:(?:image\/(?:png|jpeg|webp)|application\/pdf);base64,[A-Za-z0-9+/]+=*$/.test(receiptFile)
      || receiptFile.length > 8_000_000)) {
      return res.status(400).json({ success: false, message: 'Receipt must be a PNG, JPEG, WebP, or PDF file no larger than 6 MB.' });
    }
    const create = db().transaction(() => {
      const available = db().prepare(`
        SELECT COALESCE(SUM(l.amount), 0) -
          COALESCE((SELECT SUM(w.amount) FROM wallet_withdrawals w
            WHERE w.user_id = ? AND w.balance_type = ? AND w.status IN ('pending', 'approved')), 0) -
          COALESCE((SELECT SUM(r.amount) FROM agent_wallet_requests r
            WHERE r.user_id = ? AND r.request_type = 'withdrawal' AND r.status = 'pending' AND ? = 'real'), 0) AS available
        FROM wallet_ledger l WHERE l.user_id = ? AND l.balance_type = ?
      `).get(userId, balanceType, userId, balanceType, userId, balanceType).available;
      if (amount > available) throw new Error(`Withdrawal amount exceeds your available ${balanceType} balance.`);
      db().prepare(`INSERT INTO wallet_withdrawals
        (withdrawal_id, user_id, amount, payout_details, balance_type, transaction_reference, receipt_file)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(withdrawalId, userId, amount, payoutDetails, balanceType, transactionReference, receiptFile || null);
    });
    create();
    json(res, { withdrawalId, amount, balanceType, status: 'pending' }, 201);
  } catch (error) {
    if (error.message.startsWith('Withdrawal amount exceeds your available ')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

export const sendCoinGift = (req, res, next) => {
  try {
    const senderId = currentId(req);
    const recipientUsername = String(req.body?.recipientUsername || '').trim();
    const amount = Number(req.body?.amount);
    const recipient = db().prepare('SELECT CAST(_id AS TEXT) AS user_id, username FROM users WHERE lower(username) = lower(?)').get(recipientUsername);
    if (!recipient || String(recipient.user_id) === senderId) {
      return res.status(400).json({ success: false, message: 'Choose a different, existing friend by username.' });
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Enter a positive whole-number coin gift.' });
    }
    if (!hasFollowConnection(senderId, recipient.user_id)) {
      return res.status(403).json({ success: false, message: 'Follow this account or have them follow you before sending a coin gift.' });
    }
    const role = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(recipient.user_id))?.role;
    const rewardSettings = roleRates(role);
    const giftBonus = Math.floor(amount * Number(rewardSettings.coin_gift_bonus_percent) / 100);
    const receiveReward = Number(rewardSettings.coin_gift_receive_reward);
    const giftReference = randomUUID();
    const giftMessageId = randomUUID();
    const sendGift = db().transaction(() => {
      if (coinBalance(senderId) < amount) throw new Error('Not enough coins for this gift.');
      creditCoins(senderId, -amount, 'coin_gift_sent', `gift-sent:${giftReference}`, `Gift sent to @${recipient.username}`);
      creditCoins(recipient.user_id, amount, 'coin_gift_received', `gift-received:${giftReference}`, `Gift received from @${req.user.username || 'friend'}`);
      creditCoins(recipient.user_id, giftBonus, 'coin_gift_bonus', `gift-bonus:${giftReference}`, 'Gift percentage bonus');
      creditCoins(recipient.user_id, receiveReward, 'coin_gift_receive_reward', `gift-reward:${giftReference}`, 'Platform coin reward for receiving a gift');
      db().prepare(`
        INSERT INTO social_messages (message_id, sender_id, recipient_id, body, type)
        VALUES (?, ?, ?, ?, 'coin-gift')
      `).run(giftMessageId, senderId, recipient.user_id, JSON.stringify({
        amount,
        giftBonus: giftBonus + receiveReward,
      }));
      notify(recipient.user_id, senderId, 'coin_gift', `🎁 You received ${amount} coins from @${req.user.username || 'a friend'}${giftBonus || receiveReward ? `, plus ${giftBonus + receiveReward} bonus coins` : ''}!`, '/wallet');
      notify(senderId, recipient.user_id, 'coin_gift_sent', `🎁 Your ${amount}-coin gift was sent to @${recipient.username}.`, '/wallet');
    });
    sendGift();
    json(res, {
      giftMessageId,
      recipient: recipient.username,
      amount,
      giftBonus: giftBonus + receiveReward,
      senderCoinBalance: coinBalance(senderId),
    });
  } catch (error) {
    if (error.message === 'Not enough coins for this gift.') {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

export const convertCoinsToEtb = (req, res, next) => {
  try {
    const userId = currentId(req);
    const amount = Number(req.body?.amount);
    const userRole = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(userId))?.role;
    const settings = roleRates(userRole);
    if (!Number.isSafeInteger(amount) || amount < settings.min_coin_conversion || amount > settings.max_coin_conversion) {
      return res.status(400).json({ success: false, message: `Enter a whole coin amount between ${settings.min_coin_conversion} and ${settings.max_coin_conversion}.` });
    }
    const etb = Math.round((amount / settings.coin_per_etb) * 100) / 100;
    if (etb <= 0) return res.status(400).json({ success: false, message: 'This coin amount is below the smallest convertible ETB amount.' });
    const reference = randomUUID();
    const convert = db().transaction(() => {
      if (coinBalance(userId) < amount) throw new Error('Not enough coins for this conversion.');
      creditCoins(userId, -amount, 'coin_conversion', `coin-convert:${reference}`, `Converted ${amount} coins to ${etb.toFixed(2)} ${settings.currency}`);
      creditWallet(userId, etb, 'coin_conversion', `etb-convert:${reference}`, `Converted ${amount} coins to ETB`);
      notify(userId, null, 'coin_conversion', `Converted ${amount} coins to ${etb.toFixed(2)} ${settings.currency}.`, '/wallet');
    });
    convert();
    json(res, { coins: amount, amount: etb, currency: settings.currency });
  } catch (error) {
    if (error.message === 'Not enough coins for this conversion.') {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

export const convertEtbToCoins = (req, res, next) => {
  try {
    const userId = currentId(req);
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const userRole = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(userId))?.role;
    const settings = roleRates(userRole);
    const coins = Math.round(amount * settings.coin_per_etb);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(coins) ||
        coins < settings.min_coin_conversion || coins > settings.max_coin_conversion) {
      return res.status(400).json({ success: false, message: `Enter an ETB amount that converts to between ${settings.min_coin_conversion} and ${settings.max_coin_conversion} coins.` });
    }
    const reference = randomUUID();
    const convert = db().transaction(() => {
      const available = db().prepare(`
        SELECT COALESCE(SUM(amount), 0) -
          COALESCE((SELECT SUM(amount) FROM wallet_withdrawals WHERE user_id = ? AND balance_type = 'real' AND status IN ('pending', 'approved')), 0) -
          COALESCE((SELECT SUM(amount) FROM agent_wallet_requests
            WHERE user_id = ? AND request_type = 'withdrawal' AND status = 'pending'), 0) AS balance
        FROM wallet_ledger WHERE user_id = ? AND balance_type = 'real'
      `).get(userId, userId, userId).balance;
      if (available < amount) throw new Error('Not enough real ETB balance to buy coins.');
      creditWallet(userId, -amount, 'etb_to_coin', `coin-purchase:${reference}`, `Exchanged ${amount.toFixed(2)} ETB for ${coins} coins`);
      creditCoins(userId, coins, 'coin_purchase', `coin-purchase:${reference}`, `Bought ${coins} coins with ETB`);
      notify(userId, null, 'coin_purchase', `Bought ${coins} coins for ${amount.toFixed(2)} ${settings.currency}.`, '/wallet');
    });
    convert();
    json(res, { amount, coins, currency: settings.currency });
  } catch (error) {
    if (error.message === 'Not enough real ETB balance to buy coins.') {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

export const convertBonusToReal = (req, res, next) => {
  try {
    const userId = currentId(req);
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const userRole = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(userId))?.role;
    const settings = roleRates(userRole);
    const rate = Number(settings.bonus_to_real_rate);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Enter a valid bonus amount to convert.' });
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(409).json({ success: false, message: 'Bonus-to-real conversion is not enabled for your account role. Contact an administrator.' });
    }
    const realAmount = Math.round(amount * rate * 100) / 100;
    if (realAmount <= 0) {
      return res.status(400).json({ success: false, message: 'This bonus amount is too small to convert at the configured rate.' });
    }
    const reference = randomUUID();
    const convert = db().transaction(() => {
      const available = db().prepare(`
        SELECT COALESCE(SUM(l.amount), 0) -
          COALESCE((SELECT SUM(w.amount) FROM wallet_withdrawals w
            WHERE w.user_id = ? AND w.balance_type = 'bonus' AND w.status IN ('pending', 'approved')), 0) AS available
        FROM wallet_ledger l
        WHERE l.user_id = ? AND l.balance_type = 'bonus'
      `).get(userId, userId).available;
      if (amount > available) throw new Error('Not enough available bonus balance for this conversion.');
      const debited = creditWallet(
        userId, -amount, 'bonus_to_real_conversion', `bonus-to-real:${reference}:bonus`,
        `Converted ${amount.toFixed(2)} ${settings.currency} bonus to real balance at ${rate}`, 'bonus'
      );
      const credited = creditWallet(
        userId, realAmount, 'bonus_to_real_conversion', `bonus-to-real:${reference}:real`,
        `Received ${realAmount.toFixed(2)} ${settings.currency} from bonus conversion`, 'real'
      );
      if (!debited || !credited) throw new Error('Could not record the bonus conversion.');
      notify(userId, null, 'bonus_to_real_conversion', `Converted ${amount.toFixed(2)} bonus to ${realAmount.toFixed(2)} real ${settings.currency}.`, '/wallet');
    });
    convert();
    json(res, { bonus: amount, amount: realAmount, rate, currency: settings.currency });
  } catch (error) {
    if (error.message === 'Not enough available bonus balance for this conversion.') {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

export const getRootWalletData = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const users = db().prepare(`
      SELECT CAST(u._id AS TEXT) AS user_id, u.username, COALESCE(u.full_name, u.username) AS full_name, u.role,
        COALESCE(SUM(CASE WHEN l.balance_type = 'real' THEN l.amount ELSE 0 END), 0) AS real_balance,
        COALESCE(SUM(CASE WHEN l.balance_type = 'bonus' THEN l.amount ELSE 0 END), 0) AS bonus_balance,
        COALESCE((SELECT SUM(c.amount) FROM wallet_coin_ledger c WHERE c.user_id = CAST(u._id AS TEXT)), 0) AS coin_balance,
        COALESCE(ws.currency, 'ETB') AS currency
      FROM users u LEFT JOIN wallet_ledger l ON l.user_id = CAST(u._id AS TEXT)
      LEFT JOIN wallet_settings ws ON ws.role = lower(u.role)
      GROUP BY u._id ORDER BY u.username LIMIT 500
    `).all();
    const withdrawals = db().prepare(`
      SELECT w.withdrawal_id, w.user_id, w.amount, w.payout_details, w.balance_type,
        w.transaction_reference, w.status, w.created_at, w.updated_at, u.username,
        CASE WHEN w.receipt_file IS NULL OR w.receipt_file = '' THEN 0 ELSE 1 END AS receipt_available
      FROM wallet_withdrawals w
      LEFT JOIN users u ON CAST(u._id AS TEXT) = w.user_id
      ORDER BY CASE w.status WHEN 'pending' THEN 0 ELSE 1 END, w.created_at DESC LIMIT 200
    `).all();
    const deposits = db().prepare(`
      SELECT d.*, u.username FROM wallet_deposits d
      LEFT JOIN users u ON CAST(u._id AS TEXT) = d.user_id
      ORDER BY CASE d.status WHEN 'pending' THEN 0 ELSE 1 END, d.created_at DESC LIMIT 200
    `).all();
    const roles = db().prepare('SELECT DISTINCT role FROM users WHERE role IS NOT NULL').all().map(row => row.role);
    ['user', 'guest', 'staff', 'admin'].forEach(role => { if (!roles.includes(role)) roles.push(role); });
    const settings = roles.map(role => roleRates(role));
    json(res, { users, withdrawals, deposits, settings });
  } catch (error) { next(error); }
};

export const getRootWithdrawalReceipt = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const receipt = db().prepare(
      'SELECT receipt_file FROM wallet_withdrawals WHERE withdrawal_id = ?'
    ).get(String(req.params.withdrawalId));
    if (!receipt?.receipt_file) return res.status(404).json({ success: false, message: 'Receipt not found.' });
    json(res, { receiptFile: receipt.receipt_file });
  } catch (error) { next(error); }
};

export const getMyCoinLevel = (req, res, next) => {
  try {
    const userId = currentId(req);
    const user = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(userId));
    const rates = roleRates(user?.role);
    json(res, {
      ...getCoinLevelProgress(userId),
      earningRules: {
        signupBonus: Number(rates.signup_bonus),
        inviteReward: Number(rates.invite_reward),
        inviteRewardTrigger: rates.invite_reward_trigger,
        shareReward: Number(rates.share_reward),
        coinLoginReward: Number(rates.coin_login_reward),
        coinShareReward: Number(rates.coin_share_reward),
        coinInviteReward: Number(rates.coin_invite_reward),
        coinPurchaseReward: Number(rates.coin_purchase_reward),
        coinGiftReceiveReward: Number(rates.coin_gift_receive_reward),
        coinsPerEtb: Number(rates.coin_per_etb),
        minCoinConversion: Number(rates.min_coin_conversion),
        maxCoinConversion: Number(rates.max_coin_conversion),
      },
    });
  } catch (error) { next(error); }
};

export const getRootCoinLevelRules = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    json(res, getCoinLevelRules());
  } catch (error) { next(error); }
};

export const saveRootCoinLevelRules = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const submittedRules = req.body?.rules;
    if (!Array.isArray(submittedRules) || submittedRules.length !== 8) {
      return res.status(400).json({ success: false, message: 'Configure all eight coin levels.' });
    }
    const rules = submittedRules.map((rule, index) => ({
      level: Number(rule?.level),
      required_coins: Number(rule?.required_coins),
      reward_etb: Number(rule?.reward_etb),
    }));
    if (rules.some((rule, index) =>
      rule.level !== index + 1 ||
      !Number.isSafeInteger(rule.required_coins) ||
      rule.required_coins < 0 ||
      !Number.isFinite(rule.reward_etb) ||
      rule.reward_etb < 0 ||
      rule.reward_etb > 1000000000 ||
      Math.round(rule.reward_etb * 100) !== rule.reward_etb * 100
    ) || rules.slice(1).some((rule, index) => rule.required_coins <= rules[index].required_coins)) {
      return res.status(400).json({
        success: false,
        message: 'Coin thresholds must be non-negative whole numbers and increase at every level; ETB rewards must be valid amounts with up to two decimal places.',
      });
    }
    const save = db().transaction(() => {
      const update = db().prepare(`
        UPDATE wallet_coin_level_rules
        SET required_coins = ?, reward_etb = ?, updated_at = CURRENT_TIMESTAMP
        WHERE level = ?
      `);
      for (const rule of rules) update.run(rule.required_coins, rule.reward_etb, rule.level);
      const users = db().prepare('SELECT CAST(_id AS TEXT) AS user_id FROM users').all();
      for (const user of users) awardReachedCoinLevels(user.user_id);
    });
    save();
    json(res, getCoinLevelRules());
  } catch (error) { next(error); }
};

export const getRootCoinLevelHistory = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const history = db().prepare(`
      SELECT h.user_id, COALESCE(u.username, '') AS username,
        COALESCE(u.full_name, u.username, 'Unknown user') AS full_name,
        h.level, h.earned_coins, h.reward_etb, h.created_at
      FROM wallet_coin_level_history h
      LEFT JOIN users u ON CAST(u._id AS TEXT) = h.user_id
      ORDER BY h.created_at DESC, h.level DESC
      LIMIT 500
    `).all();
    json(res, history);
  } catch (error) { next(error); }
};

export const getRootUserActivity = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const requestedPage = req.query?.page === undefined ? 1 : Number(req.query.page);
    const pageSize = 10;
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 100000) {
      return res.status(400).json({ success: false, message: 'Choose a valid user activity page.' });
    }
    const total = db().prepare('SELECT COUNT(*) AS total FROM users').get().total;
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
    const users = db().prepare(`
      SELECT CAST(u._id AS TEXT) AS id, u.username, u.email,
        COALESCE(u.full_name, '') AS full_name, COALESCE(u.role, '') AS role,
        COALESCE(u.is_active, 0) AS is_active, u.last_login,
        COALESCE((SELECT SUM(c.amount) FROM wallet_coin_ledger c
          WHERE c.user_id = CAST(u._id AS TEXT) AND c.amount > 0
            AND c.entry_type NOT IN ('coin_purchase', 'coin_savings_return', 'coin_admin_adjustment')), 0) AS earned_coins,
        CASE WHEN u.is_active = 1 AND p.last_seen >= datetime('now', '-90 seconds')
          THEN 1 ELSE 0 END AS is_online
      FROM users u
      LEFT JOIN social_presence p ON p.user_id = CAST(u._id AS TEXT)
      ORDER BY is_online DESC, COALESCE(u.last_login, u.created_at) DESC, u.username ASC
      LIMIT ? OFFSET ?
    `).all(pageSize, (page - 1) * pageSize);
    const levelRules = getCoinLevelRules();
    const usersWithLevels = users.map(user => ({
      ...user,
      current_level: levelRules.filter(rule => user.earned_coins >= rule.required_coins).at(-1)?.level || 0,
      is_active: Boolean(user.is_active),
      is_online: Boolean(user.is_online),
    }));
    json(res, { users: usersWithLevels, total, page, pageSize });
  } catch (error) { next(error); }
};

export const getRootWalletActivity = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const from = String(req.query?.from || '');
    const to = String(req.query?.to || '');
    const role = String(req.query?.role || '');
    const asset = String(req.query?.asset || 'all');
    const search = String(req.query?.search || '').trim();
    const page = Number.parseInt(req.query?.page, 10) || 1;
    const pageSize = 50;
    const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if ((from && !isDate(String(from))) || (to && !isDate(String(to))) ||
        (from && to && from > to) || !['all', 'coin', 'ETB', 'real', 'bonus'].includes(String(asset)) ||
        role.length > 40 || search.length > 120 || !Number.isSafeInteger(page) || page < 1 || page > 100000) {
      return res.status(400).json({ success: false, message: 'Choose a valid date range, activity type, and page.' });
    }
    const conditions = [];
    const params = [];
    if (from) { conditions.push('date(created_at) >= ?'); params.push(String(from)); }
    if (to) { conditions.push('date(created_at) <= ?'); params.push(String(to)); }
    if (role) { conditions.push('lower(role) = lower(?)'); params.push(String(role)); }
    if (asset === 'real' || asset === 'bonus') {
      conditions.push("asset = 'ETB' AND bucket = ?");
      params.push(String(asset));
    } else if (asset !== 'all') { conditions.push('asset = ?'); params.push(String(asset)); }
    if (search) {
      const term = `%${String(search).trim().replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push("(username LIKE ? ESCAPE '\\' OR full_name LIKE ? ESCAPE '\\' OR user_id LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\' OR entry_type LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      params.push(term, term, term, term, term, term);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const activitySql = `
      WITH activity AS (
        SELECT l.entry_id AS id, l.user_id, COALESCE(u.username, l.user_id) AS username,
          COALESCE(u.full_name, u.username, l.user_id) AS full_name, COALESCE(u.role, 'unknown') AS role,
          l.amount, 'ETB' AS asset, l.balance_type AS bucket, l.currency, l.entry_type,
          l.description, l.created_at
        FROM wallet_ledger l LEFT JOIN users u ON CAST(u._id AS TEXT) = l.user_id
        UNION ALL
        SELECT c.entry_id AS id, c.user_id, COALESCE(u.username, c.user_id) AS username,
          COALESCE(u.full_name, u.username, c.user_id) AS full_name, COALESCE(u.role, 'unknown') AS role,
          c.amount, 'coin' AS asset, 'coin' AS bucket, 'COIN' AS currency, c.entry_type,
          c.description, c.created_at
        FROM wallet_coin_ledger c LEFT JOIN users u ON CAST(u._id AS TEXT) = c.user_id
      )
    `;
    const count = db().prepare(`${activitySql} SELECT COUNT(*) AS total FROM activity ${where}`).get(...params).total;
    const summary = db().prepare(`
      ${activitySql}
      SELECT COUNT(*) AS transaction_count,
        COALESCE(SUM(CASE WHEN asset = 'coin' AND amount > 0 THEN amount ELSE 0 END), 0) AS coins_credited,
        COALESCE(SUM(CASE WHEN asset = 'coin' AND amount < 0 THEN -amount ELSE 0 END), 0) AS coins_debited,
        COALESCE(SUM(CASE WHEN asset = 'ETB' AND amount > 0 THEN amount ELSE 0 END), 0) AS etb_credited,
        COALESCE(SUM(CASE WHEN asset = 'ETB' AND amount < 0 THEN -amount ELSE 0 END), 0) AS etb_debited,
        COALESCE(SUM(CASE WHEN asset = 'ETB' AND bucket = 'real' AND amount > 0 THEN amount ELSE 0 END), 0) AS real_credited,
        COALESCE(SUM(CASE WHEN asset = 'ETB' AND bucket = 'bonus' AND amount > 0 THEN amount ELSE 0 END), 0) AS bonus_credited
      FROM activity ${where}
    `).get(...params);
    const entries = db().prepare(`
      ${activitySql}
      SELECT * FROM activity ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize);
    json(res, { entries, total: count, page, pageSize, summary });
  } catch (error) { next(error); }
};

export const updateRootWalletSettings = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const { role } = req.body || {};
    const normalizedRole = String(role || '').trim().toLowerCase();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/i.test(normalizedRole)) {
      return res.status(400).json({ success: false, message: 'Choose a valid account role.' });
    }
    const existing = roleRates(normalizedRole);
    const numberSetting = (field, previous) => req.body?.[field] === undefined ? Number(previous) : Number(req.body[field]);
    const signupBonus = numberSetting('signupBonus', existing.signup_bonus);
    const inviteReward = numberSetting('inviteReward', existing.invite_reward);
    const shareReward = numberSetting('shareReward', existing.share_reward);
    const productSalePercent = numberSetting('productSalePercent', existing.product_sale_percent);
    const coinLoginReward = numberSetting('coinLoginReward', existing.coin_login_reward);
    const coinShareReward = numberSetting('coinShareReward', existing.coin_share_reward);
    const coinInviteReward = numberSetting('coinInviteReward', existing.coin_invite_reward);
    const coinPurchaseReward = numberSetting('coinPurchaseReward', existing.coin_purchase_reward);
    const coinGiftReceiveReward = numberSetting('coinGiftReceiveReward', existing.coin_gift_receive_reward);
    const coinGiftBonusPercent = numberSetting('coinGiftBonusPercent', existing.coin_gift_bonus_percent);
    const coinSavingsDailyRate = numberSetting('coinSavingsDailyRate', existing.coin_savings_daily_rate);
    const minCoinSavingsDeposit = numberSetting('minCoinSavingsDeposit', existing.min_coin_savings_deposit);
    const maxCoinSavingsDeposit = numberSetting('maxCoinSavingsDeposit', existing.max_coin_savings_deposit);
    const coinPerEtb = numberSetting('coinPerEtb', existing.coin_per_etb);
    const minCoinConversion = numberSetting('minCoinConversion', existing.min_coin_conversion);
    const maxCoinConversion = numberSetting('maxCoinConversion', existing.max_coin_conversion);
    const minDeposit = numberSetting('minDeposit', existing.min_deposit);
    const maxDeposit = numberSetting('maxDeposit', existing.max_deposit);
    const minWithdrawal = numberSetting('minWithdrawal', existing.min_withdrawal);
    const maxWithdrawal = numberSetting('maxWithdrawal', existing.max_withdrawal);
    const minBonusWithdrawal = numberSetting('minBonusWithdrawal', existing.min_bonus_withdrawal);
    const maxBonusWithdrawal = numberSetting('maxBonusWithdrawal', existing.max_bonus_withdrawal);
    const bonusToRealRate = numberSetting('bonusToRealRate', existing.bonus_to_real_rate);
    const inviteRewardTrigger = String(req.body?.inviteRewardTrigger ?? existing.invite_reward_trigger);
    const rates = [signupBonus, inviteReward, shareReward, productSalePercent, coinLoginReward, coinShareReward,
      coinInviteReward, coinPurchaseReward, coinGiftReceiveReward, coinGiftBonusPercent, coinPerEtb,
      coinSavingsDailyRate, minCoinSavingsDeposit, maxCoinSavingsDeposit,
      minCoinConversion, maxCoinConversion, minDeposit, maxDeposit, minWithdrawal, maxWithdrawal,
      minBonusWithdrawal, maxBonusWithdrawal, bonusToRealRate];
    const normalizedCurrency = String(req.body?.currency ?? existing.currency ?? '').trim().toUpperCase();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/i.test(normalizedRole) ||
        rates.some(value => !Number.isFinite(value) || value < 0) || productSalePercent > 100 ||
        bonusToRealRate > 100 ||
        coinGiftBonusPercent > 100 || coinSavingsDailyRate > 100 ||
        !Number.isSafeInteger(minCoinSavingsDeposit) || minCoinSavingsDeposit < 1 ||
        !Number.isSafeInteger(maxCoinSavingsDeposit) || maxCoinSavingsDeposit < minCoinSavingsDeposit ||
        !Number.isSafeInteger(coinLoginReward) ||
        !Number.isSafeInteger(coinShareReward) || !Number.isSafeInteger(coinInviteReward) ||
        !Number.isSafeInteger(coinPurchaseReward) || !Number.isSafeInteger(coinGiftReceiveReward) ||
        !Number.isSafeInteger(coinPerEtb) || coinPerEtb < 1 ||
        !Number.isSafeInteger(minCoinConversion) || !Number.isSafeInteger(maxCoinConversion) ||
        maxCoinConversion < minCoinConversion || maxCoinConversion < 1 ||
        maxDeposit < minDeposit || maxWithdrawal < minWithdrawal || maxBonusWithdrawal < minBonusWithdrawal ||
        !['registration', 'first_approved_purchase', 'both'].includes(inviteRewardTrigger) ||
        !/^[A-Za-z]{3,8}$/.test(normalizedCurrency)) {
      return res.status(400).json({ success: false, message: 'Enter valid reward amounts, coin savings rate and limits, coin conversion limits, real/bonus deposit and withdrawal limits, invitation trigger, and a 3–8 letter currency code.' });
    }
    const hasLedger = db().prepare(`
      SELECT 1 FROM users u JOIN wallet_ledger l ON l.user_id = CAST(u._id AS TEXT)
      WHERE lower(u.role) = ? LIMIT 1
    `).get(normalizedRole);
    if (hasLedger && existing.currency !== normalizedCurrency) {
      return res.status(409).json({ success: false, message: 'Currency cannot be changed after this role has wallet activity.' });
    }
    db().prepare(`
      INSERT INTO wallet_settings (
        role, signup_bonus, invite_reward, share_reward, product_sale_percent, currency, invite_reward_trigger,
        coin_login_reward, coin_share_reward, coin_invite_reward, coin_purchase_reward, coin_gift_receive_reward,
        coin_gift_bonus_percent, coin_savings_daily_rate, min_coin_savings_deposit, max_coin_savings_deposit,
        coin_per_etb, min_coin_conversion, max_coin_conversion, min_deposit, max_deposit,
        min_withdrawal, max_withdrawal, min_bonus_withdrawal, max_bonus_withdrawal, bonus_to_real_rate
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET signup_bonus = excluded.signup_bonus,
        invite_reward = excluded.invite_reward, share_reward = excluded.share_reward,
        product_sale_percent = excluded.product_sale_percent, currency = excluded.currency,
        invite_reward_trigger = excluded.invite_reward_trigger, coin_login_reward = excluded.coin_login_reward,
        coin_share_reward = excluded.coin_share_reward, coin_invite_reward = excluded.coin_invite_reward,
        coin_purchase_reward = excluded.coin_purchase_reward, coin_gift_receive_reward = excluded.coin_gift_receive_reward,
        coin_gift_bonus_percent = excluded.coin_gift_bonus_percent,
        coin_savings_daily_rate = excluded.coin_savings_daily_rate,
        min_coin_savings_deposit = excluded.min_coin_savings_deposit,
        max_coin_savings_deposit = excluded.max_coin_savings_deposit,
        coin_per_etb = excluded.coin_per_etb,
        min_coin_conversion = excluded.min_coin_conversion, max_coin_conversion = excluded.max_coin_conversion,
        min_deposit = excluded.min_deposit, max_deposit = excluded.max_deposit,
        min_withdrawal = excluded.min_withdrawal, max_withdrawal = excluded.max_withdrawal,
        min_bonus_withdrawal = excluded.min_bonus_withdrawal,
        max_bonus_withdrawal = excluded.max_bonus_withdrawal,
        bonus_to_real_rate = excluded.bonus_to_real_rate
    `).run(
      normalizedRole, signupBonus, inviteReward, shareReward, productSalePercent, normalizedCurrency,
      inviteRewardTrigger, coinLoginReward, coinShareReward, coinInviteReward, coinPurchaseReward,
      coinGiftReceiveReward, coinGiftBonusPercent, coinSavingsDailyRate, minCoinSavingsDeposit,
      maxCoinSavingsDeposit, coinPerEtb, minCoinConversion, maxCoinConversion,
      minDeposit, maxDeposit, minWithdrawal, maxWithdrawal, minBonusWithdrawal, maxBonusWithdrawal,
      bonusToRealRate
    );
    json(res, roleRates(normalizedRole));
  } catch (error) { next(error); }
};

export const updateWithdrawal = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const { status } = req.body || {};
    if (!['paid', 'rejected'].includes(status)) return res.status(400).json({ success: false, message: 'Choose paid or rejected.' });
    const withdrawal = db().prepare('SELECT * FROM wallet_withdrawals WHERE withdrawal_id = ? AND status = ?').get(req.params.withdrawalId, 'pending');
    if (!withdrawal) return res.status(404).json({ success: false, message: 'Pending withdrawal not found.' });
    const update = db().transaction(() => {
      db().prepare('UPDATE wallet_withdrawals SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE withdrawal_id = ?')
        .run(status, withdrawal.withdrawal_id);
      if (status === 'paid') {
        creditWallet(withdrawal.user_id, -withdrawal.amount, 'withdrawal', `withdrawal:${withdrawal.withdrawal_id}`, `${withdrawal.balance_type === 'bonus' ? 'Bonus' : 'Real'} wallet withdrawal paid`, withdrawal.balance_type || 'real');
      }
      notify(withdrawal.user_id, null, `withdrawal_${status}`, `Your wallet withdrawal was ${status}.`, '/wallet');
    });
    update();
    json(res, { withdrawalId: withdrawal.withdrawal_id, status });
  } catch (error) { next(error); }
};

export const updateDeposit = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const { status } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Choose approved or rejected.' });
    }

    let deposit;
    const decide = db().transaction(() => {
      deposit = db().prepare("SELECT * FROM wallet_deposits WHERE deposit_id = ? AND status = 'pending'")
        .get(req.params.depositId);
      if (!deposit) return false;
      const result = db().prepare(`
        UPDATE wallet_deposits SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE deposit_id = ? AND status = 'pending'
      `).run(status, deposit.deposit_id);
      if (result.changes !== 1) return false;
      if (status === 'approved') {
        creditWallet(deposit.user_id, deposit.amount, 'deposit', `deposit:${deposit.deposit_id}`, 'Wallet deposit approved');
      }
      notify(deposit.user_id, null, `deposit_${status}`, `Your wallet deposit was ${status}.`, '/wallet');
      return true;
    });
    if (!decide()) return res.status(404).json({ success: false, message: 'Pending deposit request not found.' });
    json(res, { depositId: deposit.deposit_id, status });
  } catch (error) { next(error); }
};

export const adjustWalletBalance = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const userId = String(req.body?.userId || '');
    const balanceType = String(req.body?.balanceType || 'bonus');
    const requestedAmount = Number(req.body?.amount);
    const amount = balanceType === 'coin' ? requestedAmount : Math.round(requestedAmount * 100) / 100;
    const reason = String(req.body?.reason || '').trim();
    const user = db().prepare('SELECT username FROM users WHERE CAST(_id AS TEXT) = ?').get(userId);
    if (!user || !Number.isFinite(amount) || amount === 0 || !validText(reason, 250) ||
        !['real', 'bonus', 'coin'].includes(balanceType) ||
        (balanceType === 'coin' && !Number.isSafeInteger(amount))) {
      return res.status(400).json({ success: false, message: 'Choose an account, balance type, valid non-zero amount, and reason (up to 250 characters). Coin adjustments must be whole numbers.' });
    }
    const reference = `manual:${randomUUID()}`;
    const adjust = db().transaction(() => {
      if (balanceType === 'coin') {
        const available = coinBalance(userId);
        if (amount < 0 && available + amount < 0) throw new Error('Adjustment would make the available coin balance negative.');
        if (!creditCoins(userId, amount, 'coin_admin_adjustment', reference, `Administrator coin adjustment: ${reason}`)) {
          throw new Error('Could not record the coin adjustment.');
        }
        notify(userId, null, 'coin_admin_adjustment', `Your coin balance was adjusted by ${amount} coins.`, '/wallet');
        return;
      }
      const available = db().prepare(`
        SELECT COALESCE(SUM(l.amount), 0) -
          COALESCE((SELECT SUM(w.amount) FROM wallet_withdrawals w
            WHERE w.user_id = ? AND w.balance_type = ? AND w.status IN ('pending', 'approved')), 0) -
          COALESCE((SELECT SUM(r.amount) FROM agent_wallet_requests r
            WHERE r.user_id = ? AND r.request_type = 'withdrawal' AND r.status = 'pending' AND ? = 'real'), 0) AS balance
        FROM wallet_ledger l WHERE l.user_id = ? AND l.balance_type = ?
      `).get(userId, balanceType, userId, balanceType, userId, balanceType).balance;
      if (amount < 0 && available + amount < 0) throw new Error('Adjustment would make the available balance negative.');
      if (!creditWallet(userId, amount, 'admin_adjustment', reference, `Administrator adjustment: ${reason}`, balanceType)) {
        throw new Error('Could not record the wallet adjustment.');
      }
      const balanceLabel = balanceType === 'bonus' ? 'bonus/reward' : 'real';
      notify(userId, null, 'wallet_adjustment', `Your ${balanceLabel} wallet was adjusted by ${amount.toFixed(2)}.`, '/wallet');
    });
    adjust();
    json(res, { userId, username: user.username, amount, balanceType, reference }, 201);
  } catch (error) {
    if (['Adjustment would make the available balance negative.', 'Adjustment would make the available coin balance negative.'].includes(error.message)) {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

export const getMyReferralCode = (req, res, next) => {
  try { json(res, { referralCode: ensureReferralCode(currentId(req)) }); }
  catch (error) { next(error); }
};

export const rewardApprovedSale = (customerUserId, requestId, saleAmount) => {
  if (!customerUserId || !Number.isFinite(Number(saleAmount)) || Number(saleAmount) <= 0) return;
  const attributed = db().prepare('SELECT inviter_user_id FROM social_referral_joins WHERE new_user_id = ?')
    .get(String(customerUserId));
  const referrerId = attributed?.inviter_user_id;
  const customer = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(customerUserId));
  if (customer) {
    const customerRates = roleRates(customer.role);
    creditCoins(customerUserId, customerRates.coin_purchase_reward, 'coin_purchase_reward', `coin-approved-purchase:${requestId}`, 'Coins for an approved booking or product purchase');
    if (customerRates.coin_purchase_reward > 0) {
      notify(customerUserId, null, 'coin_reward', `🎉 You received ${customerRates.coin_purchase_reward} coins for your approved purchase.`, '/wallet');
    }
  }
  if (!referrerId) return;
  const referrer = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(referrerId));
  const referrerRates = roleRates(referrer?.role);
  if (referrerRates.invite_reward_trigger === 'first_approved_purchase' || referrerRates.invite_reward_trigger === 'both') {
    const inviteReward = creditPlatformReward(
      referrerId,
      referrerRates.invite_reward,
      'invite_reward',
      `invite-approved-purchase:${customerUserId}`,
      'Invite reward for first approved referred purchase'
    );
    const coinInviteReward = creditCoins(
      referrerId,
      referrerRates.coin_invite_reward,
      'coin_invite_reward',
      `coin-invite-approved-purchase:${customerUserId}`,
      'Invite coins for first approved referred purchase'
    );
    if (inviteReward || coinInviteReward) {
      notify(referrerId, customerUserId, 'invite_reward', '🎉 Your invited member completed an approved purchase. Your invite reward was added to your wallet.', '/wallet');
    }
  }
  const agentSettings = String(referrer?.role || '').toLowerCase() === 'agent'
    ? db().prepare('SELECT reward_percent FROM agent_settings WHERE agent_user_id = ?').get(String(referrerId))
    : null;
  const rate = Number(agentSettings?.reward_percent ?? referrerRates.product_sale_percent);
  const commission = Math.round(Number(saleAmount) * rate) / 100;
  if (creditPlatformReward(
    referrerId,
    commission,
    'product_sale',
    `sale:${requestId}`,
    'Commission for an approved referred sale',
    String(referrer?.role || '').toLowerCase() === 'agent' ? referrerId : null
  )) {
    notify(referrerId, customerUserId, 'sale_commission', `You earned ${commission.toFixed(2)} for an approved sale.`, '/wallet');
  }
};

export const settleMarketplaceSale = (ownerUserId, requestId, productAmount, serviceCharge) => {
  const ownerAmount = Math.round(Number(productAmount) * 100) / 100;
  const platformAmount = Math.round(Number(serviceCharge) * 100) / 100;
  if (!ownerUserId || !requestId || !Number.isFinite(ownerAmount) || ownerAmount <= 0 ||
      !Number.isFinite(platformAmount) || platformAmount < 0) {
    throw new Error('Marketplace sale settlement details are invalid.');
  }

  const settle = db().transaction(() => {
    const ownerCredited = creditWallet(
      ownerUserId,
      ownerAmount,
      'marketplace_sale',
      `marketplace-sale:${requestId}`,
      'Payment for an approved marketplace product sale',
      'real'
    );
    const platformCredited = platformAmount === 0 || db().prepare(`
      INSERT OR IGNORE INTO platform_service_charge_ledger (
        entry_id, amount, request_id, entry_type, reference, description
      ) VALUES (?, ?, ?, 'service_charge', ?, ?)
    `).run(
      randomUUID(),
      platformAmount,
      String(requestId),
      `marketplace-service-charge:${requestId}`,
      'Platform service charge for an approved marketplace product sale'
    ).changes === 1;
    return { ownerCredited, platformCredited };
  })();

  if (settle.ownerCredited) {
    notify(
      ownerUserId,
      null,
      'marketplace_sale',
      `A marketplace sale was approved. ETB ${ownerAmount.toFixed(2)} was added to your real wallet balance.`,
      '/wallet'
    );
  }
  return settle;
};
