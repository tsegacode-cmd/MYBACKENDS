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

  // --- የጎደሉትን አምዶች (Columns) በራሱ ማስተካከያ (Auto-Migration/Patch) ---
  console.log('🔄 Checking and patching missing database columns...');

  const alterQueries = [
    // 1. በ messages ሠንጠረዥ ውስጥ deleted_at ካለ መኖሩን እያረጋገጠ ማከል
    `ALTER TABLE IF EXISTS messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;`,
    // 2. በ drivers ሠንጠረዥ ውስጥ latitude እና longitude ማከል
    `ALTER TABLE IF EXISTS drivers ADD COLUMN IF NOT EXISTS latitude NUMERIC(10, 8);`,
    `ALTER TABLE IF EXISTS drivers ADD COLUMN IF NOT EXISTS longitude NUMERIC(11, 8);`,
    // 3. በ rewards ሠንጠረዥ ውስጥ reward_etb ማከል
    `ALTER TABLE IF EXISTS rewards ADD COLUMN IF NOT EXISTS reward_etb NUMERIC(10, 2) DEFAULT 0;`
  ];

  for (const query of alterQueries) {
    try {
      await pool.query(query);
    } catch (err) {
      console.warn(`⚠️ Warning on patch query: ${err.message}`);
    }
  }

  console.log('✅ Database schema check and auto-patch completed successfully.');

} catch (error) {
  console.error(`Neon database check failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (neonInitialized) {
    await closeNeonDatabase();
  }
}
