-- ============================================
-- REDSEA BROKERAGE - COMPLETE MYSQL DATABASE SETUP
-- ============================================
-- This script creates the complete database schema for the Redsea Brokerage application
-- Run this script to set up MySQL from scratch

-- ============================================
-- 1. CREATE DATABASE
-- ============================================
CREATE DATABASE IF NOT EXISTS redsea_brokerage 
    CHARACTER SET utf8mb4 
    COLLATE utf8mb4_unicode_ci;

USE redsea_brokerage;

-- ============================================
-- 2. CREATE USERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL COMMENT 'Hashed password',
    email VARCHAR(255) NULL UNIQUE,
    full_name VARCHAR(255) NULL,
    phone VARCHAR(50) NULL,
    position VARCHAR(100) NULL COMMENT 'Job position/title',
    role VARCHAR(50) NOT NULL DEFAULT 'data_collector' COMMENT 'User role: root, admin, data_collector',
    is_active BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'Account active status',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_login TIMESTAMP NULL COMMENT 'Last login timestamp',
    
    -- Indexes
    INDEX idx_username (username),
    INDEX idx_email (email),
    INDEX idx_role (role),
    INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'User accounts and authentication';

-- ============================================
-- 3. CREATE DATA_REGISTRATIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS data_registrations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    work_type VARCHAR(100) NOT NULL COMMENT 'Type of work: redsea-ebc, sells-product, other',
    staff_id INT NULL COMMENT 'Foreign key to users table (nullable for Other/All/UNAPPROVED)',
    staff_username VARCHAR(100) NULL COMMENT 'Username of the staff member',
    staff_full_name VARCHAR(255) NULL COMMENT 'Full name of the staff member',
    client_name VARCHAR(255) NOT NULL,
    kebele VARCHAR(100) NOT NULL COMMENT 'Kebele location',
    house_no VARCHAR(50) NULL COMMENT 'House number (optional)',
    client_phone VARCHAR(50) NOT NULL,
    tv_no VARCHAR(10) NOT NULL COMMENT 'Number of TVs (1-50)',
    person VARCHAR(50) NOT NULL COMMENT 'Personal or Organization',
    client_email VARCHAR(255) NULL,
    client_type VARCHAR(50) NULL,
    project_title VARCHAR(200) NULL,
    org_type VARCHAR(100) NULL,
    contact_person VARCHAR(255) NULL,
    address TEXT NULL,
    condition VARCHAR(50) NOT NULL COMMENT 'New or Old',
    sign VARCHAR(50) NOT NULL COMMENT 'Sign or Unsign',
    gov_letter VARCHAR(50) NOT NULL DEFAULT 'accept' COMMENT 'Accept or Unaccept',
    paid_amount DECIMAL(10, 2) NULL COMMENT 'Amount paid in Birr',
    payment_status VARCHAR(50) NOT NULL DEFAULT 'unpaid' COMMENT 'Payment status: unpaid or paid',
    round INT NOT NULL DEFAULT 1,
    registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'When the data was registered',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Foreign key constraint (nullable to support Other/All/UNAPPROVED options)
    CONSTRAINT fk_data_reg_staff_id FOREIGN KEY (staff_id) REFERENCES users(id) ON DELETE SET NULL,
    
    -- Indexes for better query performance
    INDEX idx_staff_id (staff_id),
    INDEX idx_staff_username (staff_username),
    INDEX idx_work_type (work_type),
    INDEX idx_kebele (kebele),
    INDEX idx_payment_status (payment_status),
    INDEX idx_registered_at (registered_at),
    INDEX idx_created_at (created_at),
    INDEX idx_client_phone (client_phone),
    INDEX idx_client_name (client_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Data registration records from Data Collector module with TV revenue tracking';

-- ============================================
-- 4. CREATE CLIENTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS clients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(255) NULL,
    address TEXT NULL,
    kebele VARCHAR(100) NULL,
    house_no VARCHAR(50) NULL,
    client_type VARCHAR(50) NOT NULL DEFAULT 'individual' COMMENT 'individual or organization',
    status VARCHAR(50) NOT NULL DEFAULT 'active' COMMENT 'active, inactive, suspended',
    notes TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Indexes
    INDEX idx_phone (phone),
    INDEX idx_email (email),
    INDEX idx_status (status),
    INDEX idx_kebele (kebele),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Client information and contact details';

-- ============================================
-- 5. CREATE TRANSACTIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    transaction_number VARCHAR(100) NULL UNIQUE COMMENT 'Unique transaction identifier',
    client_id INT NOT NULL,
    transaction_type VARCHAR(50) NOT NULL COMMENT 'fixed, movable, brokerage_contract',
    property_type VARCHAR(100) NULL COMMENT 'Type of property',
    location TEXT NULL,
    amount DECIMAL(15, 2) NOT NULL COMMENT 'Transaction amount in Birr',
    commission DECIMAL(15, 2) NULL COMMENT 'Commission amount in Birr',
    status VARCHAR(50) NOT NULL DEFAULT 'pending' COMMENT 'pending, completed, cancelled',
    transaction_date DATE NULL,
    notes TEXT NULL,
    created_by INT NULL COMMENT 'User who created the transaction',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Foreign keys
    CONSTRAINT fk_trans_client_id FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT fk_trans_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    
    -- Indexes
    INDEX idx_transaction_number (transaction_number),
    INDEX idx_client_id (client_id),
    INDEX idx_transaction_type (transaction_type),
    INDEX idx_status (status),
    INDEX idx_transaction_date (transaction_date),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Transaction records for fixed, movable, and brokerage contracts';

-- ============================================
-- 6. CREATE CONTACT_INQUIRIES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS contact_inquiries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NULL,
    subject VARCHAR(255) NULL,
    message TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'new' COMMENT 'new, read, responded, closed',
    responded_by INT NULL COMMENT 'User who responded',
    response TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Foreign key
    CONSTRAINT fk_contact_responded_by FOREIGN KEY (responded_by) REFERENCES users(id) ON DELETE SET NULL,
    
    -- Indexes
    INDEX idx_status (status),
    INDEX idx_email (email),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Contact form inquiries from website';

-- ============================================
-- 7. CREATE SERVICE_TYPES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS service_types (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT NULL,
    category VARCHAR(100) NULL COMMENT 'fixed, movable, brokerage',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Indexes
    INDEX idx_category (category),
    INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Service types and categories';

-- ============================================
-- 8. INSERT DEFAULT ROOT USER
-- ============================================
-- Password: root123 (hashed with bcrypt)
-- IMPORTANT: Change this password after first login!
INSERT INTO users (username, password, email, full_name, role, is_active) 
VALUES (
    'root',
    '$2b$10$YourHashedPasswordHere',
    'root@redsea.com',
    'System Administrator',
    'root',
    TRUE
) ON DUPLICATE KEY UPDATE username=username;

-- ============================================
-- 9. INSERT SAMPLE DATA (OPTIONAL - FOR TESTING)
-- ============================================
-- Uncomment the following lines to insert sample data

-- Sample users
-- INSERT INTO users (username, password, email, full_name, phone, position, role) VALUES
-- ('admin1', '$2b$10$SampleHashedPassword', 'admin@redsea.com', 'Admin User', '+251-11-111-1111', 'Administrator', 'admin'),
-- ('collector1', '$2b$10$SampleHashedPassword', 'collector@redsea.com', 'Data Collector', '+251-11-222-2222', 'Data Collector', 'data_collector');

-- Sample data registrations
-- INSERT INTO data_registrations (work_type, staff_username, staff_full_name, client_name, kebele, client_phone, tv_no, person, condition, sign, gov_letter, payment_status) VALUES
-- ('redsea-ebc', 'collector1', 'Data Collector', 'Sample Client 1', '01', '+251-11-111-1111', '2', 'personal', 'new', 'sign', 'accept', 'unpaid'),
-- ('sells-product', 'collector1', 'Data Collector', 'Sample Client 2', '02', '+251-11-222-2222', '3', 'organization', 'old', 'sign', 'accept', 'paid'),
-- ('other', 'UNAPPROVED STAFF', 'UNAPPROVED STAFF', 'Sample Client 3', '03', '+251-11-333-3333', '1', 'personal', 'new', 'sign', 'accept', 'paid');

-- ============================================
-- 10. VERIFY SETUP
-- ============================================
SELECT 'Database setup completed successfully!' as status;

-- Show all tables
SHOW TABLES;

-- Show table structures
DESCRIBE users;
DESCRIBE data_registrations;
DESCRIBE clients;
DESCRIBE transactions;
DESCRIBE contact_inquiries;
DESCRIBE service_types;

-- Show table counts
SELECT 'users' as table_name, COUNT(*) as record_count FROM users
UNION ALL
SELECT 'data_registrations', COUNT(*) FROM data_registrations
UNION ALL
SELECT 'clients', COUNT(*) FROM clients
UNION ALL
SELECT 'transactions', COUNT(*) FROM transactions
UNION ALL
SELECT 'contact_inquiries', COUNT(*) FROM contact_inquiries
UNION ALL
SELECT 'service_types', COUNT(*) FROM service_types;
