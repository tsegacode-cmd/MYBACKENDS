import { getPostgreSQLPool } from './databaseManager.js';
import bcrypt from 'bcryptjs';

const migrateRootUser = async (pool) => {
  const rootUsername = process.env.ROOT_USERNAME?.trim() || 'root';
  const rootPassword = process.env.ROOT_PASSWORD;

  if (!rootPassword) {
    console.warn('⚠️  ROOT_PASSWORD is not configured; skipping root-user credential migration');
    return;
  }

  const passwordHash = bcrypt.hashSync(rootPassword, 10);
  
  const query = `
    INSERT INTO users (username, password_hash, full_name, role, position, is_active, updated_at)
    VALUES ($1, $2, 'Root Administrator', 'admin', 'System Administrator', 1, CURRENT_TIMESTAMP)
    ON CONFLICT (username) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      role = 'admin',
      is_active = 1,
      updated_at = CURRENT_TIMESTAMP
  `;

  try {
    await pool.query(query, [rootUsername, passwordHash]);
    console.log('   ✅ Root administrator credentials synchronized from environment');
  } catch (error) {
    console.error('   ❌ Failed to synchronize root user:', error.message);
  }
};

/**
 * Auto-migrate database schema on server startup
 * Adds missing columns to existing tables for PostgreSQL
 */
export const autoMigrateDatabase = async () => {
  console.log('🔄 Running auto-migration...');
  
  try {
    const pool = getPostgreSQLPool();
    
    if (!pool) {
      console.log('⚠️  Database pool not available, skipping migration');
      return false;
    }

    await migrateRootUser(pool);

    // Get existing columns for data_registrations
    const tableInfoQuery = `
      SELECT column_name as name 
      FROM information_schema.columns 
      WHERE table_name = 'data_registrations';
    `;
    const tableInfoResult = await pool.query(tableInfoQuery);
    const existingColumns = new Set(tableInfoResult.rows.map(col => col.name));
    
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
      { name: 'commission_period_amount', type: 'NUMERIC', default: 'NULL' },
      { name: 'commission_fee', type: 'NUMERIC', default: 'NULL' },
      { name: 'commission_total', type: 'NUMERIC', default: 'NULL' },
      { name: 'collected_amount', type: 'NUMERIC', default: 'NULL' },
      { name: 'registration_datetime', type: 'TEXT', default: 'NULL' }
    ];

    let addedCount = 0;
    let skippedCount = 0;

    // Add missing columns
    for (const column of newColumns) {
      if (!existingColumns.has(column.name)) {
        try {
          const sql = `ALTER TABLE data_registrations ADD COLUMN ${column.name} ${column.type} DEFAULT ${column.default}`;
          await pool.query(sql);
          console.log(`   ✅ Added column: ${column.name}`);
          addedCount++;
        } catch (error) {
          console.error(`   ❌ Failed to add column ${column.name}:`, error.message);
        }
      } else {
        skippedCount++;
      }
    }

    // Safely check for default project title settings if table exists
    let defaultProjectTitle = 'EBC LICENCE FEE';
    try {
      const settingResult = await pool.query(
        'SELECT configJson FROM service_payment_settings WHERE configKey = $1',
        ['ebc_project_title_settings']
      );
      if (settingResult.rows.length > 0 && settingResult.rows[0].configjson) {
        const savedSettings = JSON.parse(settingResult.rows[0].configjson);
        if (typeof savedSettings.defaultTitle === 'string' && savedSettings.defaultTitle.trim()) {
          defaultProjectTitle = savedSettings.defaultTitle.trim();
        }
      }
    } catch (err) {
      // Table might not exist yet, ignore safely
    }

    try {
      const backfillResult = await pool.query(`
        UPDATE data_registrations
        SET project_title = $1
        WHERE round = 1 AND (project_title IS NULL OR TRIM(project_title) = '')
      `, [defaultProjectTitle]);
      
      if (backfillResult.rowCount > 0) {
        console.log(`   ✅ Restored project title on ${backfillResult.rowCount} Round 1 registrations`);
      }
    } catch (err) {
      // Column or table might be missing during initial boot, safe to catch
    }

    // Create required tables if they don't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_documents (
        project_title TEXT PRIMARY KEY,
        pdf_data TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bank_receipt_documents (
        registration_id INTEGER PRIMARY KEY,
        pdf_data TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS owner_receipt_documents (
        registration_id INTEGER PRIMARY KEY,
        pdf_data TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
