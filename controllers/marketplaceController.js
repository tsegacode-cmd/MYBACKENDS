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
    published: Boolean(row.published),
    approvalStatus: row.approval_status || 'approved',
    boosted: Boolean(row.boosted),
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
  if (!row.published) throw new Error('This product is no longer available.');

  const product = JSON.parse(row.product_json);
  const options = product.paymentOptions || {};
  const option = options[paymentType];
  if (product.digitalProduct && paymentType !== 'fullPayment') {
    throw new Error('Digital products require full payment before the download can be delivered.');
  }
  if (!['serviceCharge', 'firstPayment', 'fullPayment'].includes(paymentType) ||
      (option && option.enabled === false) ||
      (options.fullPayment?.required && paymentType !== 'fullPayment')) {
    throw new Error('The selected payment option is not available for this product.');
  }

  const rawBaseAmount = paymentType === 'fullPayment'
    ? (option?.amount || product.price)
    : option?.amount;
  const productAmount = Math.round(Number(rawBaseAmount) * 100) / 100;
  if (!Number.isFinite(productAmount) || productAmount <= 0) {
    throw new Error('The selected product payment option does not have a valid amount.');
  }
  const platformFeePercent = row.owner_user_id ? await getPlatformFeePercent() : 0;
  const platformServiceCharge = Math.round(productAmount * platformFeePercent) / 100;
  const expectedAmount = Math.round((productAmount + platformServiceCharge) * 100) / 100;
  const marketplaceSplit = row.owner_user_id ? {
    productOwnerUserId: row.owner_user_id,
    productAmount: productAmount.toFixed(2),
    platformServiceCharge: platformServiceCharge.toFixed(2),
    platformFeePercent,
  } : null;
  return {
    itemId: String(itemId),
    itemName: String(product.title || product.name || 'Service booking').trim().slice(0, 200),
    category: String(product.category || row.service_key).trim().slice(0, 100),
    paymentType,
    paymentLabel: String(option?.label || paymentType).slice(0, 80),
    amount: expectedAmount.toFixed(2),
    productAmount: productAmount.toFixed(2),
    platformServiceCharge: platformServiceCharge.toFixed(2),
    platformFeePercent,
    marketplaceSplit,
  };
};

export const getMarketplaceSaleSplit = async (itemId, paymentType, amount) => {
  const { rows } = await queryNeon(`
    SELECT product_json, owner_user_id, service_key, published
    FROM service_catalog_products
    WHERE product_id = ?
  `, [String(itemId || '')]);
  const row = rows[0];
  if (!row) {
    if (String(itemId || '').startsWith('service-')) throw new Error('This product is no longer available.');
    return null;
  }
  if (!row.published) throw new Error('This product is no longer available.');
  if (!row.owner_user_id) return null;
  const details = await getMarketplaceBookingDetails(itemId, paymentType);
  if (Math.round(Number(amount) * 100) !== Math.round(Number(details.amount) * 100)) {
    throw new Error('The booking total changed. Refresh the page and try again.');
  }
  return details.marketplaceSplit;
};

export const getRootMarketplaceProducts = async (req, res, next) => {
  try {
    const { rows } = await queryNeon(`SELECT ${PRODUCT_FIELDS} FROM service_catalog_products ORDER BY service_key, updated_at DESC`);
    json(res, rows.map(row => parseProduct(row, true)));
  } catch (error) { next(error); }
};

