import express from 'express';
import {
  getAllClients,
  getClientById,
  createClient,
  updateClient,
  deleteClient
} from '../controllers/clientController.mongodb.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Get all clients
router.get('/', getAllClients);

// Get client by ID
router.get('/:id', getClientById);

// Create new client (staff and above)
router.post('/', authorize('admin', 'manager', 'agent', 'staff'), createClient);

// Update client (staff and above)
router.put('/:id', authorize('admin', 'manager', 'agent', 'staff'), updateClient);

// Delete client (admin and manager only)
router.delete('/:id', authorize('admin', 'manager'), deleteClient);

export default router;
