import { initializeNeonDatabase } from './neonDatabase.js';

const registrationColumns = {
  city: "TEXT DEFAULT 'Harar'",
  address: 'TEXT',
  receipt_no: 'TEXT',
  project_title: 'TEXT',
  bank_receipt_pdf: 'TEXT',
  payment_period_type: "TEXT DEFAULT '2014-2018'",
  payment_period_from: 'TEXT',
  payment_period_to: 'TEXT',
  commission_period_amount: 'NUMERIC(14,2)',
  commission_fee: 'NUMERIC(14,2)',
  commission_total: 'NUMERIC(14,2)',
  collected_amount: 'NUMERIC(14,2)',
  registration_datetime: 'TEXT'
};

export const autoMigrateDatabase = async () => {
  const pool = await initializeNeonDatabase();
  const { rows: tableRows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'data_registrations'
     ) AS table_exists`
  );
  if (!tableRows[0].table_exists) {
    throw new Error('Required public.data_registrations table is missing from Neon');
  }

  for (const [columnName, definition] of Object.entries(registrationColumns)) {
    await pool.query(`ALTER TABLE data_registrations ADD COLUMN IF NOT EXISTS "${columnName}" ${definition}`);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_documents (
      project_title TEXT PRIMARY KEY,
      pdf_data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_receipt_documents (
      registration_id BIGINT PRIMARY KEY REFERENCES data_registrations(_id) ON DELETE CASCADE,
      pdf_data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS owner_receipt_documents (
      registration_id BIGINT PRIMARY KEY REFERENCES data_registrations(_id) ON DELETE CASCADE,
      pdf_data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    )
  `);

  const { rows: titleColumns } = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'data_registrations'
      AND column_name IN ('project_title', 'round')
  `);
  const presentTitleColumns = new Set(titleColumns.map(column => column.column_name));
  if (presentTitleColumns.has('project_title') && presentTitleColumns.has('round')) {
    const { rowCount } = await pool.query(`
      UPDATE data_registrations
      SET project_title = 'EBC LICENCE FEE'
      WHERE round = 1 AND (project_title IS NULL OR btrim(project_title) = '')
    `);
    if (rowCount > 0) console.log(`Restored project title on ${rowCount} Round 1 registrations`);
  }

  console.log('Neon schema migration completed.');
  return true;
};

export default { autoMigrateDatabase };
