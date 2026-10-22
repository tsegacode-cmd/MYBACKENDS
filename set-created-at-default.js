import { runNeonMaintenance } from './utils/neonMaintenance.js';

await runNeonMaintenance(async pool => {
  const { rows: columns } = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'data_registrations'
       AND column_name = 'created_at'`
  );
  if (!columns.length) throw new Error('public.data_registrations.created_at does not exist in Neon');

  await pool.query(`
    ALTER TABLE data_registrations
    ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP::text
  `);
  const { rowCount } = await pool.query(`
    UPDATE data_registrations
    SET created_at = CURRENT_TIMESTAMP::text
    WHERE created_at IS NULL
  `);
  console.log(`Set Neon created_at default and backfilled ${rowCount} null rows.`);
});
