import { randomUUID } from 'crypto';
import { getRawSQLiteDB } from '../config/sqliteDatabase.js';
import { creditUserCoins } from './socialController.js';
import { recordPlatformPayout } from '../utils/platformFinance.js';

const db = () => getRawSQLiteDB();
const accountId = req => String(req.user.id);
const roleOf = req => String(req.user?.role || '').toLowerCase();
const isRoot = req => ['root', 'admin'].includes(roleOf(req));
const response = (res, data, status = 200) => res.status(status).json({ success: true, data });
const validCoordinates = (latitude, longitude) => (
  Number.isFinite(Number(latitude)) && Number(latitude) >= -90 && Number(latitude) <= 90 &&
  Number.isFinite(Number(longitude)) && Number(longitude) >= -180 && Number(longitude) <= 180
);
const distanceBetweenKm = (firstLat, firstLon, secondLat, secondLon) => {
  const radians = degrees => degrees * Math.PI / 180;
  const deltaLatitude = radians(secondLat - firstLat);
  const deltaLongitude = radians(secondLon - firstLon);
  const a = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(radians(firstLat)) * Math.cos(radians(secondLat)) *
    Math.sin(deltaLongitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const getSettings = () => db().prepare('SELECT * FROM mini_ride_settings WHERE id = 1').get();
const getRide = rideId => db().prepare(`
  SELECT r.*,
    passenger.username AS passenger_username,
    driver.username AS driver_username,
    COALESCE(driver.full_name, driver.username, 'Unassigned') AS driver_full_name
  FROM mini_rides r
  LEFT JOIN users passenger ON CAST(passenger._id AS TEXT) = r.passenger_user_id
  LEFT JOIN users driver ON CAST(driver._id AS TEXT) = r.driver_user_id
  WHERE r.ride_id = ?
`).get(String(rideId));
const sendNotification = (userId, actorId, type, message, link = '/mini-ride') => {
  db().prepare(`
    INSERT INTO social_notifications (notification_id, user_id, actor_id, type, message, link)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), String(userId), actorId == null ? null : String(actorId), type, message, link);
};
const notifyRoot = (actorId, message) => {
  const roots = db().prepare("SELECT _id FROM users WHERE LOWER(role) IN ('root', 'admin') AND is_active = 1").all();
  for (const root of roots) sendNotification(root._id, actorId, 'mini_ride', message, '/root/dashboard');
};
const getRideDetails = ride => ({
  ...ride,
  points: db().prepare(`
    SELECT user_id, role, latitude, longitude, recorded_at
    FROM mini_ride_location_points WHERE ride_id = ? ORDER BY recorded_at, rowid
  `).all(ride.ride_id),
});
const isRideParticipant = (ride, userId) => (
  String(ride.passenger_user_id) === String(userId) || String(ride.driver_user_id || '') === String(userId)
);
const driverIsOnline = userId => Boolean(db().prepare(`
  SELECT 1 FROM mini_ride_drivers
  WHERE user_id = ? AND is_online = 1 AND location_updated_at >= datetime('now', '-90 seconds')
`).get(String(userId)));

const sanitizeDriverApplication = application => {
  if (!application) return null
  return {
    ...application,
    agreement_accepted: Boolean(application.agreement_accepted === 1 || application.agreement_accepted === '1' || application.agreement_accepted === true),
  }
}

const getDriverApplicationForUser = userId => sanitizeDriverApplication(db().prepare(`
  SELECT * FROM mini_ride_driver_applications
  WHERE user_id = ?
  ORDER BY created_at DESC, updated_at DESC
  LIMIT 1
`).get(String(userId)));

const requireApprovedDriverApplication = (req, res) => {
  if (roleOf(req) !== 'driver') {
    res.status(403).json({ success: false, message: 'Driver account required.' });
    return false;
  }
  const application = getDriverApplicationForUser(accountId(req));
  if (!application || application.status !== 'approved') {
    res.status(403).json({ success: false, message: 'Your driver onboarding application must be approved before accessing the Mini Ride portal.' });
    return false;
  }
  return true;
};

const validateDriverApplicationDocument = (value, label) => {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`${label} is required.`)
  if (normalized.length > 9_000_000) throw new Error(`${label} is too large. Please upload a smaller PDF file.`)
  return normalized
}

export const submitDriverApplication = (req, res, next) => {
  try {
    if (roleOf(req) !== 'driver') return res.status(403).json({ success: false, message: 'Driver account required.' })
    const userId = accountId(req)
    const fullName = String(req.body?.fullName || req.body?.full_name || '').trim()
    const phone = String(req.body?.phone || '').trim()
    const email = String(req.body?.email || '').trim()
    const address = String(req.body?.address || '').trim()
    const city = String(req.body?.city || '').trim()
    const nationalIdNumber = String(req.body?.nationalIdNumber || req.body?.national_id_number || '').trim()
    const agreementAccepted = req.body?.agreementAccepted === true || req.body?.agreement_accepted === true || req.body?.agreementAccepted === 'true' || req.body?.agreement_accepted === 'true'
    const nationalIdFront = validateDriverApplicationDocument(req.body?.nationalIdFront || req.body?.national_id_front, 'National ID front')
    const nationalIdBack = validateDriverApplicationDocument(req.body?.nationalIdBack || req.body?.national_id_back, 'National ID back')
    const driverLicense = validateDriverApplicationDocument(req.body?.driverLicense || req.body?.driver_license, 'Driver licence')
    const collateral = validateDriverApplicationDocument(req.body?.collateral || req.body?.collateral_proof, 'Collateral proof')

    if (!fullName || !phone || !address || !city || !nationalIdNumber) {
      return res.status(400).json({ success: false, message: 'Complete your personal details before submitting the application.' })
    }
    if (!agreementAccepted) {
      return res.status(400).json({ success: false, message: 'You must accept the REDSEA driver terms and policies before continuing.' })
    }

    const payload = {
      application_id: randomUUID(),
      user_id: userId,
      full_name: fullName,
      phone,
      email: email || null,
      address,
      city,
      national_id_number: nationalIdNumber,
      national_id_front: nationalIdFront,
      national_id_back: nationalIdBack,
      driver_license: driverLicense,
      collateral,
      agreement_accepted: agreementAccepted ? 1 : 0,
      status: 'pending',
      review_note: ''
    }

    db().prepare(`
      INSERT INTO mini_ride_driver_applications (
        application_id, user_id, full_name, phone, email, address, city, national_id_number,
        national_id_front, national_id_back, driver_license, collateral, agreement_accepted, status, review_note, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        full_name = excluded.full_name,
        phone = excluded.phone,
        email = excluded.email,
        address = excluded.address,
        city = excluded.city,
        national_id_number = excluded.national_id_number,
        national_id_front = excluded.national_id_front,
        national_id_back = excluded.national_id_back,
        driver_license = excluded.driver_license,
        collateral = excluded.collateral,
        agreement_accepted = excluded.agreement_accepted,
        status = 'pending',
        review_note = '',
        updated_at = CURRENT_TIMESTAMP
    `).run(
      payload.application_id, payload.user_id, payload.full_name, payload.phone, payload.email, payload.address, payload.city, payload.national_id_number,
      payload.national_id_front, payload.national_id_back, payload.driver_license, payload.collateral, payload.agreement_accepted, payload.status, payload.review_note
    )

    notifyRoot(userId, `New driver onboarding application submitted by ${fullName}.`)
    const saved = getDriverApplicationForUser(userId)
    response(res, saved, 201)
  } catch (error) { next(error) }
}

export const getDriverApplicationStatus = (req, res, next) => {
  try {
    if (roleOf(req) !== 'driver') return res.status(403).json({ success: false, message: 'Driver account required.' })
    const application = getDriverApplicationForUser(accountId(req))
    if (!application) return res.status(404).json({ success: false, message: 'No driver application has been submitted yet.' })
    response(res, application)
  } catch (error) { next(error) }
}

export const getRootDriverApplications = (req, res, next) => {
  try {
    if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access required.' })
    const applications = db().prepare(`
      SELECT a.*, u.username, u.full_name AS account_name
      FROM mini_ride_driver_applications a
      LEFT JOIN users u ON CAST(u._id AS TEXT) = a.user_id
      ORDER BY a.created_at DESC
    `).all().map(sanitizeDriverApplication)
    response(res, applications)
  } catch (error) { next(error) }
}

export const reviewDriverApplication = (req, res, next) => {
  try {
    if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access required.' })
    const application = db().prepare('SELECT * FROM mini_ride_driver_applications WHERE application_id = ?').get(String(req.params.applicationId))
    if (!application) return res.status(404).json({ success: false, message: 'Driver application not found.' })
    const status = String(req.body?.status || '').trim().toLowerCase()
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Choose approved or rejected.' })
    }
    const note = String(req.body?.note || '').trim().slice(0, 500)
    db().prepare(`
      UPDATE mini_ride_driver_applications
      SET status = ?, review_note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE application_id = ?
    `).run(status, note, application.application_id)
    const updated = sanitizeDriverApplication(db().prepare('SELECT * FROM mini_ride_driver_applications WHERE application_id = ?').get(application.application_id))
    if (status === 'approved') {
      sendNotification(application.user_id, accountId(req), 'mini_ride', 'Your driver onboarding application was approved. You can now access the REDSEA driver portal.', '/driver')
    } else {
      sendNotification(application.user_id, accountId(req), 'mini_ride', 'Your driver onboarding application was rejected. Please review the required details and submit again.', '/driver')
    }
    response(res, updated)
  } catch (error) { next(error) }
}

const creditDriverEarning = (ride, amount) => {
  const rounded = Math.round(Number(amount) * 100) / 100;
  if (!ride.driver_user_id || rounded <= 0) return;
  const reference = `mini-ride-driver-earning:${ride.ride_id}`;
  const entry = db().prepare(`
    INSERT OR IGNORE INTO wallet_ledger
      (entry_id, user_id, amount, entry_type, reference, description, currency, balance_type)
    VALUES (?, ?, ?, 'mini_ride_earning', ?, ?, 'ETB', 'real')
  `).run(randomUUID(), String(ride.driver_user_id), rounded, reference, `Driver share for mini ride ${ride.ride_id}`);
  if (entry.changes === 1) {
    recordPlatformPayout({
      userId: ride.driver_user_id,
      agentUserId: null,
      amount: rounded,
      requestId: ride.ride_id,
      entryType: 'mini_ride_earning',
      reference: `platform-payout:${reference}`,
      description: `Driver earning for mini ride ${ride.ride_id}`,
    });
  }
};

const rewardCompletedRide = ride => {
  const settings = getSettings();
  for (const [userId, amount, type, reference, description] of [
    [
      ride.passenger_user_id,
      Number(settings.passenger_coin_reward),
      'mini_ride_passenger_reward',
      `mini-ride:${ride.ride_id}:passenger-coins`,
      'Mini Ride passenger reward',
    ],
    [
      ride.driver_user_id,
      Number(settings.driver_coin_reward),
      'mini_ride_driver_reward',
      `mini-ride:${ride.ride_id}:driver-coins`,
      'Mini Ride driver reward',
    ],
  ]) {
    if (!userId || !Number.isSafeInteger(amount) || amount <= 0) continue;
    if (creditUserCoins(userId, amount, type, reference, description)) {
      sendNotification(userId, null, 'coin_reward', `🎉 You earned ${amount} coins for completing a Mini Ride.`, '/wallet');
    }
  }
};

const finalizePaidRide = rideId => {
  const finish = db().transaction(() => {
    const ride = getRide(rideId);
    if (!ride) throw new Error('Ride request not found.');
    if (ride.status === 'completed' && ride.payment_status === 'paid') return { ride, newlyPaid: false };
    if (!['awaiting_payment', 'payment_review'].includes(ride.status)) {
      throw new Error('This ride is not awaiting payment.');
    }
    const changed = db().prepare(`
      UPDATE mini_rides
      SET status = 'completed', payment_status = 'paid', paid_at = CURRENT_TIMESTAMP,
          completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE ride_id = ? AND status IN ('awaiting_payment', 'payment_review')
    `).run(String(rideId));
    if (changed.changes !== 1) throw new Error('The ride payment status changed. Refresh and try again.');
    const updatedRide = getRide(rideId);
    const driverShare = Math.round(
      Number(updatedRide.fare_amount) * Number(getSettings().driver_commission_percent) / 100 * 100
    ) / 100;
    creditDriverEarning(updatedRide, driverShare);
    return { ride: updatedRide, newlyPaid: true };
  });
  const result = finish();
  if (result.newlyPaid) rewardCompletedRide(result.ride);
  return result.ride;
};

export const getAvailableMiniRideDrivers = (req, res, next) => {
  try {
    const drivers = db().prepare(`
      SELECT CAST(u._id AS TEXT) AS user_id,
        COALESCE(NULLIF(u.full_name, ''), u.username) AS full_name,
        d.latitude, d.longitude, d.location_updated_at
      FROM mini_ride_drivers d
      JOIN users u ON CAST(u._id AS TEXT) = d.user_id
      WHERE d.is_online = 1 AND u.is_active = 1
        AND LOWER(u.role) = 'driver'
        AND EXISTS (
          SELECT 1 FROM mini_ride_driver_applications a
          WHERE a.user_id = CAST(u._id AS TEXT) AND a.status = 'approved'
        )
        AND d.location_updated_at >= datetime('now', '-90 seconds')
      ORDER BY d.location_updated_at DESC
    `).all();
    response(res, drivers);
  } catch (error) { next(error); }
};

export const getMiniRideSettings = (req, res, next) => {
  try {
    response(res, getSettings());
  } catch (error) { next(error); }
};

export const updateMiniRideDriverStatus = (req, res, next) => {
  try {
    if (roleOf(req) !== 'driver') return res.status(403).json({ success: false, message: 'Driver account required.' });
    if (req.body?.online === true && !requireApprovedDriverApplication(req, res)) return undefined;
    const online = req.body?.online === true;
    if (online && !validCoordinates(req.body?.latitude, req.body?.longitude)) {
      return res.status(400).json({ success: false, message: 'Allow location access to go online.' });
    }
    db().prepare(`
      INSERT INTO mini_ride_drivers (user_id, is_online, latitude, longitude, location_updated_at, updated_at)
      VALUES (?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        is_online = excluded.is_online,
        latitude = CASE WHEN excluded.is_online = 1 THEN excluded.latitude ELSE mini_ride_drivers.latitude END,
        longitude = CASE WHEN excluded.is_online = 1 THEN excluded.longitude ELSE mini_ride_drivers.longitude END,
        location_updated_at = CASE WHEN excluded.is_online = 1 THEN CURRENT_TIMESTAMP ELSE mini_ride_drivers.location_updated_at END,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      accountId(req), online ? 1 : 0,
      online ? Number(req.body.latitude) : null,
      online ? Number(req.body.longitude) : null,
      online ? 1 : 0
    );
    response(res, { online, locationSharing: online });
  } catch (error) { next(error); }
};

export const createMiniRideRequest = (req, res, next) => {
  try {
    const passengerId = accountId(req);
    const passenger = db().prepare('SELECT role FROM users WHERE _id = ? AND is_active = 1').get(Number(passengerId));
    if (!passenger || ['root', 'admin', 'agent', 'driver'].includes(String(passenger.role || '').toLowerCase())) {
      return res.status(403).json({ success: false, message: 'An active passenger account is required.' });
    }
    const passengerName = String(req.body?.passengerName || '').trim();
    const passengerPhone = String(req.body?.passengerPhone || '').trim();
    const pickupLabel = String(req.body?.pickupLabel || 'Current location').trim();
    const destination = String(req.body?.destination || '').trim();
    const loadKg = Number(req.body?.loadKg || 0);
    const assignedDriverId = req.body?.driverId ? String(req.body.driverId) : null;
    const destinationLatitude = req.body?.destinationLatitude;
    const destinationLongitude = req.body?.destinationLongitude;
    const routeDistanceKm = Number(req.body?.routeDistanceKm || 0);
    if (!passengerName || passengerName.length > 120 || !/^[+()\d\s-]{7,24}$/.test(passengerPhone)) {
      return res.status(400).json({ success: false, message: 'Enter the passenger name and a valid phone number.' });
    }
    if (!pickupLabel || pickupLabel.length > 180 || !destination || destination.length > 250 || destination.length < 3) {
      return res.status(400).json({ success: false, message: 'Enter a pickup description and destination.' });
    }
    if (!validCoordinates(req.body?.latitude, req.body?.longitude)) {
      return res.status(400).json({ success: false, message: 'Current pickup location is required.' });
    }
    if ((destinationLatitude != null || destinationLongitude != null) &&
        (destinationLatitude == null || destinationLongitude == null ||
          !validCoordinates(destinationLatitude, destinationLongitude))) {
      return res.status(400).json({ success: false, message: 'Enter a valid destination location.' });
    }
    if (!Number.isFinite(routeDistanceKm) || routeDistanceKm < 0 || routeDistanceKm > 20000) {
      return res.status(400).json({ success: false, message: 'The road route distance is invalid.' });
    }
    if (validCoordinates(destinationLatitude, destinationLongitude) && routeDistanceKm <= 0) {
      return res.status(400).json({ success: false, message: 'The road route distance must be greater than zero.' });
    }
    if (validCoordinates(destinationLatitude, destinationLongitude)) {
      const directDistanceKm = distanceBetweenKm(
        Number(req.body.latitude),
        Number(req.body.longitude),
        Number(destinationLatitude),
        Number(destinationLongitude)
      );
      if (routeDistanceKm + 0.1 < directDistanceKm) {
        return res.status(400).json({ success: false, message: 'The road route distance cannot be shorter than the direct distance.' });
      }
    }
    if (!Number.isFinite(loadKg) || loadKg < 0 || loadKg > 100000) {
      return res.status(400).json({ success: false, message: 'Load must be between 0 and 100,000 kg.' });
    }
    if (assignedDriverId && !driverIsOnline(assignedDriverId)) {
      return res.status(409).json({ success: false, message: 'That driver is no longer online. Choose another available driver.' });
    }
    const rideId = randomUUID();
    db().prepare(`
      INSERT INTO mini_rides (
        ride_id, passenger_user_id, driver_user_id, passenger_name, passenger_phone,
        pickup_label, pickup_latitude, pickup_longitude, destination, load_kg,
        destination_latitude, destination_longitude, route_distance_km, passenger_latitude, passenger_longitude
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rideId, passengerId, assignedDriverId, passengerName, passengerPhone,
      pickupLabel, Number(req.body.latitude), Number(req.body.longitude), destination, loadKg,
      validCoordinates(destinationLatitude, destinationLongitude) ? Number(destinationLatitude) : null,
      validCoordinates(destinationLatitude, destinationLongitude) ? Number(destinationLongitude) : null,
      routeDistanceKm, Number(req.body.latitude), Number(req.body.longitude)
    );
    db().prepare(`
      INSERT INTO mini_ride_location_points (point_id, ride_id, user_id, role, latitude, longitude)
      VALUES (?, ?, ?, 'passenger', ?, ?)
    `).run(randomUUID(), rideId, passengerId, Number(req.body.latitude), Number(req.body.longitude));
    sendNotification(passengerId, null, 'mini_ride', 'Your Mini Ride request was sent to Root for driver assignment.', '/mini-ride');
    notifyRoot(passengerId, `New Mini Ride request: ${pickupLabel} to ${destination}.`);
    if (assignedDriverId) {
      sendNotification(assignedDriverId, passengerId, 'mini_ride', `${passengerName} requested a Mini Ride to ${destination}.`, '/driver');
    }
    response(res, getRideDetails(getRide(rideId)), 201);
  } catch (error) { next(error); }
};

export const getMyMiniRides = (req, res, next) => {
  try {
    const userId = accountId(req);
    const rides = db().prepare(`
      SELECT r.*, COALESCE(driver.full_name, driver.username, 'Unassigned') AS driver_full_name,
        COALESCE(passenger.full_name, passenger.username, 'Passenger') AS passenger_username
      FROM mini_rides r
      LEFT JOIN users driver ON CAST(driver._id AS TEXT) = r.driver_user_id
      LEFT JOIN users passenger ON CAST(passenger._id AS TEXT) = r.passenger_user_id
      WHERE r.passenger_user_id = ? OR r.driver_user_id = ?
      ORDER BY r.created_at DESC LIMIT 100
    `).all(userId, userId);
    response(res, rides.map(ride => getRideDetails(ride)));
  } catch (error) { next(error); }
};

export const getMiniRideDetails = (req, res, next) => {
  try {
    const ride = getRide(req.params.rideId);
    if (!ride) return res.status(404).json({ success: false, message: 'Ride request not found.' });
    if (!isRoot(req) && !isRideParticipant(ride, accountId(req))) {
      return res.status(403).json({ success: false, message: 'You cannot view this ride.' });
    }
    response(res, getRideDetails(ride));
  } catch (error) { next(error); }
};

export const acceptMiniRide = (req, res, next) => {
  try {
    if (!requireApprovedDriverApplication(req, res)) return undefined;
    const driverId = accountId(req);
    if (!driverIsOnline(driverId)) return res.status(409).json({ success: false, message: 'Go online and share your location before accepting rides.' });
    const changed = db().prepare(`
      UPDATE mini_rides SET driver_user_id = ?, status = 'accepted', updated_at = CURRENT_TIMESTAMP
      WHERE ride_id = ? AND status = 'requested' AND (driver_user_id IS NULL OR driver_user_id = ?)
    `).run(driverId, String(req.params.rideId), driverId);
    if (!changed.changes) return res.status(409).json({ success: false, message: 'This ride was accepted already or assigned to another driver.' });
    const ride = getRide(req.params.rideId);
    sendNotification(ride.passenger_user_id, driverId, 'mini_ride', `${ride.driver_full_name} accepted your ride request.`, '/mini-ride');
    notifyRoot(driverId, `${ride.driver_full_name} accepted Mini Ride ${ride.ride_id}.`);
    response(res, getRideDetails(ride));
  } catch (error) { next(error); }
};

export const assignMiniRideDriver = (req, res, next) => {
  try {
    const ride = getRide(req.params.rideId);
    const driverId = String(req.body?.driverId || '');
    if (!ride) return res.status(404).json({ success: false, message: 'Ride request not found.' });
    if (!['requested', 'accepted'].includes(ride.status)) {
      return res.status(409).json({ success: false, message: 'A driver can only be assigned before the ride starts.' });
    }
    const driver = db().prepare(`
      SELECT COALESCE(NULLIF(u.full_name, ''), u.username) AS name
      FROM users u JOIN mini_ride_drivers d ON d.user_id = CAST(u._id AS TEXT)
      WHERE CAST(u._id AS TEXT) = ? AND LOWER(u.role) = 'driver' AND u.is_active = 1
        AND EXISTS (
          SELECT 1 FROM mini_ride_driver_applications a
          WHERE a.user_id = CAST(u._id AS TEXT) AND a.status = 'approved'
        )
        AND d.is_online = 1 AND d.location_updated_at >= datetime('now', '-90 seconds')
    `).get(driverId);
    if (!driver) return res.status(400).json({ success: false, message: 'Choose an active driver who is sharing a current location.' });
    db().prepare(`
      UPDATE mini_rides SET driver_user_id = ?, status = 'requested', updated_at = CURRENT_TIMESTAMP
      WHERE ride_id = ?
    `).run(driverId, ride.ride_id);
    sendNotification(driverId, accountId(req), 'mini_ride', `Root assigned you Mini Ride ${ride.ride_id}.`, '/driver');
    sendNotification(ride.passenger_user_id, accountId(req), 'mini_ride', `Root assigned ${driver.name} to your Mini Ride.`, '/mini-ride');
    response(res, getRideDetails(getRide(ride.ride_id)));
  } catch (error) { next(error); }
};

export const startMiniRide = (req, res, next) => {
  try {
    const ride = getRide(req.params.rideId);
    if (!ride || String(ride.driver_user_id) !== accountId(req) || roleOf(req) !== 'driver') {
      return res.status(403).json({ success: false, message: 'Only the assigned driver can start this ride.' });
    }
    if (!requireApprovedDriverApplication(req, res)) return undefined;
    if (ride.status !== 'accepted') return res.status(409).json({ success: false, message: 'Accept the ride before starting it.' });
    if (!driverIsOnline(accountId(req))) return res.status(409).json({ success: false, message: 'Enable location sharing before starting this ride.' });
    db().prepare(`
      UPDATE mini_rides SET status = 'in_progress', started_at = CURRENT_TIMESTAMP,
        driver_latitude = (SELECT latitude FROM mini_ride_drivers WHERE user_id = ?),
        driver_longitude = (SELECT longitude FROM mini_ride_drivers WHERE user_id = ?),
        updated_at = CURRENT_TIMESTAMP
      WHERE ride_id = ? AND status = 'accepted'
    `).run(accountId(req), accountId(req), ride.ride_id);
    const point = db().prepare('SELECT latitude, longitude FROM mini_ride_drivers WHERE user_id = ?').get(accountId(req));
    db().prepare(`
      INSERT INTO mini_ride_location_points (point_id, ride_id, user_id, role, latitude, longitude)
      VALUES (?, ?, ?, 'driver', ?, ?)
    `).run(randomUUID(), ride.ride_id, accountId(req), point.latitude, point.longitude);
    sendNotification(ride.passenger_user_id, accountId(req), 'mini_ride', 'Your driver started the ride. Live trip tracking is active.', '/mini-ride');
    notifyRoot(accountId(req), `Mini Ride ${ride.ride_id} started.`);
    response(res, getRideDetails(getRide(ride.ride_id)));
  } catch (error) { next(error); }
};

export const updateMiniRideLocation = (req, res, next) => {
  try {
    const ride = getRide(req.params.rideId);
    const userId = accountId(req);
    if (!ride || !isRideParticipant(ride, userId) || roleOf(req) === 'root' || roleOf(req) === 'admin') {
      return res.status(403).json({ success: false, message: 'Only ride participants can share ride location.' });
    }
    if (!['accepted', 'in_progress'].includes(ride.status)) {
      return res.status(409).json({ success: false, message: 'Location sharing is available only for an active ride.' });
    }
    if (!validCoordinates(req.body?.latitude, req.body?.longitude)) {
      return res.status(400).json({ success: false, message: 'A valid current location is required.' });
    }
    const role = String(ride.driver_user_id) === userId ? 'driver' : 'passenger';
    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);
    const previous = db().prepare(`
      SELECT latitude, longitude, recorded_at FROM mini_ride_location_points
      WHERE ride_id = ? AND role = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1
    `).get(ride.ride_id, role);
    let segmentKm = 0;
    if (role === 'driver' && ride.status === 'in_progress' && !ride.ride_paused_at && previous) {
      const seconds = Math.max(0, (Date.now() - Date.parse(`${String(previous.recorded_at).replace(' ', 'T')}Z`)) / 1000);
      const measuredKm = distanceBetweenKm(Number(previous.latitude), Number(previous.longitude), latitude, longitude);
      if (seconds >= 2 && measuredKm <= Math.max(.15, seconds / 3600 * 120)) segmentKm = measuredKm;
    }
    const tx = db().transaction(() => {
      db().prepare(`
        INSERT INTO mini_ride_location_points (point_id, ride_id, user_id, role, latitude, longitude)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), ride.ride_id, userId, role, latitude, longitude);
      const columnPrefix = role === 'driver' ? 'driver' : 'passenger';
      db().prepare(`
        UPDATE mini_rides SET ${columnPrefix}_latitude = ?, ${columnPrefix}_longitude = ?,
          distance_km = distance_km + ?, updated_at = CURRENT_TIMESTAMP WHERE ride_id = ?
      `).run(latitude, longitude, segmentKm, ride.ride_id);
      if (role === 'driver') {
        db().prepare(`
          UPDATE mini_ride_drivers SET latitude = ?, longitude = ?, location_updated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP WHERE user_id = ?
        `).run(latitude, longitude, userId);
      }
    });
    tx();
    response(res, { updated: true });
  } catch (error) { next(error); }
};

