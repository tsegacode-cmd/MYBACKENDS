import express from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  createMarketplaceProduct,
  getMarketplaceProducts,
  getMarketplaceSettings,
  getPromotions,
} from '../controllers/marketplaceController.js';

const router = express.Router();

router.get('/products', getMarketplaceProducts);
router.post('/products', authenticate, createMarketplaceProduct);
router.get('/settings', getMarketplaceSettings);
router.get('/promotions', getPromotions);

export default router;
