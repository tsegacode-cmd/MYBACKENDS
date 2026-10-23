import { randomUUID } from 'crypto';
import { queryNeon, withNeonTransaction } from '../config/neonDatabase.js';

const json = (res, data, status = 200) => res.status(status).json({ success: true, data });
const SERVICE_KEYS = new Set(['broker-house', 'create-partnership', 'room-booking', 'logistics', 'movable-services']);
const MARKETPLACE_FEE_KEY = 'platform_service_charge_percent';
const PROMOTION_AUDIENCES = new Set(['all', 'paid', 'unpaid', 'guest', 'user', 'other']);
const PROMOTION_FIELDS = `
  promotion_id AS id, title, message, image_data, audio_data, button_text, button_url,
  background_color, audience_status, badge_text, alert_enabled, pinned, popup_enabled,
  is_hidden, created_at, updated_at
`;
const PRODUCT_FIELDS = 'product_id AS id, service_key, product_json, owner_user_id, published, boosted, approval_status, updated_at';

const isRoot = req => req.user?.isRoot === true;
export const requireMarketplaceRoot = (req, res, next) => {
  if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access required.' });
  next();
};

const parseProduct = (row, includeDownloadUrl = false) => {
  if (!row) return null;
  let product;
  try {
    product = JSON.parse(row.product_json);
  } catch {
    throw new Error(`Product ${row.id} contains invalid saved data.`);
  }
  const parsedProduct = { ...product };
  if (!includeDownloadUrl) delete parsedProduct.downloadUrl;
  return {
    ...parsedProduct,
    id: row.id,
    serviceKey: row.service_key,
    ownerProduct: Boolean(row.owner_user_id),
    published: Boolean(row.published), // Fixed for Postgres boolean
    approvalStatus: row.approval_status || 'approved',
    boosted: Boolean(row.boosted), // Fixed for Postgres boolean
  };
};

const getPlatformFeePercent = async () => {
  const { rows } = await queryNeon(
    'SELECT setting_value FROM marketplace_settings WHERE setting_key = ?',
    [MARKETPLACE_FEE_KEY]
  );
  return Number(rows[0]?.setting_value || 0);
};

const normalizeDeliverySettings = product => {
  const enabled = product.deliveryEnabled === true;
  if (enabled && String(product.deliveryFee ?? '').trim() === '') {
    throw new Error('Enter a delivery fee, or set it to zero for free delivery.');
  }
  const fee = enabled ? Number(product.deliveryFee) : 0;
  if (enabled && product.digitalProduct) {
    throw new Error('Digital products cannot offer physical delivery.');
  }
  if (enabled && (!Number.isFinite(fee) || fee < 0 || fee > 1000000000 || Number(fee.toFixed(2)) !== fee)) {
    throw new Error('Delivery fee must be zero or more with at most two decimal places.');
  }
  return {
    deliveryEnabled: enabled,
    deliveryFee: enabled ? fee : 0,
  };
};

export const getMarketplaceDeliveryDetails = async (itemId, requested) => {
  if (typeof requested !== 'boolean') throw new Error('Choose whether you want delivery.');
  if (!requested) return { deliveryRequested: false, deliveryFee: 0 };
  const { rows } = await queryNeon(`
    SELECT product_json, published
    FROM service_catalog_products
    WHERE product_id = ?
  `, [String(itemId || '')]);
  const row = rows[0];
  if (!row || !row.published) throw new Error('Delivery is only available for an active catalog product.');
  const product = JSON.parse(row.product_json);
  if (product.digitalProduct || product.deliveryEnabled !== true) {
    throw new Error('Delivery is not available for this product.');
  }
  const fee = Number(product.deliveryFee);
  if (!Number.isFinite(fee) || fee < 0 || fee > 1000000000 || Number(fee.toFixed(2)) !== fee) {
    throw new Error('This product has an invalid delivery fee. Please contact support.');
  }
  return { deliveryRequested: true, deliveryFee: fee };
};

export const getMarketplaceSettings = async (_req, res, next) => {
  try {
    const { rows } = await queryNeon('SELECT setting_value FROM marketplace_settings WHERE setting_key = ?', [MARKETPLACE_FEE_KEY]);
    json(res, { platformServiceChargePercent: Number(rows[0]?.setting_value || 0) });
  } catch (error) { next(error); }
};

export const getRootMarketplaceSettings = getMarketplaceSettings;

export const saveRootMarketplaceSettings = async (req, res, next) => {
  try {
    const percent = Number(req.body?.platformServiceChargePercent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100 ||
        Number(percent.toFixed(2)) !== percent) {
      return res.status(400).json({ success: false, message: 'Platform service charge must be from 0 to 100 with at most two decimal places.' });
    }
    await queryNeon(`
      INSERT INTO marketplace_settings (setting_key, setting_value)
      VALUES (?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
    `, [MARKETPLACE_FEE_KEY, String(percent)]);
    json(res, { platformServiceChargePercent: percent });
  } catch (error) { next(error); }
};