export const finishMiniRide = (req, res, next) => {
  try {
    const ride = getRide(req.params.rideId);
    const userId = accountId(req);
    const role = roleOf(req);
    const canFinish = ride && (
      String(ride.passenger_user_id) === userId ||
      (role === 'driver' && String(ride.driver_user_id) === userId)
    );
    if (!canFinish) {
      return res.status(403).json({ success: false, message: 'Only this ride’s passenger or assigned driver can finish the trip.' });
    }
    return completeMiniRide(ride, userId, next, res);
  } catch (error) { next(error); }
};

export const updateMiniRidePause = (req, res, next) => {
  try {
    const ride = getRide(req.params.rideId);
    const driverId = accountId(req);
    const paused = req.body?.paused === true;
    if (!ride || roleOf(req) !== 'driver' || String(ride.driver_user_id) !== driverId) {
      return res.status(403).json({ success: false, message: 'Only the assigned driver can pause or resume this trip.' });
    }
    if (ride.status !== 'in_progress') {
      return res.status(409).json({ success: false, message: 'Only a started trip can be paused or resumed.' });
    }
    if (paused && !ride.ride_paused_at) {
      db().prepare('UPDATE mini_rides SET ride_paused_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE ride_id = ? AND status = ? AND ride_paused_at IS NULL')
        .run(ride.ride_id, 'in_progress');
    } else if (!paused && ride.ride_paused_at) {
      db().prepare('UPDATE mini_rides SET ride_paused_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE ride_id = ? AND status = ?')
        .run(ride.ride_id, 'in_progress');
    }
    const updatedRide = getRide(ride.ride_id);
    const message = updatedRide.ride_paused_at ? 'Your driver paused the trip. The fare meter is stopped.' : 'Your driver resumed the trip.';
    sendNotification(ride.passenger_user_id, driverId, 'mini_ride', message, '/mini-ride');
    notifyRoot(driverId, `Mini Ride ${ride.ride_id} ${updatedRide.ride_paused_at ? 'paused' : 'resumed'}.`);
    response(res, getRideDetails(updatedRide));
  } catch (error) { next(error); }
};

