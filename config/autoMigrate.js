import { getRawSQLiteDB } from './databaseManager.js';
import bcrypt from 'bcryptjs';

/**
 * Auto-migrate database schema on server startup
 * Adds missing columns to existing tables and ensures Default Root User exists
 */
export const autoMigrateDatabase = () => {
  console.log('🔄 Running auto-migration...');
  
  try {
    const db = getRawSQLiteDB();
    
    if (!db) {
      console.log('⚠️ Database not available, skipping migration');
      return false;
    }

    // 1. RECREATE USERS TABLE WITH ALL REQUIRED COLUMNS INCLUDING permissions
    db.exec(`
      DROP TABLE IF EXISTS users;
      CREATE TABLE users (
        _id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE,
        password TEXT,
        password_hash TEXT,
        full_name TEXT,
        permissions TEXT,
        role TEXT DEFAULT 'user',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Users table recreated successfully with permissions schema');

    // Get credentials from Environment Variables or use defaults
    const rootUsername = process.env.ROOT_USERNAME || process.env.DEFAULT_ROOT_USERNAME || 'tsegawbizuayehuatredsea';
    const rootPassword = process.env.ROOT_PASSWORD || process.env.DEFAULT_ROOT_PASSWORD || '12345678';

    // Hash password & insert root user
    const hashedPassword = bcrypt.hashSync(rootPassword, 10);

    db.prepare(`
      INSERT INTO users (username, email, password, password_hash, full_name, permissions, role)
      VALUES (?, ?, ?, ?, ?, ?, 'root')
    `).run(rootUsername, `${rootUsername}@redsea.com`, hashedPassword, hashedPassword, 'Tsegaw Bizuayehu', 'all');

    console.log(`✅ Default Root User created successfully!`);
    console.log(`   👉 Username: ${rootUsername}`);

    // 2. DATA REGISTRATIONS MIGRATION
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
        } catch (error) {
          console.error(`❌ Failed to add column ${column.name}:`, error.message);
        }
      }
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS project_documents (
        project_title TEXT PRIMARY KEY,
        pdf_data TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Auto-migration completed successfully');
    return true;
  } catch (error) {
    console.error('❌ Auto-migration failed:', error.message);
    return false;
  }
};

export default { autoMigrateDatabase };
