import express from 'express';
import {
  getDashboardStats,
  getRecentActivity,
  getAllUsers,
  getAllPartners,
  getAllTransactions,
  getSystemLogs,
  getHealthStatus,
  autoFixDatabase
} from '../controllers/rootControllerMongoDB.js';
import { authenticate } from '../middleware/auth.js';
import {
  approveRootGuestUpgrade,
  getOtpSettings,
  getRootGuestUpgradeRequests,
  requireRootOtpAccess,
  saveOtpSettings,
  testTelegramOtpSettings,
} from '../controllers/otpController.js';
import {
  getRootWalletData,
  adjustWalletBalance,
  updateRootWalletSettings,
  updateWithdrawal,
  updateDeposit
} from '../controllers/socialController.js';
import {
  deleteRootMarketplaceProduct,
  deleteRootPromotion,
  getRootBoostRequests,
  getRootMarketplaceProducts,
  getRootPromotions,
  requireMarketplaceRoot,
  saveRootMarketplaceProduct,
  saveRootPromotion,
  updateRootBoostRequest,
  updateRootMarketplaceProduct,
  updateRootPromotion
} from '../controllers/marketplaceController.js';
import {
  getRootUtilityPaymentRequests,
  updateRootUtilityPaymentRequest,
} from '../controllers/utilityPaymentController.js';
import { getSiteContent, saveSiteContent } from '../controllers/siteContentController.js';

const router = express.Router();

// Health check and auto-fix routes (no auth required for health check)
router.get('/health', getHealthStatus);
router.post('/auto-fix', authenticate, autoFixDatabase);
router.get('/site-content', getSiteContent);

// All other root routes require authentication
router.use(authenticate);
router.use(requireRootOtpAccess);
router.use(requireMarketplaceRoot);

// Dashboard routes
router.get('/stats', getDashboardStats);
router.get('/activity', getRecentActivity);

// Management routes
router.get('/users', getAllUsers);
router.get('/partners', getAllPartners);
router.get('/transactions', getAllTransactions);
router.get('/logs', getSystemLogs);
router.get('/wallet-management', getRootWalletData);
router.put('/wallet-management/settings', updateRootWalletSettings);
router.post('/wallet-management/adjustments', adjustWalletBalance);
router.patch('/wallet-management/withdrawals/:withdrawalId', updateWithdrawal);
router.patch('/wallet-management/deposits/:depositId', updateDeposit);
router.get('/otp-settings', getOtpSettings);
router.put('/otp-settings', saveOtpSettings);
router.put('/site-content', saveSiteContent);
router.post('/otp-settings/test-telegram', testTelegramOtpSettings);
router.get('/otp/upgrade-requests', getRootGuestUpgradeRequests);
router.post('/otp/upgrade-requests/:requestId/approve', approveRootGuestUpgrade);
router.get('/utility-payments', getRootUtilityPaymentRequests);
router.patch('/utility-payments/:requestId', updateRootUtilityPaymentRequest);
router.get('/marketplace/products', getRootMarketplaceProducts);
router.post('/marketplace/products', saveRootMarketplaceProduct);
router.patch('/marketplace/products/:productId', updateRootMarketplaceProduct);
router.delete('/marketplace/products/:productId', deleteRootMarketplaceProduct);
router.get('/promotions', getRootPromotions);
router.post('/promotions', saveRootPromotion);
router.patch('/promotions/:promotionId', updateRootPromotion);
router.delete('/promotions/:promotionId', deleteRootPromotion);
router.get('/boost-requests', getRootBoostRequests);
router.patch('/boost-requests/:requestId', updateRootBoostRequest);

export default router;
