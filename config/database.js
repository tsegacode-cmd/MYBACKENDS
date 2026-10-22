import {
  getNeonPool,
  initializeNeonDatabase,
  queryNeon,
  toPostgresPlaceholders,
  withNeonTransaction
} from './neonDatabase.js';

const ensureNeonInitialized = async () => {
  if (!getNeonPool()) {
    await initializeNeonDatabase();
  }
};

const pool = {
  query: async (sql, params = []) => {
    await ensureNeonInitialized();
    return getNeonPool().query(toPostgresPlaceholders(sql), params);
  },
  connect: async () => {
    await ensureNeonInitialized();
    return getNeonPool().connect();
  }
};

export const testConnection = async () => {
  await initializeNeonDatabase();
  console.log('✅ Neon PostgreSQL connection verified');
  return true;
};

export const initializeTables = async () => {
  await ensureNeonInitialized();

  const result = await queryNeon(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'users'
         AND table_type = 'BASE TABLE'
     ) AS table_exists`
  );

  if (!result.rows[0]?.table_exists) {
    throw new Error(
      'The required public.users table is missing from Neon. ' +
      'Import the application schema before starting the backend.'
    );
  }

  return true;
};

export const query = async (sql, params = []) => {
  await ensureNeonInitialized();
  const result = await queryNeon(sql, params);
  return result.rows;
};

export const transaction = async callback => {
  await ensureNeonInitialized();
  return withNeonTransaction(callback);
};

export { pool };
export default pool;
