import { getRawSQLiteDB } from './databaseManager.js';
import bcrypt from 'bcryptjs';

const migrateRootUser = (db) => {
  const rootUsername = process.env.ROOT_USERNAME?.trim() || 'root';
  const rootPassword = process.env.ROOT_PASSWORD;

  if (!rootPassword) {
    console.warn('⚠️  ROOT_PASSWORD is not configured; skipping root-user credential migration');
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

  console.log('   ✅ Root administrator credentials synchronized from environment');
};

/**
 * Auto-migrate database schema on server startup
 * Adds missing columns to existing tables
 */
export const autoMigrateDatabase = () => {
  console.log('🔄 Running auto-migration...');
  
  try {
    const db = getRawSQLiteDB();
    
    if (!db) {
      console.log('⚠️  Database not available, skipping migration');
      return false;
    }

    migrateRootUser(db);

    // Get existing columns
    const tableInfo = db.prepare('PRAGMA table_info(data_registrations)').all();
    const existingColumns = new Set(tableInfo.map(col => col.name));
    
    console.log(`   Found ${existingColumns.size} existing columns`);

    // Define new columns to add
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

    // Add missing columns
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

    const projectTitleSetting = db.prepare(
      'SELECT configJson FROM service_payment_settings WHERE configKey = ?'
    ).get('ebc_project_title_settings');
    let defaultProjectTitle = 'EBC LICENCE FEE';
    if (projectTitleSetting?.configJson) {
      try {
        const savedSettings = JSON.parse(projectTitleSetting.configJson);
        if (typeof savedSettings.defaultTitle === 'string' && savedSettings.defaultTitle.trim()) {
          defaultProjectTitle = savedSettings.defaultTitle.trim();
        }
      } catch (error) {
        console.error('❌ Could not read saved project title settings for registration migration:', error.message);
      }
    }
    const backfillResult = db.prepare(`
      UPDATE data_registrations
      SET project_title = ?
      WHERE round = 1 AND (project_title IS NULL OR TRIM(project_title) = '')
    `).run(defaultProjectTitle);
    if (backfillResult.changes > 0) {
      console.log(`   ✅ Restored project title on ${backfillResult.changes} Round 1 registrations`);
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

    if (addedCount > 0) {
      console.log(`✅ Auto-migration completed: ${addedCount} columns added, ${skippedCount} already existed`);
    } else {
      console.log(`✅ Database schema is up to date (${skippedCount} columns checked)`);
    }

    return true;
  } catch (error) {
    console.error('❌ Auto-migration failed:', error.message);
    return false;
  }
};

export default { autoMigrateDatabase };
