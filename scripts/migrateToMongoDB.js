import mysql from 'mysql2/promise';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

// MySQL configuration
const mysqlConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'redsea_brokerage'
};

// MongoDB configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'redsea_brokerage';

// Migration statistics
const stats = {
  users: 0,
  clients: 0,
  service_types: 0,
  service_pricing: 0,
  brokerage_contracts: 0,
  fixed_transactions: 0,
  movable_transactions: 0,
  contact_inquiries: 0,
  data_registrations: 0,
  errors: []
};

// Connect to MySQL
const connectMySQL = async () => {
  try {
    const connection = await mysql.createConnection(mysqlConfig);
    console.log('✅ Connected to MySQL');
    return connection;
  } catch (error) {
    console.error('❌ MySQL connection failed:', error.message);
    throw error;
  }
};

// Connect to MongoDB
const connectMongoDB = async () => {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(MONGODB_DB_NAME);
    console.log('✅ Connected to MongoDB');
    return { client, db };
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    throw error;
  }
};

// Migrate users table
const migrateUsers = async (mysqlConn, mongoDB) => {
  try {
    console.log('\n📦 Migrating users...');
    const [rows] = await mysqlConn.query('SELECT * FROM users');
    
    if (rows.length === 0) {
      console.log('   No users to migrate');
      return;
    }

    const usersCollection = mongoDB.collection('users');
    
    // Transform MySQL rows to MongoDB documents
    const documents = rows.map(row => ({
      _id: row.id,
      username: row.username,
      email: row.email,
      password_hash: row.password_hash,
      full_name: row.full_name,
      role: row.role,
      position: row.position,
      phone: row.phone,
      permissions: row.permissions ? JSON.parse(row.permissions) : null,
      is_active: Boolean(row.is_active),
      last_login: row.last_login,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));

    await usersCollection.insertMany(documents, { ordered: false });
    stats.users = documents.length;
    console.log(`✅ Migrated ${documents.length} users`);
  } catch (error) {
    if (error.code !== 11000) { // Ignore duplicate key errors
      console.error('❌ Error migrating users:', error.message);
      stats.errors.push({ table: 'users', error: error.message });
    }
  }
};

// Migrate clients table
const migrateClients = async (mysqlConn, mongoDB) => {
  try {
    console.log('\n📦 Migrating clients...');
    const [rows] = await mysqlConn.query('SELECT * FROM clients');
    
    if (rows.length === 0) {
      console.log('   No clients to migrate');
      return;
    }

    const clientsCollection = mongoDB.collection('clients');
    
    const documents = rows.map(row => ({
      _id: row.id,
      client_type: row.client_type,
      full_name: row.full_name,
      company_name: row.company_name,
      national_id: row.national_id,
      tax_number: row.tax_number,
      email: row.email,
      phone: row.phone,
      secondary_phone: row.secondary_phone,
      address: row.address,
      city: row.city,
      country: row.country,
      notes: row.notes,
      status: row.status,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));

    await clientsCollection.insertMany(documents, { ordered: false });
    stats.clients = documents.length;
    console.log(`✅ Migrated ${documents.length} clients`);
  } catch (error) {
    if (error.code !== 11000) {
      console.error('❌ Error migrating clients:', error.message);
      stats.errors.push({ table: 'clients', error: error.message });
    }
  }
};

// Migrate service_types table
const migrateServiceTypes = async (mysqlConn, mongoDB) => {
  try {
    console.log('\n📦 Migrating service types...');
    const [rows] = await mysqlConn.query('SELECT * FROM service_types');
    
    if (rows.length === 0) {
      console.log('   No service types to migrate');
      return;
    }

    const collection = mongoDB.collection('service_types');
    
    const documents = rows.map(row => ({
      _id: row.id,
      category: row.category,
      service_name: row.service_name,
      service_name_ar: row.service_name_ar,
      description: row.description,
      is_active: Boolean(row.is_active),
      created_at: row.created_at,
      updated_at: row.updated_at
    }));

    await collection.insertMany(documents, { ordered: false });
    stats.service_types = documents.length;
    console.log(`✅ Migrated ${documents.length} service types`);
  } catch (error) {
    if (error.code !== 11000) {
      console.error('❌ Error migrating service types:', error.message);
      stats.errors.push({ table: 'service_types', error: error.message });
    }
  }
};

// Migrate fixed_transactions table
const migrateFixedTransactions = async (mysqlConn, mongoDB) => {
  try {
    console.log('\n📦 Migrating fixed transactions...');
    const [rows] = await mysqlConn.query('SELECT * FROM fixed_transactions');
    
    if (rows.length === 0) {
      console.log('   No fixed transactions to migrate');
      return;
    }

    const collection = mongoDB.collection('fixed_transactions');
    
    const documents = rows.map(row => ({
      _id: row.id,
      transaction_number: row.transaction_number,
      contract_id: row.contract_id,
      client_id: row.client_id,
      service_type_id: row.service_type_id,
      property_type: row.property_type,
      property_address: row.property_address,
      property_area: row.property_area,
      area_unit: row.area_unit,
      sale_price: parseFloat(row.sale_price),
      commission_amount: parseFloat(row.commission_amount),
      commission_percentage: row.commission_percentage ? parseFloat(row.commission_percentage) : null,
      currency: row.currency,
      transaction_date: row.transaction_date,
      payment_received: parseFloat(row.payment_received),
      payment_status: row.payment_status,
      status: row.status,
      notes: row.notes,
      assigned_to: row.assigned_to,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));

    await collection.insertMany(documents, { ordered: false });
    stats.fixed_transactions = documents.length;
    console.log(`✅ Migrated ${documents.length} fixed transactions`);
  } catch (error) {
    if (error.code !== 11000) {
      console.error('❌ Error migrating fixed transactions:', error.message);
      stats.errors.push({ table: 'fixed_transactions', error: error.message });
    }
  }
};

// Migrate movable_transactions table
const migrateMovableTransactions = async (mysqlConn, mongoDB) => {
  try {
    console.log('\n📦 Migrating movable transactions...');
    const [rows] = await mysqlConn.query('SELECT * FROM movable_transactions');
    
    if (rows.length === 0) {
      console.log('   No movable transactions to migrate');
      return;
    }

    const collection = mongoDB.collection('movable_transactions');
    
    const documents = rows.map(row => ({
      _id: row.id,
      transaction_number: row.transaction_number,
      contract_id: row.contract_id,
      client_id: row.client_id,
      service_type_id: row.service_type_id,
      item_type: row.item_type,
      item_description: row.item_description,
      item_specifications: row.item_specifications,
      quantity: row.quantity,
      unit_price: row.unit_price ? parseFloat(row.unit_price) : null,
      total_value: parseFloat(row.total_value),
      commission_amount: parseFloat(row.commission_amount),
      commission_percentage: row.commission_percentage ? parseFloat(row.commission_percentage) : null,
      currency: row.currency,
      transaction_date: row.transaction_date,
      payment_received: parseFloat(row.payment_received),
      payment_status: row.payment_status,
      status: row.status,
      notes: row.notes,
      assigned_to: row.assigned_to,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));

    await collection.insertMany(documents, { ordered: false });
    stats.movable_transactions = documents.length;
    console.log(`✅ Migrated ${documents.length} movable transactions`);
  } catch (error) {
    if (error.code !== 11000) {
      console.error('❌ Error migrating movable transactions:', error.message);
      stats.errors.push({ table: 'movable_transactions', error: error.message });
    }
  }
};

// Migrate contact_inquiries table
const migrateContactInquiries = async (mysqlConn, mongoDB) => {
  try {
    console.log('\n📦 Migrating contact inquiries...');
    const [rows] = await mysqlConn.query('SELECT * FROM contact_inquiries');
    
    if (rows.length === 0) {
      console.log('   No contact inquiries to migrate');
      return;
    }

    const collection = mongoDB.collection('contact_inquiries');
    
    const documents = rows.map(row => ({
      _id: row.id,
      inquiry_type: row.inquiry_type,
      full_name: row.full_name,
      email: row.email,
      phone: row.phone,
      subject: row.subject,
      message: row.message,
      status: row.status,
      priority: row.priority,
      assigned_to: row.assigned_to,
      response: row.response,
      responded_at: row.responded_at,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));

    await collection.insertMany(documents, { ordered: false });
    stats.contact_inquiries = documents.length;
    console.log(`✅ Migrated ${documents.length} contact inquiries`);
  } catch (error) {
    if (error.code !== 11000) {
      console.error('❌ Error migrating contact inquiries:', error.message);
      stats.errors.push({ table: 'contact_inquiries', error: error.message });
    }
  }
};

// Migrate data_registrations table (if exists)
const migrateDataRegistrations = async (mysqlConn, mongoDB) => {
  try {
    console.log('\n📦 Migrating data registrations...');
    const [rows] = await mysqlConn.query('SELECT * FROM data_registrations');
    
    if (rows.length === 0) {
      console.log('   No data registrations to migrate');
      return;
    }

    const collection = mongoDB.collection('data_registrations');
    
    const documents = rows.map(row => ({
      _id: row.id,
      work_type: row.work_type,
      staff_id: row.staff_id,
      staff_username: row.staff_username,
      staff_full_name: row.staff_full_name,
      client_name: row.client_name,
      kebele: row.kebele,
      house_no: row.house_no,
      client_phone: row.client_phone,
      tv_no: row.tv_no,
      person: row.person,
      client_email: row.client_email,
      condition: row.condition,
      sign: row.sign,
      gov_letter: row.gov_letter,
      paid_amount: row.paid_amount ? parseFloat(row.paid_amount) : null,
      payment_status: row.payment_status,
      registered_at: row.registered_at,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));

    await collection.insertMany(documents, { ordered: false });
    stats.data_registrations = documents.length;
    console.log(`✅ Migrated ${documents.length} data registrations`);
  } catch (error) {
    if (error.code !== 11000) {
      console.error('❌ Error migrating data registrations:', error.message);
      stats.errors.push({ table: 'data_registrations', error: error.message });
    }
  }
};

// Main migration function
const migrate = async () => {
  let mysqlConn = null;
  let mongoClient = null;

  try {
    console.log('🚀 Starting MySQL to MongoDB migration...\n');

    // Connect to databases
    mysqlConn = await connectMySQL();
    const { client, db } = await connectMongoDB();
    mongoClient = client;

    // Run migrations
    await migrateUsers(mysqlConn, db);
    await migrateClients(mysqlConn, db);
    await migrateServiceTypes(mysqlConn, db);
    await migrateFixedTransactions(mysqlConn, db);
    await migrateMovableTransactions(mysqlConn, db);
    await migrateContactInquiries(mysqlConn, db);
    await migrateDataRegistrations(mysqlConn, db);

    // Print summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 MIGRATION SUMMARY');
    console.log('='.repeat(50));
    console.log(`Users:                ${stats.users}`);
    console.log(`Clients:              ${stats.clients}`);
    console.log(`Service Types:        ${stats.service_types}`);
    console.log(`Fixed Transactions:   ${stats.fixed_transactions}`);
    console.log(`Movable Transactions: ${stats.movable_transactions}`);
    console.log(`Contact Inquiries:    ${stats.contact_inquiries}`);
    console.log(`Data Registrations:   ${stats.data_registrations}`);
    console.log('='.repeat(50));
    
    const total = stats.users + stats.clients + stats.service_types + 
                  stats.fixed_transactions + stats.movable_transactions + 
                  stats.contact_inquiries + stats.data_registrations;
    
    console.log(`Total Records:        ${total}`);
    
    if (stats.errors.length > 0) {
      console.log(`\n⚠️  Errors encountered: ${stats.errors.length}`);
      stats.errors.forEach(err => {
        console.log(`   - ${err.table}: ${err.error}`);
      });
    }

    console.log('\n✅ Migration completed successfully!');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    // Close connections
    if (mysqlConn) await mysqlConn.end();
    if (mongoClient) await mongoClient.close();
  }
};

// Run migration
migrate();
