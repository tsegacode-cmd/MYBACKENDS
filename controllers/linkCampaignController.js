import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { queryNeon, toPostgresPlaceholders, withNeonTransaction } from '../config/neonDatabase.js';
import { creditUserCoins } from './socialController.js';

const transactionContext = new AsyncLocalStorage();
const db = () => ({
  prepare(sql) {
    const execute = async params => {
      const client = transactionContext.getStore();
      return client
        ? client.query(toPostgresPlaceholders(sql), params)
        : queryNeon(sql, params);
    };
    return {
      get: async (...params) => (await execute(params)).rows[0],
      all: async (...params) => (await execute(params)).rows,
      run: async (...params) => {
        const result = await execute(params);
        return { changes: result.rowCount, rows: result.rows };
      },
    };
  },
  transaction(callback) {
    return async () => {
      const existingClient = transactionContext.getStore();
      if (existingClient) return callback(existingClient);
      return withNeonTransaction(client => transactionContext.run(client, () => callback(client)));
    };
  },
});
const json = (res, data, status = 200) => res.status(status).json({ success: true, data });
const DURATION_DAYS = {
  '1-3': 3,
  '4-7': 7,
  '8-15': 15,
  '16-30': 30,
  '31-60': 60,
  '61-180': 180,
  '181-365': 365,
};
const PRICE_COLUMN = {
  '1-3': 'price_1_3',
  '4-7': 'price_4_7',
  '8-15': 'price_8_15',
  '16-30': 'price_16_30',
  '31-60': 'price_31_60',
  '61-180': 'price_61_180',
  '181-365': 'price_181_365',
};
const SOCIAL_APPS = new Set([
  'TikTok', 'YouTube', 'Facebook', 'Instagram', 'X', 'Snapchat', 'Telegram',
  'WhatsApp', 'LinkedIn', 'Pinterest', 'Twitch', 'Reddit', 'Other',
]);
const MANUAL_PAYMENT_PROVIDERS = new Set(['Telebirr', 'Ebirr', 'CBE Birr', 'Bank']);
const COIN_EARNED_EXCLUDED_TYPES = ['coin_purchase', 'coin_savings_return', 'coin_admin_adjustment'];
const WALLET_PAYMENT_METHOD = 'REDSEA Wallet';
const toUtcDate = value => {
  const timestamp = String(value || '');
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(timestamp) ? timestamp : `${timestamp.replace(' ', 'T')}Z`);
};
const isExpired = value => {
  const expiresAt = toUtcDate(value).getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
};

const getSettings = async () => db().prepare('SELECT * FROM link_campaign_settings WHERE setting_id = 1').get();

const parseImages = value => {
  try {
    const images = JSON.parse(value || '[]');
    return Array.isArray(images) ? images : [];
  } catch (error) {
    throw new Error('A link campaign contains invalid image data.', { cause: error });
  }
};

const safeCampaign = campaign => ({
  campaign_id: campaign.campaign_id,
  user_id: campaign.user_id,
  app_name: campaign.app_name,
  title: campaign.title,
  url: campaign.url,
  description: campaign.description,
  images: parseImages(campaign.images_json),
  duration_tier: campaign.duration_tier,
  duration_days: campaign.duration_days,
  payment_amount: campaign.payment_amount,
  viewer_coins: campaign.viewer_coins,
  poster_coins: campaign.poster_coins,
  view_seconds: campaign.view_seconds,
  already_claimed: Boolean(campaign.already_claimed),
  status: campaign.status,
  starts_at: campaign.starts_at,
  expires_at: campaign.expires_at,
  created_at: campaign.created_at,
  ...(campaign.username !== undefined ? { username: campaign.username } : {}),
  ...(campaign.full_name !== undefined ? { full_name: campaign.full_name } : {}),
});

