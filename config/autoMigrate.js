import { getRawSQLiteDB } from './databaseManager.js';
import { queryNeon } from './neonDatabase.js';
import bcrypt from 'bcryptjs';

const migrateRootUserToNeon = async () => {
  if (!process.env.DATABASE_URL) return;

  const rootUsername = process.env.ROOT_USERNAME?.trim() || 'root';
  const rootPassword = process.env.ROOT_PASSWORD;

  if (!rootPassword) {
    console.warn('⚠️ ROOT_PASSWORD is not configured for Neon; skipping');
    return;
  }

  try {
    // Ensure users table exists in Neon PostgreSQL
    await queryNeon(`
      CREATE TABLE IF NOT EXISTS users (
        _id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255),
        password_hash TEXT NOT NULL,
        full_name VARCHAR(255),
        role VARCHAR(50) DEFAULT 'user',
        permissions TEXT,
        position VARCHAR(255),
        phone VARCHAR(50),
        is_active INTEGER DEFAULT 1,
        last_login TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const passwordHash = bcrypt.hashSync(rootPassword, 10);
    
    // Check if root user exists
    const { rows: existing } = await queryNeon('SELECT _id FROM users WHERE LOWER(username) = LOWER(?)', [rootUsername]);

    if (existing.length > 0) {
      await queryNeon(`
        UPDATE users 
        SET password_hash = ?, role = 'admin', is_active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE LOWER(username) = LOWER(?)
      `, [passwordHash, rootUsername]);
    } else {
      await queryNeon(`
        INSERT INTO users (username, password_hash, full_name, role, position, is_active)
        VALUES (?, ?, 'Root Administrator', 'admin', 'System Administrator', 1)
      `, [rootUsername, passwordHash]);
    }

    console.log('   ✅ Root administrator synchronized to Neon PostgreSQL');
  } catch (error) {
    console.error('   ❌ Failed to sync root user to Neon:', error.message);
  }
};

const migrateRootUser = (db) => {
  const rootUsername = process.env.ROOT_USERNAME?.trim() || 'root';
  const rootPassword = process.env.ROOT_PASSWORD;

  if (!rootPassword) {
    console.warn('⚠️ ROOT_PASSWORD is not configured; skipping root-user credential migration');
    return;
  }

  const passwordHash = bcrypt.hashSync(rootPassword, 10);
  db.prepare(`
    INSERT INTO users (username, password_hash, full_name, role, position, is_active)
    VALUES (?, ?, 'Root Administrator', 'admin', 'System Administrator', 1)
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash,
      role = 'admin',
      is_active = 1,
      updated_at = CURRENT_TIMESTAMP
  `).run(rootUsername, passwordHash);

  console.log('   ✅ Root administrator credentials synchronized from environment (SQLite)');
};

/**
 * Auto-migrate database schema on server startup
 */
export const autoMigrateDatabase = async () => {
  console.log('🔄 Running auto-migration...');
  
  try {
    // Sync to Neon PostgreSQL as well
    await migrateRootUserToNeon();

    const db = getRawSQLiteDB();
    
    if (!db) {
      console.log('⚠️ Database not available, skipping SQLite migration');
      return false;
    }

    migrateRootUser(db);

    // Get existing columns for SQLite
    const tableInfo = db.prepare('PRAGMA table_info(data_registrations)').all();
    const existingColumns = new Set(tableInfo.map(col => col.name));
    
    console.log(`   Found ${existingColumns.size} existing columns`);

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

    let addedCount = 0;
    let skippedCount = 0;

    for (const column of newColumns) {
      if (!existingColumns.has(column.name)) {
        try {
          const sql = `ALTER TABLE data_registrations ADD COLUMN ${column.name} ${column.type} DEFAULT ${column.default}`;
          db.exec(sql);
          console.log(`   ✅ Added column: ${column.name}`);
          addedCount++;
        } catch (error) {
          console.error(`   ❌ Failed to add column ${column.name}:`, error.message);
        }
      } else {
        skippedCount++;
      }
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS project_documents (
        project_title TEXT PRIMARY KEY,
        pdf_data TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS bank_receipt_documents (
        registration_id INTEGER PRIMARY KEY,
        pdf_data TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (registration_id) REFERENCES data_registrations(_id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS owner_receipt_documents (
        registration_id INTEGER PRIMARY KEY,
        pdf_data TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (registration_id) REFERENCES data_registrations(_id) ON DELETE CASCADE
      )
    `);

    console.log(`✅ Auto-migration completed successfully`);
    return true;
  } catch (error) {
    console.error('❌ Auto-migration failed:', error.message);
    return false;
  }
};

export default { autoMigrateDatabase };
