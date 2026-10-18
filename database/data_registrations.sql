-- Data Registrations Table
-- This table stores all data registration records from the Data Collector module

CREATE TABLE IF NOT EXISTS data_registrations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    work_type VARCHAR(100) NOT NULL COMMENT 'Type of work: redsea-ebc, sells-product, other',
    staff_id INT NULL COMMENT 'Foreign key to users table (nullable for Other/All)',
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
    registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'When the data was registered',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Foreign key constraint (nullable to support Other/All options)
    CONSTRAINT fk_staff_id FOREIGN KEY (staff_id) REFERENCES users(id) ON DELETE SET NULL,
    
    -- Indexes for better query performance
    INDEX idx_staff_id (staff_id),
    INDEX idx_work_type (work_type),
    INDEX idx_kebele (kebele),
    INDEX idx_registered_at (registered_at),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add some comments for documentation
ALTER TABLE data_registrations 
    COMMENT = 'Stores data registration records from Data Collector module with TV revenue tracking';