const getActiveCampaigns = async viewerId => {
  await db().prepare(`
    UPDATE link_campaigns SET status = 'expired', updated_at = CURRENT_TIMESTAMP::text
    WHERE status = 'approved' AND expires_at::timestamptz <= CURRENT_TIMESTAMP
  `).run();
  const campaigns = (await db().prepare(`
    SELECT c.*, u.username, COALESCE(u.full_name, u.username) AS full_name,
      EXISTS (
        SELECT 1 FROM link_campaign_views v
        WHERE v.campaign_id = c.campaign_id AND v.viewer_user_id = ?
          AND v.claimed_at IS NOT NULL
      ) AS already_claimed
    FROM link_campaigns c
    LEFT JOIN users u ON u._id::text = c.user_id
    WHERE c.status = 'approved'
      AND c.expires_at::timestamptz > CURRENT_TIMESTAMP
      AND c.user_id <> ?
      AND NOT EXISTS (
        SELECT 1 FROM link_campaign_views v
        WHERE v.campaign_id = c.campaign_id AND v.viewer_user_id = ?
          AND v.claimed_at IS NOT NULL
          AND v.claimed_at::timestamptz > CURRENT_TIMESTAMP - INTERVAL '24 hours'
      )
    ORDER BY c.created_at DESC
    LIMIT 200
  `).all(String(viewerId), String(viewerId), String(viewerId))).map(safeCampaign);
  return campaigns;
};

export const getLinkCampaigns = async (req, res, next) => {
  try {
    const [mine, pricing] = await Promise.all([
      db().prepare(`
        SELECT c.*, u.username, COALESCE(u.full_name, u.username) AS full_name
        FROM link_campaigns c LEFT JOIN users u ON u._id::text = c.user_id
        WHERE c.user_id = ? ORDER BY c.created_at DESC LIMIT 100
      `).all(String(req.user.id)),
      getSettings(),
    ]);
    json(res, {
      campaigns: await getActiveCampaigns(req.user.id),
      mine: mine.map(safeCampaign),
      pricing,
    });
  } catch (error) { next(error); }
};

