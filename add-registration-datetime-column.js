import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, 'database_files', 'redsea_brokerage.db');

console.log('🔧 Adding registration_datetime column to data_registrations table...');
console.log(`   Database: ${DB_FILE}`);

try {
  const db = new Database(DB_FILE);
  
  // Check if column already exists
  const tableInfo = db.prepare("PRAGMA table_info(data_registrations)").all();
  const columnExists = tableInfo.some(col => col.name === 'registration_datetime');
  
  if (columnExists) {
    console.log('✅ Column registration_datetime already exists');
  } else {
    // Add the column
    db.exec(`
      ALTER TABLE data_registrations 
      ADD COLUMN registration_datetime TEXT
    `);
    console.log('✅ Column registration_datetime added successfully');
  }
  
  // Verify the column was added
  const updatedTableInfo = db.prepare("PRAGMA table_info(data_registrations)").all();
  console.log('\n📋 Current data_registrations table structure:');
  updatedTableInfo.forEach(col => {
    console.log(`   - ${col.name} (${col.type})`);
  });
  
  db.close();
  console.log('\n✅ Migration completed successfully');
  
} catch (error) {
  console.error('❌ Migration failed:', error.message);
  process.exit(1);
}
