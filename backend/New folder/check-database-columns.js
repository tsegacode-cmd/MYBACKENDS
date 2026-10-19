// Simple script to check if database has required columns
// Run this with: node check-database-columns.js

import { query } from './config/database.js';

async function checkDatabaseColumns() {
  console.log('\n========================================');
  console.log('Database Column Check');
  console.log('========================================\n');

  try {
    // Check if table exists
    console.log('1. Checking if data_registrations table exists...');
    const tables = await query("SHOW TABLES LIKE 'data_registrations'");
    
    if (tables.length === 0) {
      console.log('✗ Table data_registrations does not exist!');
      console.log('   Please run the database setup script first.');
      return;
    }
    console.log('✓ Table exists\n');

    // Get table structure
    console.log('2. Checking table columns...');
    const columns = await query('DESCRIBE data_registrations');
    
    console.log('\nCurrent columns:');
    columns.forEach(col => {
      console.log(`   - ${col.Field} (${col.Type})`);
    });

    // Check for required columns
    console.log('\n3. Checking required columns for payment status feature...');
    
    const requiredColumns = ['payment_status', 'staff_username', 'staff_full_name'];
    const existingColumnNames = columns.map(col => col.Field);
    
    let allColumnsExist = true;
    
    requiredColumns.forEach(colName => {
      if (existingColumnNames.includes(colName)) {
        console.log(`   ✓ ${colName} - EXISTS`);
      } else {
        console.log(`   ✗ ${colName} - MISSING`);
        allColumnsExist = false;
      }
    });

    console.log('\n========================================');
    if (allColumnsExist) {
      console.log('✓ All required columns exist!');
      console.log('   Your database is ready to use.');
      
      // Check if there are any registrations
      console.log('\n4. Checking existing registrations...');
      const registrations = await query('SELECT COUNT(*) as count FROM data_registrations');
      console.log(`   Total registrations: ${registrations[0].count}`);
      
      if (registrations[0].count > 0) {
        const unpaid = await query("SELECT COUNT(*) as count FROM data_registrations WHERE payment_status = 'unpaid'");
        const paid = await query("SELECT COUNT(*) as count FROM data_registrations WHERE payment_status = 'paid'");
        console.log(`   Unpaid: ${unpaid[0].count}`);
        console.log(`   Paid: ${paid[0].count}`);
      }
    } else {
      console.log('✗ Missing required columns!');
      console.log('\n   ACTION REQUIRED:');
      console.log('   Run the migration script to add missing columns:');
      console.log('   mysql -u root -p < backend/database/add_payment_status_columns.sql');
      console.log('\n   Or follow the guide in:');
      console.log('   backend/database/MIGRATION_GUIDE.md');
    }
    console.log('========================================\n');

  } catch (error) {
    console.error('\n✗ Error checking database:', error.message);
    console.log('\nPossible issues:');
    console.log('1. Database connection failed - check backend/.env');
    console.log('2. Database does not exist - create it first');
    console.log('3. Wrong credentials - verify DB_USER and DB_PASSWORD');
    console.log('\n');
  }
}

// Run the check
checkDatabaseColumns().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
