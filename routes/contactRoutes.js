import express from 'express';
import {
  getAllInquiries,
  getInquiryById,
  createInquiry,
  updateInquiry,
  deleteInquiry,
  getInquiryStats
} from '../controllers/contactController.mongodb.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

// Public route - no authentication required
router.post('/', createInquiry);

// Protected routes - require authentication
router.get('/', authenticate, getAllInquiries);
router.get('/stats', authenticate, authorize('admin', 'manager'), getInquiryStats);
router.get('/:id', authenticate, getInquiryById);
router.put('/:id', authenticate, authorize('admin', 'manager', 'agent', 'staff'), updateInquiry);
router.delete('/:id', authenticate, authorize('admin', 'manager'), deleteInquiry);

export default router;
