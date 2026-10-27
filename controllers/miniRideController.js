import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { queryNeon, toPostgresPlaceholders, withNeonTransaction } from '../config/neonDatabase.js';
import { creditUserCoins } from './socialController.js';
const transactionContext = new AsyncLocalStorage();

const db = () => ({
  prepare(sql) {
    const execute = async params => {
      const normalizedSql = toPostgresPlaceholders(sql);
      const client = transactionContext.getStore();
      return client ? client.query(normalizedSql, params) : queryNeon(normalizedSql, params);
    };
    return {
      get: async (...params) => (await execute(params)).rows[0],
      all: async (...params) => (await execute(params)).rows,
      run: async (...params) => {
        const result = await execute(params);
        return { changes: result.rowCount, rows: result.rows };
      },
    };
  },
  transaction(callback) {
    return async () => {
      const existingClient = transactionContext.getStore();
      if (existingClient) return callback();
      return withNeonTransaction(client => transactionContext.run(client, callback));
    };
  },
});
const accountId = req => String(req.user.id);
const roleOf = req => String(req.user?.role || '').toLowerCase();
const isRoot = req => ['root', 'admin'].includes(roleOf(req));
const response = (res, data, status = 200) => res.status(status).json({ success: true, data });
const neonRows = async (sql, params = []) => (await queryNeon(sql, params)).rows;
const neonFirst = async (sql, params = []) => (await queryNeon(sql, params)).rows[0];
const neonTransactionQuery = (client, sql, params = []) =>
  client.query(toPostgresPlaceholders(sql), params);
const getNeonSettings = () => neonFirst('SELECT * FROM mini_ride_settings WHERE id = 1');
const getNeonRide = rideId => neonFirst(`
  SELECT r.*, passenger.username AS passenger_username,
    driver.username AS driver_username,
    COALESCE(driver.full_name, driver.username, 'Unassigned') AS driver_full_name
  FROM mini_rides r
  LEFT JOIN users passenger ON passenger._id::text = r.passenger_user_id
  LEFT JOIN users driver ON driver._id::text = r.driver_user_id
  WHERE r.ride_id = ?
`, [String(rideId)]);
const getNeonRideDetails = async ride => ({
  ...ride,
  points: await neonRows(`
    SELECT user_id, role, latitude, longitude, recorded_at
    FROM mini_ride_location_points WHERE ride_id = ?
    ORDER BY recorded_at, point_id
  `, [ride.ride_id]),
});
const sendNeonNotification = (userId, actorId, type, message, link = '/mini-ride', client = null) => {
  const sql = `
    INSERT INTO social_notifications (notification_id, user_id, actor_id, type, message, link)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  const params = [randomUUID(), String(userId), actorId == null ? null : String(actorId), type, message, link];
  return client
    ? client.query(toPostgresPlaceholders(sql), params)
    : queryNeon(sql, params);
};
const notifyNeonRoot = async (actorId, message, client = null) => {
  const roots = await neonRows("SELECT _id FROM users WHERE LOWER(role) IN ('root', 'admin') AND is_active = 1");
  await Promise.all(roots.map(root => sendNeonNotification(root._id, actorId, 'mini_ride', message, '/root/dashboard', client)));
};
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

const getSettings = getNeonSettings;
const getRide = getNeonRide;
const sendNotification = sendNeonNotification;
const notifyRoot = notifyNeonRoot;
const getRideDetails = getNeonRideDetails;
const isRideParticipant = (ride, userId) => (
  String(ride.passenger_user_id) === String(userId) || String(ride.driver_user_id || '') === String(userId)
);
const driverIsOnline = async userId => Boolean(await db().prepare(`
  SELECT 1 FROM mini_ride_drivers
  WHERE user_id = ? AND is_online = 1 AND location_updated_at >= CURRENT_TIMESTAMP - INTERVAL '90 seconds'
`).get(String(userId)));

const sanitizeDriverApplication = application => {
  if (!application) return null
  return {
    ...application,
    agreement_accepted: Boolean(application.agreement_accepted === 1 || application.agreement_accepted === '1' || application.agreement_accepted === true),
  }
}

const getDriverApplicationForUser = async userId => sanitizeDriverApplication(await db().prepare(`
  SELECT * FROM mini_ride_driver_applications
  WHERE user_id = ?
  ORDER BY created_at DESC, updated_at DESC
  LIMIT 1
`).get(String(userId)));

const requireApprovedDriverApplication = async (req, res) => {
  if (roleOf(req) !== 'driver') {
    res.status(403).json({ success: false, message: 'Driver account required.' });
    return false;
  }
  const application = await getDriverApplicationForUser(accountId(req));
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

export const submitDriverApplication = async (req, res, next) => {
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

    await db().prepare(`
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

    await notifyRoot(userId, `New driver onboarding application submitted by ${fullName}.`)
    const saved = await getDriverApplicationForUser(userId)
    response(res, saved, 201)
  } catch (error) { next(error) }
}

export const getDriverApplicationStatus = async (req, res, next) => {
  try {
    if (roleOf(req) !== 'driver') return res.status(403).json({ success: false, message: 'Driver account required.' })
    const application = await getDriverApplicationForUser(accountId(req))
    if (!application) return res.status(404).json({ success: false, message: 'No driver application has been submitted yet.' })
    response(res, application)
  } catch (error) { next(error) }
}

export const getRootDriverApplications = async (req, res, next) => {
  try {
    if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access required.' })
    const applications = (await neonRows(`
      SELECT a.*, u.username, u.full_name AS account_name
      FROM mini_ride_driver_applications a
      LEFT JOIN users u ON u._id::text = a.user_id
      ORDER BY a.created_at DESC
    `)).map(sanitizeDriverApplication)
    response(res, applications)
  } catch (error) { next(error) }
}

