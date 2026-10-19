import express from 'express';
import {
  getDashboardStats,
  getMonthlyRevenue,
  getAgentPerformance,
  getServicePerformance,
  getRecentActivities
} from '../controllers/dashboardController.mongodb.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Dashboard statistics
router.get('/stats', getDashboardStats);

// Monthly revenue report
router.get('/revenue/monthly', authorize('admin', 'manager'), getMonthlyRevenue);

// Agent performance
router.get('/performance/agents', authorize('admin', 'manager'), getAgentPerformance);

// Service type performance
router.get('/performance/services', authorize('admin', 'manager'), getServicePerformance);

// Recent activities
router.get('/activities', getRecentActivities);

export default router;
