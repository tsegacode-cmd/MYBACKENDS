import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, 'database_files/redsea_brokerage.db');

try {
  console.log('🔧 Adding commission_settings column to users table...');
  
  const db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  
  // Check if column already exists
  const columns = db.prepare('PRAGMA table_info(users)').all();
  const hasCommissionSettings = columns.some(col => col.name === 'commission_settings');
  
  if (hasCommissionSettings) {
    console.log('✅ commission_settings column already exists');
  } else {
    // Add the column
    db.prepare('ALTER TABLE users ADD COLUMN commission_settings TEXT').run();
    console.log('✅ commission_settings column added successfully');
  }
  
  db.close();
  console.log('✅ Database migration completed');
} catch (error) {
  console.error('❌ Migration failed:', error.message);
  process.exit(1);
}
