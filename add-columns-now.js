import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, 'database_files', 'redsea_brokerage.db');

console.log('========================================');
console.log('ADDING MISSING COLUMNS NOW');
console.log('========================================');
console.log('Database:', DB_FILE);
console.log('');

try {
  const db = new Database(DB_FILE);
  
  // Get existing columns
  const tableInfo = db.prepare('PRAGMA table_info(data_registrations)').all();
  const existingColumns = new Set(tableInfo.map(col => col.name));
  
  console.log(`Current columns: ${existingColumns.size}`);
  console.log('');
  
  // Define columns to add
  const columnsToAdd = [
    { name: 'city', sql: "ALTER TABLE data_registrations ADD COLUMN city TEXT DEFAULT 'Harar'" },
    { name: 'receipt_no', sql: "ALTER TABLE data_registrations ADD COLUMN receipt_no TEXT" },
    { name: 'payment_period_type', sql: "ALTER TABLE data_registrations ADD COLUMN payment_period_type TEXT DEFAULT '2014-2018'" },
    { name: 'payment_period_from', sql: "ALTER TABLE data_registrations ADD COLUMN payment_period_from TEXT" },
    { name: 'payment_period_to', sql: "ALTER TABLE data_registrations ADD COLUMN payment_period_to TEXT" },
    { name: 'commission_period_amount', sql: "ALTER TABLE data_registrations ADD COLUMN commission_period_amount REAL" },
    { name: 'commission_fee', sql: "ALTER TABLE data_registrations ADD COLUMN commission_fee REAL" },
    { name: 'commission_total', sql: "ALTER TABLE data_registrations ADD COLUMN commission_total REAL" },
    { name: 'collected_amount', sql: "ALTER TABLE data_registrations ADD COLUMN collected_amount REAL" }
  ];
  
  let added = 0;
  let skipped = 0;
  
  console.log('Adding columns:');
  console.log('----------------------------------------');
  
  for (const col of columnsToAdd) {
    if (!existingColumns.has(col.name)) {
      try {
        db.exec(col.sql);
        console.log(`✅ Added: ${col.name}`);
        added++;
      } catch (error) {
        console.log(`❌ Failed to add ${col.name}: ${error.message}`);
      }
    } else {
      console.log(`⏭️  Skipped: ${col.name} (already exists)`);
      skipped++;
    }
  }
  
  console.log('');
  console.log('========================================');
  console.log(`✅ COMPLETED: ${added} added, ${skipped} skipped`);
  console.log('========================================');
  console.log('');
  console.log('Now restart your backend server:');
  console.log('  1. Stop the server (Ctrl+C)');
  console.log('  2. Run: node server.js');
  console.log('');
  
  db.close();
} catch (error) {
  console.error('❌ ERROR:', error.message);
  console.error('');
  console.error('Make sure:');
  console.error('  1. The database file exists');
  console.error('  2. No other program has the database open');
  console.error('  3. You have write permissions');
}
