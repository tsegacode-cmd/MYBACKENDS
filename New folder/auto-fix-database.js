// Automatic Database Fix Script
// This script will automatically add the missing columns to your database
// Run this with: node auto-fix-database.js

import { query } from './config/database.js';

async function autoFixDatabase() {
  console.log('\n========================================');
  console.log('Automatic Database Fix');
  console.log('========================================\n');

  try {
    // Step 1: Check if table exists
    console.log('Step 1: Checking if data_registrations table exists...');
    const tables = await query("SHOW TABLES LIKE 'data_registrations'");
    
    if (tables.length === 0) {
      console.log('✗ Table data_registrations does not exist!');
      console.log('   Creating table with all required columns...\n');
      
      // Create table with all columns
      await query(`
        CREATE TABLE data_registrations (
          id INT AUTO_INCREMENT PRIMARY KEY,
          work_type VARCHAR(100) NOT NULL,
          staff_id INT NULL,
          staff_username VARCHAR(100) NULL,
          staff_full_name VARCHAR(255) NULL,
          client_name VARCHAR(255) NOT NULL,
          kebele VARCHAR(100) NOT NULL,
          house_no VARCHAR(50) NULL,
          client_phone VARCHAR(50) NOT NULL,
          tv_no VARCHAR(10) NOT NULL,
          person VARCHAR(50) NOT NULL,
          client_email VARCHAR(255) NULL,
          \`condition\` VARCHAR(50) NOT NULL,
          sign VARCHAR(50) NOT NULL,
          payment_status VARCHAR(50) NOT NULL DEFAULT 'unpaid',
          registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_staff_id (staff_id),
          INDEX idx_staff_username (staff_username),
          INDEX idx_work_type (work_type),
          INDEX idx_kebele (kebele),
          INDEX idx_payment_status (payment_status),
          INDEX idx_registered_at (registered_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      
      console.log('✓ Table created successfully!\n');
    } else {
      console.log('✓ Table exists\n');
    }

    // Step 2: Check and add missing columns
    console.log('Step 2: Checking for missing columns...');
    const columns = await query('DESCRIBE data_registrations');
    const existingColumns = columns.map(col => col.Field);
    
    let columnsAdded = 0;

    // Check and add payment_status
    if (!existingColumns.includes('payment_status')) {
      console.log('   Adding payment_status column...');
      await query(`
        ALTER TABLE data_registrations 
        ADD COLUMN payment_status VARCHAR(50) NOT NULL DEFAULT 'unpaid' 
        COMMENT 'Payment status: unpaid or paid'
      `);
      await query('CREATE INDEX idx_payment_status ON data_registrations(payment_status)');
      console.log('   ✓ payment_status added');
      columnsAdded++;
    } else {
      console.log('   ✓ payment_status already exists');
    }

    // Check and add staff_username
    if (!existingColumns.includes('staff_username')) {
      console.log('   Adding staff_username column...');
      await query(`
        ALTER TABLE data_registrations 
        ADD COLUMN staff_username VARCHAR(100) NULL 
        COMMENT 'Username of the staff member' 
        AFTER staff_id
      `);
      await query('CREATE INDEX idx_staff_username ON data_registrations(staff_username)');
      console.log('   ✓ staff_username added');
      columnsAdded++;
    } else {
      console.log('   ✓ staff_username already exists');
    }

    // Check and add staff_full_name
    if (!existingColumns.includes('staff_full_name')) {
      console.log('   Adding staff_full_name column...');
      await query(`
        ALTER TABLE data_registrations 
        ADD COLUMN staff_full_name VARCHAR(255) NULL 
        COMMENT 'Full name of the staff member' 
        AFTER staff_username
      `);
      console.log('   ✓ staff_full_name added');
      columnsAdded++;
    } else {
      console.log('   ✓ staff_full_name already exists');
    }

    console.log('');

    // Step 3: Update existing records
    console.log('Step 3: Updating existing records...');
    
    // Set default payment_status for existing records
    const updateResult1 = await query(`
      UPDATE data_registrations 
      SET payment_status = 'unpaid' 
      WHERE payment_status IS NULL OR payment_status = ''
    `);
    console.log(`   ✓ Updated ${updateResult1.affectedRows} records with default payment_status`);

    // Update staff info from users table
    const updateResult2 = await query(`
      UPDATE data_registrations dr
      LEFT JOIN users u ON dr.staff_id = u.id
      SET 
        dr.staff_username = COALESCE(u.username, 'N/A'),
        dr.staff_full_name = COALESCE(u.full_name, 'N/A')
      WHERE dr.staff_id IS NOT NULL AND (dr.staff_username IS NULL OR dr.staff_username = '')
    `);
    console.log(`   ✓ Updated ${updateResult2.affectedRows} records with staff info from users table`);

    // Set default for records without staff_id
    const updateResult3 = await query(`
      UPDATE data_registrations 
      SET 
        staff_username = 'N/A',
        staff_full_name = 'N/A'
      WHERE staff_id IS NULL AND (staff_username IS NULL OR staff_username = '')
    `);
    console.log(`   ✓ Updated ${updateResult3.affectedRows} records without staff_id\n`);

    // Step 4: Verify
    console.log('Step 4: Verifying database...');
    const finalColumns = await query('DESCRIBE data_registrations');
    const finalColumnNames = finalColumns.map(col => col.Field);
    
    const requiredColumns = ['payment_status', 'staff_username', 'staff_full_name'];
    const allPresent = requiredColumns.every(col => finalColumnNames.includes(col));
    
    if (allPresent) {
      console.log('   ✓ All required columns are present!\n');
      
      // Show statistics
      const stats = await query(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN payment_status = 'unpaid' THEN 1 ELSE 0 END) as unpaid,
          SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) as paid,
          SUM(CASE WHEN staff_username = 'UNAPPROVED STAFF' THEN 1 ELSE 0 END) as need_approval
        FROM data_registrations
      `);
      
      console.log('Current Database Statistics:');
      console.log(`   Total registrations: ${stats[0].total}`);
      console.log(`   Unpaid: ${stats[0].unpaid}`);
      console.log(`   Paid: ${stats[0].paid}`);
      console.log(`   Need Approval: ${stats[0].need_approval}`);
    } else {
      console.log('   ✗ Some columns are still missing!\n');
    }

    console.log('\n========================================');
    console.log('✓ Database Fix Complete!');
    console.log('========================================');
    console.log('\nNext Steps:');
    console.log('1. Restart your backend server');
    console.log('2. Refresh your browser');
    console.log('3. Try creating new registrations');
    console.log('4. Check if they appear in the correct pages\n');

    if (columnsAdded > 0) {
      console.log('⚠️  IMPORTANT: Restart your backend server now!');
      console.log('   Press Ctrl+C to stop the server, then run: npm start\n');
    }

  } catch (error) {
    console.error('\n✗ Error fixing database:', error.message);
    console.log('\nPossible issues:');
    console.log('1. Database connection failed - check backend/.env');
    console.log('2. Insufficient permissions - use root user');
    console.log('3. Database does not exist - create it first');
    console.log('\nError details:', error);
    console.log('\n');
    process.exit(1);
  }
}

// Run the fix
console.log('\n⚠️  WARNING: This script will modify your database structure.');
console.log('Make sure you have a backup if you have important data.\n');

autoFixDatabase().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
