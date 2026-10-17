import { randomBytes, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getRawSQLiteDB } from '../config/sqliteDatabase.js';

const db = () => getRawSQLiteDB();
const currentId = req => String(req.user.id);
const isRoot = user => user?.isRoot || ['root', 'admin'].includes(String(user?.role || '').toLowerCase());
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
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

const creditWallet = (userId, amount, type, reference, description) => {
  const value = Number(amount);
  if (!Number.isFinite(value) || value === 0 || (value < 0 && !['withdrawal', 'admin_adjustment'].includes(type))) return false;
  const roundedValue = Math.round(value * 100) / 100;
  if (roundedValue === 0) return false;
  const userRole = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(userId))?.role;
  const currency = roleRates(userRole).currency;
  const result = db().prepare(`
    INSERT OR IGNORE INTO wallet_ledger (entry_id, user_id, amount, entry_type, reference, description, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), String(userId), roundedValue, type, reference, description, currency);
  return result.changes === 1;
};

const ensureReferralCode = userId => {
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
  const signupBonusPaid = creditWallet(userId, config.signup_bonus, 'signup_bonus', `signup:${userId}`, 'Account welcome bonus');
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
      creditWallet(inviterId, inviterConfig.invite_reward, 'invite_reward', `invite:${userId}`, `Invite bonus for ${newUsername}`);
      notify(inviterId, userId, 'invite', `${newUsername} joined using your invite link.`, '/friends');
      notify(userId, inviterId, 'follow', 'You are now following your inviter.', '/friends');
    }
  }
};

export const registerAccount = async (req, res, next) => {
  try {
    const { username, email, password, full_name, phone, position, referralCode } = req.body || {};
    const cleanUsername = String(username || '').trim();
    if (!/^[A-Za-z0-9_.-]{3,40}$/.test(cleanUsername) || typeof password !== 'string' || password.length < 6 || password.length > 128) {
      return res.status(400).json({ success: false, message: 'Enter a valid username and a password of at least 6 characters.' });
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
      const result = db().prepare(`
        INSERT INTO users (username, email, password_hash, full_name, role, position, phone, is_active, created_by_role)
        VALUES (?, ?, ?, ?, 'user', ?, ?, 1, 'self')
      `).run(cleanUsername, email || null, passwordHash, String(full_name || '').trim() || null, String(position || '').trim() || null, String(phone || '').trim() || null);
      registerReferredUser(result.lastInsertRowid, cleanReferralCode);
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
      SELECT p.post_id, p.user_id, p.content, p.product_name, p.product_price, p.product_url, p.product_image, p.repost_of, p.visibility, p.created_at,
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
        p.repost_of, p.visibility, p.moderation_status, p.moderation_reason, p.moderated_at, p.created_at,
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
    if ((!content && !productName) || content.length > 2000 || productName.length > 160 ||
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
      INSERT INTO social_posts (post_id, user_id, content, product_name, product_price, product_url, product_image, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(postId, userId, content, productName || null, price, productUrl || null, productImage, visibility);
      const followers = db().prepare(`
        SELECT f.follower_id FROM social_follows f
        WHERE f.followed_id = ? AND (? = 'public' OR ? = 'friends' AND EXISTS (
          SELECT 1 FROM social_follows reciprocal
          WHERE reciprocal.follower_id = ? AND reciprocal.followed_id = f.follower_id
        ))
      `).all(userId, visibility, visibility, userId);
      followers.forEach(follower => notify(follower.follower_id, userId, 'new_post', 'Someone you follow published a post.', '/feed'));
    });
    create();
    json(res, db().prepare('SELECT * FROM social_posts WHERE post_id = ?').get(postId), 201);
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
        const rewarded = creditWallet(userId, rates.share_reward, 'share_reward', `share:${postId}:${userId}`, 'Reward for sharing a post');
        if (rewarded) notify(userId, null, 'share_reward', `Your ${rates.share_reward.toFixed(2)} post-share reward was added to your wallet.`, '/wallet');
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
        p.repost_of, p.visibility, p.created_at,
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
      SELECT CAST(u._id AS TEXT) AS user_id, u.username, COALESCE(u.full_name, u.username) AS full_name, u.role,
        EXISTS(SELECT 1 FROM social_presence presence
          WHERE presence.user_id = CAST(u._id AS TEXT)
            AND presence.last_seen >= datetime('now', '-90 seconds')) AS is_online,
        EXISTS(SELECT 1 FROM social_follows f WHERE f.follower_id = ? AND f.followed_id = CAST(u._id AS TEXT)) AS following,
        (SELECT status FROM social_friend_requests r WHERE r.requester_id = ? AND r.recipient_id = CAST(u._id AS TEXT)) AS sent_request,
        (SELECT status FROM social_friend_requests r WHERE r.requester_id = CAST(u._id AS TEXT) AND r.recipient_id = ?) AS received_request
      FROM users u WHERE u.is_active = 1 AND CAST(u._id AS TEXT) <> ?
        AND (? = '' OR u.username LIKE ? OR u.full_name LIKE ? OR u.role LIKE ?)
      ORDER BY u.username LIMIT 50
    `).all(userId, userId, userId, userId, query, `%${query}%`, `%${query}%`, `%${query}%`);
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
        m.body, m.type, m.created_at, m.read_at,
        COALESCE(u.username, 'Member') AS sender_name
      FROM social_messages m LEFT JOIN users u ON CAST(u._id AS TEXT) = m.sender_id
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
    const allowedTypes = ['text', 'voice', 'call-offer', 'call-answer', 'call-end'];
    const validBody = type === 'text'
      ? validText(body, 2000)
      : type === 'voice'
        ? /^data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(body) && body.length <= 8 * 1024 * 1024
        : ['call-offer', 'call-answer', 'call-end'].includes(type) &&
          body.length <= 100000 && isValidCallSignal(type, body);
    if (!recipient || recipient === sender || !allowedTypes.includes(type) || !validBody) {
      return res.status(400).json({ success: false, message: 'Enter a valid text, voice, or call message.' });
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
    db().prepare('INSERT INTO social_messages (message_id, sender_id, recipient_id, body, type) VALUES (?, ?, ?, ?, ?)')
      .run(messageId, sender, recipient, body, type);
    if (type === 'text' || type === 'voice' || type === 'call-offer') {
      const notification = type === 'voice'
        ? 'You received a voice message.'
        : type === 'call-offer'
          ? 'You received an incoming call.'
          : 'You received a new message.';
      notify(recipient, sender, 'message', notification, '/friends');
    }
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
        CASE WHEN m.type = 'voice' THEN 'Voice message' ELSE m.body END AS body,
        m.type, m.created_at, m.read_at,
        COALESCE(u.username, 'Member') AS sender_name
      FROM social_messages m LEFT JOIN users u ON CAST(u._id AS TEXT) = m.sender_id
      WHERE m.recipient_id = ? ORDER BY m.created_at DESC LIMIT 100
    `).all(userId);
    json(res, inbox);
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
    const rows = db().prepare('SELECT * FROM wallet_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId);
    const balance = db().prepare('SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_ledger WHERE user_id = ?').get(userId).balance;
    const withdrawals = db().prepare('SELECT * FROM wallet_withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(userId);
    const pendingWithdrawals = db().prepare("SELECT COALESCE(SUM(amount), 0) AS amount FROM wallet_withdrawals WHERE user_id = ? AND status = 'pending'").get(userId).amount;
    const deposits = db().prepare('SELECT * FROM wallet_deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 30').all(userId);
    json(res, {
      balance,
      availableBalance: Math.max(0, balance - pendingWithdrawals),
      currency: rates.currency,
      entries: rows,
      withdrawals,
      deposits,
      referralCode: ensureReferralCode(userId)
    });
  } catch (error) { next(error); }
};

export const createDeposit = (req, res, next) => {
  try {
    const userId = currentId(req);
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const paymentMethod = String(req.body?.paymentMethod || '').trim();
    const paymentReference = String(req.body?.paymentReference || '').trim();
    if (!Number.isFinite(amount) || amount <= 0 || !validText(paymentMethod, 80) || !validText(paymentReference, 250)) {
      return res.status(400).json({ success: false, message: 'Enter a positive deposit amount, payment method, and transaction reference.' });
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
    const available = db().prepare(`
      SELECT COALESCE(SUM(l.amount), 0) - COALESCE((SELECT SUM(w.amount) FROM wallet_withdrawals w WHERE w.user_id = ? AND w.status IN ('pending', 'approved')), 0) AS available
      FROM wallet_ledger l WHERE l.user_id = ?
    `).get(userId, userId).available;
    if (!Number.isFinite(amount) || amount <= 0 || amount > available || !validText(payoutDetails, 500)) {
      return res.status(400).json({ success: false, message: 'Enter a valid amount up to your available balance and payout details.' });
    }
    const withdrawalId = randomUUID();
    db().prepare('INSERT INTO wallet_withdrawals (withdrawal_id, user_id, amount, payout_details) VALUES (?, ?, ?, ?)')
      .run(withdrawalId, userId, Math.round(amount * 100) / 100, payoutDetails);
    json(res, { withdrawalId, amount, status: 'pending' }, 201);
  } catch (error) { next(error); }
};

export const getRootWalletData = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const users = db().prepare(`
      SELECT CAST(u._id AS TEXT) AS user_id, u.username, COALESCE(u.full_name, u.username) AS full_name, u.role,
        COALESCE(SUM(l.amount), 0) AS balance, COALESCE(ws.currency, 'ETB') AS currency
      FROM users u LEFT JOIN wallet_ledger l ON l.user_id = CAST(u._id AS TEXT)
      LEFT JOIN wallet_settings ws ON ws.role = lower(u.role)
      GROUP BY u._id ORDER BY u.username LIMIT 500
    `).all();
    const withdrawals = db().prepare(`
      SELECT w.*, u.username FROM wallet_withdrawals w
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

export const updateRootWalletSettings = (req, res, next) => {
  try {
    if (!isRoot(req.user)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const { role, signupBonus, inviteReward, shareReward, productSalePercent, currency } = req.body || {};
    const rates = [signupBonus, inviteReward, shareReward, productSalePercent].map(Number);
    const normalizedRole = String(role || '').trim().toLowerCase();
    const normalizedCurrency = String(currency || '').trim().toUpperCase();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/i.test(normalizedRole) ||
        rates.some(value => !Number.isFinite(value) || value < 0) || rates[3] > 100 ||
        !/^[A-Za-z]{3,8}$/.test(normalizedCurrency)) {
      return res.status(400).json({ success: false, message: 'Enter valid non-negative rates, sale percentage up to 100, and a 3–8 letter currency code.' });
    }
    const existing = roleRates(normalizedRole);
    const hasLedger = db().prepare(`
      SELECT 1 FROM users u JOIN wallet_ledger l ON l.user_id = CAST(u._id AS TEXT)
      WHERE lower(u.role) = ? LIMIT 1
    `).get(normalizedRole);
    if (hasLedger && existing.currency !== normalizedCurrency) {
      return res.status(409).json({ success: false, message: 'Currency cannot be changed after this role has wallet activity.' });
    }
    db().prepare(`
      INSERT INTO wallet_settings (role, signup_bonus, invite_reward, share_reward, product_sale_percent, currency)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET signup_bonus = excluded.signup_bonus,
        invite_reward = excluded.invite_reward, share_reward = excluded.share_reward,
        product_sale_percent = excluded.product_sale_percent, currency = excluded.currency
    `).run(normalizedRole, rates[0], rates[1], rates[2], rates[3], normalizedCurrency);
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
        creditWallet(withdrawal.user_id, -withdrawal.amount, 'withdrawal', `withdrawal:${withdrawal.withdrawal_id}`, 'Wallet withdrawal paid');
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
    const amount = Math.round(Number(req.body?.amount) * 100) / 100;
    const reason = String(req.body?.reason || '').trim();
    const user = db().prepare('SELECT username FROM users WHERE _id = ?').get(Number(userId));
    if (!user || !Number.isFinite(amount) || amount === 0 || !validText(reason, 250)) {
      return res.status(400).json({ success: false, message: 'Choose an account, non-zero amount, and reason (up to 250 characters).' });
    }
    const reference = `manual:${randomUUID()}`;
    const adjust = db().transaction(() => {
      const available = db().prepare(`
        SELECT COALESCE(SUM(l.amount), 0) -
          COALESCE((SELECT SUM(w.amount) FROM wallet_withdrawals w WHERE w.user_id = ? AND w.status = 'pending'), 0) AS balance
        FROM wallet_ledger l WHERE l.user_id = ?
      `).get(userId, userId).balance;
      if (amount < 0 && available + amount < 0) throw new Error('Adjustment would make the available balance negative.');
      creditWallet(userId, amount, 'admin_adjustment', reference, `Administrator adjustment: ${reason}`);
      notify(userId, null, 'wallet_adjustment', `Your wallet was adjusted by ${amount.toFixed(2)}.`, '/wallet');
    });
    adjust();
    json(res, { userId, amount, reference }, 201);
  } catch (error) {
    if (error.message === 'Adjustment would make the available balance negative.') {
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
  if (!referrerId) return;
  const referrer = db().prepare('SELECT role FROM users WHERE _id = ?').get(Number(referrerId));
  const rate = Number(roleRates(referrer?.role).product_sale_percent);
  const commission = Math.round(Number(saleAmount) * rate) / 100;
  if (creditWallet(referrerId, commission, 'product_sale', `sale:${requestId}`, 'Commission for an approved referred sale')) {
    notify(referrerId, customerUserId, 'sale_commission', `You earned ${commission.toFixed(2)} for an approved sale.`, '/wallet');
  }
};
