import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, 'database_files/redsea_brokerage.db');

const db = new Database(DB_FILE);

console.log('═'.repeat(70));
console.log('📋 ALL USERNAMES IN DATABASE');
console.log('═'.repeat(70));
console.log();

const users = db.prepare(`
  SELECT _id, username, role, is_active 
  FROM users 
  ORDER BY _id
`).all();

console.log('Total users:', users.length);
console.log();

console.log('┌─────┬──────────────────────┬──────────┬────────┐');
console.log('│ ID  │ Username             │ Role     │ Active │');
console.log('├─────┼──────────────────────┼──────────┼────────┤');

users.forEach(user => {
  const id = String(user._id).padEnd(3);
  const username = `"${user.username}"`.padEnd(20);
  const role = user.role.padEnd(8);
  const active = user.is_active ? '✅' : '❌';
  console.log(`│ ${id} │ ${username} │ ${role} │ ${active}     │`);
});

console.log('└─────┴──────────────────────┴──────────┴────────┘');
console.log();

console.log('💡 IMPORTANT: Usernames are CASE-SENSITIVE!');
console.log();
console.log('Examples:');
console.log('  ✅ Correct: TSEGAW (all capitals)');
console.log('  ❌ Wrong:   Tsegaw (mixed case)');
console.log('  ❌ Wrong:   tsegaw (all lowercase)');
console.log();

console.log('📝 Copy the EXACT username from the table above');
console.log();
console.log('═'.repeat(70));

db.close();