export const rootFinishMiniRide = (req, res, next) => {
  try {
    if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access is required.' });
    const ride = getRide(req.params.rideId);
    if (!ride) return res.status(404).json({ success: false, message: 'Ride request not found.' });
    return completeMiniRide(ride, accountId(req), next, res);
  } catch (error) { next(error); }
};

const completeMiniRide = (ride, actorId, next, res) => {
  try {
    if (ride.status !== 'in_progress') return res.status(409).json({ success: false, message: 'This ride is not in progress.' });
    const settings = getSettings();
    const measuredDistance = Number(ride.distance_km || 0);
    const distanceKm = Math.round((measuredDistance > 0 ? measuredDistance : Number(ride.route_distance_km || 0)) * 100) / 100;
    const fare = Math.round((
      Number(settings.base_fare) +
      distanceKm * Number(settings.fare_per_km) +
      Number(ride.load_kg) / 1000 * Number(settings.fare_per_ton)
    ) * 100) / 100;
    db().prepare(`
      UPDATE mini_rides SET status = 'awaiting_payment', fare_amount = ?, distance_km = ?,
        completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE ride_id = ? AND status = 'in_progress'
    `).run(fare, distanceKm, ride.ride_id);
    const updated = getRide(ride.ride_id);
    sendNotification(ride.passenger_user_id, actorId, 'mini_ride', `Your ride is finished. ETB ${fare.toFixed(2)} is due for payment.`, '/mini-ride');
    if (ride.driver_user_id) sendNotification(ride.driver_user_id, actorId, 'mini_ride', `Ride finished. Passenger payment due: ETB ${fare.toFixed(2)}.`, '/driver');
    notifyRoot(actorId, `Mini Ride ${ride.ride_id} finished; ETB ${fare.toFixed(2)} is due.`);
    response(res, getRideDetails(updated));
  } catch (error) { next(error); }
};

