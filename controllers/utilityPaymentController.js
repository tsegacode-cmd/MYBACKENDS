import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { queryNeon, withNeonTransaction } from '../config/neonDatabase.js';

const json = (res, data, status = 200) => res.status(status).json({ success: true, data });
const MAX_PROOF_LENGTH = 3_000_000;
const isRoot = req => req.user?.isRoot === true;

export const createUtilityGuestSession = (req, res, next) => {
  try {
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET must be configured before guest utility payments can be used.');
    const token = jwt.sign({
      id: randomUUID(),
      role: 'utility_guest',
      tokenPurpose: 'utility-payment-guest',
    }, process.env.JWT_SECRET, { expiresIn: '30d' });
    json(res, { token }, 201);
  } catch (error) { next(error); }
};

const ensureSchema = async () => queryNeon(`
  CREATE TABLE IF NOT EXISTS utility_payment_requests (
    request_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'request'
      CHECK (status IN ('request', 'approved', 'receipt', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
  )
`);

const parseRequest = row => {
  const payload = JSON.parse(row.payload_json);
  return {
    ...payload,
    id: row.request_id,
    status: row.status,
    requestedAt: payload.requestedAt || row.created_at,
    updatedAt: row.updated_at,
  };
};

const validateProof = proof => {
  if (proof == null) return true;
  if (!proof || typeof proof !== 'object' || typeof proof.dataUrl !== 'string' ||
      proof.dataUrl.length > MAX_PROOF_LENGTH || typeof proof.name !== 'string' ||
      proof.name.length > 160) return false;
  return /^data:(application\/pdf|image\/(?:jpeg|png|webp|gif));base64,[A-Za-z0-9+/]+={0,2}$/i.test(proof.dataUrl);
};

const normalizePhone = value => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.startsWith('251') && digits.length === 12 ? `0${digits.slice(3)}` : digits;
};

export const getMyUtilityPaymentRequests = async (req, res, next) => {
  try {
    await ensureSchema();
    const { rows } = await queryNeon(`
      SELECT request_id, payload_json, status, created_at, updated_at
      FROM utility_payment_requests
      WHERE user_id = ?
      ORDER BY created_at DESC
    `, [String(req.user.id)]);
    json(res, rows.map(parseRequest));
  } catch (error) { next(error); }
};

export const createUtilityPaymentRequest = async (req, res, next) => {
  try {
    await ensureSchema();
    const data = req.body || {};
    const amount = Number(data.amount);
    const paymentMethod = String(data.paymentMethod || '').trim();
    const transactionReference = String(data.transactionReference || '').trim();
    if (!data.card || typeof data.card !== 'object' ||
        !data.phoneEntry || typeof data.phoneEntry !== 'object' ||
        !Number.isFinite(amount) || amount <= 0 || amount > 100_000_000 ||
        !paymentMethod || paymentMethod.length > 80 ||
        !transactionReference || transactionReference.length > 160 ||
        !validateProof(data.paymentReceiptPdf) || !validateProof(data.paymentReceiptImage)) {
      return res.status(400).json({ success: false, message: 'Enter valid payment details and attach a supported proof file.' });
    }

    const requestId = randomUUID();
    const now = new Date().toISOString();
    const payload = {
      cardId: String(data.card.id || '').slice(0, 200),
      registrationId: data.card.registrationId ? String(data.card.registrationId).slice(0, 100) : null,
      cardTitle: String(data.card.title || '').trim().slice(0, 160),
      category: String(data.card.category || '').trim().slice(0, 100),
      phone: String(data.phoneEntry.phone || '').trim().slice(0, 24),
      ownerName: String(data.phoneEntry.ownerName || '').trim().slice(0, 120),
      amount: Math.round(amount * 100) / 100,
      paymentMethod,
      paymentAccount: data.paymentAccount && typeof data.paymentAccount === 'object' ? data.paymentAccount : {},
      transactionReference,
      paymentReceiptPdf: data.paymentReceiptPdf || null,
      paymentReceiptImage: data.paymentReceiptImage || null,
      customerName: String(data.customerName || '').trim().slice(0, 120),
      customerPhone: String(data.customerPhone || data.phoneEntry.phone || '').trim().slice(0, 24),
      requestedAt: now,
      approvedAt: null,
      receiptNumber: '',
      receiptAt: null,
      manualReceipt: '',
      receiptPdf: null,
    };
    if (!payload.cardTitle || !/^[0-9+\-\s]{6,24}$/.test(payload.phone)) {
      return res.status(400).json({ success: false, message: 'Choose a valid service and phone number.' });
    }
    if (payload.registrationId) {
      if (!/^\d+$/.test(payload.registrationId)) {
        return res.status(400).json({ success: false, message: 'The linked project registration is invalid.' });
      }
      const registrationResult = await queryNeon(
        'SELECT _id, client_phone FROM data_registrations WHERE _id = ?',
        [payload.registrationId]
      );
      const registration = registrationResult.rows[0];
      if (!registration) return res.status(404).json({ success: false, message: 'The linked project registration was not found.' });
      if (normalizePhone(registration.client_phone) !== normalizePhone(payload.phone)) {
        return res.status(403).json({ success: false, message: 'The selected project registration does not match this payment phone number.' });
      }
    }
    await queryNeon(`
      INSERT INTO utility_payment_requests (request_id, user_id, payload_json, status)
      VALUES (?, ?, ?, 'request')
    `, [requestId, String(req.user.id), JSON.stringify(payload)]);
    const savedResult = await queryNeon(`
      SELECT request_id, payload_json, status, created_at, updated_at
      FROM utility_payment_requests WHERE request_id = ?
    `, [requestId]);
    json(res, parseRequest(savedResult.rows[0]), 201);
  } catch (error) { next(error); }
};

