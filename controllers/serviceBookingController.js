import crypto from 'crypto';
import { randomUUID } from 'crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { queryNeon, toPostgresPlaceholders, withNeonTransaction } from '../config/neonDatabase.js';
import { rewardApprovedSale, settleMarketplaceSale } from './socialController.js';
import { getMarketplaceBookingDetails, getMarketplaceDeliveryDetails, getMarketplaceDigitalProduct, getMarketplaceSaleSplit } from './marketplaceController.js';

const COLLECTION = 'service_booking_requests';
const PROVIDER_SETTINGS_KEY = 'service_payment_providers';
const camelCaseColumn = value => value.toLowerCase();
const bookingColumnAliases = {
  requestid: 'requestId',
  customeruserid: 'customerUserId',
  itemid: 'itemId',
  itemname: 'itemName',
  paymenttype: 'paymentType',
  paymentlabel: 'paymentLabel',
  paymentmethod: 'paymentMethod',
  customername: 'customerName',
  customerphone: 'customerPhone',
  transactionreference: 'transactionReference',
  paymentaccount: 'paymentAccount',
  paymentstatus: 'paymentStatus',
  requestedat: 'requestedAt',
  approvedat: 'approvedAt',
  cancelledat: 'cancelledAt',
  deliveryrequested: 'deliveryRequested',
  deliveryfee: 'deliveryFee',
  deliverystatus: 'deliveryStatus',
  updatedat: 'updatedAt',
  customeremail: 'customerEmail',
  chapacheckouturl: 'chapaCheckoutUrl',
  productowneruserid: 'productOwnerUserId',
  productamount: 'productAmount',
  platformservicecharge: 'platformServiceCharge',
  platformfeepercent: 'platformFeePercent',
};
let bookingSchemaPromise;
const ensureBookingSchema = () => {
  if (!bookingSchemaPromise) {
    bookingSchemaPromise = Promise.all([
      queryNeon('ALTER TABLE service_booking_requests ADD COLUMN IF NOT EXISTS customeremail TEXT'),
      queryNeon('ALTER TABLE service_booking_requests ADD COLUMN IF NOT EXISTS chapacheckouturl TEXT'),
      queryNeon('ALTER TABLE service_booking_requests ADD COLUMN IF NOT EXISTS productowneruserid TEXT'),
      queryNeon('ALTER TABLE service_booking_requests ADD COLUMN IF NOT EXISTS productamount TEXT'),
      queryNeon('ALTER TABLE service_booking_requests ADD COLUMN IF NOT EXISTS platformservicecharge TEXT'),
      queryNeon('ALTER TABLE service_booking_requests ADD COLUMN IF NOT EXISTS platformfeepercent DOUBLE PRECISION'),
    ]).catch(error => {
      bookingSchemaPromise = null;
      throw error;
    });
  }
  return bookingSchemaPromise;
};
const bookingFromNeon = row => {
  if (!row) return null;
  const record = { ...row };
  for (const [column, alias] of Object.entries(bookingColumnAliases)) {
    if (Object.prototype.hasOwnProperty.call(row, column)) record[alias] = row[column];
  }
  if (typeof record.paymentAccount === 'string') {
    record.paymentAccount = JSON.parse(record.paymentAccount || '{}');
  }
  return record;
};
const insertBooking = async (record, client = null) => {
  await ensureBookingSchema();
  const valuesByColumn = new Map();
  for (const [key, value] of Object.entries(record)) {
    const column = camelCaseColumn(key);
    if (column === '_id') continue;
    valuesByColumn.set(column, key === 'paymentAccount' && typeof value !== 'string'
      ? JSON.stringify(value || {})
      : value);
  }
  const columns = [...valuesByColumn.keys()];
  const sql = `
    INSERT INTO ${COLLECTION} (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
    RETURNING *
  `;
  const result = client
    ? await client.query(toPostgresPlaceholders(sql), [...valuesByColumn.values()])
    : await queryNeon(sql, [...valuesByColumn.values()]);
  return bookingFromNeon(result.rows[0]);
};
const updateBooking = async (requestId, updates, conditions = '', params = []) => {
  const columns = Object.keys(updates);
  const result = await queryNeon(`
    UPDATE ${COLLECTION} SET
      ${columns.map(column => `${camelCaseColumn(column)} = ?`).join(', ')},
      updated_at = CURRENT_TIMESTAMP
    WHERE requestid = ? ${conditions}
    RETURNING *
  `, [...Object.values(updates), requestId, ...params]);
  return bookingFromNeon(result.rows[0]);
};
const listBookings = async (where = '', params = []) => {
  await ensureBookingSchema();
  const result = await queryNeon(`
    SELECT * FROM ${COLLECTION} ${where} ORDER BY requestedat DESC
  `, params);
  return result.rows.map(bookingFromNeon);
};
const getProviderSettings = async () => (await queryNeon(
  'SELECT configjson FROM service_payment_settings WHERE configkey = ?',
  [PROVIDER_SETTINGS_KEY],
)).rows[0];
const PAYMENT_METHODS = new Set(['Telebirr', 'Ebirr', 'CBE Birr', 'Bank', 'Chapa']);
const PAYMENT_TYPES = new Set(['serviceCharge', 'firstPayment', 'fullPayment']);
const CHAPA_API_URL = 'https://api.chapa.co/v1/transaction';
const CHAPA_PAYMENT_METHODS = new Set(['telebirr', 'cbe', 'amole', 'awash', 'mpesa']);
const DEFAULT_CHAPA_PAYMENT_METHODS = { telebirr: true, cbe: true, amole: false, awash: false, mpesa: false };
const DOWNLOAD_HOST_SUFFIXES = [
  '.google.com',
  '.googleusercontent.com',
  '.dropbox.com',
  '.dropboxusercontent.com',
  '.1drv.ms',
  '.live.com',
  '.onedrive.com',
  '.sharepoint.com',
];
const configKey = () => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET must be configured before saving payment provider secrets.');
  return crypto.createHash('sha256').update(process.env.JWT_SECRET).digest();
};
const encryptSecret = value => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', configKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
};
const decryptSecret = encrypted => {
  if (!encrypted) return '';
  const payload = JSON.parse(encrypted);
  const decipher = crypto.createDecipheriv('aes-256-gcm', configKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
};
const renderChapaReturn = (res, success) => res
  .status(success ? 200 : 400)
  .type('html')
  .send(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>REDSEA payment</title><body style="font:16px system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:24px;color:#1f2937"><h1>${success ? 'Payment verified' : 'Payment not verified'}</h1><p>${success ? 'Your payment was confirmed by Chapa. You may return to REDSEA.' : 'Chapa did not confirm this payment. If you were charged, contact REDSEA support with your transaction reference.'}</p><a href="/">Return to REDSEA</a></body></html>`);
const publicPaymentProviders = providers => providers.map(provider => {
  if (provider.id !== 'Chapa') return provider;
  const { chapaApiKeyEncrypted, chapaApiKey, ...safeProvider } = provider;
  return {
    ...safeProvider,
    chapaApiKey: '',
    chapaApiKeyConfigured: Boolean(chapaApiKeyEncrypted),
    chapaMethods: { ...DEFAULT_CHAPA_PAYMENT_METHODS, ...(provider.chapaMethods || {}) },
  };
});

const toResponse = record => {
  const {
    _id,
    updated_at,
    request_id,
    customer_user_id,
    item_id,
    item_name,
    payment_type,
    payment_label,
    payment_method,
    customer_name,
    customer_phone,
    transaction_reference,
    payment_status,
    requested_at,
    approved_at,
    cancelled_at,
    ...request
  } = record;
  const deliveryRequested = request.deliveryRequested === true || Number(request.deliveryRequested) === 1;
  return {
    ...request,
    deliveryRequested,
    deliveryFee: Number(request.deliveryFee || 0),
    deliveryStatus: request.deliveryStatus || (deliveryRequested ? 'requested' : 'not_requested'),
    paymentAccount: typeof request.paymentAccount === 'string'
      ? JSON.parse(request.paymentAccount || '{}')
      : request.paymentAccount || {},
  };
};

const isAllowedDownloadHost = hostname => DOWNLOAD_HOST_SUFFIXES.some(suffix =>
  hostname === suffix.slice(1) || hostname.endsWith(suffix)
);

const normalizeCloudDownloadUrl = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('This cloud download link is not supported. Use a public HTTPS file link.');
  }
  if (!isAllowedDownloadHost(url.hostname.toLowerCase())) {
    throw new Error('This cloud provider is not supported for in-app downloads. Use Google Drive, Dropbox, or OneDrive.');
  }

  if (url.hostname === 'drive.google.com' || url.hostname === 'docs.google.com') {
    const pathId = url.pathname.match(/\/(?:file\/d|document\/d|spreadsheets\/d|presentation\/d)\/([^/]+)/)?.[1];
    const fileId = pathId || url.searchParams.get('id');
    if (fileId) {
      const directUrl = new URL('https://drive.usercontent.google.com/download');
      directUrl.searchParams.set('id', fileId);
      directUrl.searchParams.set('export', 'download');
      directUrl.searchParams.set('confirm', 't');
      return directUrl;
    }
  }

  if (url.hostname.endsWith('dropbox.com')) url.searchParams.set('dl', '1');
  if (url.hostname === 'onedrive.live.com' && url.searchParams.has('resid')) {
    url.pathname = '/download';
  }
  return url;
};

const getDownloadFilename = (contentDisposition, fallback) => {
  const encodedFilename = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plainFilename = contentDisposition?.match(/filename="?([^";]+)"?/i)?.[1];
  let filename = fallback;
  try {
    if (encodedFilename) filename = decodeURIComponent(encodedFilename);
    else if (plainFilename) filename = plainFilename;
  } catch {
    filename = plainFilename || fallback;
  }
  return String(filename || 'digital-product')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim()
    .slice(0, 180) || 'digital-product';
};

const notifyBookingCustomer = (userId, requestId, itemName, digitalProduct, client = null) => {
  if (!userId) return Promise.resolve();
  const sql = `
    INSERT INTO social_notifications (notification_id, user_id, actor_id, type, message, link)
    VALUES (?, ?, NULL, 'service_booking', ?, ?)
  `;
  const params = [
    randomUUID(),
    String(userId),
    digitalProduct
      ? `${itemName} payment was approved. Your product is ready to open or download.`
      : `${itemName} payment was approved and your booking is confirmed.`,
    `/service-requests?tab=booked&open=${encodeURIComponent(requestId)}`,
  ];
  return client
    ? client.query(toPostgresPlaceholders(sql), params)
    : queryNeon(sql, params);
};

const fetchCloudDownload = async initialUrl => {
  let url = normalizeCloudDownloadUrl(initialUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(60000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || redirects === 5) {
      throw new Error('The cloud file provider returned an invalid or excessive redirect.');
    }
    url = normalizeCloudDownloadUrl(new URL(location, url).toString());
  }
  throw new Error('Could not reach the cloud file provider.');
};

export const createServiceBookingRequest = async (req, res, next) => {
  try {
    const {
      requestId,
      itemId,
      itemName,
      category,
      amount,
      paymentType,
      paymentLabel,
      paymentMethod,
      customerName,
      customerPhone,
      transactionReference,
      paymentAccount,
      deliveryRequested = false,
    } = req.body || {};

    if (
      !requestId || !itemName || !category ||
      String(requestId).length > 100 ||
      String(itemName).length > 200 ||
      String(category).length > 100 ||
      !Number.isFinite(Number(amount)) || Number(amount) <= 0 ||
      !PAYMENT_TYPES.has(paymentType) || String(paymentLabel || '').length > 80 ||
      !PAYMENT_METHODS.has(paymentMethod) ||
      !String(customerName || '').trim() || String(customerName).length > 160 ||
      !String(customerPhone || '').trim() || String(customerPhone).length > 40 ||
      !String(transactionReference || '').trim() || String(transactionReference).length > 160
    ) {
      return res.status(400).json({ success: false, message: 'Complete all booking and payment fields with a valid amount.' });
    }
    if (typeof deliveryRequested !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Choose whether you want delivery.' });
    }

    const normalizedRequestId = String(requestId);
    const normalizedCustomerUserId = String(req.user.id);
    const normalizedItemId = String(itemId || '');
    const normalizedItemName = String(itemName).trim();
    const normalizedPaymentType = String(paymentType);
    const normalizedPaymentLabel = String(paymentLabel).trim();
    const normalizedCustomerName = String(customerName).trim();
    const normalizedCustomerPhone = String(customerPhone).trim();
    const normalizedTransactionReference = String(transactionReference).trim();
    let deliveryDetails;
    try {
      deliveryDetails = await getMarketplaceDeliveryDetails(itemId, deliveryRequested);
    } catch (deliveryError) {
      return res.status(400).json({ success: false, message: deliveryError.message });
    }
    let marketplaceSplit = null;
    try {
      marketplaceSplit = await getMarketplaceSaleSplit(itemId, paymentType, amount);
    } catch (splitError) {
      return res.status(400).json({ success: false, message: splitError.message });
    }
    const requestedAt = new Date().toISOString();
    const request = {
      requestId: normalizedRequestId,
      request_id: normalizedRequestId,
      customerUserId: normalizedCustomerUserId,
      customer_user_id: normalizedCustomerUserId,
      itemId: normalizedItemId,
      item_id: normalizedItemId,
      itemName: normalizedItemName,
      item_name: normalizedItemName,
      category: String(category).trim(),
      amount: String(Number(amount)),
      paymentType: normalizedPaymentType,
      payment_type: normalizedPaymentType,
      paymentLabel: normalizedPaymentLabel,
      payment_label: normalizedPaymentLabel,
      paymentMethod,
      payment_method: paymentMethod,
      customerName: normalizedCustomerName,
      customer_name: normalizedCustomerName,
      customerPhone: normalizedCustomerPhone,
      customer_phone: normalizedCustomerPhone,
      transactionReference: normalizedTransactionReference,
      transaction_reference: normalizedTransactionReference,
      ...deliveryDetails,
      deliveryStatus: deliveryDetails.deliveryRequested ? 'requested' : 'not_requested',
      ...(marketplaceSplit || {}),
      paymentAccount: {
        accountName: String(paymentAccount?.accountName || '').slice(0, 160),
        phone: String(paymentAccount?.phone || '').slice(0, 40),
        accountNumber: String(paymentAccount?.accountNumber || '').slice(0, 80),
        bankName: String(paymentAccount?.bankName || '').slice(0, 120),
      },
      paymentStatus: 'submitted',
      payment_status: 'submitted',
      status: 'pending_approval',
      requestedAt,
      requested_at: requestedAt,
    };

    await insertBooking(request);
    return res.status(201).json({ success: true, data: request });
  } catch (error) {
    return next(error);
  }
};

const getAvailableRealWalletBalance = async (userId, client = null) => {
  const execute = (sql, params) => client
    ? client.query(toPostgresPlaceholders(sql), params)
    : queryNeon(sql, params);
  const real = await execute(`
    SELECT COALESCE(SUM(amount), 0) AS amount
    FROM wallet_ledger
    WHERE user_id = ? AND balance_type = 'real'
  `, [userId]);
  const withdrawals = await execute(`
    SELECT COALESCE(SUM(amount), 0) AS amount
    FROM wallet_withdrawals
    WHERE user_id = ? AND balance_type = 'real' AND status IN ('pending', 'approved')
  `, [userId]);
  const agentWithdrawals = await execute(`
    SELECT COALESCE(SUM(amount), 0) AS amount
    FROM agent_wallet_requests
    WHERE user_id = ? AND request_type = 'withdrawal' AND status = 'pending'
  `, [userId]);
  const realBalance = Number(real.rows[0].amount);
  const pendingWithdrawals = Number(withdrawals.rows[0].amount);
  const pendingAgentWithdrawals = Number(agentWithdrawals.rows[0].amount);
  return Math.max(0, Math.round((realBalance - pendingWithdrawals - pendingAgentWithdrawals) * 100) / 100);
};

export const getWalletBookingQuote = async (req, res, next) => {
  try {
    const { itemId, paymentType, deliveryRequested = false } = req.body || {};
    if (!String(itemId || '').trim() || String(itemId).length > 100 || !PAYMENT_TYPES.has(paymentType)) {
      return res.status(400).json({ success: false, message: 'Choose a valid catalog item and payment option.' });
    }
    let details;
    try {
      details = await getMarketplaceBookingDetails(itemId, paymentType);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
    let deliveryDetails;
    try {
      deliveryDetails = await getMarketplaceDeliveryDetails(itemId, deliveryRequested);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
    const availableBalance = await getAvailableRealWalletBalance(String(req.user.id));
    return res.json({
      success: true,
      data: {
        amount: details.amount,
        productAmount: details.productAmount,
        platformServiceCharge: details.platformServiceCharge,
        deliveryRequested: deliveryDetails.deliveryRequested,
        deliveryFee: deliveryDetails.deliveryFee,
        availableBalance,
        currency: 'ETB',
        canBook: availableBalance >= Number(details.amount),
      },
    });
  } catch (error) {
    return next(error);
  }
};

export const createWalletServiceBooking = async (req, res, next) => {
  try {
    const {
      requestId,
      itemId,
      paymentType,
      customerName,
      customerPhone,
      deliveryRequested = false,
    } = req.body || {};
    if (
      !String(requestId || '').trim() || String(requestId).length > 100 ||
      !String(itemId || '').trim() || String(itemId).length > 100 ||
      !PAYMENT_TYPES.has(paymentType) ||
      !String(customerName || '').trim() || String(customerName).length > 160 ||
      !String(customerPhone || '').trim() || String(customerPhone).length > 40
    ) {
      return res.status(400).json({ success: false, message: 'Complete the booking details with a valid catalog item.' });
    }
    if (typeof deliveryRequested !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Choose whether you want delivery.' });
    }

    let details;
    try {
      details = await getMarketplaceBookingDetails(itemId, paymentType);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
    let deliveryDetails;
    try {
      deliveryDetails = await getMarketplaceDeliveryDetails(itemId, deliveryRequested);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
    const normalizedRequestId = String(requestId);
    const userId = String(req.user.id);
    const reference = `service-booking-wallet:${normalizedRequestId}`;
    const requestedAt = new Date().toISOString();
    const digitalProduct = await getMarketplaceDigitalProduct(details.itemId);
    await ensureBookingSchema();
    const booking = await withNeonTransaction(async client => {
      await client.query('SELECT _id FROM users WHERE _id::text = $1 FOR UPDATE', [userId]);
      const existingResult = await client.query(
        'SELECT * FROM service_booking_requests WHERE requestid = $1 FOR UPDATE',
        [normalizedRequestId],
      );
      const existing = bookingFromNeon(existingResult.rows[0]);
      if (existing) {
        if (String(existing.customerUserId) !== userId ||
            existing.paymentMethod !== 'REDSEA Wallet' ||
            existing.itemId !== String(itemId) ||
            existing.paymentType !== paymentType ||
            Boolean(Number(existing.deliveryRequested)) !== deliveryDetails.deliveryRequested) {
          const conflict = new Error('This booking request ID has already been used.');
          conflict.status = 409;
          throw conflict;
        }
        return { ...existing, alreadyBooked: true };
      }

      const availableBalance = await getAvailableRealWalletBalance(userId, client);
      const amount = Number(details.amount);
      if (availableBalance < amount) {
        const insufficient = new Error(`Insufficient real wallet balance. You have ETB ${availableBalance.toFixed(2)} available; ETB ${amount.toFixed(2)} is required.`);
        insufficient.status = 400;
        insufficient.code = 'INSUFFICIENT_WALLET_BALANCE';
        throw insufficient;
      }

      const charge = await client.query(toPostgresPlaceholders(`
        INSERT INTO wallet_ledger (
          entry_id, user_id, amount, entry_type, reference, description, currency, balance_type
        ) VALUES (?, ?, ?, 'service_booking_payment', ?, ?, 'ETB', 'real')
        ON CONFLICT (reference) DO NOTHING
        RETURNING entry_id
      `), [
        randomUUID(), userId, -amount, reference, `Wallet payment for ${details.itemName}`,
      ]);
      if (charge.rowCount !== 1) {
        const conflict = new Error('This booking request ID has already been used.');
        conflict.status = 409;
        throw conflict;
      }
      const bookingRequest = await insertBooking({
        requestId: normalizedRequestId,
        request_id: normalizedRequestId,
        customerUserId: userId,
        customer_user_id: userId,
        itemId: details.itemId,
        item_id: details.itemId,
        itemName: details.itemName,
        item_name: details.itemName,
        category: details.category,
        amount: details.amount,
        paymentType: details.paymentType,
        payment_type: details.paymentType,
        paymentLabel: details.paymentLabel,
        payment_label: details.paymentLabel,
        paymentMethod: 'REDSEA Wallet',
        payment_method: 'REDSEA Wallet',
        customerName: String(customerName).trim(),
        customer_name: String(customerName).trim(),
        customerPhone: String(customerPhone).trim(),
        customer_phone: String(customerPhone).trim(),
        transactionReference: reference,
        transaction_reference: reference,
        paymentAccount: {},
        paymentStatus: 'approved',
        payment_status: 'approved',
        status: 'confirmed',
        requestedAt,
        requested_at: requestedAt,
        approvedAt: requestedAt,
        approved_at: requestedAt,
        updatedAt: requestedAt,
        deliveryRequested: deliveryDetails.deliveryRequested ? 1 : 0,
        deliveryFee: deliveryDetails.deliveryFee,
        deliveryStatus: deliveryDetails.deliveryRequested ? 'requested' : 'not_requested',
        ...(details.marketplaceSplit || {}),
      }, client);
      await notifyBookingCustomer(userId, normalizedRequestId, details.itemName, Boolean(digitalProduct), client);
      return bookingRequest;
    });

    if (details.marketplaceSplit) {
      await settleMarketplaceSale(
        details.marketplaceSplit.productOwnerUserId,
        normalizedRequestId,
        Number(details.marketplaceSplit.productAmount),
        Number(details.marketplaceSplit.platformServiceCharge)
      );
    }
    await rewardApprovedSale(userId, normalizedRequestId, Number(details.amount));
    return res.status(booking.alreadyBooked ? 200 : 201).json({ success: true, data: toResponse(booking) });
  } catch (error) {
    if (error.code === 'INSUFFICIENT_WALLET_BALANCE' || error.status === 409) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    return next(error);
  }
};

export const initiateChapaServicePayment = async (req, res, next) => {
  try {
    const { itemName, category, itemId, amount, paymentType, paymentLabel, customerName, customerEmail, customerPhone, chapaMethod, deliveryRequested = false } = req.body || {};
    const numericAmount = Number(amount);
    if (
      !String(itemName || '').trim() || String(itemName).length > 200 ||
      !String(category || '').trim() || String(category).length > 100 ||
      !Number.isFinite(numericAmount) || numericAmount <= 0 ||
      !PAYMENT_TYPES.has(paymentType) || !String(customerName || '').trim() ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customerEmail || '').trim()) ||
      String(customerEmail).length > 254 ||
      !String(customerPhone || '').trim() || String(customerPhone).length > 40
    ) {
      return res.status(400).json({ success: false, message: 'Enter a valid amount, customer name, email, and phone number to start Chapa checkout.' });
    }
    if (typeof deliveryRequested !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Choose whether you want delivery.' });
    }
    let marketplaceSplit = null;
    try {
      marketplaceSplit = await getMarketplaceSaleSplit(itemId, paymentType, numericAmount);
    } catch (splitError) {
      return res.status(400).json({ success: false, message: splitError.message });
    }
    let deliveryDetails;
    try {
      deliveryDetails = await getMarketplaceDeliveryDetails(itemId, deliveryRequested);
    } catch (deliveryError) {
      return res.status(400).json({ success: false, message: deliveryError.message });
    }

    const settings = await getProviderSettings();
    const providers = settings?.configjson
      ? (typeof settings.configjson === 'string' ? JSON.parse(settings.configjson) : settings.configjson)
      : [];
    const chapa = providers.find(provider => provider.id === 'Chapa');
    if (!chapa?.automaticEnabled || chapa.serviceEnabled === false || !chapa.chapaApiKeyEncrypted || !chapa.chapaReturnUrl) {
      return res.status(503).json({ success: false, message: 'Automatic Chapa checkout is not fully configured or enabled.' });
    }
    if (chapaMethod && (!CHAPA_PAYMENT_METHODS.has(chapaMethod) ||
      chapa.chapaMethods?.[chapaMethod] === false ||
      (chapa.chapaMethods && chapa.chapaMethods[chapaMethod] !== true))) {
      return res.status(400).json({ success: false, message: 'That Chapa payment channel is not enabled for REDSEA checkout.' });
    }

    const transactionReference = `REDSEA-${randomUUID()}`;
    const requestedAt = new Date().toISOString();
    const customerPhoneDigits = String(customerPhone).replace(/\D/g, '');
    const ethiopianPhone = customerPhoneDigits.startsWith('251') && customerPhoneDigits.length === 12
      ? `0${customerPhoneDigits.slice(3)}`
      : customerPhoneDigits;
    const request = {
      requestId: transactionReference,
      request_id: transactionReference,
      customerUserId: String(req.user.id),
      customer_user_id: String(req.user.id),
      itemId: String(itemId || ''),
      item_id: String(itemId || ''),
      itemName: String(itemName).trim(),
      item_name: String(itemName).trim(),
      category: String(category).trim(),
      amount: String(numericAmount),
      paymentType,
      payment_type: paymentType,
      paymentLabel: String(paymentLabel || '').trim().slice(0, 80),
      payment_label: String(paymentLabel || '').trim().slice(0, 80),
      paymentMethod: 'Chapa',
      payment_method: 'Chapa',
      customerName: String(customerName).trim(),
      customer_name: String(customerName).trim(),
      customerEmail: String(customerEmail).trim().toLowerCase(),
      customerPhone: String(customerPhone).trim(),
      customer_phone: String(customerPhone).trim(),
      transactionReference,
      transaction_reference: transactionReference,
      ...deliveryDetails,
      deliveryStatus: deliveryDetails.deliveryRequested ? 'requested' : 'not_requested',
      ...(marketplaceSplit || {}),
      paymentAccount: {},
      paymentStatus: 'initiating',
      payment_status: 'initiating',
      status: 'pending_payment',
      requestedAt,
      requested_at: requestedAt,
    };
    await insertBooking(request);

    const returnUrl = new URL(chapa.chapaReturnUrl);
    returnUrl.searchParams.set('tx_ref', transactionReference);
    const payload = {
      amount: String(numericAmount),
      currency: 'ETB',
      email: request.customerEmail,
      first_name: request.customerName.split(/\s+/)[0],
      last_name: request.customerName.split(/\s+/).slice(1).join(' ') || request.customerName.split(/\s+/)[0],
      tx_ref: transactionReference,
      return_url: returnUrl.toString(),
      customization: {
        title: 'REDSEA Payment',
        description: request.itemName.slice(0, 100),
      },
      ...(ethiopianPhone.length === 10 && (ethiopianPhone.startsWith('09') || ethiopianPhone.startsWith('07'))
        ? { phone_number: ethiopianPhone }
        : {}),
      ...(chapaMethod ? { payment_options: chapaMethod } : {}),
    };

    try {
      const response = await fetch(`${CHAPA_API_URL}/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${decryptSecret(chapa.chapaApiKeyEncrypted)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      const checkoutUrl = result?.data?.checkout_url;
      if (!response.ok || result?.status !== 'success' || typeof checkoutUrl !== 'string') {
        await updateBooking(transactionReference, {
          paymentStatus: 'failed', payment_status: 'failed', status: 'payment_failed', updatedAt: new Date().toISOString(),
        });
        return res.status(502).json({ success: false, message: result?.message || `Chapa could not initialize checkout (${response.status}).` });
      }
      const parsedCheckoutUrl = new URL(checkoutUrl);
      if (parsedCheckoutUrl.protocol !== 'https:' || parsedCheckoutUrl.hostname !== 'checkout.chapa.co') {
        await updateBooking(transactionReference, {
          paymentStatus: 'failed', payment_status: 'failed', status: 'payment_failed', updatedAt: new Date().toISOString(),
        });
        return res.status(502).json({ success: false, message: 'Chapa returned an unexpected checkout URL.' });
      }
      await updateBooking(transactionReference, {
        paymentStatus: 'initiated', payment_status: 'initiated', chapaCheckoutUrl: checkoutUrl,
      });
      return res.json({ success: true, data: { checkoutUrl } });
    } catch (error) {
      await updateBooking(transactionReference, {
        paymentStatus: 'failed', payment_status: 'failed', status: 'payment_failed', updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  } catch (error) {
    return next(error);
  }
};

export const completeChapaServicePayment = async (req, res, next) => {
  try {
    const transactionReference = String(req.query.tx_ref || '').trim();
    if (!/^REDSEA-[a-f0-9-]{36}$/i.test(transactionReference)) {
      return renderChapaReturn(res, false);
    }
    await ensureBookingSchema();
    const request = bookingFromNeon((await queryNeon(
      'SELECT * FROM service_booking_requests WHERE requestid = ? AND paymentmethod = ?',
      [transactionReference, 'Chapa'],
    )).rows[0]);
    if (!request) return renderChapaReturn(res, false);
    const settings = await getProviderSettings();
    const providers = settings?.configjson
      ? (typeof settings.configjson === 'string' ? JSON.parse(settings.configjson) : settings.configjson)
      : [];
    const chapa = providers.find(provider => provider.id === 'Chapa');
    if (!chapa?.chapaApiKeyEncrypted) return renderChapaReturn(res, false);

    const response = await fetch(`${CHAPA_API_URL}/verify/${encodeURIComponent(transactionReference)}`, {
      headers: { Authorization: `Bearer ${decryptSecret(chapa.chapaApiKeyEncrypted)}` },
      signal: AbortSignal.timeout(15000),
    });
    const verification = await response.json();
    const payment = verification?.data;
    const verified = response.ok &&
      verification?.status === 'success' &&
      payment?.status === 'success' &&
      payment?.tx_ref === transactionReference &&
      String(payment?.currency || '').toUpperCase() === 'ETB' &&
      Number(payment?.amount) === Number(request.amount);
    if (!verified) return renderChapaReturn(res, false);

    const updatedAt = new Date().toISOString();
    if (request.productOwnerUserId) {
      await settleMarketplaceSale(
        request.productOwnerUserId,
        transactionReference,
        Number(request.productAmount),
        Number(request.platformServiceCharge)
      );
    }
    const result = await queryNeon(`
      UPDATE service_booking_requests
      SET paymentstatus = 'approved', payment_status = 'approved', status = 'confirmed',
        approvedat = ?, approved_at = ?, updatedat = ?, updated_at = CURRENT_TIMESTAMP
      WHERE requestid = ? AND paymentstatus <> 'approved'
      RETURNING requestid
    `, [updatedAt, updatedAt, updatedAt, transactionReference]);
    if (result.rowCount) {
      await rewardApprovedSale(request.customerUserId || request.customer_user_id, transactionReference, Number(request.amount));
      const digitalProduct = await getMarketplaceDigitalProduct(request.itemId || request.item_id);
      await notifyBookingCustomer(
        request.customerUserId || request.customer_user_id,
        transactionReference,
        request.itemName || request.item_name || 'Your product',
        Boolean(digitalProduct)
      );
    }
    return renderChapaReturn(res, true);
  } catch (error) {
    return next(error);
  }
};

export const getServiceBookingRequests = async (_req, res, next) => {
  try {
    const requests = await listBookings();
    return res.json({ success: true, data: requests.map(toResponse) });
  } catch (error) {
    return next(error);
  }
};

export const getMyServiceBookingRequests = async (req, res, next) => {
  try {
    const requests = await listBookings(
      'WHERE customeruserid = ? OR customer_user_id = ?',
      [String(req.user.id), String(req.user.id)],
    );
    const responseRequests = await Promise.all(requests.map(async record => {
      const request = toResponse(record);
      const product = await getMarketplaceDigitalProduct(request.itemId || request.item_id);
      return {
        ...request,
        digitalProductAvailable: Boolean(product),
        digitalProduct: Boolean(product),
        downloadFilename: product?.downloadFilename || '',
      };
    }));
    return res.json({ success: true, data: responseRequests });
  } catch (error) {
    return next(error);
  }
};

const getOwnedBooking = async (req, requestId) => {
  await ensureBookingSchema();
  const userId = String(req.user.id);
  const request = bookingFromNeon((await queryNeon(`
    SELECT * FROM service_booking_requests
    WHERE requestid = ? AND (customeruserid = ? OR customer_user_id = ?)
  `, [requestId, userId, userId])).rows[0]);
  return request ? toResponse(request) : null;
};

const streamApprovedDigitalProduct = async (req, res, disposition) => {
  const requestId = String(req.params.requestId || '');
  if (!requestId || requestId.length > 120) {
    return res.status(400).json({ success: false, message: 'A valid service request ID is required.' });
  }
  const request = await getOwnedBooking(req, requestId);
  if (!request) {
    return res.status(404).json({ success: false, message: 'Approved digital product request not found.' });
  }
  if ((request.paymentStatus || request.payment_status) !== 'approved' ||
      !['confirmed', 'approved'].includes(request.status)) {
    return res.status(403).json({ success: false, message: 'The product is available after payment approval.' });
  }

  const product = await getMarketplaceDigitalProduct(request.itemId || request.item_id);
  if (!product) {
    return res.status(404).json({ success: false, message: 'The digital product file is no longer available.' });
  }
  let upstream;
  try {
    upstream = await fetchCloudDownload(product.downloadUrl);
  } catch (downloadError) {
    return res.status(502).json({ success: false, message: downloadError.message });
  }
  if (!upstream.ok || !upstream.body) {
    return res.status(502).json({ success: false, message: 'The cloud file could not be loaded. Check that the shared file is accessible.' });
  }

  const filename = getDownloadFilename(upstream.headers.get('content-disposition'), product.downloadFilename);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  await pipeline(Readable.fromWeb(upstream.body), res);
};

export const downloadApprovedDigitalProduct = async (req, res, next) => {
  try {
    return await streamApprovedDigitalProduct(req, res, 'attachment');
  } catch (error) {
    return next(error);
  }
};

export const previewApprovedDigitalProduct = async (req, res, next) => {
  try {
    return await streamApprovedDigitalProduct(req, res, 'inline');
  } catch (error) {
    return next(error);
  }
};

export const updateServiceBookingRequest = async (req, res, next) => {
  try {
    await ensureBookingSchema();
    const { status, deliveryStatus } = req.body || {};
    const hasPaymentUpdate = status !== undefined;
    const hasDeliveryUpdate = deliveryStatus !== undefined;
    if ((!hasPaymentUpdate && !hasDeliveryUpdate) ||
        (hasPaymentUpdate && !['approved', 'cancelled'].includes(status)) ||
        (hasDeliveryUpdate && !['requested', 'preparing', 'out_for_delivery', 'delivered'].includes(deliveryStatus))) {
      return res.status(400).json({ success: false, message: 'Choose a valid payment or delivery status.' });
    }

    const requestId = String(req.params.requestId);
    const request = bookingFromNeon((await queryNeon(`
      SELECT * FROM service_booking_requests WHERE requestid = ?
    `, [requestId])).rows[0]);
    if (!request) return res.status(404).json({ success: false, message: 'Service booking request not found.' });
    if (hasPaymentUpdate && request.paymentMethod === 'REDSEA Wallet') {
      return res.status(409).json({ success: false, message: 'Wallet bookings are already paid and cannot be changed here.' });
    }
    if (hasDeliveryUpdate && !Boolean(Number(request.deliveryRequested))) {
      return res.status(400).json({ success: false, message: 'This booking does not include a delivery request.' });
    }

    const timestamp = new Date().toISOString();
    const changes = {};
    if (hasPaymentUpdate) Object.assign(changes, status === 'approved'
      ? { paymentStatus: 'approved', payment_status: 'approved', status: 'confirmed', approvedAt: timestamp }
      : { paymentStatus: 'cancelled', payment_status: 'cancelled', status: 'cancelled', cancelledAt: timestamp });
    if (hasDeliveryUpdate) {
      changes.deliveryStatus = deliveryStatus;
    }
    if (status === 'approved' && request.productOwnerUserId &&
        request.status !== 'confirmed' && request.paymentStatus !== 'approved') {
      await settleMarketplaceSale(
        request.productOwnerUserId,
        requestId,
        Number(request.productAmount),
        Number(request.platformServiceCharge)
      );
    }
    const updatedRequest = await updateBooking(
      requestId,
      { ...changes, updatedAt: timestamp },
      hasPaymentUpdate ? "AND COALESCE(paymentstatus, '') <> 'approved' AND COALESCE(payment_status, '') <> 'approved'" : '',
    );
    if (!updatedRequest) {
      return res.status(409).json({ success: false, message: 'This booking has already been approved or changed.' });
    }

    if (status === 'approved' &&
        !request.productOwnerUserId && request.status !== 'confirmed' && request.paymentStatus !== 'approved') {
      await rewardApprovedSale(request.customerUserId || request.customer_user_id, requestId, Number(request.amount));
    }
    if (status === 'approved') {
      const digitalProduct = await getMarketplaceDigitalProduct(request.itemId || request.item_id);
      await notifyBookingCustomer(
        request.customerUserId || request.customer_user_id,
        requestId,
        request.itemName || request.item_name || 'Your product',
        Boolean(digitalProduct)
      );
    }

    return res.json({ success: true, data: toResponse(updatedRequest) });
  } catch (error) {
    return next(error);
  }
};

export const getServicePaymentProviders = async (_req, res, next) => {
  try {
    const settings = await getProviderSettings();
    const savedProviders = settings?.configjson
      ? (typeof settings.configjson === 'string' ? JSON.parse(settings.configjson) : settings.configjson)
      : null;
    const providers = Array.isArray(savedProviders) ? publicPaymentProviders(savedProviders) : savedProviders;
    return res.json({ success: true, data: providers });
  } catch (error) {
    return next(error);
  }
};

export const saveServicePaymentProviders = async (req, res, next) => {
  try {
    const { providers } = req.body || {};
    if (
      !Array.isArray(providers) ||
      providers.length !== PAYMENT_METHODS.size ||
      providers.some(provider =>
        !PAYMENT_METHODS.has(provider?.id) ||
        !String(provider.name || '').trim() ||
        String(provider.name).length > 100 ||
        String(provider.accountName || '').length > 160 ||
        String(provider.phone || '').length > 40 ||
        String(provider.accountNumber || '').length > 80 ||
        String(provider.bankName || '').length > 120 ||
        String(provider.ussdTemplate || '').length > 200 ||
        String(provider.logo || '').length > 80000 ||
        String(provider.chapaApiKey || '').length > 500 ||
        String(provider.chapaReturnUrl || '').length > 500 ||
        (provider.id === 'Chapa' && typeof provider.automaticEnabled !== 'boolean') ||
        (provider.id === 'Chapa' && provider.chapaMethods !== undefined &&
          (!provider.chapaMethods || typeof provider.chapaMethods !== 'object' || Array.isArray(provider.chapaMethods) ||
            Object.entries(provider.chapaMethods).some(([method, enabled]) =>
              !CHAPA_PAYMENT_METHODS.has(method) || typeof enabled !== 'boolean'))) ||
        !Array.isArray(provider.accounts) ||
        provider.accounts.length < 1 ||
        provider.accounts.length > 20 ||
        provider.accounts.some(account =>
          !String(account.accountName || '').trim() ||
          String(account.accountName).length > 160 ||
          String(account.phone || '').length > 40 ||
          String(account.accountNumber || '').length > 80 ||
          String(account.bankName || '').length > 120 ||
          String(account.ussdTemplate || '').length > 200 ||
          (account.serviceEnabled !== undefined && typeof account.serviceEnabled !== 'boolean') ||
          (account.utilityEnabled !== undefined && typeof account.utilityEnabled !== 'boolean') ||
          (account.walletEnabled !== undefined && typeof account.walletEnabled !== 'boolean')
        )
      )
    ) {
      return res.status(400).json({ success: false, message: 'Provide valid settings and at least one account for each payment provider.' });
    }

    const existingSettings = await getProviderSettings();
    const existingProviders = existingSettings?.configjson
      ? (typeof existingSettings.configjson === 'string' ? JSON.parse(existingSettings.configjson) : existingSettings.configjson)
      : [];
    const normalizedProviders = providers.map(provider => {
      if (provider.id !== 'Chapa') return provider;
      let chapaReturnUrl = String(provider.chapaReturnUrl || '').trim();
      if (chapaReturnUrl) {
        let parsedUrl;
        try { parsedUrl = new URL(chapaReturnUrl); } catch {
          return null;
        }
        if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) return null;
        chapaReturnUrl = parsedUrl.toString();
      }
      const existing = existingProviders.find(item => item.id === 'Chapa');
      const apiKey = String(provider.chapaApiKey || '').trim();
      const chapaApiKeyEncrypted = apiKey ? encryptSecret(apiKey) : existing?.chapaApiKeyEncrypted || '';
      const requestedChapaMethods = provider.chapaMethods || existing?.chapaMethods || DEFAULT_CHAPA_PAYMENT_METHODS;
      if (Object.entries(requestedChapaMethods).some(([method, enabled]) =>
        !CHAPA_PAYMENT_METHODS.has(method) || typeof enabled !== 'boolean')) return null;
      const chapaMethods = {
        ...DEFAULT_CHAPA_PAYMENT_METHODS,
        ...requestedChapaMethods,
      };
      if (provider.automaticEnabled && (!chapaApiKeyEncrypted || !chapaReturnUrl)) return null;
      const { chapaApiKey: _chapaApiKey, chapaApiKeyConfigured: _configured, ...publicProvider } = provider;
      return { ...publicProvider, chapaReturnUrl, chapaApiKeyEncrypted, chapaMethods };
    });
    if (normalizedProviders.some(provider => provider === null)) {
      return res.status(400).json({ success: false, message: 'Automatic Chapa payments require an API key and a valid HTTPS return URL.' });
    }
    const configJson = JSON.stringify(normalizedProviders);
    const updatedAt = new Date().toISOString();
    await queryNeon(`
      INSERT INTO service_payment_settings (configkey, configjson, updatedat)
      VALUES (?, ?, ?)
      ON CONFLICT (configkey) DO UPDATE
      SET configjson = EXCLUDED.configjson, updatedat = EXCLUDED.updatedat
    `, [PROVIDER_SETTINGS_KEY, configJson, updatedAt]);
    return res.json({ success: true, data: publicPaymentProviders(normalizedProviders) });
  } catch (error) {
    return next(error);
  }
};