export const submitMiniRidePayment = (req, res, next) => {
  try {
    const ride = getRide(req.params.rideId);
    if (!ride || String(ride.passenger_user_id) !== accountId(req)) {
      return res.status(403).json({ success: false, message: 'Only the passenger can pay this ride.' });
    }
    if (ride.status !== 'awaiting_payment') return res.status(409).json({ success: false, message: 'This ride is not awaiting payment.' });
    const method = String(req.body?.method || '').trim();
    if (method === 'cash') {
      db().prepare(`
        UPDATE mini_rides SET status = 'cash_confirmation', payment_method = 'Cash',
          payment_status = 'pending', updated_at = CURRENT_TIMESTAMP
        WHERE ride_id = ? AND status = 'awaiting_payment'
      `).run(ride.ride_id);
      sendNotification(ride.driver_user_id, accountId(req), 'mini_ride_cash', 'Passenger selected cash. Confirm receipt after collecting the fare.', '/driver');
      notifyRoot(accountId(req), `Cash payment confirmation requested for Mini Ride ${ride.ride_id}.`);
      return response(res, getRideDetails(getRide(ride.ride_id)));
    }
    if (method === 'wallet') {
      const pay = db().transaction(() => {
        const current = getRide(ride.ride_id);
        if (current.status !== 'awaiting_payment') throw new Error('This ride payment has already been submitted.');
        const balance = Number(db().prepare(`
          SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_ledger
          WHERE user_id = ? AND balance_type = 'real'
        `).get(accountId(req)).balance);
        if (balance < Number(current.fare_amount)) throw new Error(`Insufficient real wallet balance. Available: ETB ${balance.toFixed(2)}.`);
        const reference = `mini-ride-wallet-payment:${current.ride_id}`;
        const charged = db().prepare(`
          INSERT OR IGNORE INTO wallet_ledger
            (entry_id, user_id, amount, entry_type, reference, description, currency, balance_type)
          VALUES (?, ?, ?, 'mini_ride_payment', ?, ?, 'ETB', 'real')
        `).run(randomUUID(), accountId(req), -Number(current.fare_amount), reference, `Payment for Mini Ride ${current.ride_id}`);
        if (charged.changes !== 1) throw new Error('This wallet payment has already been used.');
        db().prepare(`
          UPDATE mini_rides SET status = 'completed', payment_status = 'paid',
            payment_method = 'REDSEA Wallet', paid_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP WHERE ride_id = ?
        `).run(current.ride_id);
        const paidRide = getRide(current.ride_id);
        const driverShare = Math.round(Number(paidRide.fare_amount) * Number(getSettings().driver_commission_percent) / 100 * 100) / 100;
        creditDriverEarning(paidRide, driverShare);
        return paidRide;
      });
      const paidRide = pay();
      rewardCompletedRide(paidRide);
      sendNotification(paidRide.driver_user_id, accountId(req), 'mini_ride', 'Passenger paid by REDSEA Wallet. Ride completed.', '/driver');
      return response(res, getRideDetails(paidRide));
    }
    if (!method || method.length > 100 || !String(req.body?.reference || '').trim() || String(req.body.reference).trim().length > 180) {
      return res.status(400).json({ success: false, message: 'Choose a payment provider and enter its payment reference.' });
    }
    db().prepare(`
      UPDATE mini_rides SET status = 'payment_review', payment_status = 'pending',
        payment_method = ?, payment_reference = ?, updated_at = CURRENT_TIMESTAMP
      WHERE ride_id = ? AND status = 'awaiting_payment'
    `).run(method, String(req.body.reference).trim(), ride.ride_id);
    notifyRoot(accountId(req), `Mini Ride ${ride.ride_id} payment needs review (${method}).`);
    sendNotification(ride.driver_user_id, accountId(req), 'mini_ride', 'Passenger submitted payment for Root verification.', '/driver');
    response(res, getRideDetails(getRide(ride.ride_id)));
  } catch (error) {
    if (String(error?.message || '').startsWith('Insufficient real wallet balance.')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

export const confirmMiniRideCash = (req, res, next) => {
  try {
    if (roleOf(req) !== 'driver') return res.status(403).json({ success: false, message: 'Driver account required.' });
    const ride = getRide(req.params.rideId);
    if (!ride || String(ride.driver_user_id) !== accountId(req) || ride.status !== 'cash_confirmation') {
      return res.status(409).json({ success: false, message: 'This ride has no cash receipt awaiting driver confirmation.' });
    }
    db().prepare(`
      UPDATE mini_rides SET status = 'completed', payment_status = 'paid', payment_method = 'Cash',
        paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE ride_id = ? AND status = 'cash_confirmation'
    `).run(ride.ride_id);
    const completed = getRide(ride.ride_id);
    rewardCompletedRide(completed);
    sendNotification(ride.passenger_user_id, accountId(req), 'mini_ride', 'Driver confirmed the cash payment. Thank you for riding with REDSEA.', '/mini-ride');
    notifyRoot(accountId(req), `Driver confirmed cash for Mini Ride ${ride.ride_id}.`);
    response(res, getRideDetails(completed));
  } catch (error) { next(error); }
};

export const getDriverMiniRideDashboard = (req, res, next) => {
  try {
    if (!requireApprovedDriverApplication(req, res)) return undefined;
    const userId = accountId(req);
    const driverStatus = db().prepare('SELECT * FROM mini_ride_drivers WHERE user_id = ?').get(userId) || {
      user_id: userId, is_online: 0,
    };
    const rides = db().prepare(`
      SELECT r.*, COALESCE(passenger.full_name, passenger.username) AS passenger_username
      FROM mini_rides r
      LEFT JOIN users passenger ON CAST(passenger._id AS TEXT) = r.passenger_user_id
      WHERE r.driver_user_id = ? OR (r.status = 'requested' AND r.driver_user_id IS NULL)
      ORDER BY CASE WHEN r.status = 'requested' THEN 0 ELSE 1 END, r.created_at DESC
      LIMIT 100
    `).all(userId);
    const earnings = db().prepare(`
      SELECT COALESCE(SUM(amount), 0) AS wallet_earnings FROM wallet_ledger
      WHERE user_id = ? AND entry_type = 'mini_ride_earning' AND balance_type = 'real'
    `).get(userId);
    response(res, {
      status: { ...driverStatus, online: driverStatus.is_online === 1 && driverIsOnline(userId) },
      settings: getSettings(),
      rides: rides.map(ride => getRideDetails(ride)),
      summary: {
        totalTrips: Number(db().prepare("SELECT COUNT(*) AS count FROM mini_rides WHERE driver_user_id = ? AND status = 'completed'").get(userId).count),
        walletEarnings: Number(earnings.wallet_earnings),
        coinEarnings: Number(db().prepare(`
          SELECT COALESCE(SUM(amount), 0) AS coins FROM wallet_coin_ledger
          WHERE user_id = ? AND entry_type = 'mini_ride_driver_reward'
        `).get(userId).coins),
      },
    });
  } catch (error) { next(error); }
};

export const getRootMiniRideData = (req, res, next) => {
  try {
    const rides = db().prepare(`
      SELECT r.*, COALESCE(passenger.full_name, passenger.username) AS passenger_username,
        passenger.phone AS passenger_account_phone,
        COALESCE(driver.full_name, driver.username, 'Unassigned') AS driver_full_name,
        driver.phone AS driver_phone
      FROM mini_rides r
      LEFT JOIN users passenger ON CAST(passenger._id AS TEXT) = r.passenger_user_id
      LEFT JOIN users driver ON CAST(driver._id AS TEXT) = r.driver_user_id
      ORDER BY r.created_at DESC LIMIT 500
    `).all();
    const drivers = db().prepare(`
      SELECT CAST(u._id AS TEXT) AS user_id, u.username,
        COALESCE(NULLIF(u.full_name, ''), u.username) AS full_name, u.phone, u.is_active,
        COALESCE((SELECT SUM(w.amount) FROM wallet_ledger w
          WHERE w.user_id = CAST(u._id AS TEXT) AND w.balance_type = 'real'), 0) AS real_balance,
        COALESCE((SELECT SUM(w.amount) FROM wallet_ledger w
          WHERE w.user_id = CAST(u._id AS TEXT) AND w.balance_type = 'bonus'), 0) AS bonus_balance,
        COALESCE((SELECT SUM(c.amount) FROM wallet_coin_ledger c
          WHERE c.user_id = CAST(u._id AS TEXT)), 0) AS coin_balance,
        CASE WHEN d.is_online = 1 AND d.location_updated_at >= datetime('now', '-90 seconds')
          AND u.is_active = 1 THEN 1 ELSE 0 END AS is_online,
        d.latitude, d.longitude, d.location_updated_at
      FROM users u LEFT JOIN mini_ride_drivers d ON d.user_id = CAST(u._id AS TEXT)
      WHERE LOWER(u.role) = 'driver' ORDER BY u.username
    `).all();
    const totals = db().prepare(`
      SELECT COUNT(*) AS ride_count,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN fare_amount ELSE 0 END), 0) AS completed_fares,
        SUM(CASE WHEN status IN ('requested', 'accepted', 'in_progress', 'cash_confirmation', 'payment_review') THEN 1 ELSE 0 END) AS active_count,
        SUM(CASE WHEN status = 'payment_review' THEN 1 ELSE 0 END) AS pending_payment_count
      FROM mini_rides
    `).get();
    const driverWalletPayouts = Number(db().prepare(`
      SELECT COALESCE(SUM(amount), 0) AS amount
      FROM wallet_ledger WHERE entry_type = 'mini_ride_earning' AND balance_type = 'real'
    `).get().amount);
    const completedFares = Number(totals.completed_fares || 0);
    const platformSharePercent = 100 - Number(getSettings().driver_commission_percent);
    response(res, {
      settings: getSettings(),
      rides: rides.map(ride => getRideDetails(ride)),
      drivers,
      summary: {
        rideCount: Number(totals.ride_count || 0),
        completedFares,
        platformEarnings: Math.round(completedFares * platformSharePercent) / 100,
        driverWalletPayouts,
        activeCount: Number(totals.active_count || 0),
        pendingPaymentCount: Number(totals.pending_payment_count || 0),
      },
    });
  } catch (error) { next(error); }
};

export const adjustMiniRideDriverWallet = (req, res, next) => {
  try {
    if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access is required.' });
    const driverId = String(req.params.driverId || '');
    const asset = String(req.body?.asset || '').trim().toLowerCase();
    const direction = String(req.body?.direction || '').trim().toLowerCase();
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || '').trim();
    const driver = db().prepare("SELECT _id FROM users WHERE CAST(_id AS TEXT) = ? AND LOWER(role) = 'driver'").get(driverId);
    if (!driver) return res.status(404).json({ success: false, message: 'Mini Ride driver not found.' });
    if (!['real', 'bonus', 'coin'].includes(asset) || !['credit', 'debit'].includes(direction) ||
        !Number.isFinite(amount) || amount <= 0 || amount > 100000000 ||
        (asset === 'coin' && !Number.isSafeInteger(amount)) ||
        !description || description.length > 500) {
      return res.status(400).json({ success: false, message: 'Provide a valid balance type, action, amount, and reason. Coin amounts must be whole numbers.' });
    }
    const signedAmount = direction === 'credit' ? amount : -amount;
    const reference = `root-mini-ride-wallet:${asset}:${randomUUID()}`;
    const adjust = db().transaction(() => {
      if (direction === 'debit') {
        const currentBalance = asset === 'coin'
          ? Number(db().prepare('SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_coin_ledger WHERE user_id = ?').get(driverId).balance)
          : Number(db().prepare(`
              SELECT COALESCE(SUM(amount), 0) AS balance
              FROM wallet_ledger WHERE user_id = ? AND balance_type = ?
            `).get(driverId, asset).balance);
        const reserved = asset === 'coin' ? 0 : Number(db().prepare(`
          SELECT COALESCE(SUM(amount), 0) AS balance
          FROM wallet_withdrawals
          WHERE user_id = ? AND balance_type = ? AND status IN ('pending', 'approved')
        `).get(driverId, asset).balance);
        if (amount > currentBalance - reserved) {
          throw Object.assign(new Error(`Cannot deduct more than the available ${asset} balance.`), { status: 400 });
        }
      }
      if (asset === 'coin') {
        db().prepare(`
          INSERT INTO wallet_coin_ledger (entry_id, user_id, amount, entry_type, reference, description)
          VALUES (?, ?, ?, 'root_mini_ride_adjustment', ?, ?)
        `).run(randomUUID(), driverId, signedAmount, reference, description);
      } else {
        db().prepare(`
          INSERT INTO wallet_ledger
            (entry_id, user_id, amount, entry_type, reference, description, balance_type)
          VALUES (?, ?, ?, 'root_mini_ride_adjustment', ?, ?, ?)
        `).run(randomUUID(), driverId, signedAmount, reference, description, asset);
      }
    });
    adjust.immediate();
    response(res, { driver_id: driverId, asset, amount: signedAmount });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    next(error);
  }
};

export const updateRootMiniRideSettings = (req, res, next) => {
  try {
    const settings = req.body || {};
    const numbers = {
      base_fare: Number(settings.base_fare),
      fare_per_km: Number(settings.fare_per_km),
      fare_per_ton: Number(settings.fare_per_ton),
      driver_commission_percent: Number(settings.driver_commission_percent),
      passenger_coin_reward: Number(settings.passenger_coin_reward),
      driver_coin_reward: Number(settings.driver_coin_reward),
    };
    if (
      Object.values(numbers).some(value => !Number.isFinite(value) || value < 0) ||
      numbers.driver_commission_percent > 100 ||
      numbers.passenger_coin_reward > 10000000 || numbers.driver_coin_reward > 10000000
    ) {
      return res.status(400).json({ success: false, message: 'Enter valid non-negative fares, commission, and coin rewards.' });
    }
    if (!Number.isSafeInteger(numbers.passenger_coin_reward) || !Number.isSafeInteger(numbers.driver_coin_reward)) {
      return res.status(400).json({ success: false, message: 'Coin rewards must be whole numbers.' });
    }
    db().prepare(`
      UPDATE mini_ride_settings SET base_fare = ?, fare_per_km = ?, fare_per_ton = ?,
        driver_commission_percent = ?, passenger_coin_reward = ?, driver_coin_reward = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = 1
    `).run(
      numbers.base_fare, numbers.fare_per_km, numbers.fare_per_ton,
      numbers.driver_commission_percent, numbers.passenger_coin_reward, numbers.driver_coin_reward
    );
    response(res, getSettings());
  } catch (error) { next(error); }
};

export const reviewMiniRidePayment = (req, res, next) => {
  try {
    const ride = getRide(req.params.rideId);
    const status = String(req.body?.status || '');
    if (!ride || ride.status !== 'payment_review' || ride.payment_status !== 'pending') {
      return res.status(409).json({ success: false, message: 'This ride payment is not awaiting Root review.' });
    }
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Choose approved or rejected.' });
    }
    if (status === 'approved') {
      const paid = finalizePaidRide(ride.ride_id);
      sendNotification(paid.passenger_user_id, accountId(req), 'mini_ride', 'Root approved your Mini Ride payment. Thank you for riding with REDSEA.', '/mini-ride');
      sendNotification(paid.driver_user_id, accountId(req), 'mini_ride', 'Root approved the passenger payment. Your ride is complete.', '/driver');
      return response(res, getRideDetails(paid));
    }
    db().prepare(`
      UPDATE mini_rides SET status = 'awaiting_payment', payment_status = 'rejected',
        payment_method = NULL, payment_reference = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE ride_id = ?
    `).run(ride.ride_id);
    sendNotification(ride.passenger_user_id, accountId(req), 'mini_ride', 'Root could not verify your payment. Choose another payment method and retry.', '/mini-ride');
    response(res, getRideDetails(getRide(ride.ride_id)));
  } catch (error) { next(error); }
};
