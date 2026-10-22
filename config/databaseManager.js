import bcrypt from 'bcryptjs';
import {
  closeNeonDatabase,
  initializeNeonDatabase,
} from './neonDatabase.js';

const connectionStatus = {
  neon: { connected: false, lastAttempt: null, error: null },
  primaryDB: 'neon',
};

const syncRootUser = async pool => {
  const rootPassword = process.env.ROOT_PASSWORD;
  if (!rootPassword) return;

  const rootUsername = process.env.ROOT_USERNAME?.trim() || 'root';
  const passwordHash = await bcrypt.hash(rootPassword, 10);
  await pool.query(`
    INSERT INTO users (username, password_hash, full_name, role, position, is_active)
    VALUES ($1, $2, 'Root Administrator', 'admin', 'System Administrator', 1)
    ON CONFLICT (username) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      role = 'admin',
      is_active = 1,
      updated_at = CURRENT_TIMESTAMP::text
  `, [rootUsername, passwordHash]);
};

export const initializeDatabases = async () => {
  connectionStatus.neon.lastAttempt = new Date();
  try {
    const pool = await initializeNeonDatabase();
    await pool.query('SELECT _id FROM users LIMIT 0');
    await syncRootUser(pool);
    connectionStatus.neon.connected = true;
    connectionStatus.neon.error = null;
    return true;
  } catch (error) {
    connectionStatus.neon.connected = false;
    connectionStatus.neon.error = error.message;
    throw new Error(
      `Neon PostgreSQL initialization failed: ${error.message}. ` +
      'Set DATABASE_URL to a Neon database with the imported application schema and data.',
      { cause: error },
    );
  }
};

export const autoFixDatabaseConnection = async () => {
  connectionStatus.neon.lastAttempt = new Date();
  try {
    const pool = await initializeNeonDatabase();
    await pool.query('SELECT _id FROM users LIMIT 0');
    await syncRootUser(pool);
    connectionStatus.neon.connected = true;
    connectionStatus.neon.error = null;
    return {
      neon: { success: true, error: null, message: 'Connected successfully' },
      timestamp: new Date(),
    };
  } catch (error) {
    connectionStatus.neon.connected = false;
    connectionStatus.neon.error = error.message;
    return {
      neon: { success: false, error: error.message },
      timestamp: new Date(),
    };
  }
};

export const getDatabaseStatus = () => ({
  ...connectionStatus,
  neon: { ...connectionStatus.neon },
  timestamp: new Date(),
});

export const closeAllConnections = async () => {
  await closeNeonDatabase();
  connectionStatus.neon.connected = false;
  return ['Neon PostgreSQL connection closed'];
};

export default {
  initializeDatabases,
  autoFixDatabaseConnection,
  getDatabaseStatus,
  closeAllConnections,
};
