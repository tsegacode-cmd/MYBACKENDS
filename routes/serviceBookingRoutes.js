import express from 'express';
import { authorize, authenticate } from '../middleware/auth.js';
import {
  createServiceBookingRequest,
  getWalletBookingQuote,
  createWalletServiceBooking,
  getServiceBookingRequests,
  getMyServiceBookingRequests,
  downloadApprovedDigitalProduct,
  previewApprovedDigitalProduct,
  updateServiceBookingRequest,
  getServicePaymentProviders,
  saveServicePaymentProviders,
  initiateChapaServicePayment,
  completeChapaServicePayment,
} from '../controllers/serviceBookingController.js';

const router = express.Router();

router.post('/requests', authenticate, createServiceBookingRequest);
router.post('/wallet/quote', authenticate, getWalletBookingQuote);
router.post('/wallet/requests', authenticate, createWalletServiceBooking);
router.get('/payment-providers', getServicePaymentProviders);
router.post('/chapa/initialize', authenticate, initiateChapaServicePayment);
router.get('/chapa/return', completeChapaServicePayment);

router.get('/requests/mine', authenticate, getMyServiceBookingRequests);
router.get('/requests/:requestId/preview', authenticate, previewApprovedDigitalProduct);
router.get('/requests/:requestId/download', authenticate, downloadApprovedDigitalProduct);
router.use(authenticate, authorize('admin', 'root'));
router.get('/requests', getServiceBookingRequests);
router.patch('/requests/:requestId', updateServiceBookingRequest);
router.put('/payment-providers', saveServicePaymentProviders);

export default router;
