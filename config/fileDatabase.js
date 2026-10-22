import {
  getNeonPool,
  initializeNeonDatabase,
  toPostgresPlaceholders,
  withNeonTransaction
} from './neonDatabase.js';

const collections = new Set([
  'users',
  'clients',
  'data_registrations',
  'fixed_transactions',
  'movable_transactions',
  'contact_inquiries',
  'brokerage_contracts',
  'service_types'
]);

const ensureNeonInitialized = async () => {
  if (!getNeonPool()) {
    await initializeNeonDatabase();
  }
};

const quoteIdentifier = (identifier) => {
  if (typeof identifier !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsupported database identifier: ${String(identifier)}`);
  }
  return `"${identifier}"`;
};

const getCollection = (collectionName) => {
  if (!collections.has(collectionName)) {
    throw new Error(`Unsupported Neon collection: ${String(collectionName)}`);
  }
  return quoteIdentifier(collectionName);
};

const createWhereClause = (query = {}, values = []) => {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new TypeError('Collection query must be an object');
  }

  const conditions = [];
  for (const [key, value] of Object.entries(query)) {
    if (key === '$or') {
      if (!Array.isArray(value) || value.length === 0) {
        throw new TypeError('$or must be a non-empty array of query objects');
      }
      const alternatives = value.map(condition => {
        const nested = createWhereClause(condition, values);
        if (!nested) {
          throw new TypeError('$or query objects must include at least one condition');
        }
        return `(${nested})`;
      });
      conditions.push(`(${alternatives.join(' OR ')})`);
      continue;
    }

    const column = quoteIdentifier(key);
    values.push(value);
    conditions.push(`${column} IS NOT DISTINCT FROM $${values.length}`);
  }

  return conditions.join(' AND ');
};

const insertDocument = async (client, table, document) => {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('Collection document must be an object');
  }

  const record = { ...document };
  const now = new Date().toISOString();
  record.created_at ??= now;
  record.updated_at = now;

  const columns = Object.keys(record);
  if (columns.length === 0) {
    throw new Error('Cannot insert an empty collection document');
  }
  const columnList = columns.map(quoteIdentifier).join(', ');
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  const values = columns.map(column => record[column]);
  const result = await client.query(
    `INSERT INTO ${table} (${columnList}) VALUES (${placeholders}) RETURNING *`,
    values
  );
  return result.rows[0];
};

export const readCollection = async (collectionName) => {
  await ensureNeonInitialized();
  const result = await getNeonPool().query(`SELECT * FROM ${getCollection(collectionName)}`);
  return result.rows;
};

export const writeCollection = async (collectionName, data) => {
  if (!Array.isArray(data)) {
    throw new TypeError('Collection data must be an array');
  }

  const table = getCollection(collectionName);
  await ensureNeonInitialized();
  await withNeonTransaction(async client => {
    await client.query(`DELETE FROM ${table}`);
    for (const document of data) {
      await insertDocument(client, table, document);
    }
  });
  return true;
};

export const find = async (collectionName, query = {}) => {
  await ensureNeonInitialized();
  const values = [];
  const whereClause = createWhereClause(query, values);
  const sql = `SELECT * FROM ${getCollection(collectionName)}${whereClause ? ` WHERE ${whereClause}` : ''}`;
  const result = await getNeonPool().query(sql, values);
  return result.rows;
};

export const findOne = async (collectionName, query = {}) => {
  await ensureNeonInitialized();
  const values = [];
  const whereClause = createWhereClause(query, values);
  const sql = `SELECT * FROM ${getCollection(collectionName)}${whereClause ? ` WHERE ${whereClause}` : ''} LIMIT 1`;
  const result = await getNeonPool().query(sql, values);
  return result.rows[0] ?? null;
};

export const insertOne = async (collectionName, document) => {
  await ensureNeonInitialized();
  const row = await insertDocument(getNeonPool(), getCollection(collectionName), document);
  return { insertedId: row._id ?? row.id, ...row };
};

export const insertMany = async (collectionName, documents) => {
  if (!Array.isArray(documents)) {
    throw new TypeError('Documents must be an array');
  }

  const table = getCollection(collectionName);
  await ensureNeonInitialized();
  await withNeonTransaction(async client => {
    for (const document of documents) {
      await insertDocument(client, table, document);
    }
  });
  return { insertedCount: documents.length };
};

export const updateOne = async (collectionName, query, update) => {
  if (!update?.$set || typeof update.$set !== 'object' || Array.isArray(update.$set)) {
    throw new TypeError('Update must contain a $set object');
  }

  const table = getCollection(collectionName);
  const values = [];
  const assignments = Object.entries(update.$set).map(([key, value]) => {
    values.push(value);
    return `${quoteIdentifier(key)} = $${values.length}`;
  });
  if (assignments.length === 0) {
    throw new Error('Cannot apply an empty $set update');
  }

  values.push(new Date().toISOString());
  assignments.push(`"updated_at" = $${values.length}`);
  const whereClause = createWhereClause(query, values);
  if (!whereClause) {
    throw new Error('A query is required to update a collection document');
  }
  await ensureNeonInitialized();
  const result = await getNeonPool().query(
    `UPDATE ${table} SET ${assignments.join(', ')}${whereClause ? ` WHERE ${whereClause}` : ''}`,
    values
  );
  return { matchedCount: result.rowCount, modifiedCount: result.rowCount };
};

export const deleteOne = async (collectionName, query) => {
  const table = getCollection(collectionName);
  const values = [];
  const whereClause = createWhereClause(query, values);
  if (!whereClause) {
    throw new Error('A query is required to delete a collection document');
  }

  await ensureNeonInitialized();
  const result = await getNeonPool().query(
    `DELETE FROM ${table} WHERE ${whereClause}`,
    values
  );
  return { deletedCount: result.rowCount };
};

export const countDocuments = async (collectionName, query = {}) => {
  await ensureNeonInitialized();
  const values = [];
  const whereClause = createWhereClause(query, values);
  const result = await getNeonPool().query(
    `SELECT COUNT(*)::int AS count FROM ${getCollection(collectionName)}${whereClause ? ` WHERE ${whereClause}` : ''}`,
    values
  );
  return result.rows[0].count;
};

export const aggregate = async (collectionName, pipeline = []) => {
  let data = await readCollection(collectionName);

  for (const stage of pipeline) {
    if (stage.$match) {
      data = data.filter(document => Object.entries(stage.$match).every(([key, expected]) => {
        if (expected && typeof expected === 'object' && Array.isArray(expected.$in)) {
          return expected.$in.includes(document[key]);
        }
        if (expected && typeof expected === 'object' && '$ne' in expected) {
          return document[key] !== expected.$ne;
        }
        return document[key] === expected;
      }));
    }

    if (stage.$group) {
      const groupField = stage.$group._id;
      const groups = new Map();
      for (const document of data) {
        const key = typeof groupField === 'string' && groupField.startsWith('$')
          ? document[groupField.slice(1)]
          : groupField ?? null;
        const groupKey = JSON.stringify(key);
        if (!groups.has(groupKey)) {
          const group = { _id: key };
          for (const [field, operation] of Object.entries(stage.$group)) {
            if (field !== '_id' && operation?.$sum !== undefined) group[field] = 0;
          }
          groups.set(groupKey, group);
        }

        const group = groups.get(groupKey);
        for (const [field, operation] of Object.entries(stage.$group)) {
          if (field === '_id' || operation?.$sum === undefined) continue;
          const sum = operation.$sum;
          group[field] += sum === 1
            ? 1
            : Number(document[typeof sum === 'string' && sum.startsWith('$') ? sum.slice(1) : ''] ?? 0);
        }
      }
      data = [...groups.values()];
    }
  }

  return data;
};

export const getDatabaseStatus = async () => {
  const pool = await initializeNeonDatabase();
  const result = await pool.query('SELECT current_database() AS database');
  return {
    type: 'neon',
    connected: true,
    database: result.rows[0].database,
    collections: [...collections]
  };
};

export const initializeFileDatabase = async () => {
  await initializeNeonDatabase();
  console.log('✅ Neon-backed collection database ready');
  return true;
};

export default {
  find,
  findOne,
  insertOne,
  insertMany,
  updateOne,
  deleteOne,
  countDocuments,
  aggregate,
  getDatabaseStatus,
  initializeFileDatabase,
  readCollection,
  writeCollection
};
