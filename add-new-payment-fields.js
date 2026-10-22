import { addRegistrationPaymentColumns, runNeonMaintenance } from './utils/neonMaintenance.js';

await runNeonMaintenance(async pool => {
  console.log('Adding registration payment fields to Neon...');
  await addRegistrationPaymentColumns(pool);
  const { rows } = await pool.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'data_registrations'
     ORDER BY ordinal_position`
  );
  console.log('Current registration columns:', rows.map(column => `${column.column_name} (${column.data_type})`).join(', '));
});
