import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'database_files', 'redsea_brokerage.db');
const db = new Database(dbPath);

console.log('Checking if registered_at column needs to be added...\n');

try {
  // Check current columns
  const columns = db.prepare('PRAGMA table_info(data_registrations)').all();
  const columnNames = columns.map(col => col.name);
  
  console.log('Current columns:', columns.length);
  console.log('Column names:', columnNames.join(', '));
  
  // Check if registered_at exists
  const hasRegisteredAt = columnNames.includes('registered_at');
  
  if (hasRegisteredAt) {
    console.log('\n✅ registered_at column already exists');
  } else {
    console.log('\n⚠️  registered_at column does NOT exist');
    console.log('Adding registered_at column...');
    
    db.prepare(`ALTER TABLE data_registrations ADD COLUMN registered_at TEXT`).run();
    console.log('✅ Added registered_at column');
  }
  
  // Verify final count
  const finalColumns = db.prepare('PRAGMA table_info(data_registrations)').all();
  console.log('\nFinal column count:', finalColumns.length);
  
} catch (error) {
  console.error('\n❌ Error:', error.message);
  process.exit(1);
} finally {
  db.close();
}
