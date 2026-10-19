import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'database_files', 'redsea_brokerage.db');
const db = new Database(dbPath);

console.log('Setting DEFAULT for created_at column...\n');

try {
  // SQLite doesn't support ALTER COLUMN to add DEFAULT
  // So we need to check if created_at has a default
  const tableInfo = db.prepare('PRAGMA table_info(data_registrations)').all();
  const createdAtCol = tableInfo.find(col => col.name === 'created_at');
  
  console.log('created_at column info:', createdAtCol);
  
  if (createdAtCol && createdAtCol.dflt_value === null) {
    console.log('\n⚠️  created_at has no DEFAULT value');
    console.log('SQLite cannot add DEFAULT to existing column');
    console.log('Solution: Backend will not insert created_at, database will use CURRENT_TIMESTAMP');
  } else {
    console.log('\n✅ created_at column is configured');
  }
  
  // Update any NULL created_at values to current timestamp
  const updateResult = db.prepare(`
    UPDATE data_registrations 
    SET created_at = datetime('now') 
    WHERE created_at IS NULL
  `).run();
  
  console.log(`\nUpdated ${updateResult.changes} rows with NULL created_at`);
  
} catch (error) {
  console.error('\n❌ Error:', error.message);
  process.exit(1);
} finally {
  db.close();
}
