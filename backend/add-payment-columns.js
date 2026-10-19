import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'database_files', 'redsea_brokerage.db');
const db = new Database(dbPath);

console.log('Starting migration to add missing payment columns...\n');

try {
  // Add city column
  try {
    db.prepare(`ALTER TABLE data_registrations ADD COLUMN city TEXT DEFAULT 'Harar'`).run();
    console.log('✓ Added city column');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('- city column already exists');
    } else {
      throw e;
    }
  }

  // Add receipt_no column
  try {
    db.prepare(`ALTER TABLE data_registrations ADD COLUMN receipt_no TEXT`).run();
    console.log('✓ Added receipt_no column');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('- receipt_no column already exists');
    } else {
      throw e;
    }
  }

  // Add payment_period_type column
  try {
    db.prepare(`ALTER TABLE data_registrations ADD COLUMN payment_period_type TEXT DEFAULT '2014-2018'`).run();
    console.log('✓ Added payment_period_type column');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('- payment_period_type column already exists');
    } else {
      throw e;
    }
  }

  // Add payment_period_from column
  try {
    db.prepare(`ALTER TABLE data_registrations ADD COLUMN payment_period_from TEXT`).run();
    console.log('✓ Added payment_period_from column');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('- payment_period_from column already exists');
    } else {
      throw e;
    }
  }

  // Add payment_period_to column
  try {
    db.prepare(`ALTER TABLE data_registrations ADD COLUMN payment_period_to TEXT`).run();
    console.log('✓ Added payment_period_to column');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('- payment_period_to column already exists');
    } else {
      throw e;
    }
  }

  // Add commission_period_amount column
  try {
    db.prepare(`ALTER TABLE data_registrations ADD COLUMN commission_period_amount REAL`).run();
    console.log('✓ Added commission_period_amount column');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('- commission_period_amount column already exists');
    } else {
      throw e;
    }
  }

  // Add commission_fee column
  try {
    db.prepare(`ALTER TABLE data_registrations ADD COLUMN commission_fee REAL`).run();
    console.log('✓ Added commission_fee column');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('- commission_fee column already exists');
    } else {
      throw e;
    }
  }

  // Add commission_total column
  try {
    db.prepare(`ALTER TABLE data_registrations ADD COLUMN commission_total REAL`).run();
    console.log('✓ Added commission_total column');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('- commission_total column already exists');
    } else {
      throw e;
    }
  }

  // Add collected_amount column
  try {
    db.prepare(`ALTER TABLE data_registrations ADD COLUMN collected_amount REAL`).run();
    console.log('✓ Added collected_amount column');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('- collected_amount column already exists');
    } else {
      throw e;
    }
  }

  // Add gov_letter column
  try {
    db.prepare(`ALTER TABLE data_registrations ADD COLUMN gov_letter TEXT DEFAULT 'accept'`).run();
    console.log('✓ Added gov_letter column');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('- gov_letter column already exists');
    } else {
      throw e;
    }
  }

  // Add paid_amount column
  try {
    db.prepare(`ALTER TABLE data_registrations ADD COLUMN paid_amount REAL`).run();
    console.log('✓ Added paid_amount column');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('- paid_amount column already exists');
    } else {
      throw e;
    }
  }

  // Add registration_datetime column
  try {
    db.prepare(`ALTER TABLE data_registrations ADD COLUMN registration_datetime TEXT`).run();
    console.log('✓ Added registration_datetime column');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('- registration_datetime column already exists');
    } else {
      throw e;
    }
  }

  console.log('\n✅ Migration completed successfully!');
  console.log('\nVerifying table structure...');
  
  const columns = db.prepare('PRAGMA table_info(data_registrations)').all();
  console.log('\nCurrent columns in data_registrations table:');
  columns.forEach(col => {
    console.log(`  - ${col.name} (${col.type})`);
  });

} catch (error) {
  console.error('\n❌ Migration failed:', error.message);
  process.exit(1);
} finally {
  db.close();
}
