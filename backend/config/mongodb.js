import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

// MongoDB connection configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGODB_DB_NAME || 'redsea_brokerage';

let client = null;
let db = null;

// Connect to MongoDB
export const connectMongoDB = async () => {
  try {
    if (client && client.topology && client.topology.isConnected()) {
      console.log('✅ MongoDB already connected');
      return db;
    }

    client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    await client.connect();
    db = client.db(DB_NAME);

    console.log('✅ MongoDB connected successfully');
    console.log(`   URI: ${MONGODB_URI}`);
    console.log(`   Database: ${DB_NAME}`);

    // Create indexes for better performance
    await createIndexes();

    return db;
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    console.error('   Falling back to in-memory storage');
    return null;
  }
};

// Create indexes for collections
const createIndexes = async () => {
  try {
    // Users collection indexes
    await db.collection('users').createIndex({ username: 1 }, { unique: true });
    await db.collection('users').createIndex({ email: 1 }, { unique: true, sparse: true });
    await db.collection('users').createIndex({ role: 1 });
    await db.collection('users').createIndex({ is_active: 1 });

    // Clients collection indexes
    await db.collection('clients').createIndex({ phone: 1 });
    await db.collection('clients').createIndex({ email: 1 }, { sparse: true });
    await db.collection('clients').createIndex({ client_type: 1 });
    await db.collection('clients').createIndex({ status: 1 });
    await db.collection('clients').createIndex({ created_at: -1 });

    // Data registrations collection indexes
    await db.collection('data_registrations').createIndex({ registered_at: -1 });
    await db.collection('data_registrations').createIndex({ staff_id: 1 });
    await db.collection('data_registrations').createIndex({ payment_status: 1 });
    await db.collection('data_registrations').createIndex({ work_type: 1 });

    // Transactions collection indexes
    await db.collection('fixed_transactions').createIndex({ transaction_number: 1 }, { unique: true });
    await db.collection('fixed_transactions').createIndex({ client_id: 1 });
    await db.collection('fixed_transactions').createIndex({ transaction_date: -1 });
    await db.collection('fixed_transactions').createIndex({ status: 1 });
    await db.collection('fixed_transactions').createIndex({ payment_status: 1 });

    await db.collection('movable_transactions').createIndex({ transaction_number: 1 }, { unique: true });
    await db.collection('movable_transactions').createIndex({ client_id: 1 });
    await db.collection('movable_transactions').createIndex({ transaction_date: -1 });
    await db.collection('movable_transactions').createIndex({ status: 1 });
    await db.collection('movable_transactions').createIndex({ payment_status: 1 });

    // Contact inquiries collection indexes
    await db.collection('contact_inquiries').createIndex({ created_at: -1 });
    await db.collection('contact_inquiries').createIndex({ status: 1 });
    await db.collection('contact_inquiries').createIndex({ inquiry_type: 1 });

    console.log('✅ MongoDB indexes created successfully');
  } catch (error) {
    console.error('⚠️  Warning: Failed to create some indexes:', error.message);
  }
};

// Get database instance
export const getDB = () => {
  if (!db) {
    throw new Error('Database not initialized. Call connectMongoDB() first.');
  }
  return db;
};

// Check if MongoDB is available
export const isMongoDBAvailable = async () => {
  try {
    if (!db) return false;
    await db.admin().ping();
    return true;
  } catch (error) {
    return false;
  }
};

// Close MongoDB connection
export const closeMongoDB = async () => {
  try {
    if (client) {
      await client.close();
      client = null;
      db = null;
      console.log('✅ MongoDB connection closed');
    }
  } catch (error) {
    console.error('❌ Error closing MongoDB connection:', error.message);
  }
};

// Helper function to get collection
export const getCollection = (collectionName) => {
  const database = getDB();
  return database.collection(collectionName);
};

export default { connectMongoDB, getDB, isMongoDBAvailable, closeMongoDB, getCollection };
