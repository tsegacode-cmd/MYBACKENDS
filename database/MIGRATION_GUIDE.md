# Database Migration Guide

## Payment Status Feature Migration

This guide explains how to add the payment status tracking feature to your existing database.

### What's Being Added

1. **payment_status** column - Tracks whether a registration is 'unpaid' or 'paid'
2. **staff_username** column - Stores the username of the assigned staff member
3. **staff_full_name** column - Stores the full name of the assigned staff member

### Migration Steps

#### Option 1: Using MySQL Command Line

1. Connect to your MySQL database:
```bash
mysql -u root -p
```

2. Select your database:
```sql
USE your_database_name;
```

3. Run the migration script:
```sql
source backend/database/add_payment_status_columns.sql;
```

#### Option 2: Using MySQL Workbench

1. Open MySQL Workbench
2. Connect to your database
3. Open the file `backend/database/add_payment_status_columns.sql`
4. Execute the script (click the lightning bolt icon)

#### Option 3: Using phpMyAdmin

1. Open phpMyAdmin
2. Select your database
3. Go to the "SQL" tab
4. Copy and paste the contents of `backend/database/add_payment_status_columns.sql`
5. Click "Go" to execute

### Verification

After running the migration, verify the changes:

```sql
DESCRIBE data_registrations;
```

You should see the new columns:
- `payment_status` (VARCHAR(50), NOT NULL, DEFAULT 'unpaid')
- `staff_username` (VARCHAR(100), NULL)
- `staff_full_name` (VARCHAR(255), NULL)

### Testing

1. Restart your backend server:
```bash
cd backend
npm start
```

2. Test the Data Registration page:
   - Register a new entry
   - Check if it appears in the Unpaid page

3. Test the Pay Registration page:
   - Register a paid entry with a real staff member
   - Check if it appears in the Paid page
   - Register a paid entry with UNAPPROVED STAFF
   - Check if it appears in the Need Approval page

### Rollback (if needed)

If you need to rollback the changes:

```sql
-- Remove the added columns
ALTER TABLE data_registrations DROP COLUMN payment_status;
ALTER TABLE data_registrations DROP COLUMN staff_username;
ALTER TABLE data_registrations DROP COLUMN staff_full_name;

-- Remove the indexes
DROP INDEX idx_payment_status ON data_registrations;
DROP INDEX idx_staff_username ON data_registrations;
```

### Troubleshooting

**Issue: Column already exists**
- If you see an error about columns already existing, it means the migration was already run
- You can skip this migration or verify the columns are correct

**Issue: Foreign key constraint error**
- Make sure the `users` table exists before running the migration
- The migration script handles NULL values for staff_id

**Issue: Data not showing in Unpaid page**
- Check if the backend server is running
- Check browser console for API errors
- Verify the migration was successful using `DESCRIBE data_registrations`
- Check if `payment_status` column has the correct default value

### Support

If you encounter any issues:
1. Check the backend logs for errors
2. Verify database connection in `backend/.env`
3. Ensure all required columns exist in the table
