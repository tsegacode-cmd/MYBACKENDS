import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, 'database_files', 'redsea_brokerage.db');

console.log('========================================');
console.log('DATABASE COLUMN VERIFICATION');
console.log('========================================');
console.log('Database:', DB_FILE);
console.log('');

try {
  const db = new Database(DB_FILE);
  
  // Get all columns
  const tableInfo = db.prepare('PRAGMA table_info(data_registrations)').all();
  
  console.log(`Total columns: ${tableInfo.length}`);
  console.log('');
  console.log('Column List:');
  console.log('----------------------------------------');
  
  tableInfo.forEach((col, index) => {
    console.log(`${index + 1}. ${col.name} (${col.type})`);
  });
  
  console.log('');
  console.log('Checking for new columns:');
  console.log('----------------------------------------');
  
  const requiredColumns = [
    'city',
    'receipt_no',
    'payment_period_type',
    'payment_period_from',
    'payment_period_to',
    'commission_period_amount',
    'commission_fee',
    'commission_total',
    'collected_amount',
    'registration_datetime'
  ];
  
  const existingColumns = new Set(tableInfo.map(col => col.name));
  let allPresent = true;
  
  requiredColumns.forEach(col => {
    if (existingColumns.has(col)) {
      console.log(`✓ ${col} - EXISTS`);
    } else {
      console.log(`✗ ${col} - MISSING`);
      allPresent = false;
    }
  });
  
  console.log('');
  console.log('========================================');
  if (allPresent) {
    console.log('✅ ALL REQUIRED COLUMNS EXIST');
    console.log('The UPDATE button should work now!');
  } else {
    console.log('❌ SOME COLUMNS ARE MISSING');
    console.log('Please restart the server to run auto-migration');
  }
  console.log('========================================');
  
  db.close();
} catch (error) {
  console.error('❌ Error:', error.message);
}
