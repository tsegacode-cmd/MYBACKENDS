-- Direct SQL script to add missing columns
-- Open your SQLite database and run these commands one by one

-- Add city column
ALTER TABLE data_registrations ADD COLUMN city TEXT DEFAULT 'Harar';

-- Add receipt_no column
ALTER TABLE data_registrations ADD COLUMN receipt_no TEXT;

-- Add payment_period_type column
ALTER TABLE data_registrations ADD COLUMN payment_period_type TEXT DEFAULT '2014-2018';

-- Add payment_period_from column
ALTER TABLE data_registrations ADD COLUMN payment_period_from TEXT;

-- Add payment_period_to column
ALTER TABLE data_registrations ADD COLUMN payment_period_to TEXT;

-- Add commission_period_amount column
ALTER TABLE data_registrations ADD COLUMN commission_period_amount REAL;

-- Add commission_fee column
ALTER TABLE data_registrations ADD COLUMN commission_fee REAL;

-- Add commission_total column
ALTER TABLE data_registrations ADD COLUMN commission_total REAL;

-- Add collected_amount column
ALTER TABLE data_registrations ADD COLUMN collected_amount REAL;

-- Verify columns were added
PRAGMA table_info(data_registrations);
