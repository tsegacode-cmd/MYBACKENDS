import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

// Neon PostgreSQL configuration
const DATABASE_URL = process.env.DATABASE_URL;

// Connection state
let postgresPool = null;
let connectionStatus = {
  postgresql: { connected: false, lastAttempt: null, error: null },
  primaryDB: 'postgresql'
};

/**
 * Connect to Neon PostgreSQL with retry logic
 */
export const connectPostgreSQL = async () => {
  connectionStatus.postgresql.lastAttempt = new Date();
  
  try {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not defined!');
    }

    if (!postgresPool) {
      postgresPool = new Pool({
        connectionString: DATABASE_URL,
        ssl: {
          rejectUnauthorized: false // Neon requires SSL connection
        }
      });
    }

    // Test connection
    const client = await postgresPool.connect();
    await client.query('SELECT NOW()');
    client.release();

    connectionStatus.postgresql.connected = true;
    connectionStatus.postgresql.error = null;
    connectionStatus.primaryDB = 'postgresql';

    console.log('✅ Neon PostgreSQL connected successfully');
    console.log(`   Database URL configured securely`);

    return postgresPool;
  } catch (error) {
    connectionStatus.postgresql.connected = false;
    connectionStatus.postgresql.error = error.message;
    console.error(`❌ Neon PostgreSQL connection failed: ${error.message}`);
    throw error;
  }
};

/**
 * Get database connection status
 */
export const getDatabaseStatus = () => {
  return {
    ...connectionStatus,
    timestamp: new Date()
  };
};

/**
 * Get active database connection pool
 */
export const getActiveDB = () => {
  if (!postgresPool) {
    throw new Error('PostgreSQL not connected. Call initializeDatabases() first.');
  }
  return { type: 'postgresql', db: postgresPool };
};

export const getPostgreSQLPool = () => {
  if (!postgresPool) {
    throw new Error('PostgreSQL pool not initialized.');
  }
  return postgresPool;
};

// Compatibility wrappers so other files (like autoMigrate.js) won't crash
export const getMongoDB = () => {
  if (!postgresPool) {
    throw new Error('PostgreSQL not initialized.');
  }
  return postgresPool;
};

export const getRawSQLiteDB = () => {
  throw new Error('SQLite is no longer supported. Using Neon PostgreSQL.');
};

export const getMySQLPool = () => {
  throw new Error('MySQL is not used. Using Neon PostgreSQL.');
};

export const isMongoDBAvailable = () => {
  return connectionStatus.postgresql.connected && postgresPool !== null;
};

export const isMySQLAvailable = () => {
  return false;
};

export const autoFixDatabaseConnection = async () => {
  console.log('🔧 Verifying Neon PostgreSQL connection...');
  try {
    await connectPostgreSQL();
    return { postgresql: { success: true }, timestamp: new Date() };
  } catch (error) {
    return { postgresql: { success: false, error: error.message }, timestamp: new Date() };
  }
};

/**
 * Close all database connections
 */
export const closeAllConnections = async () => {
  if (postgresPool) {
    try {
      await postgresPool.end();
      postgresPool = null;
      connectionStatus.postgresql.connected = false;
      console.log('✅ PostgreSQL connection closed');
    } catch (error) {
      console.error(`❌ PostgreSQL close error: ${error.message}`);
    }
  }
};

/**
 * Initialize database connections - Connects to Neon PostgreSQL
 */
export const initializeDatabases = async () => {
  console.log('🚀 Initializing database connections (Neon PostgreSQL)...');
  
  try {
    await connectPostgreSQL();
    console.log('✅ Neon PostgreSQL Database initialized successfully');
    console.log('✅ Data persistence is active on Neon Cloud (No data loss)');
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize Neon PostgreSQL Database:', error.message);
    throw error;
  }
};

export default {
  connectPostgreSQL,
  autoFixDatabaseConnection,
  getDatabaseStatus,
  getActiveDB,
  getPostgreSQLPool,
  getMongoDB,
  getRawSQLiteDB,
  getMySQLPool,
  isMongoDBAvailable,
  isMySQLAvailable,
  closeAllConnections,
  initializeDatabases
};
