import { addNeonColumns, runNeonMaintenance } from './utils/neonMaintenance.js';

await runNeonMaintenance(async pool => {
  console.log('Adding registered_at to Neon data_registrations...');
  await addNeonColumns(pool, 'data_registrations', { registered_at: 'TEXT' });
  const columns = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'data_registrations'
     ORDER BY ordinal_position`
  );
  console.log(`Verified ${columns.rows.length} registration columns`);
});
