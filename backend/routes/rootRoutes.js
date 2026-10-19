import express from 'express';
import {
  getDashboardStats,
  getRootDashboardStatus,
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
  configureTelegramContactWebhook,
  getOtpSettings,
  getRootGuestUpgradeRequests,
  requireRootOtpAccess,
  saveOtpSettings,
  testTelegramOtpSettings,
} from '../controllers/otpController.js';
import {
  getRootWalletData,
  getRootWithdrawalReceipt,
  getRootWalletActivity,
  getRootUserActivity,
  getRootCoinLevelRules,
  saveRootCoinLevelRules,
  getRootCoinLevelHistory,
  adjustWalletBalance,
  updateRootWalletSettings,
  updateWithdrawal,
  updateDeposit
} from '../controllers/socialController.js';
import { createRootPromoCode, createRootPromoCodeBatch, getRootPromoCodes } from '../controllers/promoCodeController.js';
import {
  deleteRootMarketplaceProduct,
  deleteRootPromotion,
  getRootBoostRequests,
  getRootMarketplaceProducts,
  getRootMarketplaceSettings,
  getRootPromotions,
  reviewAgentCatalogProduct,
  requireMarketplaceRoot,
  saveRootMarketplaceProduct,
  saveRootMarketplaceSettings,
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
import {
  getRootLinkCampaigns,
  getRootLinkCampaignSettings,
  reviewRootLinkCampaign,
  saveRootLinkCampaignSettings,
} from '../controllers/linkCampaignController.js';
import {
  getRootDailyGameRewardSettings,
  saveRootDailyGameRewardSettings,
} from '../controllers/dailyGameRewardController.js';
import {
  fundAgentPackagePool,
  adjustAgentPackageBalance,
  adjustAgentWalletBalance,
  getAgentPlatformAnalytics,
  getRootAgentDetails,
  getRootAgentDetailsStatus,
  getRootAgentManagement,
  getAgentWalletRequestReceipt,
  reviewAgentProduct,
  reviewAgentPackageRequest,
  updateAgentSettings,
} from '../controllers/agentController.js';
import {
  assignMiniRideDriver,
  adjustMiniRideDriverWallet,
  getRootDriverApplications,
  getRootMiniRideData,
  reviewDriverApplication,
  reviewMiniRidePayment,
  rootFinishMiniRide,
  updateRootMiniRideSettings,
} from '../controllers/miniRideController.js';

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
router.get('/dashboard-status', getRootDashboardStatus);
router.get('/activity', getRecentActivity);

// Management routes
router.get('/users', getAllUsers);
router.get('/partners', getAllPartners);
router.get('/transactions', getAllTransactions);
router.get('/logs', getSystemLogs);
router.get('/wallet-management', getRootWalletData);
router.get('/wallet-management/withdrawals/:withdrawalId/receipt', getRootWithdrawalReceipt);
router.get('/wallet-management/activity', getRootWalletActivity);
router.get('/user-activity', getRootUserActivity);
router.get('/coin-level-rules', getRootCoinLevelRules);
router.put('/coin-level-rules', saveRootCoinLevelRules);
router.get('/coin-level-history', getRootCoinLevelHistory);
router.put('/wallet-management/settings', updateRootWalletSettings);
router.post('/wallet-management/adjustments', adjustWalletBalance);
router.patch('/wallet-management/withdrawals/:withdrawalId', updateWithdrawal);
router.patch('/wallet-management/deposits/:depositId', updateDeposit);
router.get('/otp-settings', getOtpSettings);
router.put('/otp-settings', saveOtpSettings);
router.put('/site-content', saveSiteContent);
router.post('/otp-settings/test-telegram', testTelegramOtpSettings);
router.post('/otp-settings/configure-telegram-webhook', configureTelegramContactWebhook);
router.get('/otp/upgrade-requests', getRootGuestUpgradeRequests);
router.post('/otp/upgrade-requests/:requestId/approve', approveRootGuestUpgrade);
router.get('/utility-payments', getRootUtilityPaymentRequests);
router.patch('/utility-payments/:requestId', updateRootUtilityPaymentRequest);
router.get('/marketplace/products', getRootMarketplaceProducts);
router.post('/marketplace/products', saveRootMarketplaceProduct);
router.get('/marketplace/settings', getRootMarketplaceSettings);
router.put('/marketplace/settings', saveRootMarketplaceSettings);
router.patch('/marketplace/products/:productId', updateRootMarketplaceProduct);
router.delete('/marketplace/products/:productId', deleteRootMarketplaceProduct);
router.get('/promotions', getRootPromotions);
router.post('/promotions', saveRootPromotion);
router.patch('/promotions/:promotionId', updateRootPromotion);
router.delete('/promotions/:promotionId', deleteRootPromotion);
router.get('/promo-codes', getRootPromoCodes);
router.post('/promo-codes/batch', createRootPromoCodeBatch);
router.post('/promo-codes', createRootPromoCode);
router.get('/boost-requests', getRootBoostRequests);
router.get('/link-campaigns', getRootLinkCampaigns);
router.get('/link-campaign-settings', getRootLinkCampaignSettings);
router.put('/link-campaign-settings', saveRootLinkCampaignSettings);
router.get('/daily-game-reward-settings', getRootDailyGameRewardSettings);
router.put('/daily-game-reward-settings', saveRootDailyGameRewardSettings);
router.get('/mini-rides', getRootMiniRideData);
router.get('/driver-applications', getRootDriverApplications);
router.patch('/driver-applications/:applicationId', reviewDriverApplication);
router.put('/mini-rides/settings', updateRootMiniRideSettings);
router.post('/mini-rides/drivers/:driverId/wallet-adjustments', adjustMiniRideDriverWallet);
router.patch('/mini-rides/:rideId/assign', assignMiniRideDriver);
router.post('/mini-rides/:rideId/finish', rootFinishMiniRide);
router.patch('/mini-rides/:rideId/payment', reviewMiniRidePayment);
router.patch('/link-campaigns/:campaignId', reviewRootLinkCampaign);
router.patch('/boost-requests/:requestId', updateRootBoostRequest);
router.get('/agents', getRootAgentManagement);
router.get('/agents/analytics', getAgentPlatformAnalytics);
router.get('/agents/:agentId/status', getRootAgentDetailsStatus);
router.patch('/agents/products/:productId', reviewAgentProduct);
router.patch('/agents/service-products/:productId', reviewAgentCatalogProduct);
router.get('/agents/wallet-requests/:requestId/receipt', getAgentWalletRequestReceipt);
router.post('/agents/:agentId/package-adjustments', adjustAgentPackageBalance);
router.post('/agents/:agentId/wallet-adjustments', adjustAgentWalletBalance);
router.get('/agents/:agentId', getRootAgentDetails);
router.put('/agents/:agentId/settings', updateAgentSettings);
router.post('/agents/package-pool', fundAgentPackagePool);
router.patch('/agents/package-requests/:requestId', reviewAgentPackageRequest);

export default router;
