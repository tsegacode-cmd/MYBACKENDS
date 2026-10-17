-- Complete Database Setup Script
-- This script creates the data_registrations table with all required columns
-- Run this if you're setting up the database for the first time

-- Drop existing table if you want to start fresh (CAUTION: This deletes all data!)
-- DROP TABLE IF EXISTS data_registrations;

-- Create data_registrations table with all required columns
CREATE TABLE IF NOT EXISTS data_registrations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    work_type VARCHAR(100) NOT NULL COMMENT 'Type of work: redsea-ebc, sells-product, other',
    staff_id INT NULL COMMENT 'Foreign key to users table (nullable for Other/All)',
    staff_username VARCHAR(100) NULL COMMENT 'Username of the staff member',
    staff_full_name VARCHAR(255) NULL COMMENT 'Full name of the staff member',
    client_name VARCHAR(255) NOT NULL,
    kebele VARCHAR(100) NOT NULL COMMENT 'Kebele location',
    house_no VARCHAR(50) NULL COMMENT 'House number (optional)',
    client_phone VARCHAR(50) NOT NULL,
    tv_no VARCHAR(10) NOT NULL COMMENT 'Number of TVs (1-50)',
    person VARCHAR(50) NOT NULL COMMENT 'Personal or Organization',
    client_email VARCHAR(255) NULL,
    project_title VARCHAR(200) NULL,
    condition VARCHAR(50) NOT NULL COMMENT 'New or Old',
    sign VARCHAR(50) NOT NULL COMMENT 'Sign or Unsign',
    payment_status VARCHAR(50) NOT NULL DEFAULT 'unpaid' COMMENT 'Payment status: unpaid or paid',
    registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'When the data was registered',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Foreign key constraint (nullable to support Other/All options)
    CONSTRAINT fk_staff_id FOREIGN KEY (staff_id) REFERENCES users(id) ON DELETE SET NULL,
    
    -- Indexes for better query performance
    INDEX idx_staff_id (staff_id),
    INDEX idx_staff_username (staff_username),
    INDEX idx_work_type (work_type),
    INDEX idx_kebele (kebele),
    INDEX idx_payment_status (payment_status),
    INDEX idx_registered_at (registered_at),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add table comment
ALTER TABLE data_registrations 
    COMMENT = 'Stores data registration records from Data Collector module with TV revenue tracking and payment status';

-- Insert sample data for testing (optional - remove if not needed)
-- INSERT INTO data_registrations (
--     work_type, staff_username, staff_full_name, client_name, kebele, 
--     client_phone, tv_no, person, condition, sign, payment_status
-- ) VALUES 
-- ('redsea-ebc', 'testuser', 'Test User', 'Sample Client 1', '01', '+251-11-111-1111', '2', 'personal', 'new', 'sign', 'unpaid'),
-- ('sells-product', 'testuser', 'Test User', 'Sample Client 2', '02', '+251-11-222-2222', '3', 'organization', 'old', 'sign', 'paid'),
-- ('other', 'UNAPPROVED STAFF', 'UNAPPROVED STAFF', 'Sample Client 3', '03', '+251-11-333-3333', '1', 'personal', 'new', 'sign', 'paid');

-- Verify the table structure
SELECT 'Table created successfully!' as status;
DESCRIBE data_registrations;