export const createLinkCampaign = async (req, res, next) => {
  try {
    const body = req.body || {};
    const appName = String(body.appName || '').trim();
    const title = String(body.title || '').trim();
    const description = String(body.description || '').trim();
    const url = String(body.url || '').trim();
    const durationTier = String(body.durationTier || '');
    const paymentMethod = String(body.paymentMethod || '').trim();
    const paymentReference = String(body.paymentReference || '').trim();
    const walletPayment = paymentMethod === WALLET_PAYMENT_METHOD;
    const images = body.images;
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { parsedUrl = null; }
    if (!SOCIAL_APPS.has(appName) || !title || title.length > 160 ||
        description.length > 2000 || !parsedUrl || parsedUrl.protocol !== 'https:' ||
        url.length > 2048 || !Object.hasOwn(DURATION_DAYS, durationTier) ||
        !paymentMethod || paymentMethod.length > 80 ||
        (!walletPayment && !MANUAL_PAYMENT_PROVIDERS.has(paymentMethod)) ||
        (!walletPayment && (!paymentReference || paymentReference.length > 160)) ||
        !Array.isArray(images) || images.length < 1 || images.length > 5 ||
        images.some(image => typeof image !== 'string' ||
          image.length > 1500000 ||
          !/^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+=*$/i.test(image)) ||
        (body.paymentProof != null && (typeof body.paymentProof !== 'string' ||
          body.paymentProof.length > 1800000 ||
          !/^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+=*$/i.test(body.paymentProof)))) {
      return res.status(400).json({ success: false, message: 'Enter a valid social app, title, HTTPS link, duration, payment details, and one to five images.' });
    }
    const settings = await getSettings();
    const amount = Number(settings[PRICE_COLUMN[durationTier]]);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(409).json({ success: false, message: 'The Root administrator has not configured a price for this campaign duration yet.' });
    }
    const campaignId = randomUUID();
    const userId = String(req.user.id);
    const saveCampaign = await db().transaction(async () => {
      const internalReference = walletPayment ? `link-campaign-wallet:${campaignId}` : paymentReference;
      if (walletPayment) {
        const realBalance = Number((await db().prepare(`
          SELECT COALESCE(SUM(amount), 0) AS amount
          FROM wallet_ledger WHERE user_id = ? AND balance_type = 'real'
        `).get(userId)).amount);
        const pendingWithdrawals = Number((await db().prepare(`
          SELECT COALESCE(SUM(amount), 0) AS amount FROM wallet_withdrawals
          WHERE user_id = ? AND balance_type = 'real' AND status IN ('pending', 'approved')
        `).get(userId)).amount);
        const pendingAgentWithdrawals = Number((await db().prepare(`
          SELECT COALESCE(SUM(amount), 0) AS amount FROM agent_wallet_requests
          WHERE user_id = ? AND request_type = 'withdrawal' AND status = 'pending'
        `).get(userId)).amount);
        const availableBalance = Math.max(0, Math.round((realBalance - pendingWithdrawals - pendingAgentWithdrawals) * 100) / 100);
        if (availableBalance < amount) {
          const insufficient = new Error(`Insufficient real wallet balance. You have ETB ${availableBalance.toFixed(2)} available; ETB ${amount.toFixed(2)} is required.`);
          insufficient.status = 400;
          insufficient.code = 'INSUFFICIENT_WALLET_BALANCE';
          throw insufficient;
        }
        await db().prepare(`
          INSERT INTO wallet_ledger (entry_id, user_id, amount, entry_type, reference, description, currency, balance_type)
          VALUES (?, ?, ?, 'link_campaign_payment', ?, ?, 'ETB', 'real')
        `).run(randomUUID(), userId, -amount, internalReference, `Wallet payment for link campaign: ${title}`);
      }
      await db().prepare(`
        INSERT INTO link_campaigns (
          campaign_id, user_id, app_name, title, url, description, images_json,
          duration_tier, duration_days, payment_amount, payment_method,
          payment_reference, payment_proof, viewer_coins, poster_coins, view_seconds
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        campaignId,
        userId,
        appName,
        title,
        url,
        description,
        JSON.stringify(images),
        durationTier,
        DURATION_DAYS[durationTier],
        amount,
        paymentMethod,
        internalReference,
        walletPayment ? null : body.paymentProof || null,
        settings.viewer_coins,
        settings.poster_coins,
        settings.view_seconds,
      );
      return await db().prepare('SELECT * FROM link_campaigns WHERE campaign_id = ?').get(campaignId);
    })();
    json(res, safeCampaign(saveCampaign), 201);
  } catch (error) {
    if (error.code === 'INSUFFICIENT_WALLET_BALANCE') {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    next(error);
  }
};

export const startLinkCampaignView = async (req, res, next) => {
  try {
    const viewerId = String(req.user.id);
    const campaignId = String(req.params.campaignId || '');
    const campaign = await db().prepare(`
      SELECT campaign_id, user_id, status, expires_at, view_seconds, viewer_coins
      FROM link_campaigns WHERE campaign_id = ?
    `).get(campaignId);
    if (!campaign || campaign.status !== 'approved' || isExpired(campaign.expires_at)) {
      return res.status(404).json({ success: false, message: 'This campaign is no longer available.' });
    }
    if (campaign.user_id === viewerId) {
      return res.status(403).json({ success: false, message: 'You cannot earn coins by viewing your own campaign.' });
    }
    const existing = await db().prepare(`
      SELECT view_id, active_seconds, claimed_at, viewer_coins, poster_coins
      FROM link_campaign_views WHERE campaign_id = ? AND viewer_user_id = ?
    `).get(campaignId, viewerId);
    if (existing?.claimed_at) {
      return json(res, {
        alreadyClaimed: true,
        viewerCoins: existing.viewer_coins,
        posterCoins: existing.poster_coins,
      });
    }
    if (existing) {
      await db().prepare('UPDATE link_campaign_views SET last_progress_at = CURRENT_TIMESTAMP::text WHERE view_id = ?')
        .run(existing.view_id);
      return json(res, {
        viewId: existing.view_id,
        activeSeconds: existing.active_seconds,
        requiredSeconds: campaign.view_seconds,
        viewerCoins: campaign.viewer_coins,
      });
    }
    const viewId = randomUUID();
    await db().prepare(`
      INSERT INTO link_campaign_views (view_id, campaign_id, viewer_user_id)
      VALUES (?, ?, ?)
    `).run(viewId, campaignId, viewerId);
    json(res, {
      viewId,
      activeSeconds: 0,
      requiredSeconds: campaign.view_seconds,
      viewerCoins: campaign.viewer_coins,
    }, 201);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'You have already opened this campaign.' });
    }
    next(error);
  }
};

export const progressLinkCampaignView = async (req, res, next) => {
  try {
    const viewerId = String(req.user.id);
    const viewId = String(req.params.viewId || '');
    const progress = await db().transaction(async () => {
      const view = await db().prepare(`
        SELECT v.view_id, v.last_progress_at, v.active_seconds, c.view_seconds,
          c.status, c.expires_at
        FROM link_campaign_views v JOIN link_campaigns c ON c.campaign_id = v.campaign_id
        WHERE v.view_id = ? AND v.viewer_user_id = ? AND v.claimed_at IS NULL
      `).get(viewId, viewerId);
      if (!view || view.status !== 'approved' || isExpired(view.expires_at)) {
        throw new Error('This campaign view is no longer active.');
      }
      const lastProgress = toUtcDate(view.last_progress_at).getTime();
      const elapsed = Number.isFinite(lastProgress)
        ? Math.max(0, Math.min(5, Math.floor((Date.now() - lastProgress) / 1000)))
        : 0;
      if (elapsed > 0) {
        await db().prepare(`
          UPDATE link_campaign_views
          SET active_seconds = active_seconds + ?, last_progress_at = CURRENT_TIMESTAMP::text
          WHERE view_id = ? AND claimed_at IS NULL
        `).run(elapsed, viewId);
      }
      return db().prepare('SELECT active_seconds FROM link_campaign_views WHERE view_id = ?').get(viewId);
    })();
    json(res, { activeSeconds: progress.active_seconds });
  } catch (error) {
    if (error.message === 'This campaign view is no longer active.') {
      return res.status(409).json({ success: false, message: error.message });
    }
    next(error);
  }
};

export const claimLinkCampaignReward = async (req, res, next) => {
  try {
    const viewerId = String(req.user.id);
    const viewId = String(req.params.viewId || '');
    const claim = await db().transaction(async client => {
      const view = await db().prepare(`
        SELECT v.view_id, v.campaign_id, v.viewer_user_id, v.active_seconds,
          v.claimed_at, c.user_id AS poster_id, c.status, c.expires_at,
          c.view_seconds, c.viewer_coins, c.poster_coins, c.title
        FROM link_campaign_views v JOIN link_campaigns c ON c.campaign_id = v.campaign_id
        WHERE v.view_id = ? AND v.viewer_user_id = ?
      `).get(viewId, viewerId);
      if (!view || view.status !== 'approved' || isExpired(view.expires_at)) {
        throw new Error('This campaign reward is no longer available.');
      }
      if (view.claimed_at) throw new Error('You have already claimed this campaign reward.');
      if (view.active_seconds < view.view_seconds) {
        throw new Error(`Keep the campaign open for ${view.view_seconds - view.active_seconds} more seconds before claiming.`);
      }
      const claimed = await db().prepare(`
        UPDATE link_campaign_views SET claimed_at = CURRENT_TIMESTAMP::text,
          viewer_coins = ?, poster_coins = ? WHERE view_id = ? AND claimed_at IS NULL
      `).run(view.viewer_coins, view.poster_coins, viewId);
      if (!claimed.changes) throw new Error('You have already claimed this campaign reward.');
      if (view.viewer_coins > 0 && !await creditUserCoins(
        viewerId,
        view.viewer_coins,
        'link_campaign_view_reward',
        `link-viewer:${view.campaign_id}:${viewerId}`,
        `Coins for viewing ${view.title}`,
        client,
      )) throw new Error('Could not credit the viewer coin reward.');
      if (view.poster_coins > 0 && !await creditUserCoins(
        view.poster_id,
        view.poster_coins,
        'link_campaign_poster_reward',
        `link-poster:${view.campaign_id}:${viewerId}`,
        `Coins for a qualified view of ${view.title}`,
        client,
      )) throw new Error('Could not credit the campaign poster coin reward.');

      const insertNotification = db().prepare(`
        INSERT INTO social_notifications (notification_id, user_id, actor_id, type, message, link)
        VALUES (?, ?, NULL, 'coin_reward', ?, ?)
      `);
      if (view.viewer_coins > 0) await insertNotification.run(
        randomUUID(), viewerId,
        `You earned ${view.viewer_coins} coins for viewing ${view.title}.`,
        `/feed?campaign=${encodeURIComponent(view.campaign_id)}`,
      );
      if (view.poster_coins > 0) await insertNotification.run(
        randomUUID(), view.poster_id,
        `Your campaign “${view.title}” earned ${view.poster_coins} coins from a qualified view.`,
        `/feed?campaign=${encodeURIComponent(view.campaign_id)}`,
      );
      return { viewerCoins: view.viewer_coins, posterCoins: view.poster_coins };
    })();
    json(res, claim);
  } catch (error) {
    if (['This campaign reward is no longer available.', 'You have already claimed this campaign reward.'].includes(error.message) ||
        error.message.startsWith('Keep the campaign open for ')) {
      return res.status(409).json({ success: false, message: error.message });
    }
    next(error);
  }
};

export const getRootLinkCampaigns = async (req, res, next) => {
  try {
    await db().prepare(`
      UPDATE link_campaigns SET status = 'expired', updated_at = CURRENT_TIMESTAMP::text
      WHERE status = 'approved' AND expires_at::timestamptz <= CURRENT_TIMESTAMP
    `).run();
    const campaigns = (await db().prepare(`
      SELECT c.*, u.username, COALESCE(u.full_name, u.username) AS full_name,
        (SELECT COUNT(*) FROM link_campaign_views v WHERE v.campaign_id = c.campaign_id AND v.claimed_at IS NOT NULL) AS qualified_views
      FROM link_campaigns c LEFT JOIN users u ON u._id::text = c.user_id
      ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END, c.created_at DESC
      LIMIT 500
    `).all()).map(campaign => ({
      ...safeCampaign(campaign),
      payment_method: campaign.payment_method,
      payment_reference: campaign.payment_reference,
      payment_proof: campaign.payment_proof,
      qualified_views: campaign.qualified_views,
    }));
    json(res, { campaigns, settings: await getSettings() });
  } catch (error) { next(error); }
};

export const getRootLinkCampaignSettings = async (req, res, next) => {
  try {
    json(res, await getSettings());
  } catch (error) { next(error); }
};

export const saveRootLinkCampaignSettings = async (req, res, next) => {
  try {
    const body = req.body || {};
    const prices = Object.keys(PRICE_COLUMN).map(tier => Number(body.prices?.[tier]));
    const viewerCoins = Number(body.viewerCoins);
    const posterCoins = Number(body.posterCoins);
    const viewSeconds = Number(body.viewSeconds);
    const closeDelaySeconds = Number(body.closeDelaySeconds);
    if (prices.some(value => !Number.isFinite(value) || value < 0 || value > 100000000 ||
          Math.round(value * 100) !== value * 100) ||
        !Number.isSafeInteger(viewerCoins) || viewerCoins < 0 || viewerCoins > 1000000000 ||
        !Number.isSafeInteger(posterCoins) || posterCoins < 0 || posterCoins > 1000000000 ||
        !Number.isSafeInteger(viewSeconds) || viewSeconds < 1 || viewSeconds > 3600 ||
        !Number.isSafeInteger(closeDelaySeconds) || closeDelaySeconds < 0 || closeDelaySeconds > 300) {
      return res.status(400).json({ success: false, message: 'Enter valid duration prices, coin rewards, view time, and close-button delay.' });
    }
    const update = await db().prepare(`
      UPDATE link_campaign_settings SET
        price_1_3 = ?, price_4_7 = ?, price_8_15 = ?, price_16_30 = ?,
        price_31_60 = ?, price_61_180 = ?, price_181_365 = ?,
        viewer_coins = ?, poster_coins = ?, view_seconds = ?,
        close_delay_seconds = ?, updated_at = CURRENT_TIMESTAMP::text
      WHERE setting_id = 1
    `).run(...prices, viewerCoins, posterCoins, viewSeconds, closeDelaySeconds);
    if (update.changes !== 1) throw new Error('Link campaign settings were not saved.');
    json(res, await getSettings());
  } catch (error) { next(error); }
};

export const reviewRootLinkCampaign = async (req, res, next) => {
  try {
    const status = String(req.body?.status || '');
    const campaignId = String(req.params.campaignId || '');
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Choose approve or reject.' });
    }
    const review = await db().transaction(async () => {
      const campaign = await db().prepare(`
        SELECT campaign_id, user_id, title, status, duration_days, payment_amount, payment_method FROM link_campaigns
        WHERE campaign_id = ?
      `).get(campaignId);
      if (!campaign) throw new Error('Link campaign not found.');
      if (campaign.status !== 'pending') throw new Error('Only pending link campaigns can be reviewed.');
      const updated = await db().prepare(`
        UPDATE link_campaigns SET status = ?, reviewed_by = ?,
          starts_at = CASE WHEN ? = 'approved' THEN CURRENT_TIMESTAMP::text ELSE NULL END,
          expires_at = CASE WHEN ? = 'approved' THEN (CURRENT_TIMESTAMP + duration_days * INTERVAL '1 day')::text ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP::text
        WHERE campaign_id = ? AND status = 'pending'
      `).run(status, String(req.user.id), status, status, campaignId);
      if (updated.changes !== 1) throw new Error('Only pending link campaigns can be reviewed.');
      if (status === 'approved') {
        await db().prepare(`
          INSERT INTO social_notifications (notification_id, user_id, actor_id, type, message, link)
          VALUES (?, ?, ?, 'link_campaign_approved', ?, ?)
        `).run(
          randomUUID(),
          campaign.user_id,
          String(req.user.id),
          `Your link campaign “${campaign.title}” was approved and is now live.`,
          `/feed?campaign=${encodeURIComponent(campaign.campaign_id)}`,
        );
        await db().prepare(`
          INSERT INTO social_notifications (notification_id, user_id, actor_id, type, message, link)
          SELECT gen_random_uuid()::text, _id::text, ?, 'link_campaign_new',
            ?, ?
          FROM users WHERE is_active = 1 AND _id::text <> ?
        `).run(
          String(req.user.id),
          `New ${campaign.title} campaign is live. View it and earn coins.`,
          `/feed?campaign=${encodeURIComponent(campaign.campaign_id)}`,
          campaign.user_id,
        );
      } else {
        const walletRefund = campaign.payment_method === WALLET_PAYMENT_METHOD;
        if (walletRefund) {
          await db().prepare(`
            INSERT INTO wallet_ledger (entry_id, user_id, amount, entry_type, reference, description, currency, balance_type)
            VALUES (?, ?, ?, 'link_campaign_refund', ?, ?, 'ETB', 'real')
          `).run(
            randomUUID(),
            campaign.user_id,
            campaign.payment_amount,
            `link-campaign-wallet-refund:${campaign.campaign_id}`,
            `Real wallet refund for rejected link campaign: ${campaign.title}`,
          );
        }
        await db().prepare(`
          INSERT INTO social_notifications (notification_id, user_id, actor_id, type, message, link)
          VALUES (?, ?, ?, 'link_campaign_rejected', ?, '/feed')
        `).run(
          randomUUID(),
          campaign.user_id,
          String(req.user.id),
          walletRefund
            ? `Your link campaign “${campaign.title}” was rejected. ETB ${Number(campaign.payment_amount).toFixed(2)} was returned to your real wallet.`
            : `Your link campaign “${campaign.title}” was rejected.`,
        );
      }
      return db().prepare('SELECT * FROM link_campaigns WHERE campaign_id = ?').get(campaignId);
    })();
    json(res, safeCampaign(review));
  } catch (error) {
    if (['Link campaign not found.', 'Only pending link campaigns can be reviewed.'].includes(error.message)) {
      return res.status(error.message === 'Link campaign not found.' ? 404 : 409)
        .json({ success: false, message: error.message });
    }
    next(error);
  }
};