export const reviewDriverApplication = async (req, res, next) => {
  try {
    if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access required.' })
    const application = await neonFirst('SELECT * FROM mini_ride_driver_applications WHERE application_id = ?', [String(req.params.applicationId)])
    if (!application) return res.status(404).json({ success: false, message: 'Driver application not found.' })
    const status = String(req.body?.status || '').trim().toLowerCase()
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Choose approved or rejected.' })
    }
    const note = String(req.body?.note || '').trim().slice(0, 500)
    const updated = await neonFirst(`
      UPDATE mini_ride_driver_applications
      SET status = ?, review_note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE application_id = ?
      RETURNING *
    `, [status, note, application.application_id])
    const safeUpdated = sanitizeDriverApplication(updated)
    if (status === 'approved') {
      await sendNeonNotification(application.user_id, accountId(req), 'mini_ride', 'Your driver onboarding application was approved. You can now access the REDSEA driver portal.', '/driver')
    } else {
      await sendNeonNotification(application.user_id, accountId(req), 'mini_ride', 'Your driver onboarding application was rejected. Please review the required details and submit again.', '/driver')
    }
    response(res, safeUpdated)
  } catch (error) { next(error) }
}

const creditDriverEarning = async (ride, amount, client = null) => {
  const rounded = Math.round(Number(amount) * 100) / 100;
  if (!ride.driver_user_id || rounded <= 0) return;
  const reference = `mini-ride-driver-earning:${ride.ride_id}`;
  const execute = client
    ? (sql, params) => neonTransactionQuery(client, sql, params)
    : (sql, params) => queryNeon(sql, params);
  const entry = await execute(`
    INSERT INTO wallet_ledger
      (entry_id, user_id, amount, entry_type, reference, description, currency, balance_type)
    VALUES (?, ?, ?, 'mini_ride_earning', ?, ?, 'ETB', 'real')
    ON CONFLICT (reference) DO NOTHING
    RETURNING entry_id
  `, [randomUUID(), String(ride.driver_user_id), rounded, reference, `Driver share for mini ride ${ride.ride_id}`]);
  if (entry.rowCount === 1) {
    await execute(`
      INSERT INTO platform_payout_ledger
        (payout_id, user_id, agent_user_id, amount, request_id, entry_type, reference, description)
      VALUES (?, ?, NULL, ?, ?, 'mini_ride_earning', ?, ?)
    `, [
      randomUUID(), String(ride.driver_user_id), -rounded, String(ride.ride_id),
      `platform-payout:${reference}`, `Driver earning for mini ride ${ride.ride_id}`,
    ]);
  }
};

const rewardCompletedRide = async (ride, client = null) => {
  const settings = client
    ? (await neonTransactionQuery(client, 'SELECT passenger_coin_reward, driver_coin_reward FROM mini_ride_settings WHERE id = 1')).rows[0]
    : await getSettings();
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
    if (await creditUserCoins(userId, amount, type, reference, description, client)) {
      await sendNotification(userId, null, 'coin_reward', `You earned ${amount} coins for completing a Mini Ride.`, '/wallet', client);
    }
  }
};

export const getAvailableMiniRideDrivers = async (req, res, next) => {
  try {
    const drivers = await db().prepare(`
      SELECT u._id::text AS user_id,
        COALESCE(NULLIF(u.full_name, ''), u.username) AS full_name,
        d.latitude, d.longitude, d.location_updated_at
      FROM mini_ride_drivers d
      JOIN users u ON u._id::text = d.user_id
      WHERE d.is_online = 1 AND u.is_active = 1
        AND LOWER(u.role) = 'driver'
        AND EXISTS (
          SELECT 1 FROM mini_ride_driver_applications a
          WHERE a.user_id = u._id::text AND a.status = 'approved'
        )
        AND d.location_updated_at >= CURRENT_TIMESTAMP - INTERVAL '90 seconds'
      ORDER BY d.location_updated_at DESC
    `).all();
    response(res, drivers);
  } catch (error) { next(error); }
};

export const getMiniRideSettings = async (req, res, next) => {
  try {
    response(res, await getSettings());
  } catch (error) { next(error); }
};

export const updateMiniRideDriverStatus = async (req, res, next) => {
  try {
    if (roleOf(req) !== 'driver') return res.status(403).json({ success: false, message: 'Driver account required.' });
    if (req.body?.online === true && !await requireApprovedDriverApplication(req, res)) return undefined;
    const online = req.body?.online === true;
    if (online && !validCoordinates(req.body?.latitude, req.body?.longitude)) {
      return res.status(400).json({ success: false, message: 'Allow location access to go online.' });
    }
    await db().prepare(`
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

export const createMiniRideRequest = async (req, res, next) => {
  try {
    const passengerId = accountId(req);
    const passenger = await db().prepare('SELECT role FROM users WHERE _id::text = ? AND is_active = 1').get(passengerId);
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
    if (assignedDriverId && !await driverIsOnline(assignedDriverId)) {
      return res.status(409).json({ success: false, message: 'That driver is no longer online. Choose another available driver.' });
    }
    const rideId = randomUUID();
    await db().transaction(async () => {
      await db().prepare(`
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
      await db().prepare(`
        INSERT INTO mini_ride_location_points (point_id, ride_id, user_id, role, latitude, longitude)
        VALUES (?, ?, ?, 'passenger', ?, ?)
      `).run(randomUUID(), rideId, passengerId, Number(req.body.latitude), Number(req.body.longitude));
    })();
    await sendNotification(passengerId, null, 'mini_ride', 'Your Mini Ride request was sent to Root for driver assignment.', '/mini-ride');
    await notifyRoot(passengerId, `New Mini Ride request: ${pickupLabel} to ${destination}.`);
    if (assignedDriverId) {
      await sendNotification(assignedDriverId, passengerId, 'mini_ride', `${passengerName} requested a Mini Ride to ${destination}.`, '/driver');
    }
    response(res, await getRideDetails(await getRide(rideId)), 201);
  } catch (error) { next(error); }
};

export const getMyMiniRides = async (req, res, next) => {
  try {
    const userId = accountId(req);
    const rides = await db().prepare(`
      SELECT r.*, COALESCE(driver.full_name, driver.username, 'Unassigned') AS driver_full_name,
        COALESCE(passenger.full_name, passenger.username, 'Passenger') AS passenger_username
      FROM mini_rides r
      LEFT JOIN users driver ON driver._id::text = r.driver_user_id
      LEFT JOIN users passenger ON passenger._id::text = r.passenger_user_id
      WHERE r.passenger_user_id = ? OR r.driver_user_id = ?
      ORDER BY r.created_at DESC LIMIT 100
    `).all(userId, userId);
    response(res, await Promise.all(rides.map(ride => getRideDetails(ride))));
  } catch (error) { next(error); }
};

