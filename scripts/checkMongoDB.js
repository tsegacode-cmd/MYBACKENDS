import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'redsea_brokerage';

/**
 * Check MongoDB connection before starting the server
 */
async function checkMongoDB() {
  console.log('🔍 Checking MongoDB connection...');
  console.log(`   URI: ${MONGODB_URI}`);
  console.log(`   Database: ${MONGODB_DB_NAME}`);
  console.log('');

  let client;
  
  try {
    client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    });

    await client.connect();
    const db = client.db(MONGODB_DB_NAME);
    await db.admin().ping();

    console.log('✅ MongoDB is running and accessible');
    console.log('✅ Connection successful');
    console.log('');
    
    // List collections
    const collections = await db.listCollections().toArray();
    console.log(`📊 Found ${collections.length} collections:`);
    collections.forEach(col => {
      console.log(`   - ${col.name}`);
    });
    console.log('');
    
    await client.close();
    
    console.log('✅ MongoDB check passed - ready to start server');
    process.exit(0);
  } catch (error) {
    console.error('❌ MongoDB connection failed!');
    console.error('');
    console.error('Error:', error.message);
    console.error('');
    console.error('Troubleshooting:');
    console.error('  1. Ensure MongoDB is installed');
    console.error('  2. Start MongoDB service:');
    console.error('     - Windows: Run start-mongodb.bat or net start MongoDB');
    console.error('     - Linux: sudo systemctl start mongod');
    console.error('     - Mac: brew services start mongodb-community');
    console.error('');
    console.error('  3. Verify MongoDB is running:');
    console.error('     - Run: mongosh');
    console.error('     - Should connect without errors');
    console.error('');
    console.error('  4. Check .env configuration:');
    console.error(`     - MONGODB_URI=${MONGODB_URI}`);
    console.error(`     - MONGODB_DB_NAME=${MONGODB_DB_NAME}`);
    console.error('');
    
    if (client) {
      await client.close();
    }
    
    process.exit(1);
  }
}

checkMongoDB();
