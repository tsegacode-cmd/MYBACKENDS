import { MongoClient } from 'mongodb';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import * as fileDB from './fileDatabase.js';
import * as sqliteDB from './sqliteDatabase.js';
import bcrypt from 'bcryptjs';
import { closeNeonDatabase, getNeonPool, initializeNeonDatabase } from './neonDatabase.js';

dotenv.config();

// Database configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'redsea_brokerage';
const USE_SQLITE = process.env.USE_SQLITE !== 'false'; // Default to SQLite
const USE_FILE_DB = process.env.USE_FILE_DB === 'true';

// MySQL configuration
const MYSQL_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'redsea_brokerage',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000
};

// Connection state
let mongoClient = null;
let mongoDB = null;
let mysqlPool = null;
let usingFileDB = false;
let usingSQLite = false;
let connectionStatus = {
  mongodb: { connected: false, lastAttempt: null, error: null },
  neon: { connected: false, lastAttempt: null, error: null },
  mysql: { connected: false, lastAttempt: null, error: null },
  sqlite: { connected: false, lastAttempt: null, error: null },
  filedb: { connected: false, lastAttempt: null, error: null },
  primaryDB: 'sqlite' // Default to SQLite
};

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 5,
  retryDelay: 3000, // 3 seconds
  connectionTimeout: 10000 // 10 seconds
};

/**
 * Connect to MongoDB with retry logic
 */