export const saveRootMarketplaceProduct = async (req, res, next) => {
  try {
    const product = req.body?.product;
    const serviceKey = String(req.body?.serviceKey || '');
    if (!SERVICE_KEYS.has(serviceKey) || !product || typeof product !== 'object' || Array.isArray(product) ||
        typeof product.id !== 'string' || product.id.length > 100) {
      return res.status(400).json({ success: false, message: 'A valid service category and product are required.' });
    }
    if (product.digitalProduct) {
      let downloadUrl;
      try {
        downloadUrl = new URL(String(product.downloadUrl || ''));
      } catch {
        return res.status(400).json({ success: false, message: 'Digital products need a valid HTTPS download link.' });
      }
      if (downloadUrl.protocol !== 'https:' || String(product.downloadUrl).length > 2048) {
        return res.status(400).json({ success: false, message: 'Digital products need a valid HTTPS download link.' });
      }
    }
    let deliverySettings;
    try {
      deliverySettings = normalizeDeliverySettings(product);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
    const safeProduct = { ...product };
    safeProduct.description = String(product.description || '').trim().slice(0, 2000);
    Object.assign(safeProduct, deliverySettings);
    if (!safeProduct.digitalProduct) {
      delete safeProduct.downloadUrl;
      delete safeProduct.downloadFilename;
    }
    const currentResult = await queryNeon('SELECT published, boosted FROM service_catalog_products WHERE product_id = ?', [product.id]);
    const current = currentResult.rows[0];
    const published = current ? current.published : (product.published === false ? false : true);
    const boosted = current ? current.boosted : false;
    await queryNeon(`
      INSERT INTO service_catalog_products (product_id, service_key, product_json, published, boosted, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP::text)
      ON CONFLICT(product_id) DO UPDATE SET
        service_key = excluded.service_key,
        product_json = excluded.product_json,
        updated_at = CURRENT_TIMESTAMP::text
    `, [product.id, serviceKey, JSON.stringify(safeProduct), published, boosted]);
    const savedResult = await queryNeon(`SELECT ${PRODUCT_FIELDS} FROM service_catalog_products WHERE product_id = ?`, [product.id]);
    const saved = savedResult.rows[0];
    json(res, parseProduct(saved, true), current ? 200 : 201);
  } catch (error) { next(error); }
};

export const getMarketplaceDigitalProduct = async productId => {
  if (!productId) return null;
  const { rows } = await queryNeon(`
    SELECT product_json, service_key
    FROM service_catalog_products
    WHERE product_id = ?
  `, [String(productId)]);
  const row = rows[0];
  if (!row) return null;
  const product = JSON.parse(row.product_json);
  if (!product.digitalProduct || !product.downloadUrl) return null;
  return {
    downloadUrl: product.downloadUrl,
    downloadFilename: product.downloadFilename || product.title || product.name || 'digital-product',
    title: product.title || product.name || 'Digital product',
  };
};

export const updateRootMarketplaceProduct = async (req, res, next) => {
  try {
    const { published, boosted } = req.body || {};
    if (published === undefined && boosted === undefined) {
      return res.status(400).json({ success: false, message: 'Choose whether to publish or boost this product.' });
    }
    if ((published !== undefined && typeof published !== 'boolean') ||
        (boosted !== undefined && typeof boosted !== 'boolean')) {
      return res.status(400).json({ success: false, message: 'Publish and boost values must be true or false.' });
    }
    const productId = String(req.params.productId);
    const currentResult = await queryNeon('SELECT published, boosted FROM service_catalog_products WHERE product_id = ?', [productId]);
    const current = currentResult.rows[0];
    if (!current) return res.status(404).json({ success: false, message: 'Product not found.' });
    await queryNeon(`
      UPDATE service_catalog_products SET published = ?, boosted = ?, updated_at = CURRENT_TIMESTAMP::text
      WHERE product_id = ?
    `, [published === undefined ? current.published : published,
      boosted === undefined ? current.boosted : boosted, productId]);
    const savedResult = await queryNeon(`SELECT ${PRODUCT_FIELDS} FROM service_catalog_products WHERE product_id = ?`, [productId]);
    json(res, parseProduct(savedResult.rows[0]));
  } catch (error) { next(error); }
};

export const deleteRootMarketplaceProduct = async (req, res, next) => {
  try {
    const result = await queryNeon('DELETE FROM service_catalog_products WHERE product_id = ?', [String(req.params.productId)]);
    if (!result.rowCount) return res.status(404).json({ success: false, message: 'Product not found.' });
    json(res, { deleted: true });
  } catch (error) { next(error); }
};

export const reviewAgentCatalogProduct = async (req, res, next) => {
  try {
    if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const productId = String(req.params.productId || '');
    const status = String(req.body?.status || '').toLowerCase();
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be approved or rejected.' });
    }
    const productResult = await queryNeon(`
      SELECT product_id, owner_user_id, approval_status
      FROM service_catalog_products
      WHERE product_id = ? AND owner_user_id IS NOT NULL
    `, [productId]);
    const product = productResult.rows[0];
    if (!product) return res.status(404).json({ success: false, message: 'Agent catalog product not found.' });
    if (product.approval_status !== 'pending') {
      return res.status(409).json({ success: false, message: 'This product has already been reviewed.' });
    }
    const update = await queryNeon(`
      UPDATE service_catalog_products
      SET approval_status = ?, published = ?, updated_at = CURRENT_TIMESTAMP::text
      WHERE product_id = ? AND approval_status = 'pending'
    `, [status, status === 'approved', productId]);
    if (update.rowCount !== 1) return res.status(409).json({ success: false, message: 'This product has already been reviewed.' });
    const savedResult = await queryNeon(`SELECT ${PRODUCT_FIELDS} FROM service_catalog_products WHERE product_id = ?`, [productId]);
    const saved = savedResult.rows[0];
    return json(res, parseProduct(saved, true));
  } catch (error) { next(error); }
};

