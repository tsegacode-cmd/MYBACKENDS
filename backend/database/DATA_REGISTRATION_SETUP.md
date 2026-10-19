# Data Registration Feature - Setup Guide

## Overview
The Data Registration feature tracks TV revenue request letters with client information, TV details, and staff assignments. This document provides complete setup instructions.

## Database Setup

### For New Installations

If you're setting up the database for the first time:

```bash
# Connect to MySQL
mysql -u root -p

# Create database if not exists
CREATE DATABASE IF NOT EXISTS redsea_db;
USE redsea_db;

# Run the schema file
source backend/database/data_registrations.sql;
```

### For Existing Installations

If you already have a `data_registrations` table with old fields:

```bash
# Connect to MySQL
mysql -u root -p

# Select your database
USE redsea_db;

# Run the migration script
source backend/database/migrate_data_registrations.sql;
```

### Database Schema

The `data_registrations` table includes:

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| id | INT | Yes | Auto-increment primary key |
| work_type | VARCHAR(100) | Yes | Type of work (redsea-ebc, sells-product, other) |
| staff_id | INT | No | Foreign key to users table (nullable for Other/All) |
| client_name | VARCHAR(255) | Yes | Client's full name |
| kebele | VARCHAR(100) | Yes | Kebele location |
| house_no | VARCHAR(50) | No | House number (optional) |
| client_phone | VARCHAR(50) | Yes | Client's phone number |
| tv_no | VARCHAR(10) | Yes | Number of TVs (1-50) |
| person | VARCHAR(50) | Yes | Personal or Organization |
| client_email | VARCHAR(255) | No | Client's email (optional) |
| condition | VARCHAR(50) | Yes | New or Old |
| sign | VARCHAR(50) | Yes | Sign or Unsign |
| registered_at | TIMESTAMP | Yes | When the data was registered |
| created_at | TIMESTAMP | Yes | Record creation timestamp |
| updated_at | TIMESTAMP | Yes | Record update timestamp |

### Verify Installation

```sql
DESCRIBE data_registrations;
```

Expected output should show all fields with correct data types and constraints.

## Backend Components

### Files:
1. **Controller**: `backend/controllers/dataRegistrationController.js`
   - Handles CRUD operations
   - Includes in-memory fallback when database is unavailable
   - Stores staff_username and staff_full_name for in-memory mode

2. **Routes**: `backend/routes/dataRegistrationRoutes.js`
   - POST `/api/v1/data-registrations` - Create new registration
   - GET `/api/v1/data-registrations` - Get all registrations
   - GET `/api/v1/data-registrations/:id` - Get single registration
   - PUT `/api/v1/data-registrations/:id` - Update registration
   - DELETE `/api/v1/data-registrations/:id` - Delete registration

3. **Database Schema**: `backend/database/data_registrations.sql`
   - Table creation script with new fields

4. **Migration Script**: `backend/database/migrate_data_registrations.sql`
   - Updates existing tables to new schema

## Frontend Components

### Pages:
1. **Data Collect**: `src/pages/DataCollector/DataCollect.jsx`
   - Landing page with beautiful gradient design
   - Navigation to Data Registration and Unpaid pages

2. **Data Registration**: `src/pages/DataCollector/DataRegistration.jsx`
   - Work Type dropdown (REDSEA with EBC Work, Sells Product Work, Other)
   - Staff dropdown (loads from users, shows username - full_name - phone)
   - Core form fields: Client Name, Kebele, House No, Client Phone, TV No, Person, Client Email, Condition, Sign
   - Optional transaction number, which can be filled by scanning a QR code from the QR Scan control in the web-app header
   - Optional photo upload or camera capture; images are resized before storage
   - Transaction numbers are stored on the registration record; photos are stored as registration image documents and can be opened from the Registered list
   - Form enables only after both dropdowns selected
   - Navigates to Unpaid page after successful registration

3. **Unpaid Page**: `src/pages/DataCollector/Unpaid.jsx`
   - Lists all registrations with UNPAID indicator
   - Shows staff information first, then registration details
   - Action buttons: View, Edit, Mark as Paid

### Routes:
- `/data-collect` - Data Collector landing page
- `/data-registration` - Registration form
- `/unpaid` - Unpaid registrations list

## API Endpoints

### Create Registration
```http
POST /api/v1/data-registrations
Content-Type: application/json

{
  "work_type": "redsea-ebc",
  "staff_id": 1,
  "staff_username": "john_doe",
  "staff_full_name": "John Doe",
  "client_name": "Jane Smith",
  "kebele": "Kebele 05",
  "house_no": "123",
  "client_phone": "+251-11-123-4567",
  "tv_no": "3",
  "person": "personal",
  "client_email": "jane@example.com",
  "condition": "new",
  "sign": "sign",
  "registered_at": "2024-01-15T10:30:00Z"
}
```

