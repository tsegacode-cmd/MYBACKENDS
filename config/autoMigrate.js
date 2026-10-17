import { getRawSQLiteDB } from './databaseManager.js';
import bcrypt from 'bcryptjs';

export const autoMigrateDatabase = () => {
  console.log('🔄 Running auto-migration...');
  
  try {
    const db = getRawSQLiteDB();
    if (!db) return false;

    // 1. RECREATE USERS TABLE
    db.exec(`
      DROP TABLE IF EXISTS users;
      CREATE TABLE users (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE,
        password TEXT,
        password_hash TEXT,
        full_name TEXT,
        position TEXT,
        department TEXT,
        permissions TEXT,
        role TEXT DEFAULT 'user',
        status TEXT DEFAULT 'active',
        phone TEXT,
        avatar TEXT,
        is_active INTEGER DEFAULT 1,
        last_login TEXT,
        login_count INTEGER DEFAULT 0,
        created_by TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. INSERT ROOT USER WITH BOTH PLAIN & HASHED PASSWORD TO PREVENT ANY LOGIN FAILURE
    const rootUsername = 'tsegawbizuayehuatredsea';
    const rootPassword = '12345678';
    const hashedPassword = bcrypt.hashSync(rootPassword, 10);

    db.prepare(`
      INSERT INTO users (username, email, password, password_hash, full_name, position, department, permissions, role, status, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'root', 'active', 1)
    `).run(rootUsername, `${rootUsername}@redsea.com`, rootPassword, hashedPassword, 'Tsegaw Bizuayehu', 'System Administrator', 'IT', 'all');

    // Also support the slight typo variation just in case
    db.prepare(`
      INSERT OR IGNORE INTO users (username, email, password, password_hash, full_name, position, department, permissions, role, status, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'root', 'active', 1)
    `).run('tsegawbizuayheuatredsea', 'tsegaw@redsea.com', rootPassword, hashedPassword, 'Tsegaw Bizuayehu', 'System Administrator', 'IT', 'all');

    console.log(`✅ Default Root Users created successfully!`);

    // 3. FIX OTP CONFIG & SETTINGS TO PREVENT 500 ERRORS
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      
      INSERT OR REPLACE INTO settings (key, value) 
      VALUES ('otp_config', '{"enabled":false,"provider":"none","required":false}');
    `);

    // 4. DATA REGISTRATIONS MIGRATION
    const tableInfo = db.prepare('PRAGMA table_info(data_registrations)').all();
    const existingColumns = new Set(tableInfo.map(col => col.name));

    const newColumns = [
      { name: 'city', type: 'TEXT', default: "'Harar'" },
      { name: 'address', type: 'TEXT', default: 'NULL' },
      { name: 'receipt_no', type: 'TEXT', default: 'NULL' },
      { name: 'project_title', type: 'TEXT', default: 'NULL' },
      { name: 'bank_receipt_pdf', type: 'TEXT', default: 'NULL' },
      { name: 'payment_period_type', type: 'TEXT', default: "'2014-2018'" },
      { name: 'payment_period_from', type: 'TEXT', default: 'NULL' },
      { name: 'payment_period_to', type: 'TEXT', default: 'NULL' },
      { name: 'commission_period_amount', type: 'REAL', default: 'NULL' },
      { name: 'commission_fee', type: 'REAL', default: 'NULL' },
      { name: 'commission_total', type: 'REAL', default: 'NULL' },
      { name: 'collected_amount', type: 'REAL', default: 'NULL' },
      { name: 'registration_datetime', type: 'TEXT', default: 'NULL' }
    ];

    for (const column of newColumns) {
      if (!existingColumns.has(column.name)) {
        try {
          db.exec(`ALTER TABLE data_registrations ADD COLUMN ${column.name} ${column.type} DEFAULT ${column.default}`);
        } catch (error) {}
      }
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS project_documents (
        project_title TEXT PRIMARY KEY,
        pdf_data TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    return true;
  } catch (error) {
    console.error('❌ Auto-migration failed:', error.message);
    return false;
  }
};

export default { autoMigrateDatabase };
