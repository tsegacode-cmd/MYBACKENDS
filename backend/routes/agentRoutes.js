import express from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  createAgentChildAccount,
  createAgentCommissionRecord,
  createAgentProduct,
  createAgentWalletRequest,
  getActiveAgents,
  getAgentDashboard,
  getAgentDashboardStatus,
  getAgentTeamMemberActivity,
  getAgentWalletRequestReceipt,
  getMyAgentWalletRequests,
  reviewAgentWalletRequest,
  requestAgentPackageFunds,
  updateAgentProduct,
} from '../controllers/agentController.js';

const router = express.Router();
router.use(authenticate);

router.get('/active', getActiveAgents);
router.get('/wallet-requests/mine', getMyAgentWalletRequests);
router.get('/wallet-requests/:requestId/receipt', getAgentWalletRequestReceipt);
router.post('/wallet-requests', createAgentWalletRequest);
router.patch('/wallet-requests/:requestId', reviewAgentWalletRequest);
router.get('/dashboard', getAgentDashboard);
router.get('/dashboard/status', getAgentDashboardStatus);
router.get('/team/:userId/activity', getAgentTeamMemberActivity);
router.post('/commissions', createAgentCommissionRecord);
router.post('/products', createAgentProduct);
router.patch('/products/:productId', updateAgentProduct);
router.post('/package-requests', requestAgentPackageFunds);
router.post('/children', createAgentChildAccount);

export default router;
