-- Add new payment fields to data_registrations table
-- Run this script to add the missing columns

-- City field
ALTER TABLE data_registrations ADD COLUMN IF NOT EXISTS city VARCHAR(100) DEFAULT 'Harar';

-- Receipt Number
ALTER TABLE data_registrations ADD COLUMN IF NOT EXISTS receipt_no VARCHAR(50);

-- Payment Period fields
ALTER TABLE data_registrations ADD COLUMN IF NOT EXISTS payment_period_type VARCHAR(20) DEFAULT '2014-2018';
ALTER TABLE data_registrations ADD COLUMN IF NOT EXISTS payment_period_from VARCHAR(10);
ALTER TABLE data_registrations ADD COLUMN IF NOT EXISTS payment_period_to VARCHAR(10);

-- Commission Amount fields
ALTER TABLE data_registrations ADD COLUMN IF NOT EXISTS commission_period_amount DECIMAL(10, 2);
ALTER TABLE data_registrations ADD COLUMN IF NOT EXISTS commission_fee DECIMAL(10, 2);
ALTER TABLE data_registrations ADD COLUMN IF NOT EXISTS commission_total DECIMAL(10, 2);

-- Collected Amount
ALTER TABLE data_registrations ADD COLUMN IF NOT EXISTS collected_amount DECIMAL(10, 2);

-- Registration DateTime (if not exists)
ALTER TABLE data_registrations ADD COLUMN IF NOT EXISTS registration_datetime DATETIME;

-- Verify columns were added
SELECT 
    COLUMN_NAME, 
    DATA_TYPE, 
    COLUMN_DEFAULT, 
    IS_NULLABLE
FROM 
    INFORMATION_SCHEMA.COLUMNS
WHERE 
    TABLE_NAME = 'data_registrations'
    AND COLUMN_NAME IN (
        'city', 
        'receipt_no', 
        'payment_period_type', 
        'payment_period_from', 
        'payment_period_to',
        'commission_period_amount',
        'commission_fee',
        'commission_total',
        'collected_amount',
        'registration_datetime'
    )
ORDER BY 
    COLUMN_NAME;
