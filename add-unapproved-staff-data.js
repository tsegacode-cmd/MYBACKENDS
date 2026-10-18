/**
 * Add UNAPPROVED STAFF test data directly to SQLite database
 */

import { getRawSQLiteDB } from './config/databaseManager.js';

function addUnapprovedStaffData() {
  console.log('🔧 Adding UNAPPROVED STAFF test data...');
  
  try {
    const db = getRawSQLiteDB();
    
    if (!db) {
      console.error('❌ Database not available');
      return;
    }
    
    // Check current data
    const existing = db.prepare('SELECT COUNT(*) as count FROM data_registrations WHERE staff_username = ?').get('UNAPPROVED STAFF');
    console.log('📊 Existing UNAPPROVED STAFF records:', existing.count);
    
    // Add test data
    const testData = [
      {
        work_type: 'redsea-ebc',
        staff_id: null,
        staff_username: 'UNAPPROVED STAFF',
        staff_full_name: 'UNAPPROVED STAFF',
        client_name: 'Ahmed Mohammed Test',
        city: 'Harar',
        kebele: '01',
        house_no: 'H-123',
        receipt_no: 'RCP-001',
        client_phone: '+251911234567',
        tv_no: 2,
        person: 'personal',
        client_email: 'ahmed@test.com',
        condition: 'new',
        sign: 'sign',
        gov_letter: 'accept',
        payment_status: 'unpaid',
        paid_amount: null,
        registered_at: new Date().toISOString()
      },
      {
        work_type: 'sells-product',
        staff_id: null,
        staff_username: 'UNAPPROVED STAFF',
        staff_full_name: 'UNAPPROVED STAFF',
        client_name: 'Fatima Hassan Test',
        city: 'Harar',
        kebele: '03',
        house_no: 'H-456',
        receipt_no: 'RCP-002',
        client_phone: '+251922345678',
        tv_no: 1,
        person: 'personal',
        client_email: 'fatima@test.com',
        condition: 'new',
        sign: 'sign',
        gov_letter: 'accept',
        payment_status: 'unpaid',
        paid_amount: null,
        registered_at: new Date().toISOString()
      },
      {
        work_type: 'other',
        staff_id: null,
        staff_username: 'UNAPPROVED STAFF',
        staff_full_name: 'UNAPPROVED STAFF',
        client_name: 'Yusuf Ali Test',
        city: 'Harar',
        kebele: '05',
        house_no: 'H-789',
        receipt_no: 'RCP-003',
        client_phone: '+251933456789',
        tv_no: 3,
        person: 'organization',
        client_email: 'yusuf@test.com',
        condition: 'old',
        sign: 'sign',
        gov_letter: 'accept',
        payment_status: 'unpaid',
        paid_amount: null,
        registered_at: new Date().toISOString()
      }
    ];
    
    // Insert test data
    const insertStmt = db.prepare(`
      INSERT INTO data_registrations (
        work_type, staff_id, staff_username, staff_full_name, client_name,
        city, kebele, house_no, receipt_no, client_phone, tv_no, person,
        client_email, condition, sign, gov_letter, payment_status, paid_amount, registered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let inserted = 0;
    for (const data of testData) {
      try {
        const result = insertStmt.run(
          data.work_type, data.staff_id, data.staff_username, data.staff_full_name,
          data.client_name, data.city, data.kebele, data.house_no, data.receipt_no,
          data.client_phone, data.tv_no, data.person, data.client_email,
          data.condition, data.sign, data.gov_letter, data.payment_status,
          data.paid_amount, data.registered_at
        );
        console.log(`✅ Inserted: ${data.client_name} (ID: ${result.lastInsertRowid})`);
        inserted++;
      } catch (error) {
        console.log(`⚠️ Skipped: ${data.client_name} (may already exist)`);
      }
    }
    
    // Verify insertion
    const final = db.prepare('SELECT COUNT(*) as count FROM data_registrations WHERE staff_username = ?').get('UNAPPROVED STAFF');
    console.log('📊 Total UNAPPROVED STAFF records now:', final.count);
    
    // Show sample data
    const sample = db.prepare('SELECT client_name, kebele, work_type FROM data_registrations WHERE staff_username = ? LIMIT 5').all('UNAPPROVED STAFF');
    console.log('📋 Sample UNAPPROVED STAFF records:');
    sample.forEach((record, index) => {
      console.log(`  ${index + 1}. ${record.client_name} - ${record.kebele} - ${record.work_type}`);
    });
    
    console.log('');
    console.log('✅ Test data added successfully!');
    console.log('🌐 Now refresh the Need Approval page to see the data');
    
  } catch (error) {
    console.error('❌ Failed to add test data:', error);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  addUnapprovedStaffData();
}

export { addUnapprovedStaffData };