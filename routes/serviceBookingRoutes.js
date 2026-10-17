import express from 'express';
import { authorize, authenticate } from '../middleware/auth.js';
import {
  createServiceBookingRequest,
  getServiceBookingRequests,
  getMyServiceBookingRequests,
  updateServiceBookingRequest,
  getServicePaymentProviders,
  saveServicePaymentProviders
} from '../controllers/serviceBookingController.js';

const router = express.Router();

router.post('/requests', authenticate, createServiceBookingRequest);
router.get('/payment-providers', getServicePaymentProviders);

router.get('/requests/mine', authenticate, getMyServiceBookingRequests);
router.use(authenticate, authorize('admin', 'root'));
router.get('/requests', getServiceBookingRequests);
router.patch('/requests/:requestId', updateServiceBookingRequest);
router.put('/payment-providers', saveServicePaymentProviders);

export default router;
