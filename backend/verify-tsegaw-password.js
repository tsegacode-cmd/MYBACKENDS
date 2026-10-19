import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, 'database_files/redsea_brokerage.db');

async function verifyTsegawPassword() {
  const db = new Database(DB_FILE);
  
  console.log('🔍 Checking TSEGAW password...\n');
  
  const user = db.prepare('SELECT _id, username, password_hash FROM users WHERE username = ?').get('TSEGAW');
  
  if (!user) {
    console.log('❌ User not found');
    db.close();
    return;
  }
  
  console.log('✅ User found:', user.username);
  console.log('Password hash length:', user.password_hash.length);
  console.log('Password hash:', user.password_hash.substring(0, 20) + '...');
  
  // Test password
  const password = 'redsea@2024';
  console.log(`\n🔑 Testing password: "${password}"`);
  
  try {
    const isValid = await bcrypt.compare(password, user.password_hash);
    
    if (isValid) {
      console.log('✅ Password is CORRECT!');
    } else {
      console.log('❌ Password is INCORRECT');
      console.log('\n🔧 Resetting password...');
      
      const newHash = await bcrypt.hash(password, 10);
      db.prepare('UPDATE users SET password_hash = ? WHERE _id = ?').run(newHash, user._id);
      
      console.log('✅ Password reset complete');
      
      // Verify again
      const updatedUser = db.prepare('SELECT password_hash FROM users WHERE _id = ?').get(user._id);
      const isValidNow = await bcrypt.compare(password, updatedUser.password_hash);
      
      if (isValidNow) {
        console.log('✅ Verification successful - password now works!');
      } else {
        console.log('❌ Still not working - something is wrong');
      }
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
  
  db.close();
}

verifyTsegawPassword();
