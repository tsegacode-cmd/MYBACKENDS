import { closeNeonDatabase, initializeNeonDatabase } from '../config/neonDatabase.js';

let neonInitialized = false;

try {
  const pool = await initializeNeonDatabase();
  neonInitialized = true;

  const result = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
  const tableNames = result.rows.map(row => row.table_name);

  if (!tableNames.includes('users')) {
    throw new Error(
      'Neon is reachable, but the required public.users table is missing. ' +
      'Import the application schema before starting the backend.'
    );
  }

  console.log(`Neon database is ready (${tableNames.length} public tables; users table found).`);
} catch (error) {
  console.error(`Neon database check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (neonInitialized) {
    await closeNeonDatabase();
  }
}
