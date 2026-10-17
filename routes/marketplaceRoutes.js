import express from 'express';
import { getMarketplaceProducts, getPromotions } from '../controllers/marketplaceController.js';

const router = express.Router();

router.get('/products', getMarketplaceProducts);
router.get('/promotions', getPromotions);

export default router;
