-- Add missing columns to data_registrations table
-- This script adds all payment-related columns that are missing

-- Add city column
ALTER TABLE data_registrations 
ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT 'Harar' COMMENT 'City location';

-- Add receipt_no column
ALTER TABLE data_registrations 
ADD COLUMN IF NOT EXISTS receipt_no VARCHAR(100) NULL COMMENT 'Receipt number';

-- Add payment period columns
ALTER TABLE data_registrations 
ADD COLUMN IF NOT EXISTS payment_period_type VARCHAR(50) DEFAULT '2014-2018' COMMENT 'Payment period type: 2014-2018 or custom';

ALTER TABLE data_registrations 
ADD COLUMN IF NOT EXISTS payment_period_from VARCHAR(10) NULL COMMENT 'Payment period start year';

ALTER TABLE data_registrations 
ADD COLUMN IF NOT EXISTS payment_period_to VARCHAR(10) NULL COMMENT 'Payment period end year';

-- Add commission columns
ALTER TABLE data_registrations 
ADD COLUMN IF NOT EXISTS commission_period_amount DECIMAL(10,2) NULL COMMENT 'Commission period amount in ETB';

ALTER TABLE data_registrations 
ADD COLUMN IF NOT EXISTS commission_fee DECIMAL(10,2) NULL COMMENT 'Commission fee in ETB';

ALTER TABLE data_registrations 
ADD COLUMN IF NOT EXISTS commission_total DECIMAL(10,2) NULL COMMENT 'Total commission in ETB';

ALTER TABLE data_registrations 
ADD COLUMN IF NOT EXISTS collected_amount DECIMAL(10,2) NULL COMMENT 'Collected amount in ETB';

-- Add gov_letter column
ALTER TABLE data_registrations 
ADD COLUMN IF NOT EXISTS gov_letter VARCHAR(50) DEFAULT 'accept' COMMENT 'Government letter status: accept or unaccept';

-- Add paid_amount column (if not exists)
ALTER TABLE data_registrations 
ADD COLUMN IF NOT EXISTS paid_amount DECIMAL(10,2) NULL COMMENT 'Paid amount in ETB';

-- Add registration_datetime column
ALTER TABLE data_registrations 
ADD COLUMN IF NOT EXISTS registration_datetime DATETIME NULL COMMENT 'Valid date of official letter';

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_city ON data_registrations(city);
CREATE INDEX IF NOT EXISTS idx_receipt_no ON data_registrations(receipt_no);
CREATE INDEX IF NOT EXISTS idx_payment_period_type ON data_registrations(payment_period_type);
CREATE INDEX IF NOT EXISTS idx_registration_datetime ON data_registrations(registration_datetime);

-- Verify columns were added
SELECT 'Migration completed successfully!' as status;
