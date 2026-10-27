-- Migration script to update data_registrations table with new fields
-- Run this script if you have an existing data_registrations table

-- Step 1: Add new columns
ALTER TABLE data_registrations
ADD COLUMN IF NOT EXISTS project_title VARCHAR(200) NULL,
ADD COLUMN IF NOT EXISTS round INT NOT NULL DEFAULT 1;

ALTER TABLE data_registrations
ADD COLUMN IF NOT EXISTS kebele VARCHAR(100) NULL COMMENT 'Kebele location' AFTER client_name,
ADD COLUMN IF NOT EXISTS house_no VARCHAR(50) NULL COMMENT 'House number (optional)' AFTER kebele,
ADD COLUMN IF NOT EXISTS tv_no VARCHAR(10) NULL COMMENT 'Number of TVs (1-50)' AFTER client_phone,
ADD COLUMN IF NOT EXISTS person VARCHAR(50) NULL COMMENT 'Personal or Organization' AFTER tv_no,
ADD COLUMN IF NOT EXISTS condition VARCHAR(50) NULL COMMENT 'New or Old' AFTER client_email,
ADD COLUMN IF NOT EXISTS sign VARCHAR(50) NULL COMMENT 'Sign or Unsign' AFTER condition;

-- Step 2: Make staff_id nullable (to support Other/All options)
ALTER TABLE data_registrations
MODIFY COLUMN staff_id INT NULL COMMENT 'Foreign key to users table (nullable for Other/All)';

-- Step 3: Drop old foreign key constraint if exists
ALTER TABLE data_registrations
DROP FOREIGN KEY IF EXISTS fk_staff_id;

-- Step 4: Add new foreign key constraint with SET NULL on delete
ALTER TABLE data_registrations
ADD CONSTRAINT fk_staff_id FOREIGN KEY (staff_id) REFERENCES users(id) ON DELETE SET NULL;

-- Step 5: Add index for kebele
ALTER TABLE data_registrations
ADD INDEX IF NOT EXISTS idx_kebele (kebele);

-- Restore the configured Round 1 project title on legacy rows that predate title storage.
UPDATE data_registrations
SET project_title = 'EBC LICENCE FEE'
WHERE round = 1 AND (project_title IS NULL OR TRIM(project_title) = '');

-- Step 6: Remove old columns that are no longer used (optional - comment out if you want to keep data)
-- ALTER TABLE data_registrations
-- DROP COLUMN IF EXISTS product_service,
-- DROP COLUMN IF EXISTS amount,
-- DROP COLUMN IF EXISTS commission_rate,
-- DROP COLUMN IF EXISTS notes;

-- Step 7: Update existing records with default values for new required fields
UPDATE data_registrations
SET 
    kebele = COALESCE(kebele, 'N/A'),
    tv_no = COALESCE(tv_no, '1'),
    person = COALESCE(person, 'personal'),
    condition = COALESCE(condition, 'new'),
    sign = COALESCE(sign, 'sign')
WHERE kebele IS NULL OR tv_no IS NULL OR person IS NULL OR condition IS NULL OR sign IS NULL;

-- Step 8: Make new columns NOT NULL after setting defaults
ALTER TABLE data_registrations
MODIFY COLUMN kebele VARCHAR(100) NOT NULL COMMENT 'Kebele location',
MODIFY COLUMN tv_no VARCHAR(10) NOT NULL COMMENT 'Number of TVs (1-50)',
MODIFY COLUMN person VARCHAR(50) NOT NULL COMMENT 'Personal or Organization',
MODIFY COLUMN condition VARCHAR(50) NOT NULL COMMENT 'New or Old',
MODIFY COLUMN sign VARCHAR(50) NOT NULL COMMENT 'Sign or Unsign';

-- Verification query
SELECT 
    COLUMN_NAME, 
    DATA_TYPE, 
    IS_NULLABLE, 
    COLUMN_DEFAULT, 
    COLUMN_COMMENT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'data_registrations'
ORDER BY ORDINAL_POSITION;