export const getRootUtilityPaymentRequests = async (req, res, next) => {
  try {
    await ensureSchema();
    if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const { rows } = await queryNeon(`
      SELECT r.request_id, r.user_id, r.payload_json, r.status, r.created_at, r.updated_at,
        COALESCE(u.username, '') AS username
      FROM utility_payment_requests r
      LEFT JOIN users u ON u._id::text = r.user_id
      ORDER BY CASE r.status WHEN 'request' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, r.created_at DESC
    `);
    const requests = rows.map(row => ({ ...parseRequest(row), userId: row.user_id, username: row.username }));
    json(res, requests);
  } catch (error) { next(error); }
};

export const updateRootUtilityPaymentRequest = async (req, res, next) => {
  try {
    await ensureSchema();
    if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access required.' });
    const requestId = String(req.params.requestId || '');
    const status = String(req.body?.status || '');
    const currentResult = await queryNeon(`
      SELECT request_id, user_id, payload_json, status, created_at, updated_at
      FROM utility_payment_requests WHERE request_id = ?
    `, [requestId]);
    const current = currentResult.rows[0];
    if (!current) return res.status(404).json({ success: false, message: 'Utility payment request not found.' });

    const payload = JSON.parse(current.payload_json);
    let message;
    let notificationType;
    if (status === 'approved') {
      if (current.status !== 'request') return res.status(409).json({ success: false, message: 'Only pending payment requests can be approved.' });
      payload.approvedAt = new Date().toISOString();
      message = `Your utility payment for ${payload.cardTitle} has been approved. The receipt is awaiting final approval.`;
      notificationType = 'utility_payment_approved';
    } else if (status === 'receipt') {
      const manualReceipt = String(req.body?.manualReceipt || '').trim();
      const receiptPdf = req.body?.receiptPdf;
      if (current.status !== 'approved') return res.status(409).json({ success: false, message: 'Approve the payment before approving its receipt.' });
      const receiptNumber = String(req.body?.receiptNumber || '').trim();
      if (!manualReceipt || manualReceipt.length > 160 || !/^[A-Z0-9-]{3,40}$/i.test(receiptNumber) || typeof receiptPdf !== 'string' ||
          receiptPdf.length > MAX_PROOF_LENGTH ||
          !/^data:application\/pdf;(?:filename=[^;,]+;)?base64,[A-Za-z0-9+/]+={0,2}$/i.test(receiptPdf)) {
        return res.status(400).json({ success: false, message: 'Enter a valid manual receipt number and PDF receipt.' });
      }
      payload.manualReceipt = manualReceipt;
      payload.receiptNumber = receiptNumber;
      payload.receiptAt = new Date().toISOString();
      payload.receiptPdf = receiptPdf;
      if (payload.registrationId) {
        const registrationResult = await queryNeon('SELECT _id FROM data_registrations WHERE _id = ?', [payload.registrationId]);
        const registration = registrationResult.rows[0];
        if (!registration) return res.status(404).json({ success: false, message: 'The linked project registration no longer exists.' });
      }
      message = `Your approved receipt ${payload.receiptNumber} for ${payload.cardTitle} is ready.`;
      notificationType = 'utility_receipt_approved';
    } else if (status === 'cancelled') {
      if (!['request', 'approved'].includes(current.status)) return res.status(409).json({ success: false, message: 'This utility request can no longer be cancelled.' });
      payload.cancelledAt = new Date().toISOString();
      message = `Your utility payment request for ${payload.cardTitle} was cancelled.`;
      notificationType = 'utility_payment_cancelled';
    } else {
      return res.status(400).json({ success: false, message: 'Choose payment approval, receipt approval, or cancellation.' });
    }

    const saved = await withNeonTransaction(async client => {
      const update = await client.query(`
        UPDATE utility_payment_requests
        SET payload_json = $1, status = $2, updated_at = CURRENT_TIMESTAMP::text
        WHERE request_id = $3 AND status = $4
      `, [JSON.stringify(payload), status, requestId, current.status]);
      if (!update.rowCount) return false;
      if (status === 'receipt' && payload.registrationId) {
        await client.query(`
          UPDATE data_registrations
          SET payment_status = 'paid', updated_at = CURRENT_TIMESTAMP::text
          WHERE _id = $1
        `, [payload.registrationId]);
      }
      await client.query(`
        INSERT INTO social_notifications (notification_id, user_id, actor_id, type, message, link)
        VALUES ($1, $2, $3, $4, $5, '/service-requests')
      `, [randomUUID(), current.user_id, String(req.user.id), notificationType, message]);
      return true;
    });
    if (!saved) return res.status(409).json({ success: false, message: 'This utility request was changed by another administrator. Refresh and try again.' });
    const savedResult = await queryNeon(`
      SELECT request_id, user_id, payload_json, status, created_at, updated_at
      FROM utility_payment_requests WHERE request_id = ?
    `, [requestId]);
    json(res, parseRequest(savedResult.rows[0]));
  } catch (error) { next(error); }
};
