import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// Database connection pool configuration
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'redsea_brokerage',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

// Test database connection
const testConnection = async () => {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Database connected successfully');
    console.log(`   Host: ${process.env.DB_HOST || 'localhost'}`);
    console.log(`   Database: ${process.env.DB_NAME || 'redsea_brokerage'}`);
    connection.release();
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    console.error('   Please ensure MySQL is running and credentials are correct');
    return false;
  }
};

// Initialize database tables if they don't exist
const initializeTables = async () => {
  try {
    // Check if users table exists
    const [tables] = await pool.query(
      "SHOW TABLES LIKE 'users'"
    );
    
    if (tables.length === 0) {
      console.log('⚠️  Users table does not exist. Creating table...');
      
      // Create users table
      await pool.query(`
        CREATE TABLE users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(50) NOT NULL UNIQUE,
          email VARCHAR(100) UNIQUE,
          password_hash VARCHAR(255) NOT NULL,
          full_name VARCHAR(100),
          role ENUM('admin', 'manager', 'agent', 'staff', 'user') DEFAULT 'user',
          position VARCHAR(100),
          phone VARCHAR(20),
          permissions JSON,
          is_active BOOLEAN DEFAULT TRUE,
          last_login TIMESTAMP NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_email (email),
          INDEX idx_username (username),
          INDEX idx_role (role)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      
      console.log('✅ Users table created successfully');
      return true;
    } else {
      console.log('✅ Users table exists');
      return true;
    }
  } catch (error) {
    console.error('❌ Failed to initialize tables:', error.message);
    return false;
  }
};

// Execute query helper
const query = async (sql, params = []) => {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (error) {
    console.error('❌ DATABASE QUERY ERROR:', error.message);
    console.error('SQL:', sql);
    console.error('Params:', params);
    console.error('Error Code:', error.code);
    console.error('SQL Message:', error.sqlMessage);
    throw error;
  }
};

// Execute transaction helper
const transaction = async (callback) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    console.error('❌ TRANSACTION ERROR:', error.message);
    console.error('Error Code:', error.code);
    console.error('SQL Message:', error.sqlMessage);
    throw error;
  } finally {
    connection.release();
  }
};

export { pool, testConnection, initializeTables, query, transaction };
export default pool;
