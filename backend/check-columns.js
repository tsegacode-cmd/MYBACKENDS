import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'database_files', 'redsea_brokerage.db');
const db = new Database(dbPath);

try {
  const columns = db.prepare('PRAGMA table_info(data_registrations)').all();
  console.log('Total columns:', columns.length);
  console.log('\nColumn names:');
  columns.forEach((col, i) => {
    console.log(`  ${i+1}. ${col.name} (${col.type})`);
  });
} finally {
  db.close();
}