export const getMiniRideDetails = async (req, res, next) => {
  try {
    const ride = await getRide(req.params.rideId);
    if (!ride) return res.status(404).json({ success: false, message: 'Ride request not found.' });
    if (!isRoot(req) && !isRideParticipant(ride, accountId(req))) {
      return res.status(403).json({ success: false, message: 'You cannot view this ride.' });
    }
    response(res, await getRideDetails(ride));
  } catch (error) { next(error); }
};

export const acceptMiniRide = async (req, res, next) => {
  try {
    if (!await requireApprovedDriverApplication(req, res)) return undefined;
    const driverId = accountId(req);
    if (!await driverIsOnline(driverId)) return res.status(409).json({ success: false, message: 'Go online and share your location before accepting rides.' });
    const changed = await db().prepare(`
      UPDATE mini_rides SET driver_user_id = ?, status = 'accepted', updated_at = CURRENT_TIMESTAMP
      WHERE ride_id = ? AND status = 'requested' AND (driver_user_id IS NULL OR driver_user_id = ?)
    `).run(driverId, String(req.params.rideId), driverId);
    if (!changed.changes) return res.status(409).json({ success: false, message: 'This ride was accepted already or assigned to another driver.' });
    const ride = await getRide(req.params.rideId);
    await sendNotification(ride.passenger_user_id, driverId, 'mini_ride', `${ride.driver_full_name} accepted your ride request.`, '/mini-ride');
    await notifyRoot(driverId, `${ride.driver_full_name} accepted Mini Ride ${ride.ride_id}.`);
    response(res, await getRideDetails(ride));
  } catch (error) { next(error); }
};

export const assignMiniRideDriver = async (req, res, next) => {
  try {
    const ride = await getNeonRide(req.params.rideId);
    const driverId = String(req.body?.driverId || '');
    if (!ride) return res.status(404).json({ success: false, message: 'Ride request not found.' });
    if (!['requested', 'accepted'].includes(ride.status)) {
      return res.status(409).json({ success: false, message: 'A driver can only be assigned before the ride starts.' });
    }
    const driver = await neonFirst(`
      SELECT COALESCE(NULLIF(u.full_name, ''), u.username) AS name
      FROM users u JOIN mini_ride_drivers d ON d.user_id = u._id::text
      WHERE u._id::text = ? AND LOWER(u.role) = 'driver' AND u.is_active = 1
        AND EXISTS (
          SELECT 1 FROM mini_ride_driver_applications a
          WHERE a.user_id = u._id::text AND a.status = 'approved'
        )
        AND d.is_online = 1 AND d.location_updated_at::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '90 seconds'
    `, [driverId]);
    if (!driver) return res.status(400).json({ success: false, message: 'Choose an active driver who is sharing a current location.' });
    const updated = await neonFirst(`
      UPDATE mini_rides SET driver_user_id = ?, status = 'requested', updated_at = CURRENT_TIMESTAMP
      WHERE ride_id = ? AND status IN ('requested', 'accepted')
      RETURNING ride_id
    `, [driverId, ride.ride_id]);
    if (!updated) return res.status(409).json({ success: false, message: 'A driver can only be assigned before the ride starts.' });
    await sendNeonNotification(driverId, accountId(req), 'mini_ride', `Root assigned you Mini Ride ${ride.ride_id}.`, '/driver');
    await sendNeonNotification(ride.passenger_user_id, accountId(req), 'mini_ride', `Root assigned ${driver.name} to your Mini Ride.`, '/mini-ride');
    response(res, await getNeonRideDetails(await getNeonRide(ride.ride_id)));
  } catch (error) { next(error); }
};

export const startMiniRide = async (req, res, next) => {
  try {
    const ride = await getRide(req.params.rideId);
    if (!ride || String(ride.driver_user_id) !== accountId(req) || roleOf(req) !== 'driver') {
      return res.status(403).json({ success: false, message: 'Only the assigned driver can start this ride.' });
    }
    if (!await requireApprovedDriverApplication(req, res)) return undefined;
    if (ride.status !== 'accepted') return res.status(409).json({ success: false, message: 'Accept the ride before starting it.' });
    if (!await driverIsOnline(accountId(req))) return res.status(409).json({ success: false, message: 'Enable location sharing before starting this ride.' });
    const started = await db().transaction(async () => {
      const changed = await db().prepare(`
        UPDATE mini_rides SET status = 'in_progress', started_at = CURRENT_TIMESTAMP,
          driver_latitude = (SELECT latitude FROM mini_ride_drivers WHERE user_id = ?),
          driver_longitude = (SELECT longitude FROM mini_ride_drivers WHERE user_id = ?),
          updated_at = CURRENT_TIMESTAMP
        WHERE ride_id = ? AND status = 'accepted' AND driver_user_id = ?
        RETURNING ride_id
      `).run(accountId(req), accountId(req), ride.ride_id, accountId(req));
      if (!changed.changes) return false;
      const point = await db().prepare('SELECT latitude, longitude FROM mini_ride_drivers WHERE user_id = ?').get(accountId(req));
      if (!point) throw new Error('Enable location sharing before starting this ride.');
      await db().prepare(`
        INSERT INTO mini_ride_location_points (point_id, ride_id, user_id, role, latitude, longitude)
        VALUES (?, ?, ?, 'driver', ?, ?)
      `).run(randomUUID(), ride.ride_id, accountId(req), point.latitude, point.longitude);
      return true;
    })();
    if (!started) return res.status(409).json({ success: false, message: 'Accept the ride before starting it.' });
    await sendNotification(ride.passenger_user_id, accountId(req), 'mini_ride', 'Your driver started the ride. Live trip tracking is active.', '/mini-ride');
    await notifyRoot(accountId(req), `Mini Ride ${ride.ride_id} started.`);
    response(res, await getRideDetails(await getRide(ride.ride_id)));
  } catch (error) { next(error); }
};

