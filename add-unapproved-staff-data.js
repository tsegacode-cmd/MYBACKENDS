import { runNeonMaintenance } from './utils/neonMaintenance.js';

const testData = [
  {
    work_type: 'redsea-ebc',
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
    registered_at: new Date().toISOString()
  },
  {
    work_type: 'sells-product',
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
    registered_at: new Date().toISOString()
  },
  {
    work_type: 'other',
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
    registered_at: new Date().toISOString()
  }
];

if (process.env.ALLOW_TEST_REGISTRATION_DATA !== 'true') {
  console.error('Test data was not inserted. Set ALLOW_TEST_REGISTRATION_DATA=true to explicitly allow it.');
  process.exitCode = 1;
} else {
  await runNeonMaintenance(async pool => {
    const { rows: existingRows } = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM data_registrations
       WHERE staff_username = $1`,
      ['UNAPPROVED STAFF']
    );
    console.log(`Existing UNAPPROVED STAFF registrations: ${existingRows[0].count}`);

    for (const data of testData) {
      const columns = Object.keys(data);
      const values = Object.values(data);
      const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
      const identifiers = columns.map(column => `"${column}"`).join(', ');
      const { rows } = await pool.query(
        `INSERT INTO data_registrations (${identifiers})
         VALUES (${placeholders})
         RETURNING _id, client_name`,
        values
      );
      console.log(`Inserted test registration: ${rows[0].client_name} (ID ${rows[0]._id})`);
    }
  });
}
