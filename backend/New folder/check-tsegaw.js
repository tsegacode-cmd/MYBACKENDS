import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, 'database_files/redsea_brokerage.db');

const db = new Database(DB_FILE);

console.log('🔍 Checking TSEGAW user...\n');

// Check all users with TSEGAW in name
const users = db.prepare(`
  SELECT _id, username, LENGTH(username) as name_length, role, is_active, 
         HEX(SUBSTR(username, 1, 1)) as first_char_hex,
         HEX(SUBSTR(username, -1, 1)) as last_char_hex
  FROM users 
  WHERE username LIKE '%TSEGAW%'
`).all();

console.log('Found users:', users.length);
console.log('\nDetails:');
users.forEach(user => {
  console.log('─'.repeat(60));
  console.log('ID:', user._id);
  console.log('Username:', `"${user.username}"`);
  console.log('Length:', user.name_length);
  console.log('Role:', user.role);
  console.log('Active:', user.is_active);
  console.log('First char hex:', user.first_char_hex);
  console.log('Last char hex:', user.last_char_hex);
  
  // Check for special characters
  for (let i = 0; i < user.username.length; i++) {
    const char = user.username[i];
    const code = char.charCodeAt(0);
    if (code < 33 || code > 126) {
      console.log(`⚠️ Special char at position ${i}: code ${code}`);
    }
  }
});

console.log('\n' + '═'.repeat(60));

// Try exact match
const exactMatch = db.prepare('SELECT * FROM users WHERE username = ?').get('TSEGAW');
console.log('\nExact match for "TSEGAW":', exactMatch ? 'Found' : 'Not found');

// Try with TRIM
const trimMatch = db.prepare('SELECT * FROM users WHERE TRIM(username) = ?').get('TSEGAW');
console.log('Match with TRIM:', trimMatch ? 'Found' : 'Not found');

db.close();