### Get All Registrations
```http
GET /api/v1/data-registrations
```

Response includes staff_username and staff_full_name for display.

## Features

### In-Memory Fallback
- Automatically activates when database is unavailable
- Maintains full CRUD functionality
- Stores staff information (username, full_name) for proper display
- Data persists during server runtime
- Useful for development and testing

### Form Features
- Landscape layout (max-width: 1100px)
- 4-column grid on desktop, responsive on mobile
- TV No dropdown with 1-50 options
- Person dropdown (Personal/Organization)
- Condition dropdown (New/Old)
- Sign dropdown (Sign/Unsign)
- Lock icon when form disabled
- Toast notifications for success/error

### Unpaid Page Features
- Grid layout with responsive cards
- UNPAID badge with pulsing animation
- Staff Information section (first)
- Registration Details section (second)
- Action buttons: View, Edit, Mark as Paid
- Beautiful gradient design

## Testing

### 1. Test Registration Flow
1. Navigate to `/data-collect`
2. Click "Start Registration"
3. Select Work Type
4. Select Staff (or Other/All)
5. Fill in all required fields
6. Click "Register Data"
7. Verify toast notification
8. Verify navigation to Unpaid page
9. Verify registration appears in list

### 2. Test In-Memory Mode
```bash
# Stop MySQL temporarily
# Start backend server
cd backend
npm run dev
```

Expected: System works normally with "(in-memory)" in success messages

### 3. Test Database Mode
```bash
# Ensure MySQL is running
# Start backend server
cd backend
npm run dev
```

Expected: Data persists in database

## Data Flow

1. **User selects dropdowns** → Form enables
2. **User fills form** → Frontend validates input
3. **Form submission** → Data sent to API with staff info
4. **API receives request** → Controller validates required fields
5. **Database check** → Determines if DB is available
6. **Data storage** → Saves to database or in-memory (with staff info)
7. **Response sent** → Success message returned
8. **Toast notification** → User sees feedback
9. **Navigation** → Redirects to Unpaid page after 1 second
10. **Display** → Registration appears in Unpaid list with staff info

## Migration from Old Schema

If you have existing data with old fields (product_service, amount, commission_rate, notes):

1. Run the migration script: `source backend/database/migrate_data_registrations.sql`
2. The script will:
   - Add new columns (kebele, house_no, tv_no, person, condition, sign)
   - Make staff_id nullable
   - Update foreign key constraint
   - Set default values for existing records
   - Optionally remove old columns (commented out by default)

## Troubleshooting

### Issue: "Missing required fields" error
**Solution**: Ensure all required fields are filled (work_type, client_name, kebele, client_phone, tv_no, person, condition, sign)

### Issue: Staff information not showing on Unpaid page
**Solution**: 
- For database mode: Ensure users table exists and has data
- For in-memory mode: Ensure staff_username and staff_full_name are sent in registration request

### Issue: Form not enabling after selecting dropdowns
**Solution**: Ensure both Work Type AND Staff are selected (not empty)

### Issue: Database connection error
**Solution**: System will automatically use in-memory storage. Check MySQL connection settings in .env file

### Issue: Foreign key constraint fails
**Solution**: 
- Ensure the staff_id exists in the users table
- Or select "Other" or "All" which sets staff_id to null

## Security Considerations

1. **Input Validation**: All required fields validated on backend
2. **SQL Injection**: Using parameterized queries
3. **Foreign Key Constraints**: Ensures data integrity (nullable for Other/All)
4. **Error Messages**: Generic messages to prevent information leakage

## Future Enhancements

- [ ] Implement View functionality on Unpaid page
- [ ] Implement Edit functionality on Unpaid page
- [ ] Implement Mark as Paid functionality
- [ ] Add payment tracking
- [ ] Add filtering and search on Unpaid page
- [ ] Export data to CSV/Excel
- [ ] Add data analytics dashboard
- [ ] Implement audit logging
- [ ] Add email notifications

## Version History

- **v2.0.0** (2024-01-15): Major update
  - New fields: kebele, house_no, tv_no, person, condition, sign
  - Removed fields: product_service, amount, commission_rate, notes
  - Added Unpaid page
  - Landscape form layout
  - Staff information display on Unpaid page
  - Migration script for existing installations

- **v1.0.0** (2024-01-15): Initial implementation
  - CRUD operations
  - In-memory fallback
  - Toast notifications
  - Staff integration
