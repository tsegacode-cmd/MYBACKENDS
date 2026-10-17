import { getMongoDB } from '../config/databaseManager.js';
import { rewardApprovedSale } from './socialController.js';

const COLLECTION = 'service_booking_requests';
const SETTINGS_COLLECTION = 'service_payment_settings';
const PROVIDER_SETTINGS_KEY = 'service_payment_providers';
const PAYMENT_METHODS = new Set(['Telebirr', 'Ebirr', 'CBE Birr', 'Bank']);
const PAYMENT_TYPES = new Set(['serviceCharge', 'firstPayment', 'fullPayment']);

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
  return {
    ...request,
    paymentAccount: typeof request.paymentAccount === 'string'
      ? JSON.parse(request.paymentAccount || '{}')
      : request.paymentAccount || {},
  };
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
      paymentAccount
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

    const normalizedRequestId = String(requestId);
    const normalizedCustomerUserId = String(req.user.id);
    const normalizedItemId = String(itemId || '');
    const normalizedItemName = String(itemName).trim();
    const normalizedPaymentType = String(paymentType);
    const normalizedPaymentLabel = String(paymentLabel).trim();
    const normalizedCustomerName = String(customerName).trim();
    const normalizedCustomerPhone = String(customerPhone).trim();
    const normalizedTransactionReference = String(transactionReference).trim();
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

    const db = getMongoDB();
    await db.collection(COLLECTION).insertOne(request);
    return res.status(201).json({ success: true, data: request });
  } catch (error) {
    return next(error);
  }
};

export const getServiceBookingRequests = async (_req, res, next) => {
  try {
    const db = getMongoDB();
    const requests = await db.collection(COLLECTION).find().sort({ requestedAt: -1 }).toArray();
    return res.json({ success: true, data: requests.map(toResponse) });
  } catch (error) {
    return next(error);
  }
};

export const getMyServiceBookingRequests = async (req, res, next) => {
  try {
    const db = getMongoDB();
    const requests = await db.collection(COLLECTION)
      .find({ $or: [
        { customerUserId: String(req.user.id) },
        { customer_user_id: String(req.user.id) },
      ] })
      .sort({ requestedAt: -1 })
      .toArray();
    return res.json({ success: true, data: requests.map(toResponse) });
  } catch (error) {
    return next(error);
  }
};

export const updateServiceBookingRequest = async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!['approved', 'cancelled'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Booking payment status must be approved or cancelled.' });
    }

    const db = getMongoDB();
    const collection = db.collection(COLLECTION);
    const requestId = String(req.params.requestId);
    const requestQuery = { $or: [{ requestId }, { request_id: requestId }] };
    const request = await collection.findOne(requestQuery);
    if (!request) {
      return res.status(404).json({ success: false, message: 'Service booking request not found.' });
    }

    const timestamp = new Date().toISOString();
    const changes = status === 'approved'
      ? { paymentStatus: 'approved', status: 'confirmed', approvedAt: timestamp }
      : { paymentStatus: 'cancelled', status: 'cancelled', cancelledAt: timestamp };
    await collection.updateOne(requestQuery, { $set: { ...changes, updatedAt: timestamp } });

    if (status === 'approved' && request.status !== 'confirmed' && request.paymentStatus !== 'approved') {
      rewardApprovedSale(request.customerUserId || request.customer_user_id, requestId, Number(request.amount));
    }

    return res.json({ success: true, data: { ...request, ...changes, updatedAt: timestamp } });
  } catch (error) {
    return next(error);
  }
};

export const getServicePaymentProviders = async (_req, res, next) => {
  try {
    const db = getMongoDB();
    const settings = await db.collection(SETTINGS_COLLECTION).findOne({ configKey: PROVIDER_SETTINGS_KEY });
    const providers = settings?.configJson
      ? (typeof settings.configJson === 'string' ? JSON.parse(settings.configJson) : settings.configJson)
      : null;
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
        !Array.isArray(provider.accounts) ||
        provider.accounts.length < 1 ||
        provider.accounts.length > 20 ||
        provider.accounts.some(account =>
          !String(account.accountName || '').trim() ||
          String(account.accountName).length > 160 ||
          String(account.phone || '').length > 40 ||
          String(account.accountNumber || '').length > 80 ||
          String(account.bankName || '').length > 120 ||
          String(account.ussdTemplate || '').length > 200
        )
      )
    ) {
      return res.status(400).json({ success: false, message: 'Provide valid settings and at least one account for each payment provider.' });
    }

    const db = getMongoDB();
    const collection = db.collection(SETTINGS_COLLECTION);
    const configJson = JSON.stringify(providers);
    const updatedAt = new Date().toISOString();
    const result = await collection.updateOne(
      { configKey: PROVIDER_SETTINGS_KEY },
      { $set: { configJson, updatedAt } }
    );
    if (!result.matchedCount) {
      await collection.insertOne({ configKey: PROVIDER_SETTINGS_KEY, configJson, updatedAt });
    }
    return res.json({ success: true, data: providers });
  } catch (error) {
    return next(error);
  }
};
