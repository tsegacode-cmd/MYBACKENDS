-- Migration script to add payment_status, staff_username, and staff_full_name columns
-- Run this script to update the data_registrations table

-- Add payment_status column
ALTER TABLE data_registrations 
ADD COLUMN payment_status VARCHAR(50) NOT NULL DEFAULT 'unpaid' 
COMMENT 'Payment status: unpaid or paid' 
AFTER sign;

-- Add staff_username column
ALTER TABLE data_registrations 
ADD COLUMN staff_username VARCHAR(100) NULL 
COMMENT 'Username of the staff member' 
AFTER staff_id;

-- Add staff_full_name column
ALTER TABLE data_registrations 
ADD COLUMN staff_full_name VARCHAR(255) NULL 
COMMENT 'Full name of the staff member' 
AFTER staff_username;

-- Add index for payment_status for better query performance
CREATE INDEX idx_payment_status ON data_registrations(payment_status);

-- Add index for staff_username for better query performance
CREATE INDEX idx_staff_username ON data_registrations(staff_username);

-- Update existing records to have default values
UPDATE data_registrations 
SET payment_status = 'unpaid' 
WHERE payment_status IS NULL OR payment_status = '';

-- Update staff_username and staff_full_name from users table for existing records
UPDATE data_registrations dr
LEFT JOIN users u ON dr.staff_id = u.id
SET 
    dr.staff_username = COALESCE(u.username, 'N/A'),
    dr.staff_full_name = COALESCE(u.full_name, 'N/A')
WHERE dr.staff_id IS NOT NULL;

-- Set default values for records without staff_id
UPDATE data_registrations 
SET 
    staff_username = 'N/A',
    staff_full_name = 'N/A'
WHERE staff_id IS NULL AND (staff_username IS NULL OR staff_username = '');
