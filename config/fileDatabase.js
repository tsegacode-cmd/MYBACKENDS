import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database directory
const DB_DIR = path.join(__dirname, '../database_files');

// Ensure database directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Initialize collections
const collections = {
  users: 'users.json',
  clients: 'clients.json',
  data_registrations: 'data_registrations.json',
  fixed_transactions: 'fixed_transactions.json',
  movable_transactions: 'movable_transactions.json',
  contact_inquiries: 'contact_inquiries.json',
  brokerage_contracts: 'brokerage_contracts.json',
  service_types: 'service_types.json'
};

// Initialize collection files
Object.entries(collections).forEach(([name, filename]) => {
  const filepath = path.join(DB_DIR, filename);
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, JSON.stringify([], null, 2));
    console.log(`✅ Created collection: ${name}`);
  }
});

// Read collection
export const readCollection = (collectionName) => {
  try {
    const filepath = path.join(DB_DIR, collections[collectionName]);
    const data = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading ${collectionName}:`, error.message);
    return [];
  }
};

// Write collection
export const writeCollection = (collectionName, data) => {
  try {
    const filepath = path.join(DB_DIR, collections[collectionName]);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error(`Error writing ${collectionName}:`, error.message);
    return false;
  }
};

// Find documents
export const find = (collectionName, query = {}) => {
  const data = readCollection(collectionName);
  
  if (Object.keys(query).length === 0) {
    return data;
  }
  
  return data.filter(doc => {
    return Object.entries(query).every(([key, value]) => {
      if (key === '$or') {
        return value.some(condition => {
          return Object.entries(condition).some(([k, v]) => doc[k] === v);
        });
      }
      return doc[key] === value;
    });
  });
};

// Find one document
export const findOne = (collectionName, query) => {
  const results = find(collectionName, query);
  return results.length > 0 ? results[0] : null;
};

// Insert document
export const insertOne = (collectionName, document) => {
  const data = readCollection(collectionName);
  
  // Generate ID if not provided
  if (!document._id) {
    const maxId = data.length > 0 ? Math.max(...data.map(d => d._id || 0)) : 0;
    document._id = maxId + 1;
  }
  
  // Add timestamps
  document.created_at = document.created_at || new Date().toISOString();
  document.updated_at = new Date().toISOString();
  
  data.push(document);
  writeCollection(collectionName, data);
  
  return { insertedId: document._id, ...document };
};

// Insert many documents
export const insertMany = (collectionName, documents) => {
  const data = readCollection(collectionName);
  const maxId = data.length > 0 ? Math.max(...data.map(d => d._id || 0)) : 0;
  
  documents.forEach((doc, index) => {
    if (!doc._id) {
      doc._id = maxId + index + 1;
    }
    doc.created_at = doc.created_at || new Date().toISOString();
    doc.updated_at = new Date().toISOString();
    data.push(doc);
  });
  
  writeCollection(collectionName, data);
  return { insertedCount: documents.length };
};

// Update document
export const updateOne = (collectionName, query, update) => {
  const data = readCollection(collectionName);
  const index = data.findIndex(doc => {
    return Object.entries(query).every(([key, value]) => doc[key] === value);
  });
  
  if (index === -1) {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  
  // Apply $set operator
  if (update.$set) {
    Object.assign(data[index], update.$set);
    data[index].updated_at = new Date().toISOString();
  }
  
  writeCollection(collectionName, data);
  return { matchedCount: 1, modifiedCount: 1 };
};

// Delete document
export const deleteOne = (collectionName, query) => {
  const data = readCollection(collectionName);
  const index = data.findIndex(doc => {
    return Object.entries(query).every(([key, value]) => doc[key] === value);
  });
  
  if (index === -1) {
    return { deletedCount: 0 };
  }
  
  data.splice(index, 1);
  writeCollection(collectionName, data);
  return { deletedCount: 1 };
};

// Count documents
export const countDocuments = (collectionName, query = {}) => {
  return find(collectionName, query).length;
};

// Aggregate (simplified)
export const aggregate = (collectionName, pipeline) => {
  let data = readCollection(collectionName);
  
  pipeline.forEach(stage => {
    if (stage.$match) {
      data = data.filter(doc => {
        return Object.entries(stage.$match).every(([key, value]) => {
          if (typeof value === 'object' && value.$in) {
            return value.$in.includes(doc[key]);
          }
          if (typeof value === 'object' && value.$ne) {
            return doc[key] !== value.$ne;
          }
          return doc[key] === value;
        });
      });
    }
    
    if (stage.$group) {
      // Simplified grouping
      const grouped = {};
      data.forEach(doc => {
        const key = stage.$group._id || 'all';
        if (!grouped[key]) {
          grouped[key] = { _id: key };
          Object.entries(stage.$group).forEach(([field, operation]) => {
            if (field !== '_id') {
              grouped[key][field] = 0;
            }
          });
        }
        
        Object.entries(stage.$group).forEach(([field, operation]) => {
          if (field !== '_id' && operation.$sum) {
            if (operation.$sum === 1) {
              grouped[key][field]++;
            } else if (typeof operation.$sum === 'string') {
              const fieldName = operation.$sum.replace('$', '');
              grouped[key][field] += doc[fieldName] || 0;
            }
          }
        });
      });
      data = Object.values(grouped);
    }
  });
  
  return data;
};

// Database status
export const getDatabaseStatus = () => {
  return {
    type: 'file',
    connected: true,
    location: DB_DIR,
    collections: Object.keys(collections)
  };
};

// Initialize with default root user
const initializeDefaultData = () => {
  const users = readCollection('users');
  if (users.length === 0) {
    insertOne('users', {
      _id: 1,
      username: 'root',
      email: 'root@redsea.com',
      password_hash: '$2a$10$rZ5qH8qZ5qH8qZ5qH8qZ5u', // This will be replaced on first login
      full_name: 'Root Administrator',
      role: 'admin',
      position: 'System Administrator',
      phone: null,
      permissions: null,
      is_active: true,
      last_login: null
    });
    console.log('✅ Created default root user');
  }
};

// Initialize database
export const initializeFileDatabase = () => {
  console.log('📁 Initializing File-Based Database...');
  console.log(`   Location: ${DB_DIR}`);
  initializeDefaultData();
  console.log('✅ File-Based Database ready');
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
