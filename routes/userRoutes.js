import express from 'express';
import {
  createUser,
  getAllUsers,
  updateUser,
  toggleUserStatus,
  deleteUser
} from '../controllers/userController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// User management routes
router.post('/', authorize('root', 'admin', 'Root', 'Admin'), createUser);
router.get('/', getAllUsers);
router.put('/:id', authorize('root', 'admin', 'Root', 'Admin'), updateUser);
router.patch('/:id/toggle-status', authorize('root', 'admin', 'Root', 'Admin'), toggleUserStatus);
router.delete('/:id', authorize('root', 'admin', 'Root', 'Admin'), deleteUser);

export default router;
