import express from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  acceptMiniRide,
  confirmMiniRideCash,
  createMiniRideRequest,
  finishMiniRide,
  getAvailableMiniRideDrivers,
  getDriverApplicationStatus,
  getDriverMiniRideDashboard,
  getMiniRideDetails,
  getMyMiniRides,
  startMiniRide,
  submitDriverApplication,
  submitMiniRidePayment,
  updateMiniRideDriverStatus,
  updateMiniRideLocation,
} from '../controllers/miniRideController.js';

const router = express.Router();
router.use(authenticate);

router.get('/drivers', getAvailableMiniRideDrivers);
router.get('/mine', getMyMiniRides);
router.get('/driver/application', getDriverApplicationStatus);
router.post('/driver/application', submitDriverApplication);
router.get('/driver/dashboard', getDriverMiniRideDashboard);
router.put('/driver/status', updateMiniRideDriverStatus);
router.post('/rides', createMiniRideRequest);
router.get('/rides/:rideId', getMiniRideDetails);
router.post('/rides/:rideId/accept', acceptMiniRide);
router.post('/rides/:rideId/start', startMiniRide);
router.post('/rides/:rideId/finish', finishMiniRide);
router.post('/rides/:rideId/location', updateMiniRideLocation);
router.post('/rides/:rideId/payment', submitMiniRidePayment);
router.post('/rides/:rideId/cash-confirmation', confirmMiniRideCash);

export default router;