export const getPromotions = async (req, res, next) => {
  try {
    const audienceStatus = String(req.query.audienceStatus || 'all').toLowerCase();
    if (!PROMOTION_AUDIENCES.has(audienceStatus)) {
      return res.status(400).json({ success: false, message: 'Choose a valid promotion audience.' });
    }
    const { rows } = await queryNeon(`
      SELECT ${PROMOTION_FIELDS} FROM promotions
      WHERE is_hidden = false AND (audience_status = 'all' OR audience_status = ?)
      ORDER BY pinned DESC, created_at DESC
    `, [audienceStatus]);
    json(res, rows.map(row => ({
      ...row,
      alert_enabled: Boolean(row.alert_enabled),
      pinned: Boolean(row.pinned),
      popup_enabled: Boolean(row.popup_enabled),
      is_hidden: Boolean(row.is_hidden),
    })));
  } catch (error) { next(error); }
};

const promotionInput = body => {
  const title = String(body?.title || '').trim();
  const message = String(body?.message || '').trim();
  const imageData = body?.imageData == null ? null : String(body.imageData);
  const audioData = body?.audioData == null ? null : String(body.audioData);
  const buttonText = String(body?.buttonText || '').trim();
  const buttonUrl = String(body?.buttonUrl || '').trim();
  const backgroundColor = String(body?.backgroundColor ?? '');
  const audienceStatus = String(body?.audienceStatus || 'all');
  const badgeText = String(body?.badgeText || '').trim();
  if (!title || title.length > 160 || message.length > 1200 || (imageData && imageData.length > 1800000) ||
      (audioData && (audioData.length > 8500000 || !/^data:audio\/[a-z0-9.+-]+(?:;[^,]*)?;base64,[a-z0-9+/]+=*$/i.test(audioData))) ||
      buttonText.length > 60 || buttonUrl.length > 500 ||
      (backgroundColor !== '' && !/^#[0-9a-f]{6}$/i.test(backgroundColor)) ||
      !PROMOTION_AUDIENCES.has(audienceStatus) || badgeText.length > 60 ||
      (buttonUrl && !/^https?:\/\//i.test(buttonUrl) && !/^\/(?!\/)/.test(buttonUrl))) {
    return null;
  }
  return {
    title, message, imageData, audioData, buttonText: buttonText || null, buttonUrl: buttonUrl || null,
    backgroundColor, audienceStatus, badgeText: badgeText || null,
    alertEnabled: Boolean(body.alertEnabled),
    pinned: Boolean(body.pinned),
    popupEnabled: Boolean(body.popupEnabled),
  };
};

export const getRootPromotions = async (req, res, next) => {
  try {
    const { rows } = await queryNeon(`SELECT ${PROMOTION_FIELDS} FROM promotions ORDER BY pinned DESC, created_at DESC`);
    json(res, rows.map(row => ({
      ...row,
      alert_enabled: Boolean(row.alert_enabled),
      pinned: Boolean(row.pinned),
      popup_enabled: Boolean(row.popup_enabled),
      is_hidden: Boolean(row.is_hidden),
    })));
  } catch (error) { next(error); }
};

export const saveRootPromotion = async (req, res, next) => {
  try {
    const fields = promotionInput(req.body);
    if (!fields) return res.status(400).json({ success: false, message: 'Check the promotion title, text, image, audio, color, audience, and button link.' });
    const promotionId = randomUUID();
    await queryNeon(`
      INSERT INTO promotions (
        promotion_id, title, message, image_data, audio_data, button_text, button_url,
        background_color, audience_status, badge_text, alert_enabled, pinned, popup_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [promotionId, fields.title, fields.message, fields.imageData, fields.audioData, fields.buttonText,
      fields.buttonUrl, fields.backgroundColor, fields.audienceStatus, fields.badgeText, fields.alertEnabled, fields.pinned, fields.popupEnabled]);
    const { rows } = await queryNeon(`SELECT ${PROMOTION_FIELDS} FROM promotions WHERE promotion_id = ?`, [promotionId]);
    json(res, rows[0], 201);
  } catch (error) { next(error); }
};

export const updateRootPromotion = async (req, res, next) => {
  try {
    const promotionId = String(req.params.promotionId);
    const currentResult = await queryNeon(`SELECT ${PROMOTION_FIELDS} FROM promotions WHERE promotion_id = ?`, [promotionId]);
    const current = currentResult.rows[0];
    if (!current) return res.status(404).json({ success: false, message: 'Promotion not found.' });
    if (req.body?.isHidden !== undefined) {
      await queryNeon('UPDATE promotions SET is_hidden = ?, updated_at = CURRENT_TIMESTAMP::text WHERE promotion_id = ?',
        [Boolean(req.body.isHidden), promotionId]);
    } else {
      const fields = promotionInput(req.body);
      if (!fields) return res.status(400).json({ success: false, message: 'Check the promotion title, text, image, audio, color, audience, and button link.' });
      await queryNeon(`
        UPDATE promotions SET title = ?, message = ?, image_data = ?, audio_data = ?, button_text = ?, button_url = ?,
          background_color = ?, audience_status = ?, badge_text = ?, alert_enabled = ?, pinned = ?,
          popup_enabled = ?,
          updated_at = CURRENT_TIMESTAMP::text
        WHERE promotion_id = ?
      `, [fields.title, fields.message, fields.imageData, fields.audioData, fields.buttonText, fields.buttonUrl,
        fields.backgroundColor, fields.audienceStatus, fields.badgeText, fields.alertEnabled, fields.pinned, fields.popupEnabled, promotionId]);
    }
    const savedResult = await queryNeon(`SELECT ${PROMOTION_FIELDS} FROM promotions WHERE promotion_id = ?`, [promotionId]);
    const saved = savedResult.rows[0];
    if (!saved) return res.status(404).json({ success: false, message: 'Promotion not found.' });
    json(res, {
      ...saved,
      alert_enabled: Boolean(saved.alert_enabled),
      pinned: Boolean(saved.pinned),
      popup_enabled: Boolean(saved.popup_enabled),
      is_hidden: Boolean(saved.is_hidden),
    });
  } catch (error) { next(error); }
};

export const deleteRootPromotion = async (req, res, next) => {
  try {
    const result = await queryNeon('DELETE FROM promotions WHERE promotion_id = ?', [String(req.params.promotionId)]);
    if (!result.rowCount) return res.status(404).json({ success: false, message: 'Promotion not found.' });
    json(res, { deleted: true });
  } catch (error) { next(error); }
};

export const requestPostBoost = async (req, res, next) => {
  try {
    const postId = String(req.body?.postId || '');
    const amount = Number(req.body?.amount);
    const paymentMethod = String(req.body?.paymentMethod || '').trim();
    const paymentReference = String(req.body?.paymentReference || '').trim();
    const paymentProof = req.body?.paymentProof ? String(req.body.paymentProof) : null;
    if (!postId || !Number.isFinite(amount) || amount <= 0 || amount > 100000000 ||
        !paymentMethod || paymentMethod.length > 80 || !paymentReference || paymentReference.length > 160 ||
        (paymentProof && paymentProof.length > 1800000)) {
      return res.status(400).json({ success: false, message: 'Enter a valid boost amount, payment method, and payment reference.' });
    }
    const userId = String(req.user.id);
    const postResult = await queryNeon('SELECT post_id, user_id, visibility, product_name, product_url FROM social_posts WHERE post_id = ?', [postId]);
    const post = postResult.rows[0];
    if (!post || post.user_id !== userId) return res.status(404).json({ success: false, message: 'Your product post was not found.' });
    if (post.visibility !== 'public') {
      return res.status(400).json({ success: false, message: 'Only public posts can be boosted.' });
    }
    const requestId = randomUUID();
    await queryNeon(`
      INSERT INTO boost_requests (request_id, post_id, user_id, amount, payment_method, payment_reference, payment_proof)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [requestId, postId, userId, Math.round(amount * 100) / 100, paymentMethod, paymentReference, paymentProof]);
    const savedResult = await queryNeon(`
      SELECT b.request_id, b.post_id, b.amount, b.payment_method, b.payment_reference, b.payment_proof, b.status, b.created_at,
        p.product_name, p.product_url
      FROM boost_requests b JOIN social_posts p ON p.post_id = b.post_id WHERE b.request_id = ?
    `, [requestId]);
    json(res, savedResult.rows[0], 201);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'A boost request already exists for this post.' });
    }
    next(error);
  }
};

