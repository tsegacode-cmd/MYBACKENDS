import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database file location
const DB_DIR = path.join(__dirname, 'database_files');
const DB_FILE = path.join(DB_DIR, 'redsea_brokerage.db');

console.log('🔧 RENAMING COLUMN: client_name → payer_name');
console.log('=====================================');

try {
  const db = new Database(DB_FILE);
  
  // Check if column exists
  const tableInfo = db.prepare('PRAGMA table_info(data_registrations)').all();
  const hasClientName = tableInfo.some(col => col.name === 'client_name');
  const hasPayerName = tableInfo.some(col => col.name === 'payer_name');
  
  console.log('📊 Current columns:', tableInfo.length);
  console.log('🔍 Has client_name:', hasClientName);
  console.log('🔍 Has payer_name:', hasPayerName);
  
  if (hasPayerName) {
    console.log('✅ Column payer_name already exists - no changes needed');
    process.exit(0);
  }
  
  if (!hasClientName) {
    console.log('❌ Column client_name not found - cannot rename');
    process.exit(1);
  }
  
  console.log('🔄 Starting column rename process...');
  
  // SQLite doesn't support ALTER COLUMN RENAME directly
  // We need to create a new table and copy data
  
  // Step 1: Create new table with payer_name
  console.log('📝 Step 1: Creating new table structure...');
  db.exec(`
    CREATE TABLE data_registrations_new (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_type TEXT,
      staff_id INTEGER,
      staff_username TEXT,
      staff_full_name TEXT,
      payer_name TEXT,
      city TEXT DEFAULT 'Harar',
      kebele TEXT,
      house_no TEXT,
      receipt_no TEXT,
      client_phone TEXT,
      tv_no TEXT,
      person TEXT,
      client_email TEXT,
      condition TEXT,
      sign TEXT,
      gov_letter TEXT,
      paid_amount REAL,
      payment_status TEXT DEFAULT 'unpaid',
      payment_period_type TEXT DEFAULT '2014-2018',
      payment_period_from TEXT,
      payment_period_to TEXT,
      commission_period_amount REAL,
      commission_fee REAL,
      commission_total REAL,
      collected_amount REAL,
      registration_datetime TEXT,
      registered_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Step 2: Copy all data from old table to new table
  console.log('📋 Step 2: Copying all existing data...');
  const copyResult = db.exec(`
    INSERT INTO data_registrations_new (
      _id, work_type, staff_id, staff_username, staff_full_name, payer_name,
      city, kebele, house_no, receipt_no, client_phone, tv_no, person,
      client_email, condition, sign, gov_letter, paid_amount, payment_status,
      payment_period_type, payment_period_from, payment_period_to,
      commission_period_amount, commission_fee, commission_total, collected_amount,
      registration_datetime, registered_at, created_at, updated_at
    )
    SELECT 
      _id, work_type, staff_id, staff_username, staff_full_name, client_name,
      city, kebele, house_no, receipt_no, client_phone, tv_no, person,
      client_email, condition, sign, gov_letter, paid_amount, payment_status,
      payment_period_type, payment_period_from, payment_period_to,
      commission_period_amount, commission_fee, commission_total, collected_amount,
      registration_datetime, registered_at, created_at, updated_at
    FROM data_registrations
  `);
  
  // Step 3: Drop old table
  console.log('🗑️  Step 3: Removing old table...');
  db.exec('DROP TABLE data_registrations');
  
  // Step 4: Rename new table
  console.log('🔄 Step 4: Renaming new table...');
  db.exec('ALTER TABLE data_registrations_new RENAME TO data_registrations');
  
  // Verify the change
  const newTableInfo = db.prepare('PRAGMA table_info(data_registrations)').all();
  const hasNewPayerName = newTableInfo.some(col => col.name === 'payer_name');
  const stillHasClientName = newTableInfo.some(col => col.name === 'client_name');
  
  console.log('');
  console.log('✅ COLUMN RENAME COMPLETED!');
  console.log('📊 New table columns:', newTableInfo.length);
  console.log('✅ Has payer_name:', hasNewPayerName);
  console.log('❌ Has client_name:', stillHasClientName);
  
  // Count records to verify data integrity
  const recordCount = db.prepare('SELECT COUNT(*) as count FROM data_registrations').get();
  console.log('📋 Total records preserved:', recordCount.count);
  
  db.close();
  
  console.log('');
  console.log('🎉 SUCCESS: client_name → payer_name');
  console.log('💡 Now update the backend code to use payer_name');
  
} catch (error) {
  console.error('❌ Column rename failed:', error.message);
  console.error('Stack:', error.stack);
}