export const getMarketplaceProducts = async (req, res, next) => {
  try {
    const key = req.query.serviceKey;
    if (key && !SERVICE_KEYS.has(String(key))) {
      return res.status(400).json({ success: false, message: 'Choose a valid service category.' });
    }
    const { rows } = key
      ? await queryNeon(`SELECT ${PRODUCT_FIELDS} FROM service_catalog_products WHERE published = true AND service_key = ? ORDER BY boosted DESC, updated_at DESC`, [String(key)])
      : await queryNeon(`SELECT ${PRODUCT_FIELDS} FROM service_catalog_products WHERE published = true ORDER BY boosted DESC, updated_at DESC`);
    const products = rows.map(parseProduct);
    const { rows: boostedRows } = await queryNeon(`
      SELECT p.post_id, p.product_name, p.product_price, p.product_url, p.product_image, p.content, p.created_at,
        COALESCE(u.full_name, u.username, 'REDSEA member') AS provider
      FROM social_posts p
      JOIN boost_requests b ON b.post_id = p.post_id AND b.status = 'approved'
      LEFT JOIN users u ON u._id::text = p.user_id
      WHERE p.visibility = 'public'
      ORDER BY b.updated_at DESC
    `);
    const boostedPosts = boostedRows.map(post => ({
      id: `boosted-${post.post_id}`,
      title: post.product_name || post.content?.trim().slice(0, 100) || 'Boosted post',
      name: post.product_name || post.content?.trim().slice(0, 100) || 'Boosted post',
      price: post.product_price,
      image: post.product_image,
      productUrl: post.product_url || `/feed?post=${encodeURIComponent(post.post_id)}`,
      organizationName: post.provider,
      description: post.content,
      category: 'Boosted product',
      serviceKey: key || 'boosted-posts',
      boosted: true,
      published: true,
      statusLabel: 'Boosted',
      createdAt: post.created_at,
    }));
    json(res, [...products, ...boostedPosts]);
  } catch (error) { next(error); }
};

export const createMarketplaceProduct = async (req, res, next) => {
  try {
    const submittedProduct = req.body?.product;
    const serviceKey = String(req.body?.serviceKey || '');
    const name = String(submittedProduct?.name || submittedProduct?.title || '').trim();
    const ownerName = String(submittedProduct?.ownerName || '').trim();
    const organizationName = String(submittedProduct?.organizationName || '').trim();
    const price = Number(submittedProduct?.price);
    const id = String(submittedProduct?.id || '');
    if (!SERVICE_KEYS.has(serviceKey) || !submittedProduct || typeof submittedProduct !== 'object' ||
        Array.isArray(submittedProduct) || !id || id.length > 100 || !name || name.length > 200 ||
        (!ownerName && !organizationName) || ownerName.length > 160 || organizationName.length > 160 ||
        !Number.isFinite(price) || price <= 0 || price > 1000000000) {
      return res.status(400).json({ success: false, message: 'Provide a valid service category, product, owner/provider, and price.' });
    }
    if (submittedProduct.digitalProduct) {
      let downloadUrl;
      try {
        downloadUrl = new URL(String(submittedProduct.downloadUrl || ''));
      } catch {
        return res.status(400).json({ success: false, message: 'Digital products need a valid HTTPS download link.' });
      }
      if (downloadUrl.protocol !== 'https:' || String(submittedProduct.downloadUrl).length > 2048) {
        return res.status(400).json({ success: false, message: 'Digital products need a valid HTTPS download link.' });
      }
    }
    let deliverySettings;
    try {
      deliverySettings = normalizeDeliverySettings(submittedProduct);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    const userId = String(req.user.id);
    const safeProduct = {
      ...submittedProduct,
      id,
      name,
      title: name,
      ownerName,
      organizationName,
      price,
      description: String(submittedProduct.description || '').trim().slice(0, 2000),
      ...deliverySettings,
      serviceProduct: true,
    };
    if (!safeProduct.digitalProduct) {
      delete safeProduct.downloadUrl;
      delete safeProduct.downloadFilename;
    }
    delete safeProduct.ownerUserId;
    delete safeProduct.published;
    delete safeProduct.boosted;
    delete safeProduct.ownerProduct;
    const agentSubmission = String(req.user?.role || '').toLowerCase() === 'agent';
    const approvalStatus = agentSubmission ? 'pending' : 'approved';
    const result = await queryNeon(`
      INSERT INTO service_catalog_products (
        product_id, service_key, product_json, owner_user_id, published, boosted, approval_status, updated_at
      ) VALUES (?, ?, ?, ?, ?, false, ?, CURRENT_TIMESTAMP::text)
    `, [id, serviceKey, JSON.stringify(safeProduct), userId, agentSubmission ? false : true, approvalStatus]);
    const { rows } = await queryNeon(`SELECT ${PRODUCT_FIELDS} FROM service_catalog_products WHERE product_id = ?`, [id]);
    return json(res, parseProduct(rows[0]), result.rowCount === 1 ? 201 : 200);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'A product with this ID already exists. Please try again.' });
    }
    return next(error);
  }
};

export const getMarketplaceBookingDetails = async (itemId, paymentType) => {
  const { rows } = await queryNeon(`
    SELECT product_json, owner_user_id, service_key, published
    FROM service_catalog_products
    WHERE product_id = ?
  `, [String(itemId || '')]);
  const row = rows[0];
  if (!row) throw new Error('This product is no longer available for wallet booking.');
  if (!row.published) throw new Error('This product is no longer available