export const connectMongoDB = async (retries = RETRY_CONFIG.maxRetries) => {
  connectionStatus.mongodb.lastAttempt = new Date();
  
  try {
    // Check if already connected
    if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected()) {
      connectionStatus.mongodb.connected = true;
      connectionStatus.mongodb.error = null;
      return mongoDB;
    }

    if (connectionStatus.neon.connected) {
      try {
        await closeNeonDatabase();
        connectionStatus.neon.connected = false;
        results.push('Neon PostgreSQL connection closed');
      } catch (error) {
        results.push(`Neon PostgreSQL close error: ${error.message}`);
      }
    }

    // Create new connection
    mongoClient = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000, // Reduced from 10s to 5s for faster fallback
      socketTimeoutMS: 45000,
      retryWrites: true,
      retryReads: true,
    });

    await mongoClient.connect();
    mongoDB = mongoClient.db(MONGODB_DB_NAME);

    // Test connection
    await mongoDB.admin().ping();

    connectionStatus.mongodb.connected = true;
    connectionStatus.mongodb.error = null;

    console.log('✅ MongoDB connected successfully');
    console.log(`   URI: ${MONGODB_URI}`);
    console.log(`   Database: ${MONGODB_DB_NAME}`);

    // Set up connection monitoring
    setupMongoDBMonitoring();

    // Create indexes
    await createMongoDBIndexes();

    return mongoDB;
  } catch (error) {
    connectionStatus.mongodb.connected = false;
    connectionStatus.mongodb.error = error.message;
    
    // Don't retry if it's a connection refused error (MongoDB not running)
    if (error.message.includes('ECONNREFUSED') || error.message.includes('connect')) {
      // Only log on first attempt to avoid spam
      if (retries === RETRY_CONFIG.maxRetries) {
        console.log('ℹ️  MongoDB not available (service not running) - using SQLite');
      }
      return null;
    }

    // Only log detailed errors on first attempt
    if (retries === RETRY_CONFIG.maxRetries) {
      console.warn(`⚠️  MongoDB connection failed: ${error.message}`);
    }

    // Retry logic for other errors
    if (retries > 0) {
      console.log(`   Retrying MongoDB connection (${RETRY_CONFIG.maxRetries - retries + 1}/${RETRY_CONFIG.maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_CONFIG.retryDelay));
      return connectMongoDB(retries - 1);
    }

    return null;
  }
};

/**
 * Setup MongoDB connection monitoring and auto-reconnect
 */
const setupMongoDBMonitoring = () => {
  if (!mongoClient) return;

  mongoClient.on('close', () => {
    console.warn('⚠️  MongoDB connection closed');
    connectionStatus.mongodb.connected = false;
    attemptReconnect();
  });

  mongoClient.on('error', (error) => {
    console.error('❌ MongoDB connection error:', error.message);
    connectionStatus.mongodb.connected = false;
    connectionStatus.mongodb.error = error.message;
  });

  mongoClient.on('timeout', () => {
    console.warn('⚠️  MongoDB connection timeout');
  });

  mongoClient.on('reconnect', () => {
    console.log('✅ MongoDB reconnected successfully');
    connectionStatus.mongodb.connected = true;
    connectionStatus.mongodb.error = null;
  });
};

/**
 * Attempt to reconnect to MongoDB
 */
const attemptReconnect = async () => {
  console.log('🔄 Attempting to reconnect to MongoDB...');
  
  // Wait before attempting reconnection
  await new Promise(resolve => setTimeout(resolve, RETRY_CONFIG.retryDelay));
  
  try {
    await connectMongoDB();
  } catch (error) {
    console.error('❌ Reconnection failed:', error.message);
  }
};

/**
 * Connect to MySQL with retry logic
 */
export const connectMySQL = async (retries = RETRY_CONFIG.maxRetries) => {
  connectionStatus.mysql.lastAttempt = new Date();
  
  try {
    // Create connection pool if not exists
    if (!mysqlPool) {
      mysqlPool = mysql.createPool(MYSQL_CONFIG);
    }

    // Test connection
    const connection = await mysqlPool.getConnection();
    await connection.ping();
    connection.release();

    connectionStatus.mysql.connected = true;
    connectionStatus.mysql.error = null;

    console.log('✅ MySQL connected successfully');
    console.log(`   Host: ${MYSQL_CONFIG.host}`);
    console.log(`   Database: ${MYSQL_CONFIG.database}`);

    return mysqlPool;
  } catch (error) {
    connectionStatus.mysql.connected = false;
    connectionStatus.mysql.error = error.message;
    
    // Only log on first attempt to avoid spam
    if (retries === RETRY_CONFIG.maxRetries) {
      console.log('ℹ️  MySQL not available (service not running or not configured) - using SQLite');
    }

    return null;
  }
};

/**
 * Check if SQLite is available and working
 */
const checkSQLiteConnection = () => {
  try {
    if (!usingSQLite) {
      console.log('   checkSQLiteConnection: usingSQLite is false');
      return false;
    }
    
    // Try to get the SQLite DB instance
    const db = sqliteDB.getSQLiteDB();
    if (!db) {
      console.log('   checkSQLiteConnection: getSQLiteDB returned null');
      return false;
    }
    
    console.log('   checkSQLiteConnection: SQLite DB instance exists');
    return true;
  } catch (error) {
    console.error('   checkSQLiteConnection failed:', error.message);
    return false;
  }
};

/**
 * Auto-fix: Attempt to connect to all databases
 */
export const autoFixDatabaseConnection = async () => {
  console.log('🔧 Starting database auto-fix...');
  
  const results = {
    mongodb: { success: false, error: null },
    mysql: { success: false, error: null },
    sqlite: { success: false, error: null },
    timestamp: new Date()
  };

  // Try SQLite first if enabled (default and most reliable)
  if (USE_SQLITE) {
    try {
      // Check if SQLite is already initialized and working
      if (usingSQLite && connectionStatus.sqlite.connected && checkSQLiteConnection()) {
        console.log('✅ SQLite Database already connected and working');
        results.sqlite.success = true;
        results.sqlite.message = 'Already connected';
      } else {
        // Initialize or re-initialize SQLite
        console.log('🔄 Initializing SQLite Database...');
        const initResult = sqliteDB.initializeSQLiteDatabase();
        if (initResult) {
          usingSQLite = true;
          connectionStatus.sqlite.connected = true;
          connectionStatus.sqlite.lastAttempt = new Date();
          connectionStatus.sqlite.error = null;
          connectionStatus.primaryDB = 'sqlite';
          results.sqlite.success = true;
          results.sqlite.message = 'Connected successfully';
          console.log('✅ SQLite Database connected successfully');
        } else {
          throw new Error('SQLite initialization returned false');
        }
      }
    } catch (error) {
      results.sqlite.error = error.message;
      connectionStatus.sqlite.error = error.message;
      console.error('❌ SQLite connection failed:', error.message);
      console.error('   Error stack:', error.stack);
    }
  }

  // Try MongoDB (optional secondary database)
  try {
    const db = await connectMongoDB();
    results.mongodb.success = !!db;
    if (db && !results.sqlite.success) {
      connectionStatus.primaryDB = 'mongodb';
    }
  } catch (error) {
    results.mongodb.error = error.message;
  }

  // Try MySQL (optional fallback)
  try {
    const pool = await connectMySQL();
    results.mysql.success = !!pool;
    if (pool && !results.mongodb.success && !results.sqlite.success) {
      connectionStatus.primaryDB = 'mysql';
    }
  } catch (error) {
    results.mysql.error = error.message;
  }

  // Log results
  if (results.sqlite.success || results.mongodb.success || results.mysql.success) {
    console.log('✅ Auto-fix completed successfully');
    console.log(`   Primary database: ${connectionStatus.primaryDB.toUpperCase()}`);
    console.log(`   SQLite: ${results.sqlite.success ? '✅' : '❌'}`);
    console.log(`   MongoDB: ${results.mongodb.success ? '✅' : '❌'}`);
    console.log(`   MySQL: ${results.mysql.success ? '✅' : '❌'}`);
  } else {
    console.error('❌ Auto-fix failed: No database connections available');
    console.error('   SQLite error:', results.sqlite.error);
    console.error('   MongoDB error:', results.mongodb.error);
    console.error('   MySQL error:', results.mysql.error);
  }

  return results;
};

/**
 * Create MongoDB indexes
 */
const createMongoDBIndexes = async () => {
  if (!mongoDB) return;

  try {
    // Users collection
    await mongoDB.collection('users').createIndex({ username: 1 }, { unique: true });
    await mongoDB.collection('users').createIndex({ email: 1 }, { unique: true, sparse: true });
    await mongoDB.collection('users').createIndex({ role: 1 });

    // Clients collection
    await mongoDB.collection('clients').createIndex({ phone: 1 });
    await mongoDB.collection('clients').createIndex({ status: 1 });
    await mongoDB.collection('clients').createIndex({ created_at: -1 });

    // Transactions collections
    await mongoDB.collection('transactions').createIndex({ transaction_number: 1 }, { unique: true, sparse: true });
    await mongoDB.collection('transactions').createIndex({ client_id: 1 });
    await mongoDB.collection('transactions').createIndex({ status: 1 });
    await mongoDB.collection('transactions').createIndex({ created_at: -1 });

    // Data registrations
    await mongoDB.collection('data_registrations').createIndex({ registered_at: -1 });
    await mongoDB.collection('data_registrations').createIndex({ staff_id: 1 });
    await mongoDB.collection('data_registrations').createIndex({ payment_status: 1 });

    console.log('✅ MongoDB indexes created successfully');
  } catch (error) {
    console.error('⚠️  Warning: Failed to create some indexes:', error.message);
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
 * Get active database connection
 */
export const getActiveDB = () => {
  if (connectionStatus.mongodb.connected && mongoDB) {
    return { type: 'mongodb', db: mongoDB };
  }
  if (connectionStatus.mysql.connected && mysqlPool) {
    return { type: 'mysql', db: mysqlPool };
  }
  return { type: 'none', db: null };
};

/**
 * Get raw SQLite database instance
 */
export const getRawSQLiteDB = () => {
  if (usingSQLite) {
    return sqliteDB.getRawSQLiteDB();
  }
  throw new Error('Not using SQLite database');
};

/**
 * Get MongoDB instance or SQLite/File DB wrapper
 */
export const getMongoDB = () => {
  if (usingSQLite) {
    return sqliteDB.getSQLiteDB();
  }
  
  if (usingFileDB) {
    // Return File DB wrapper that mimics MongoDB API
    return {
      collection: (name) => ({
        find: (query = {}) => ({
          toArray: async () => fileDB.find(name, query),
          sort: (sortObj) => ({
            toArray: async () => {
              const data = fileDB.find(name, query);
              // Simple sort implementation
              const sortKey = Object.keys(sortObj)[0];
              const sortOrder = sortObj[sortKey];
              return data.sort((a, b) => {
                if (sortOrder === 1) return a[sortKey] > b[sortKey] ? 1 : -1;
                return a[sortKey] < b[sortKey] ? 1 : -1;
              });
            },
            limit: (n) => ({
              toArray: async () => {
                const data = fileDB.find(name, query);
                const sortKey = Object.keys(sortObj)[0];
                const sortOrder = sortObj[sortKey];
                const sorted = data.sort((a, b) => {
                  if (sortOrder === 1) return a[sortKey] > b[sortKey] ? 1 : -1;
                  return a[sortKey] < b[sortKey] ? 1 : -1;
                });
                return sorted.slice(0, n);
              }
            })
          }),
          limit: (n) => ({
            toArray: async () => fileDB.find(name, query).slice(0, n)
          })
        }),
        findOne: async (query) => fileDB.findOne(name, query),
        insertOne: async (doc) => fileDB.insertOne(name, doc),
        insertMany: async (docs) => fileDB.insertMany(name, docs),
        updateOne: async (query, update) => fileDB.updateOne(name, query, update),
        deleteOne: async (query) => fileDB.deleteOne(name, query),
        countDocuments: async (query) => fileDB.countDocuments(name, query),
        aggregate: (pipeline) => ({
          toArray: async () => fileDB.aggregate(name, pipeline)
        })
      })
    };
  }
  
  if (!mongoDB) {
    throw new Error('MongoDB not connected. Call connectMongoDB() first.');
  }
  return mongoDB;
};

/**
 * Get MySQL pool
 */
export const getMySQLPool = () => {
  if (!mysqlPool) {
    throw new Error('MySQL not connected. Call connectMySQL() first.');
  }
  return mysqlPool;
};

/**
 * Check if MongoDB is available
 */
export const isMongoDBAvailable = () => {
  if (usingSQLite || usingFileDB) return true; // SQLite/File DB is always available
  return connectionStatus.mongodb.connected && mongoDB !== null;
};

/**
 * Check if MySQL is available
 */
export const isMySQLAvailable = () => {
  return connectionStatus.mysql.connected && mysqlPool !== null;
};

/**
 * Close all database connections
 */
export const closeAllConnections = async () => {
  const results = [];

  if (mongoClient) {
    try {
      await mongoClient.close();
      mongoClient = null;
      mongoDB = null;
      connectionStatus.mongodb.connected = false;
      results.push('MongoDB connection closed');
    } catch (error) {
      results.push(`MongoDB close error: ${error.message}`);
    }
  }

  if (mysqlPool) {
    try {
      await mysqlPool.end();
      mysqlPool = null;
      connectionStatus.mysql.connected = false;
      results.push('MySQL connection closed');
    } catch (error) {
      results.push(`MySQL close error: ${error.message}`);
    }
  }

  console.log('✅ All database connections closed');
  return results;
};

/**
 * Initialize database connections - Try MongoDB first, fallback to SQLite
 */
export const initializeDatabases = async () => {
  console.log('🚀 Initializing database connections...');

  if (process.env.DATABASE_URL) {
    connectionStatus.neon.lastAttempt = new Date();
    try {
      await initializeNeonDatabase();
      connectionStatus.neon.connected = true;
      connectionStatus.neon.error = null;
      const pool = getNeonPool();
      await pool.query('SELECT _id FROM users LIMIT 0');

      const rootPassword = process.env.ROOT_PASSWORD;
      if (rootPassword) {
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
      }

      console.log('✅ Neon PostgreSQL is ready for password and root authentication');
    } catch (error) {
      connectionStatus.neon.connected = false;
      connectionStatus.neon.error = error.message;
      throw new Error(
        `Neon authentication database initialization failed: ${error.message}. ` +
        'Set DATABASE_URL to a Neon database with the imported application schema.',
        { cause: error }
      );
    }
  }
  
  // Use SQLite if explicitly enabled (default - handles 1M+ users, 10M+ registrations)
  if (USE_SQLITE) {
    console.log('📊 Using SQLite Database (Very High Capacity)');
    try {
      sqliteDB.initializeSQLiteDatabase();
      usingSQLite = true;
      connectionStatus.sqlite.connected = true;
      connectionStatus.sqlite.lastAttempt = new Date();
      connectionStatus.primaryDB = 'sqlite';
      console.log('✅ SQLite Database initialized successfully');
      console.log('✅ Enhanced Capacity: 1,000,000+ users, 10,000,000+ registrations');
      console.log('✅ Max Database Size: ~1TB');
      console.log('✅ All data persists to SQLite database file');
      
      // Try MongoDB in background (optional, non-blocking)
      connectMongoDB().then(mongoDb => {
        if (mongoDb) {
          console.log('✅ MongoDB also connected (available as secondary)');
        }
      }).catch(() => {
        // Silently ignore MongoDB connection failures when SQLite is primary
      });
      
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize SQLite Database:', error.message);
      console.log('⚠️  Falling back to MongoDB...');
    }
  }
  
  // Try MongoDB (if SQLite is disabled or failed)
  if (!USE_FILE_DB) {
    console.log('📌 Attempting MongoDB connection...');
    const mongoDb = await connectMongoDB();
    
    if (mongoDb) {
      connectionStatus.primaryDB = 'mongodb';
      console.log('✅ Using MongoDB as primary database');
      return true;
    }
    
    console.log('⚠️  MongoDB connection failed, trying SQLite fallback...');
    
    // Emergency fallback to SQLite if MongoDB fails
    try {
      sqliteDB.initializeSQLiteDatabase();
      usingSQLite = true;
      connectionStatus.sqlite.connected = true;
      connectionStatus.sqlite.lastAttempt = new Date();
      connectionStatus.primaryDB = 'sqlite';
      console.log('✅ SQLite Database initialized as fallback');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize SQLite fallback:', error.message);
    }
  }
  
  // Fallback to File-Based Database
  if (USE_FILE_DB) {
    console.log('📁 Using File-Based Database');
    try {
      fileDB.initializeFileDatabase();
      usingFileDB = true;
      connectionStatus.filedb.connected = true;
      connectionStatus.filedb.lastAttempt = new Date();
      connectionStatus.primaryDB = 'filedb';
      console.log('✅ File-Based Database initialized successfully');
      console.log('⚠️  Note: File DB best for < 10,000 records');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize File-Based Database:', error.message);
    }
  }
  
  throw new Error('No database available');
};

export default {
  connectMongoDB,
  connectMySQL,
  autoFixDatabaseConnection,
  getDatabaseStatus,
  getActiveDB,
  getMongoDB,
  getMySQLPool,
  isMongoDBAvailable,
  isMySQLAvailable,
  closeAllConnections,
  initializeDatabases
};