export const getMyBoostRequests = async (req, res, next) => {
  try {
    const { rows } = await queryNeon(`
      SELECT b.request_id, b.post_id, b.amount, b.payment_method, b.payment_reference, b.status, b.created_at,
        p.product_name, p.product_url
      FROM boost_requests b JOIN social_posts p ON p.post_id = b.post_id
      WHERE b.user_id = ? ORDER BY b.created_at DESC
    `, [String(req.user.id)]);
    json(res, rows);
  } catch (error) { next(error); }
};

export const getRootBoostRequests = async (req, res, next) => {
  try {
    const { rows } = await queryNeon(`
      SELECT b.request_id, b.post_id, b.user_id, b.amount, b.payment_method, b.payment_reference, b.payment_proof,
        b.status, b.created_at, p.product_name, p.product_url, p.content,
        u.username, u.full_name
      FROM boost_requests b
      JOIN social_posts p ON p.post_id = b.post_id
      LEFT JOIN users u ON u._id::text = b.user_id
      ORDER BY CASE b.status WHEN 'pending' THEN 0 ELSE 1 END, b.created_at DESC
    `);
    json(res, rows);
  } catch (error) { next(error); }
};

export const updateRootBoostRequest = async (req, res, next) => {
  try {
    const status = String(req.body?.status || '');
    if (!['approved', 'rejected', 'unboosted'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Choose approve, reject, or unboost for this request.' });
    }
    const requestId = String(req.params.requestId);
    const requestResult = await queryNeon('SELECT request_id, user_id, post_id, status FROM boost_requests WHERE request_id = ?', [requestId]);
    const request = requestResult.rows[0];
    if (!request) return res.status(404).json({ success: false, message: 'Boost request not found.' });
    await withNeonTransaction(async client => {
      await client.query(
        'UPDATE boost_requests SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE request_id = $2',
        [status, requestId]
      );
      if (status !== request.status) {
        const message = status === 'approved'
          ? 'Your post boost was approved and is now visible across the feed and marketplace.'
          : status === 'unboosted'
            ? 'Your post boost has been removed.'
            : 'Your post boost request was not approved.';
        await client.query(`
          INSERT INTO social_notifications (notification_id, user_id, actor_id, type, message, link)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          randomUUID(),
          request.user_id,
          String(req.user.id),
          `boost_${status}`,
          message,
          `/feed?post=${encodeURIComponent(request.post_id)}`
        ]);
      }
    });
    const savedResult = await queryNeon('SELECT request_id, post_id, user_id, amount, status, updated_at FROM boost_requests WHERE request_id = ?', [requestId]);
    json(res, savedResult.rows[0]);
  } catch (error) { next(error); }
};
