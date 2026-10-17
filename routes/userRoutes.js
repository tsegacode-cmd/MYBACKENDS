import express from 'express';
import {
  createUser,
  getAllUsers,
  updateUser,
  toggleUserStatus,
  deleteUser
} from '../controllers/userController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// User management routes
router.post('/', createUser);
router.get('/', getAllUsers);
router.put('/:id', updateUser);
router.patch('/:id/toggle-status', toggleUserStatus);
router.delete('/:id', deleteUser);

export default router;
