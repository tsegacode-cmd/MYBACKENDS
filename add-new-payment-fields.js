/**
 * Migration Script: Add New Payment Fields to Database
 * 
 * This script adds the following columns to the data_registrations table:
 * - city
 * - receipt_no
 * - payment_period_type
 * - payment_period_from
 * - payment_period_to
 * - commission_period_amount
 * - commission_fee
 * - commission_total
 * - collected_amount
 * 
 * Run this script with: node add-new-payment-fields.js
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database path
const dbPath = path.join(__dirname, 'database_files', 'redsea_brokerage.db');

console.log('🔧 Starting database migration...');
console.log(`📁 Database path: ${dbPath}`);

// Connect to database
const db = new Database(dbPath);

console.log('✅ Connected to SQLite database');

// Migration queries
const migrations = [
  {
    name: 'Add city column',
    query: `ALTER TABLE data_registrations ADD COLUMN city TEXT DEFAULT 'Harar'`
  },
  {
    name: 'Add receipt_no column',
    query: `ALTER TABLE data_registrations ADD COLUMN receipt_no TEXT`
  },
  {
    name: 'Add payment_period_type column',
    query: `ALTER TABLE data_registrations ADD COLUMN payment_period_type TEXT DEFAULT '2014-2018'`
  },
  {
    name: 'Add payment_period_from column',
    query: `ALTER TABLE data_registrations ADD COLUMN payment_period_from TEXT`
  },
  {
    name: 'Add payment_period_to column',
    query: `ALTER TABLE data_registrations ADD COLUMN payment_period_to TEXT`
  },
  {
    name: 'Add commission_period_amount column',
    query: `ALTER TABLE data_registrations ADD COLUMN commission_period_amount REAL`
  },
  {
    name: 'Add commission_fee column',
    query: `ALTER TABLE data_registrations ADD COLUMN commission_fee REAL`
  },
  {
    name: 'Add commission_total column',
    query: `ALTER TABLE data_registrations ADD COLUMN commission_total REAL`
  },
  {
    name: 'Add collected_amount column',
    query: `ALTER TABLE data_registrations ADD COLUMN collected_amount REAL`
  }
];

// Run migrations
let completedMigrations = 0;
let failedMigrations = 0;

console.log('\n🔄 Running migrations...\n');

migrations.forEach(migration => {
  try {
    console.log(`   Running: ${migration.name}...`);
    db.exec(migration.query);
    console.log(`   ✅ Success`);
    completedMigrations++;
  } catch (error) {
    // Check if column already exists
    if (error.message.includes('duplicate column name')) {
      console.log(`   ⚠️  Column already exists, skipping`);
      completedMigrations++;
    } else {
      console.error(`   ❌ Error: ${error.message}`);
      failedMigrations++;
    }
  }
});

// Verify columns were added
console.log('\n🔍 Verifying columns...\n');

const tableInfo = db.prepare('PRAGMA table_info(data_registrations)').all();

const newColumns = [
  'city',
  'receipt_no',
  'payment_period_type',
  'payment_period_from',
  'payment_period_to',
  'commission_period_amount',
  'commission_fee',
  'commission_total',
  'collected_amount'
];

console.log('📋 New columns status:');
newColumns.forEach(colName => {
  const exists = tableInfo.find(row => row.name === colName);
  if (exists) {
    console.log(`   ✅ ${colName} (${exists.type})`);
  } else {
    console.log(`   ❌ ${colName} - NOT FOUND`);
  }
});

console.log('\n📊 Migration Summary:');
console.log(`   ✅ Successful: ${completedMigrations}`);
console.log(`   ❌ Failed: ${failedMigrations}`);

console.log('\n✨ Migration completed!');
console.log('🎉 You can now use the new payment fields in your application.');

// Close database connection
db.close();
console.log('\n👋 Database connection closed');

