import express from 'express';
import {
  createRegistration,
  getAllRegistrations,
  getRegistrationById,
  getRegistrationImage,
  updateRegistration,
  deleteRegistration,
  getProjectTitleSettings,
  saveProjectTitleSettings,
  getProjectDocuments,
  saveProjectDocument,
  deleteProjectDocument,
  getBankReceiptDocument,
  getOwnerReceiptDocument
} from '../controllers/dataRegistrationController.js';

const router = express.Router();

// Create new data registration
router.post('/', createRegistration);

// Get all data registrations
router.get('/', getAllRegistrations);

// Get single registration by ID
router.get('/:id/image', getRegistrationImage);
router.get('/:id', getRegistrationById);
router.get('/:id/bank-receipt', getBankReceiptDocument);
router.get('/:id/owner-receipt', getOwnerReceiptDocument);

// Update data registration
router.put('/:id', updateRegistration);

// Delete data registration
router.delete('/:id', deleteRegistration);
router.get('/settings/project-titles', getProjectTitleSettings);
router.put('/settings/project-titles', saveProjectTitleSettings);
router.get('/settings/project-documents', getProjectDocuments);
router.put('/settings/project-documents/:title', saveProjectDocument);
router.delete('/settings/project-documents/:title', deleteProjectDocument);

export default router;
