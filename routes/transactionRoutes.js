import express from 'express';
import {
  getAllTransactions,
  getFixedTransactionById,
  getMovableTransactionById,
  createFixedTransaction,
  createMovableTransaction,
  updateFixedTransaction,
  updateMovableTransaction
} from '../controllers/transactionController.mongodb.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Get all transactions
router.get('/', getAllTransactions);

// Fixed transactions
router.get('/fixed/:id', getFixedTransactionById);
router.post('/fixed', authorize('admin', 'manager', 'agent', 'staff'), createFixedTransaction);
router.put('/fixed/:id', authorize('admin', 'manager', 'agent', 'staff'), updateFixedTransaction);

// Movable transactions
router.get('/movable/:id', getMovableTransactionById);
router.post('/movable', authorize('admin', 'manager', 'agent', 'staff'), createMovableTransaction);
router.put('/movable/:id', authorize('admin', 'manager', 'agent', 'staff'), updateMovableTransaction);

export default router;
