const runtimeSQLiteError = () =>
  new Error(
    'SQLite is no longer an application runtime database. ' +
    'Use Neon PostgreSQL; scripts/migrateSqliteToNeon.js is retained only to import an existing SQLite source.'
  );

export const initializeSQLiteDatabase = async () => {
  throw runtimeSQLiteError();
};

export const getRawSQLiteDB = () => {
  throw runtimeSQLiteError();
};

export const getSQLiteDB = () => {
  throw runtimeSQLiteError();
};

export const getDatabaseStatus = () => {
  throw runtimeSQLiteError();
};

export default {
  initializeSQLiteDatabase,
  getRawSQLiteDB,
  getSQLiteDB,
  getDatabaseStatus
};
