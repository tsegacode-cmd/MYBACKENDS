import { getPostgreSQLPool } from './databaseManager.js';
import bcrypt from 'bcryptjs';

/**
 * Auto-migrate database schema on server startup
 * Creates tables (including missing user columns) first, then synchronizes root user
 */
export const autoMigrateDatabase = async () => {
  console.log('🔄 Running auto-migration (PostgreSQL)...');
  
  try {
    const pool = getPostgreSQLPool();
    
    if (!pool) {
      console.log('⚠️  Database pool not available, skipping migration');
      return false;
    }

    // 1. CREATE TABLES FIRST (Including created_by_user_id, created_by_role, commission_settings)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(255),
        role VARCHAR(50) DEFAULT 'user',
        position VARCHAR(100),
        phone VARCHAR(50),
        email VARCHAR(255),
        permissions TEXT,
        commission_settings TEXT,
        created_by_user_id VARCHAR(255),
        created_by_role VARCHAR(50),
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Ensure all required columns exist in 'users' table if it was created previously
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_settings TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by_user_id VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by_role VARCHAR(50);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions TEXT;
    `).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS data_registrations (
        _id SERIAL PRIMARY KEY,
        round INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS service_payment_settings (
        configKey VARCHAR(255) PRIMARY KEY,
        configJson TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS project_documents (
        project_title TEXT PRIMARY KEY,
        pdf_data TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bank_receipt_documents (
        registration_id INTEGER PRIMARY KEY,
        pdf_data TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS owner_receipt_documents (
        registration_id INTEGER PRIMARY KEY,
        pdf_data TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. SYNCHRONIZE ROOT USER
    const rootUsername = process.env.ROOT_USERNAME?.trim() || 'root';
    const rootPassword = process.env.ROOT_PASSWORD;

    if (rootPassword) {
      const passwordHash = bcrypt.hashSync(rootPassword, 10);
      const userQuery = `
        INSERT INTO users (username, password_hash, full_name, role, position, is_active, updated_at)
        VALUES ($1, $2, 'Root Administrator', 'admin', 'System Administrator', 1, CURRENT_TIMESTAMP)
        ON CONFLICT (username) DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          role = 'admin',
          is_active = 1,
          updated_at = CURRENT_TIMESTAMP
      `;
      await pool.query(userQuery, [rootUsername, passwordHash]);
      console.log('   ✅ Root administrator credentials synchronized from environment');
    } else {
      console.warn('⚠️  ROOT_PASSWORD is not configured; skipping root-user credential migration');
    }

    // 4. CHECK AND ADD MISSING COLUMNS TO data_registrations
    const tableInfoQuery = `
      SELECT column_name as name 
      FROM information_schema.columns 
      WHERE table_name = 'data_registrations';
    `;
    const tableInfoResult = await pool.query(tableInfoQuery);
    const existingColumns = new Set(tableInfoResult.rows.map(col => col.name));
    
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
    for (const column of newColumns) {
      if (!existingColumns.has(column.name)) {
        try {
          const sql = `ALTER TABLE data_registrations ADD COLUMN ${column.name} ${column.type} DEFAULT ${column.default}`;
          await pool.query(sql);
          console.log(`   ✅ Added column to data_registrations: ${column.name}`);
          addedCount++;
        } catch (error) {
          console.error(`   ❌ Failed to add column ${column.name}:`, error.message);
        }
      }
    }

    console.log(`✅ Auto-migration completed successfully.`);
    return true;
  } catch (error) {
    console.error('❌ Auto-migration failed:', error.message);
    return false;
  }
};

export default { autoMigrateDatabase };
