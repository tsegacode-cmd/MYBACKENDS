import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
let pool = null;

export const toPostgresPlaceholders = (sql) => {
  let result = '';
  let parameterIndex = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const nextCharacter = sql[index + 1];

    if (lineComment) {
      result += character;
      if (character === '\n') lineComment = false;
      continue;
    }

    if (blockComment) {
      result += character;
      if (character === '*' && nextCharacter === '/') {
        result += nextCharacter;
        index += 1;
        blockComment = false;
      }
      continue;
    }

    if (quote) {
      result += character;
      if (character === quote) {
        if (nextCharacter === quote) {
          result += nextCharacter;
          index += 1;
        } else {
          quote = null;
        }
      } else if (character === '\\' && quote === "'" && nextCharacter) {
        result += nextCharacter;
        index += 1;
      }
      continue;
    }

    if (character === '-' && nextCharacter === '-') {
      result += character + nextCharacter;
      index += 1;
      lineComment = true;
    } else if (character === '/' && nextCharacter === '*') {
      result += character + nextCharacter;
      index += 1;
      blockComment = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      result += character;
    } else if (character === '?') {
      parameterIndex += 1;
      result += `$${parameterIndex}`;
    } else {
      result += character;
    }
  }

  return result;
};

export const initializeNeonDatabase = async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to connect to Neon PostgreSQL');
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      max: Number.parseInt(process.env.DATABASE_POOL_SIZE || '10', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
  }

  try {
    await pool.query('SELECT 1');
    console.log('✅ Neon PostgreSQL connected successfully');
    return pool;
  } catch (error) {
    await pool.end();
    pool = null;
    throw new Error(`Neon PostgreSQL connection failed: ${error.message}`, { cause: error });
  }
};

export const queryNeon = async (sql, params = []) => {
  // Auto-initialize if pool is null but DATABASE_URL exists
  if (!pool && process.env.DATABASE_URL) {
    try {
      await initializeNeonDatabase();
    } catch (err) {
      console.error('❌ Auto-initialization during query failed:', err.message);
    }
  }

  if (!pool) {
    const error = new Error(
      process.env.DATABASE_URL
        ? 'Neon PostgreSQL is not initialized. Check DATABASE_URL and backend startup logs.'
        : 'Neon PostgreSQL is required for authentication. Configure DATABASE_URL in the backend environment.'
    );
    error.statusCode = 503;
    throw error;
  }

  try {
    return await pool.query(toPostgresPlaceholders(sql), params);
  } catch (error) {
    console.error('❌ Neon database query failed:', error.message);
    throw error;
  }
};

export const withNeonTransaction = async (callback) => {
  if (!pool && process.env.DATABASE_URL) {
    await initializeNeonDatabase();
  }

  if (!pool) {
    throw new Error('Neon PostgreSQL is not initialized; call initializeNeonDatabase first');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const closeNeonDatabase = async () => {
  if (pool) {
    await pool.end();
    pool = null;
  }
};

export const getNeonPool = () => pool;

// Automatically initialize Neon database on module load if DATABASE_URL is available
if (process.env.DATABASE_URL) {
  initializeNeonDatabase().catch((error) => {
    console.error('❌ Neon database auto-initialization error:', error.message);
  });
}