export const updateMiniRideLocation = async (req, res, next) => {
  try {
    const ride = await getRide(req.params.rideId);
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
    const previous = await db().prepare(`
      SELECT latitude, longitude, recorded_at FROM mini_ride_location_points
      WHERE ride_id = ? AND role = ? ORDER BY recorded_at DESC, point_id DESC LIMIT 1
    `).get(ride.ride_id, role);
    let segmentKm = 0;
    if (role === 'driver' && ride.status === 'in_progress' && !ride.ride_paused_at && previous) {
      const seconds = Math.max(0, (Date.now() - new Date(previous.recorded_at).getTime()) / 1000);
      const measuredKm = distanceBetweenKm(Number(previous.latitude), Number(previous.longitude), latitude, longitude);
      if (seconds >= 2 && measuredKm <= Math.max(.15, seconds / 3600 * 120)) segmentKm = measuredKm;
    }
    const tx = db().transaction(async () => {
      await db().prepare(`
        INSERT INTO mini_ride_location_points (point_id, ride_id, user_id, role, latitude, longitude)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), ride.ride_id, userId, role, latitude, longitude);
      const columnPrefix = role === 'driver' ? 'driver' : 'passenger';
      await db().prepare(`
        UPDATE mini_rides SET ${columnPrefix}_latitude = ?, ${columnPrefix}_longitude = ?,
          distance_km = distance_km + ?, updated_at = CURRENT_TIMESTAMP WHERE ride_id = ?
      `).run(latitude, longitude, segmentKm, ride.ride_id);
      if (role === 'driver') {
        await db().prepare(`
          UPDATE mini_ride_drivers SET latitude = ?, longitude = ?, location_updated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP WHERE user_id = ?
        `).run(latitude, longitude, userId);
      }
    });
    await tx();
    response(res, { updated: true });
  } catch (error) { next(error); }
};

export const finishMiniRide = async (req, res, next) => {
  try {
    const ride = await getRide(req.params.rideId);
    const userId = accountId(req);
    const role = roleOf(req);
    const canFinish = ride && (
      String(ride.passenger_user_id) === userId ||
      (role === 'driver' && String(ride.driver_user_id) === userId)
    );
    if (!canFinish) {
      return res.status(403).json({ success: false, message: 'Only this ride’s passenger or assigned driver can finish the trip.' });
    }
    return await completeMiniRide(ride, userId, next, res);
  } catch (error) { next(error); }
};

export const updateMiniRidePause = async (req, res, next) => {
  try {
    const ride = await getRide(req.params.rideId);
    const driverId = accountId(req);
    const paused = req.body?.paused === true;
    if (!ride || roleOf(req) !== 'driver' || String(ride.driver_user_id) !== driverId) {
      return res.status(403).json({ success: false, message: 'Only the assigned driver can pause or resume this trip.' });
    }
    if (ride.status !== 'in_progress') {
      return res.status(409).json({ success: false, message: 'Only a started trip can be paused or resumed.' });
    }
    if (paused && !ride.ride_paused_at) {
      await db().prepare('UPDATE mini_rides SET ride_paused_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE ride_id = ? AND status = ? AND ride_paused_at IS NULL')
        .run(ride.ride_id, 'in_progress');
    } else if (!paused && ride.ride_paused_at) {
      await db().prepare('UPDATE mini_rides SET ride_paused_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE ride_id = ? AND status = ?')
        .run(ride.ride_id, 'in_progress');
    }
    const updatedRide = await getRide(ride.ride_id);
    const message = updatedRide.ride_paused_at ? 'Your driver paused the trip. The fare meter is stopped.' : 'Your driver resumed the trip.';
    await sendNotification(ride.passenger_user_id, driverId, 'mini_ride', message, '/mini-ride');
    await notifyRoot(driverId, `Mini Ride ${ride.ride_id} ${updatedRide.ride_paused_at ? 'paused' : 'resumed'}.`);
    response(res, await getRideDetails(updatedRide));
  } catch (error) { next(error); }
};

export const rootFinishMiniRide = async (req, res, next) => {
  try {
    if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access is required.' });
    const ride = await getNeonRide(req.params.rideId);
    if (!ride) return res.status(404).json({ success: false, message: 'Ride request not found.' });
    if (ride.status !== 'in_progress') return res.status(409).json({ success: false, message: 'This ride is not in progress.' });
    const settings = await getNeonSettings();
    const measuredDistance = Number(ride.distance_km || 0);
    const distanceKm = Math.round((measuredDistance > 0 ? measuredDistance : Number(ride.route_distance_km || 0)) * 100) / 100;
    const fare = Math.round((
      Number(settings.base_fare) + distanceKm * Number(settings.fare_per_km) +
      Number(ride.load_kg) / 1000 * Number(settings.fare_per_ton)
    ) * 100) / 100;
    const updated = await neonFirst(`
      UPDATE mini_rides SET status = 'awaiting_payment', fare_amount = ?, distance_km = ?,
        completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE ride_id = ? AND status = 'in_progress'
      RETURNING *
    `, [fare, distanceKm, ride.ride_id]);
    if (!updated) return res.status(409).json({ success: false, message: 'This ride is not in progress.' });
    const actorId = accountId(req);
    await sendNeonNotification(ride.passenger_user_id, actorId, 'mini_ride', `Your ride is finished. ETB ${fare.toFixed(2)} is due for payment.`, '/mini-ride');
    if (ride.driver_user_id) await sendNeonNotification(ride.driver_user_id, actorId, 'mini_ride', `Ride finished. Passenger payment due: ETB ${fare.toFixed(2)}.`, '/driver');
    await notifyNeonRoot(actorId, `Mini Ride ${ride.ride_id} finished; ETB ${fare.toFixed(2)} is due.`);
    response(res, await getNeonRideDetails(await getNeonRide(ride.ride_id)));
  } catch (error) { next(error); }
};

const completeMiniRide = async (ride, actorId, next, res) => {
  try {
    if (ride.status !== 'in_progress') return res.status(409).json({ success: false, message: 'This ride is not in progress.' });
    const settings = await getSettings();
    const measuredDistance = Number(ride.distance_km || 0);
    const distanceKm = Math.round((measuredDistance > 0 ? measuredDistance : Number(ride.route_distance_km || 0)) * 100) / 100;
    const fare = Math.round((
      Number(settings.base_fare) +
      distanceKm * Number(settings.fare_per_km) +
      Number(ride.load_kg) / 1000 * Number(settings.fare_per_ton)
    ) * 100) / 100;
    const updated = await neonFirst(`
      UPDATE mini_rides SET status = 'awaiting_payment', fare_amount = ?, distance_km = ?,
        completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE ride_id = ? AND status = 'in_progress'
      RETURNING *
    `, [fare, distanceKm, ride.ride_id]);
    if (!updated) return res.status(409).json({ success: false, message: 'This ride is not in progress.' });
    await sendNotification(ride.passenger_user_id, actorId, 'mini_ride', `Your ride is finished. ETB ${fare.toFixed(2)} is due for payment.`, '/mini-ride');
    if (ride.driver_user_id) await sendNotification(ride.driver_user_id, actorId, 'mini_ride', `Ride finished. Passenger payment due: ETB ${fare.toFixed(2)}.`, '/driver');
    await notifyRoot(actorId, `Mini Ride ${ride.ride_id} finished; ETB ${fare.toFixed(2)} is due.`);
    response(res, await getRideDetails(await getRide(ride.ride_id)));
  } catch (error) { next(error); }
};

export const submitMiniRidePayment = async (req, res, next) => {
  try {
    const ride = await getRide(req.params.rideId);
    if (!ride || String(ride.passenger_user_id) !== accountId(req)) {
      return res.status(403).json({ success: false, message: 'Only the passenger can pay this ride.' });
    }
    if (ride.status !== 'awaiting_payment') return res.status(409).json({ success: false, message: 'This ride is not awaiting payment.' });
    const method = String(req.body?.method || '').trim();
    if (method === 'cash') {
      const updated = await neonFirst(`
        UPDATE mini_rides SET status = 'cash_confirmation', payment_method = 'Cash',
          payment_status = 'pending', updated_at = CURRENT_TIMESTAMP
        WHERE ride_id = ? AND status = 'awaiting_payment'
        RETURNING ride_id
      `, [ride.ride_id]);
      if (!updated) return res.status(409).json({ success: false, message: 'This ride payment has already been submitted.' });
      await sendNotification(ride.driver_user_id, accountId(req), 'mini_ride_cash', 'Passenger selected cash. Confirm receipt after collecting the fare.', '/driver');
      await notifyRoot(accountId(req), `Cash payment confirmation requested for Mini Ride ${ride.ride_id}.`);
      return response(res, await getRideDetails(await getRide(ride.ride_id)));
    }
    if (method === 'wallet') {
      const paidRide = await withNeonTransaction(async client => {
        await neonTransactionQuery(client, 'SELECT _id FROM users WHERE _id::text = ? FOR UPDATE', [accountId(req)]);
        const current = (await neonTransactionQuery(client, `
          SELECT * FROM mini_rides WHERE ride_id = ? FOR UPDATE
        `, [ride.ride_id])).rows[0];
        if (!current || current.status !== 'awaiting_payment') throw new Error('This ride payment has already been submitted.');
        const balance = Number((await neonTransactionQuery(client, `
          SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_ledger
          WHERE user_id = ? AND balance_type = 'real'
        `, [accountId(req)])).rows[0].balance);
        if (balance < Number(current.fare_amount)) throw new Error(`Insufficient real wallet balance. Available: ETB ${balance.toFixed(2)}.`);
        const reference = `mini-ride-wallet-payment:${current.ride_id}`;
        const charged = await neonTransactionQuery(client, `
          INSERT INTO wallet_ledger
            (entry_id, user_id, amount, entry_type, reference, description, currency, balance_type)
          VALUES (?, ?, ?, 'mini_ride_payment', ?, ?, 'ETB', 'real')
          ON CONFLICT (reference) DO NOTHING
          RETURNING entry_id
        `, [randomUUID(), accountId(req), -Number(current.fare_amount), reference, `Payment for Mini Ride ${current.ride_id}`]);
        if (charged.rowCount !== 1) throw new Error('This wallet payment has already been used.');
        const updated = await neonTransactionQuery(client, `
          UPDATE mini_rides SET status = 'completed', payment_status = 'paid',
            payment_method = 'REDSEA Wallet', paid_at = CURRENT_TIMESTAMP,
            completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP WHERE ride_id = ? AND status = 'awaiting_payment'
          RETURNING *
        `, [current.ride_id]);
        if (!updated.rowCount) throw new Error('This ride payment has already been submitted.');
        const completedRide = updated.rows[0];
        const commission = Number((await neonTransactionQuery(client, `
          SELECT driver_commission_percent FROM mini_ride_settings WHERE id = 1
        `)).rows[0].driver_commission_percent);
        const driverShare = Math.round(Number(completedRide.fare_amount) * commission) / 100;
        await creditDriverEarning(completedRide, driverShare, client);
        await rewardCompletedRide(completedRide, client);
        return completedRide;
      });
      await sendNotification(paidRide.driver_user_id, accountId(req), 'mini_ride', 'Passenger paid by REDSEA Wallet. Ride completed.', '/driver');
      return response(res, await getRideDetails(await getRide(paidRide.ride_id)));
    }
    if (!method || method.length > 100 || !String(req.body?.reference || '').trim() || String(req.body.reference).trim().length > 180) {
      return res.status(400).json({ success: false, message: 'Choose a payment provider and enter its payment reference.' });
    }
    const updated = await neonFirst(`
      UPDATE mini_rides SET status = 'payment_review', payment_status = 'pending',
        payment_method = ?, payment_reference = ?, updated_at = CURRENT_TIMESTAMP
      WHERE ride_id = ? AND status = 'awaiting_payment'
      RETURNING ride_id
    `, [method, String(req.body.reference).trim(), ride.ride_id]);
    if (!updated) return res.status(409).json({ success: false, message: 'This ride payment has already been submitted.' });
    await notifyRoot(accountId(req), `Mini Ride ${ride.ride_id} payment needs review (${method}).`);
    await sendNotification(ride.driver_user_id, accountId(req), 'mini_ride', 'Passenger submitted payment for Root verification.', '/driver');
    response(res, await getRideDetails(await getRide(ride.ride_id)));
  } catch (error) {
    if (String(error?.message || '').startsWith('Insufficient real wallet balance.')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

export const confirmMiniRideCash = async (req, res, next) => {
  try {
    if (roleOf(req) !== 'driver') return res.status(403).json({ success: false, message: 'Driver account required.' });
    const ride = await getRide(req.params.rideId);
    if (!ride || String(ride.driver_user_id) !== accountId(req) || ride.status !== 'cash_confirmation') {
      return res.status(409).json({ success: false, message: 'This ride has no cash receipt awaiting driver confirmation.' });
    }
    const completed = await withNeonTransaction(async client => {
      const updated = await neonTransactionQuery(client, `
        UPDATE mini_rides SET status = 'completed', payment_status = 'paid', payment_method = 'Cash',
          paid_at = CURRENT_TIMESTAMP, completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
        WHERE ride_id = ? AND status = 'cash_confirmation'
        RETURNING *
      `, [ride.ride_id]);
      if (!updated.rowCount) throw Object.assign(new Error('This ride has no cash receipt awaiting driver confirmation.'), { status: 409 });
      await rewardCompletedRide(updated.rows[0], client);
      return updated.rows[0];
    });
    await sendNotification(ride.passenger_user_id, accountId(req), 'mini_ride', 'Driver confirmed the cash payment. Thank you for riding with REDSEA.', '/mini-ride');
    await notifyRoot(accountId(req), `Driver confirmed cash for Mini Ride ${ride.ride_id}.`);
    response(res, await getRideDetails(await getRide(completed.ride_id)));
  } catch (error) { next(error); }
};

export const getDriverMiniRideDashboard = async (req, res, next) => {
  try {
    if (!await requireApprovedDriverApplication(req, res)) return undefined;
    const userId = accountId(req);
    const driverStatus = await db().prepare('SELECT * FROM mini_ride_drivers WHERE user_id = ?').get(userId) || {
      user_id: userId, is_online: 0,
    };
    const rides = await db().prepare(`
      SELECT r.*, COALESCE(passenger.full_name, passenger.username) AS passenger_username
      FROM mini_rides r
      LEFT JOIN users passenger ON passenger._id::text = r.passenger_user_id
      WHERE r.driver_user_id = ? OR (r.status = 'requested' AND r.driver_user_id IS NULL)
      ORDER BY CASE WHEN r.status = 'requested' THEN 0 ELSE 1 END, r.created_at DESC
      LIMIT 100
    `).all(userId);
    const earnings = await db().prepare(`
      SELECT COALESCE(SUM(amount), 0) AS wallet_earnings FROM wallet_ledger
      WHERE user_id = ? AND entry_type = 'mini_ride_earning' AND balance_type = 'real'
    `).get(userId);
    const [totalTrips, coinEarnings, online, settings] = await Promise.all([
      db().prepare("SELECT COUNT(*) AS count FROM mini_rides WHERE driver_user_id = ? AND status = 'completed'").get(userId),
      db().prepare(`
        SELECT COALESCE(SUM(amount), 0) AS coins FROM wallet_coin_ledger
        WHERE user_id = ? AND entry_type = 'mini_ride_driver_reward'
      `).get(userId),
      driverIsOnline(userId),
      getSettings(),
    ]);
    response(res, {
      status: { ...driverStatus, online: Number(driverStatus.is_online) === 1 && online },
      settings,
      rides: await Promise.all(rides.map(ride => getRideDetails(ride))),
      summary: {
        totalTrips: Number(totalTrips.count),
        walletEarnings: Number(earnings.wallet_earnings),
        coinEarnings: Number(coinEarnings.coins),
      },
    });
  } catch (error) { next(error); }
};

export const getRootMiniRideData = async (req, res, next) => {
  try {
    if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access is required.' });
    const [rideRows, drivers, totals, payoutSummary, settings] = await Promise.all([
      neonRows(`
      SELECT r.*, COALESCE(passenger.full_name, passenger.username) AS passenger_username,
        passenger.phone AS passenger_account_phone,
        COALESCE(driver.full_name, driver.username, 'Unassigned') AS driver_full_name,
        driver.phone AS driver_phone
      FROM mini_rides r
      LEFT JOIN users passenger ON passenger._id::text = r.passenger_user_id
      LEFT JOIN users driver ON driver._id::text = r.driver_user_id
      ORDER BY r.created_at DESC LIMIT 500
    `),
      neonRows(`
      SELECT u._id::text AS user_id, u.username,
        COALESCE(NULLIF(u.full_name, ''), u.username) AS full_name, u.phone, u.is_active,
        COALESCE((SELECT SUM(w.amount) FROM wallet_ledger w
          WHERE w.user_id = u._id::text AND w.balance_type = 'real'), 0) AS real_balance,
        COALESCE((SELECT SUM(w.amount) FROM wallet_ledger w
          WHERE w.user_id = u._id::text AND w.balance_type = 'bonus'), 0) AS bonus_balance,
        COALESCE((SELECT SUM(c.amount) FROM wallet_coin_ledger c
          WHERE c.user_id = u._id::text), 0) AS coin_balance,
        CASE WHEN d.is_online = 1 AND d.location_updated_at::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '90 seconds'
          AND u.is_active = 1 THEN 1 ELSE 0 END AS is_online,
        d.latitude, d.longitude, d.location_updated_at
      FROM users u LEFT JOIN mini_ride_drivers d ON d.user_id = u._id::text
      WHERE LOWER(u.role) = 'driver' ORDER BY u.username
    `),
      neonFirst(`
      SELECT COUNT(*) AS ride_count,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN fare_amount ELSE 0 END), 0) AS completed_fares,
        SUM(CASE WHEN status IN ('requested', 'accepted', 'in_progress', 'cash_confirmation', 'payment_review') THEN 1 ELSE 0 END) AS active_count,
        SUM(CASE WHEN status = 'payment_review' THEN 1 ELSE 0 END) AS pending_payment_count
      FROM mini_rides
    `),
      neonFirst(`
      SELECT COALESCE(SUM(amount), 0) AS amount
      FROM wallet_ledger WHERE entry_type = 'mini_ride_earning' AND balance_type = 'real'
    `),
      getNeonSettings(),
    ]);
    const rides = await Promise.all(rideRows.map(getNeonRideDetails));
    const driverWalletPayouts = Number(payoutSummary.amount);
    const completedFares = Number(totals.completed_fares || 0);
    const platformSharePercent = 100 - Number(settings.driver_commission_percent);
    response(res, {
      settings,
      rides,
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

export const adjustMiniRideDriverWallet = async (req, res, next) => {
  try {
    if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access is required.' });
    const driverId = String(req.params.driverId || '');
    const asset = String(req.body?.asset || '').trim().toLowerCase();
    const direction = String(req.body?.direction || '').trim().toLowerCase();
    const amount = Number(req.body?.amount);
    const description = String(req.body?.description || '').trim();
    const driver = await neonFirst("SELECT _id FROM users WHERE _id::text = ? AND LOWER(role) = 'driver'", [driverId]);
    if (!driver) return res.status(404).json({ success: false, message: 'Mini Ride driver not found.' });
    if (!['real', 'bonus', 'coin'].includes(asset) || !['credit', 'debit'].includes(direction) ||
        !Number.isFinite(amount) || amount <= 0 || amount > 100000000 ||
        (asset === 'coin' && !Number.isSafeInteger(amount)) ||
        !description || description.length > 500) {
      return res.status(400).json({ success: false, message: 'Provide a valid balance type, action, amount, and reason. Coin amounts must be whole numbers.' });
    }
    const signedAmount = direction === 'credit' ? amount : -amount;
    const reference = `root-mini-ride-wallet:${asset}:${randomUUID()}`;
    await withNeonTransaction(async client => {
      await neonTransactionQuery(client, 'SELECT _id FROM users WHERE _id::text = ? FOR UPDATE', [driverId]);
      if (direction === 'debit') {
        const currentBalance = asset === 'coin'
          ? Number((await neonTransactionQuery(client, 'SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_coin_ledger WHERE user_id = ?', [driverId])).rows[0].balance)
          : Number((await neonTransactionQuery(client, `
              SELECT COALESCE(SUM(amount), 0) AS balance
              FROM wallet_ledger WHERE user_id = ? AND balance_type = ?
            `, [driverId, asset])).rows[0].balance);
        const reserved = asset === 'coin' ? 0 : Number((await neonTransactionQuery(client, `
          SELECT COALESCE(SUM(amount), 0) AS balance
          FROM wallet_withdrawals
          WHERE user_id = ? AND balance_type = ? AND status IN ('pending', 'approved')
        `, [driverId, asset])).rows[0].balance);
        if (amount > currentBalance - reserved) {
          throw Object.assign(new Error(`Cannot deduct more than the available ${asset} balance.`), { status: 400 });
        }
      }
      if (asset === 'coin') {
        await neonTransactionQuery(client, `
          INSERT INTO wallet_coin_ledger (entry_id, user_id, amount, entry_type, reference, description)
          VALUES (?, ?, ?, 'root_mini_ride_adjustment', ?, ?)
        `, [randomUUID(), driverId, signedAmount, reference, description]);
      } else {
        await neonTransactionQuery(client, `
          INSERT INTO wallet_ledger
            (entry_id, user_id, amount, entry_type, reference, description, balance_type)
          VALUES (?, ?, ?, 'root_mini_ride_adjustment', ?, ?, ?)
        `, [randomUUID(), driverId, signedAmount, reference, description, asset]);
      }
    });
    response(res, { driver_id: driverId, asset, amount: signedAmount });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    next(error);
  }
};

export const updateRootMiniRideSettings = async (req, res, next) => {
  try {
    if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access is required.' });
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
    await queryNeon(`
      UPDATE mini_ride_settings SET base_fare = ?, fare_per_km = ?, fare_per_ton = ?,
        driver_commission_percent = ?, passenger_coin_reward = ?, driver_coin_reward = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = 1
    `, [
      numbers.base_fare, numbers.fare_per_km, numbers.fare_per_ton,
      numbers.driver_commission_percent, numbers.passenger_coin_reward, numbers.driver_coin_reward
    ]);
    response(res, await getNeonSettings());
  } catch (error) { next(error); }
};

export const reviewMiniRidePayment = async (req, res, next) => {
  try {
    if (!isRoot(req)) return res.status(403).json({ success: false, message: 'Root access is required.' });
    const ride = await getNeonRide(req.params.rideId);
    const status = String(req.body?.status || '');
    if (!ride || ride.status !== 'payment_review' || ride.payment_status !== 'pending') {
      return res.status(409).json({ success: false, message: 'This ride payment is not awaiting Root review.' });
    }
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Choose approved or rejected.' });
    }
    if (status === 'approved') {
      await withNeonTransaction(async client => {
        const updated = await neonTransactionQuery(client, `
          UPDATE mini_rides SET status = 'completed', payment_status = 'paid',
            paid_at = CURRENT_TIMESTAMP, completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
          WHERE ride_id = ? AND status = 'payment_review' AND payment_status = 'pending'
          RETURNING *
        `, [ride.ride_id]);
        if (!updated.rowCount) throw Object.assign(new Error('This ride payment is not awaiting Root review.'), { status: 409 });
        const paidRide = updated.rows[0];
        const settings = (await neonTransactionQuery(client, 'SELECT driver_commission_percent, passenger_coin_reward, driver_coin_reward FROM mini_ride_settings WHERE id = 1')).rows[0];
        const driverShare = Math.round(Number(paidRide.fare_amount) * Number(settings.driver_commission_percent) / 100 * 100) / 100;
        if (paidRide.driver_user_id && driverShare > 0) {
          const ledger = await neonTransactionQuery(client, `
            INSERT INTO wallet_ledger
              (entry_id, user_id, amount, entry_type, reference, description, currency, balance_type)
            VALUES (?, ?, ?, 'mini_ride_earning', ?, ?, 'ETB', 'real')
            ON CONFLICT (reference) DO NOTHING
            RETURNING entry_id
          `, [
            randomUUID(), String(paidRide.driver_user_id), driverShare,
            `mini-ride-driver-earning:${paidRide.ride_id}`,
            `Driver share for mini ride ${paidRide.ride_id}`,
          ]);
          if (ledger.rowCount) {
            await neonTransactionQuery(client, `
              INSERT INTO platform_payout_ledger
                (payout_id, user_id, agent_user_id, amount, request_id, entry_type, reference, description)
              VALUES (?, ?, NULL, ?, ?, 'mini_ride_earning', ?, ?)
            `, [
              randomUUID(), String(paidRide.driver_user_id), -driverShare, paidRide.ride_id,
              `platform-payout:mini-ride-driver-earning:${paidRide.ride_id}`,
              `Driver earning for mini ride ${paidRide.ride_id}`,
            ]);
          }
        }
        for (const [userId, reward, type, reference, description] of [
          [paidRide.passenger_user_id, Number(settings.passenger_coin_reward), 'mini_ride_passenger_reward', `mini-ride:${paidRide.ride_id}:passenger-coins`, 'Mini Ride passenger reward'],
          [paidRide.driver_user_id, Number(settings.driver_coin_reward), 'mini_ride_driver_reward', `mini-ride:${paidRide.ride_id}:driver-coins`, 'Mini Ride driver reward'],
        ]) {
          if (!userId || !Number.isSafeInteger(reward) || reward <= 0) continue;
          const credited = await creditUserCoins(userId, reward, type, reference, description, client);
          if (credited) {
            await neonTransactionQuery(client, `
              INSERT INTO social_notifications (notification_id, user_id, actor_id, type, message, link)
              VALUES (?, ?, NULL, 'coin_reward', ?, '/wallet')
            `, [randomUUID(), String(userId), `You earned ${reward} coins for completing a Mini Ride.`]);
          }
        }
        await sendNeonNotification(paidRide.passenger_user_id, accountId(req), 'mini_ride', 'Root approved your Mini Ride payment. Thank you for riding with REDSEA.', '/mini-ride', client);
        if (paidRide.driver_user_id) {
          await sendNeonNotification(paidRide.driver_user_id, accountId(req), 'mini_ride', 'Root approved the passenger payment. Your ride is complete.', '/driver', client);
        }
      });
      const paid = await getNeonRide(ride.ride_id);
      return response(res, await getNeonRideDetails(paid));
    }
    const rejected = await neonFirst(`
      UPDATE mini_rides SET status = 'awaiting_payment', payment_status = 'rejected',
        payment_method = NULL, payment_reference = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE ride_id = ? AND status = 'payment_review' AND payment_status = 'pending'
      RETURNING ride_id
    `, [ride.ride_id]);
    if (!rejected) return res.status(409).json({ success: false, message: 'This ride payment is not awaiting Root review.' });
    await sendNeonNotification(ride.passenger_user_id, accountId(req), 'mini_ride', 'Root could not verify your payment. Choose another payment method and retry.', '/mini-ride');
    response(res, await getNeonRideDetails(await getNeonRide(ride.ride_id)));
  } catch (error) { next(error); }
};
// ... [የቀረው የኮድ ክፍል ካቆመበት የሚቀጥለው] ...

export const completeMiniRide = async (ride, userId, next, res = null) => {
  try {
    const finished = await db().transaction(async () => {
      const changed = await db().prepare(`
        UPDATE mini_rides SET status = 'completed', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE ride_id = ? AND status IN ('accepted', 'in_progress')
        RETURNING *
      `).run(ride.ride_id);
      if (!changed.changes) return null;
      return changed.rows[0];
    })();
    if (!finished) {
      if (res) return res.status(409).json({ success: false, message: 'This ride has already been finished or cancelled.' });
      return;
    }
    await creditDriverEarning(ride, Number(ride.route_distance_km || 0) * 15); // ምሳሌ የክፍያ ስሌት
    await rewardCompletedRide(ride);
    await sendNotification(ride.passenger_user_id, userId, 'mini_ride', 'Your Mini Ride has been completed. Thank you!', '/mini-ride');
    if (ride.driver_user_id && ride.driver_user_id !== userId) {
      await sendNotification(ride.driver_user_id, userId, 'mini_ride', `Mini Ride ${ride.ride_id} was completed.`, '/driver');
    }
    await notifyRoot(userId, `Mini Ride ${ride.ride_id} completed.`);
    if (res) {
      response(res, await getRideDetails(await getRide(ride.ride_id)));
    }
  } catch (error) {
    if (next) next(error);
  }
};
export const finishMiniRide = async (req, res, next) => {
  try {
    const ride = await getRide(req.params.rideId);
    const userId = accountId(req);
    const role = roleOf(req);
    const canFinish = ride && (
      String(ride.passenger_user_id) === userId ||
      (role === 'driver' && String(ride.driver_user_id) === userId)
    );
    if (!canFinish) {
      return res.status(403).json({ success: false, message: 'Only this ride’s passenger or assigned driver can finish the trip.' });
    }
    return await completeMiniRide(ride, userId, next, res);
  } catch (error) { next(error); }
};

export const updateMiniRidePause = async (req, res, next) => {
  try {
    const ride = await getRide(req.params.rideId);
    const userId = accountId(req);
    if (!ride || String(ride.driver_user_id) !== userId || roleOf(req) !== 'driver') {
      return res.status(403).json({ success: false, message: 'Only the assigned driver can pause or resume this ride.' });
    }
    if (ride.status !== 'in_progress') {
      return res.status(409).json({ success: false, message: 'Ride must be in progress to pause or resume.' });
    }
    const pause = req.body?.pause === true;
    await db().prepare(`
      UPDATE mini_rides SET ride_paused_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
        updated_at = CURRENT_TIMESTAMP WHERE ride_id = ?
    `).run(pause ? 1 : 0, ride.ride_id);
    response(res, await getRideDetails(await getRide(ride.ride_id)));
  } catch (error) { next(error); }
};

export const completeMiniRide = async (ride, userId, next, res = null) => {
  try {
    const finished = await db().transaction(async () => {
      const changed = await db().prepare(`
        UPDATE mini_rides SET status = 'completed', finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE ride_id = ? AND status IN ('accepted', 'in_progress')
        RETURNING *
      `).run(ride.ride_id);
      if (!changed.changes) return null;
      return changed.rows[0];
    })();
    if (!finished) {
      if (res) return res.status(409).json({ success: false, message: 'This ride has already been finished or cancelled.' });
      return;
    }
    await creditDriverEarning(ride, Number(ride.route_distance_km || 0) * 15);
    await rewardCompletedRide(ride);
    await sendNotification(ride.passenger_user_id, userId, 'mini_ride', 'Your Mini Ride has been completed. Thank you!', '/mini-ride');
    if (ride.driver_user_id && ride.driver_user_id !== userId) {
      await sendNotification(ride.driver_user_id, userId, 'mini_ride', `Mini Ride ${ride.ride_id} was completed.`, '/driver');
    }
    await notifyRoot(userId, `Mini Ride ${ride.ride_id} completed.`);
    if (res) {
      response(res, await getRideDetails(await getRide(ride.ride_id)));
    }
  } catch (error) {
    if (next) next(error);
  }
};
