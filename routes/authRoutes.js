import express from 'express';
import { login, getProfile, updateProfile, changePassword, rootLogin, verifyRoot } from '../controllers/authController.js';
import { registerAccount } from '../controllers/socialController.js';
import {
  createUtilityGuestSession,
  createUtilityPaymentRequest,
  getMyUtilityPaymentRequests,
} from '../controllers/utilityPaymentController.js';
import { authenticate, authenticateUtilityRequest } from '../middleware/auth.js';
import {
  getTelegramLinkStatus,
  getPublicOtpConfig,
  createGuestUpgradeRequest,
  getGuestUpgradeStatus,
  verifyGuestUpgradeOtp,
  sendOtp,
  startTelegramLink,
  telegramMiniAppLogin,
  telegramWidgetLogin,
  verifyOtp,
  verifyFirebaseOtp,
  verifyTelegramLink,
} from '../controllers/otpController.js';

const router = express.Router();

// Public routes
router.post('/login', login);
router.post('/root/login', rootLogin);
router.get('/otp/config', getPublicOtpConfig);
router.post('/otp/upgrade-requests', createGuestUpgradeRequest);
router.get('/otp/upgrade-requests/:requestId', getGuestUpgradeStatus);
router.post('/otp/upgrade-requests/:requestId/verify', verifyGuestUpgradeOtp);
router.post('/otp/send', sendOtp);
router.post('/otp/verify', verifyOtp);
router.post('/otp/firebase/verify', verifyFirebaseOtp);
router.post('/telegram/miniapp/login', telegramMiniAppLogin);
router.post('/telegram/widget/login', telegramWidgetLogin);
router.post('/register', registerAccount);
router.post('/utility-guest-session', createUtilityGuestSession);

// Protected routes
router.get('/me', authenticate, getProfile); // Get current user data (for permission refresh)
router.get('/profile', authenticate, getProfile);
router.put('/profile', authenticate, updateProfile);
router.get('/utility-payments', authenticateUtilityRequest, getMyUtilityPaymentRequests);
router.post('/utility-payments', authenticateUtilityRequest, createUtilityPaymentRequest);
router.get('/telegram/link', authenticate, getTelegramLinkStatus);
router.post('/telegram/link', authenticate, startTelegramLink);
router.post('/telegram/link/verify', authenticate, verifyTelegramLink);
router.post('/change-password', authenticate, changePassword);
router.get('/root/verify', authenticate, verifyRoot);

export default router;
