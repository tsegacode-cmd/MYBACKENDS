import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, 'database_files/redsea_brokerage.db');

async function resetAllPasswords() {
  try {
    console.log('🔐 Resetting passwords for all users...\n');
    console.log('═'.repeat(60));
    
    const db = new Database(DB_FILE);
    
    // Get all active users
    const users = db.prepare('SELECT _id, username, role FROM users WHERE is_active = 1').all();
    
    console.log(`\n📋 Found ${users.length} active users\n`);
    
    // Default password for all users
    const defaultPassword = 'redsea@2024';
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);
    
    console.log(`🔑 Setting password for all users to: ${defaultPassword}\n`);
    console.log('─'.repeat(60));
    
    // Update each user
    const updateStmt = db.prepare('UPDATE users SET password_hash = ? WHERE _id = ?');
    
    for (const user of users) {
      updateStmt.run(hashedPassword, user._id);
      console.log(`✅ ${user.username.padEnd(20)} (${user.role})`);
    }
    
    db.close();
    
    console.log('\n' + '═'.repeat(60));
    console.log('\n✅ All passwords have been reset successfully!');
    console.log('\n📝 Login credentials for ALL users:');
    console.log(`   Password: ${defaultPassword}`);
    console.log('\n💡 Users can now login from any device with their username and this password');
    console.log('\n🔒 Users should change their password after first login');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

resetAllPasswords();
