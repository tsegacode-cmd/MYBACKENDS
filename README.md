# Red Sea Brokerage - Backend API

RESTful API backend for the Red Sea Brokerage application built with Node.js and Express.

## Features

- **Authentication & Authorization**: JWT-based authentication with role-based access control
- **Client Management**: CRUD operations for individual and company clients
- **Transaction Management**: Handle fixed (real estate) and movable (vehicles, machinery) transactions
- **Contact Inquiries**: Public contact form with admin management
- **Dashboard Analytics**: Revenue reports, agent performance, and statistics
- **Security**: Helmet.js, CORS, input validation, and SQL injection protection
- **Database**: Neon PostgreSQL is the only database used by active application routes and server startup. The SQLite-to-Neon importer is an offline, one-time migration utility; it reads SQLite as a source and writes to Neon.

## Tech Stack

- **Runtime**: Node.js (ES Modules)
- **Framework**: Express.js
- **Database**: Neon PostgreSQL (`DATABASE_URL`) for all active application routes.
- **Authentication**: JWT (jsonwebtoken)
- **Password Hashing**: bcryptjs
- **Security**: Helmet, CORS
- **Logging**: Morgan
- **Environment**: dotenv
- **Media Uploads**: Cloudinary with Multer

## Prerequisites

- Node.js 16+ and npm
- A Neon PostgreSQL database configured with the imported application schema and data

## Installation

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Environment

Copy the example environment file and update with your settings:

```bash
cp .env.example .env
```

Edit `.env` file:

```env
# Server Configuration
PORT=5000
NODE_ENV=development

# Neon PostgreSQL connection (required by all active application routes)
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require

# Root administrator login (synchronized during each backend startup)
ROOT_USERNAME=root
ROOT_PASSWORD=your_secure_root_password

# JWT Configuration
JWT_SECRET=your_secure_random_secret_key
JWT_EXPIRES_IN=7d

# CORS Configuration
CORS_ORIGIN=http://localhost:5173

# Cloudinary image and media uploads
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

The image uploader is available from `config/cloudinary.js` as `upload`; it uses the `redsea_brokerage` folder and accepts JPG, PNG, and WebP images up to 5 MB. The general media endpoint is `POST /api/v1/upload` with a multipart form field named `file`. It accepts images, videos, PDF, Word, Excel, CSV, and plain-text files up to 20 MB and stores them in `redsea_all_uploads`. Keep all Cloudinary credentials server-side; do not use `VITE_`-prefixed variables. Existing JSON/base64 document endpoints are unchanged.

### 3. Current Database Setup

All active application routes—including root dashboard, promotions, clients, transactions, inquiries, authentication/OTP, marketplace, service booking and payments, Mini Ride, site content, utilities, data registration, daily-game rewards, agent management, social/wallet, link campaigns, live chat, and promo codes—read and write Neon PostgreSQL. Server startup requires `DATABASE_URL` and the imported `users` table. The offline SQLite-to-Neon importer remains available for one-time migration; MongoDB-only historical service-booking documents still require a separate data migration if that history must be preserved. Keep existing SQLite/MongoDB databases and backups until historical data has been checked and the Neon copy is verified.

The legacy collection API in `config/fileDatabase.js` now uses Neon tables instead of local JSON files. Its operations are asynchronous, and it does not create tables or seed a default user.

The Root Dashboard website-content editor manages public Home page section copy, header and footer text (including the copyright year), Contact page content, maintenance mode, and role-based page visibility. These settings are stored in Neon.

Backend database maintenance and diagnostic JavaScript scripts use `DATABASE_URL` and Neon. The retired SQLite runtime module fails explicitly if called. `scripts/migrateSqliteToNeon.js` is the only retained SQLite reader; it reads an existing SQLite source for a one-time import and writes the result to Neon. Do not delete or modify historical SQLite backups until their data has been verified in Neon.

To import SQLite schema and data into a **new, empty** Neon database, configure `DATABASE_URL` and optionally `DB_PATH`, then run:

```bash
npm run migrate-sqlite-to-neon
```

The importer refuses to run if the Neon database already contains public tables. Review and back up the source database first. It copies the SQLite schema and data, including dashboard, marketplace, service-booking, OTP/authentication, data-registration, daily-game, agent-management, social, wallet, link-campaign, live-chat, Mini Ride, and promo-code tables, to Neon. It is an offline migration tool and is not called during application startup.

To verify the Neon connection and confirm that the required `public.users` table exists, run:

```bash
npm run check-neon
```

The check is read-only; it does not create or alter database tables. The legacy `setup-mysql.bat` and `setup-mysql.sh` names now only run this Neon check; they no longer create MySQL databases or overwrite `.env`.

Configure `DATABASE_URL` and start the backend normally. It connects to Neon and exits with an explicit error if the connection or required `users` table is unavailable.

### 4. Start the Server

**Development mode** (with auto-reload):
```bash
npm run dev
```

**Production mode**:
```bash
npm start
```

The server will start on `http://localhost:5000` (or your configured PORT).

## API Documentation

### Base URL

```
http://localhost:5000/api/v1
```

### Authentication

Most endpoints require authentication. Include the JWT token in the Authorization header:

```
Authorization: Bearer <your_jwt_token>
```

---

## API Endpoints

### Authentication

#### Login
```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "admin@redsea-brokerage.com",
  "password": "password"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": {
      "id": 1,
      "username": "admin",
      "email": "admin@redsea-brokerage.com",
      "full_name": "System Administrator",
      "role": "admin"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

#### Get Profile
```http
GET /api/v1/auth/profile
Authorization: Bearer <token>
```

#### Update Profile
```http
PUT /api/v1/auth/profile
Authorization: Bearer <token>
Content-Type: application/json

{
  "full_name": "Updated Name",
  "phone": "+249123456789"
}
```

#### Change Password
```http
POST /api/v1/auth/change-password
Authorization: Bearer <token>
Content-Type: application/json

{
  "current_password": "old_password",
  "new_password": "new_password"
}
```

---

### Clients

#### Get All Clients
```http
GET /api/v1/clients?page=1&limit=10&status=active&client_type=individual&search=mohammed
Authorization: Bearer <token>
```

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `status` (optional): active, inactive, blocked
- `client_type` (optional): individual, company
- `search` (optional): Search by name, phone, or email

#### Get Client by ID
```http
GET /api/v1/clients/:id
Authorization: Bearer <token>
```

#### Create Client
```http
POST /api/v1/clients
Authorization: Bearer <token>
Content-Type: application/json

{
  "client_type": "individual",
  "full_name": "Ahmed Hassan",
  "national_id": "SD123456789",
  "email": "ahmed@email.com",
  "phone": "+249912345678",
  "address": "Street 10, Khartoum",
  "city": "Khartoum",
  "status": "active"
}
```

#### Update Client
```http
PUT /api/v1/clients/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "phone": "+249912345679",
  "status": "inactive"
}
```

#### Delete Client
```http
DELETE /api/v1/clients/:id
Authorization: Bearer <token>
```

#### Telegram Mini App sign-in

Configure the Telegram bot token in **Root Dashboard → OTP API → OTP Delivery Settings**, link each user's Telegram chat from **My Profile**, and configure the bot's Mini App URL in BotFather. The deployed Mini App URL must use HTTPS.

```http
POST /api/v1/auth/telegram/miniapp/login
Content-Type: application/json

{
  "initData": "<Telegram.WebApp.initData>"
}
```

The API verifies Telegram's signed launch data and its timestamp, then returns a JWT session only for an active, non-root account linked to that Telegram user. Root and admin accounts must use the Root Portal. Do not trust Telegram user fields sent separately from `initData`.

---

### Transactions

#### Get All Transactions
```http
GET /api/v1/transactions?type=fixed&status=completed&payment_status=paid&page=1&limit=10
Authorization: Bearer <token>
```

**Query Parameters:**
- `type` (optional): fixed, movable
- `status` (optional): pending, in_progress, completed, cancelled
- `payment_status` (optional): pending, partial, paid
- `page` (optional): Page number
- `limit` (optional): Items per page

#### Get Fixed Transaction by ID
```http
GET /api/v1/transactions/fixed/:id
Authorization: Bearer <token>
```

#### Create Fixed Transaction
```http
POST /api/v1/transactions/fixed
Authorization: Bearer <token>
Content-Type: application/json

{
  "transaction_number": "FT-2024-007",
  "client_id": 1,
  "service_type_id": 1,
  "property_type": "residential",
  "property_address": "Street 15, Khartoum",
  "property_area": 350,
  "area_unit": "sqm",
  "sale_price": 2500000,
  "commission_amount": 62500,
  "commission_percentage": 2.5,
  "transaction_date": "2024-03-15",
  "status": "pending",
  "assigned_to": 3
}
```

#### Get Movable Transaction by ID
```http
GET /api/v1/transactions/movable/:id
Authorization: Bearer <token>
```

#### Create Movable Transaction
```http
POST /api/v1/transactions/movable
Authorization: Bearer <token>
Content-Type: application/json

{
  "transaction_number": "MT-2024-006",
  "client_id": 2,
  "service_type_id": 6,
  "item_type": "vehicle",
  "item_description": "Toyota Land Cruiser 2023",
  "item_specifications": "V8, White, 5000 km",
  "quantity": 1,
  "total_value": 900000,
  "commission_amount": 27000,
  "commission_percentage": 3.0,
  "transaction_date": "2024-03-15",
  "status": "pending",
  "assigned_to": 4
}
```

#### Update Fixed Transaction
```http
PUT /api/v1/transactions/fixed/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "status": "completed",
  "payment_received": 62500,
  "payment_status": "paid"
}
```

#### Update Movable Transaction
```http
PUT /api/v1/transactions/movable/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "status": "in_progress",
  "payment_received": 13500,
  "payment_status": "partial"
}
```

---

### Contact Inquiries

#### Submit Inquiry (Public)
```http
POST /api/v1/contact
Content-Type: application/json

{
  "inquiry_type": "fixed_commission",
  "full_name": "Ali Hassan",
  "email": "ali@email.com",
  "phone": "+249912345678",
  "subject": "Property Sale Inquiry",
  "message": "I would like to sell my property in Khartoum",
  "priority": "medium"
}
```

#### Get All Inquiries
```http
GET /api/v1/contact?status=new&inquiry_type=fixed_commission&priority=high&page=1&limit=10
Authorization: Bearer <token>
```

#### Get Inquiry by ID
```http
GET /api/v1/contact/:id
Authorization: Bearer <token>
```

#### Update Inquiry
```http
PUT /api/v1/contact/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "status": "in_progress",
  "assigned_to": 3,
  "response": "Thank you for your inquiry. We will contact you soon."
}
```

#### Get Inquiry Statistics
```http
GET /api/v1/contact/stats
Authorization: Bearer <token>
```

---

### Dashboard

#### Get Dashboard Statistics
```http
GET /api/v1/dashboard/stats
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "activeClients": 25,
    "activeContracts": 12,
    "pendingTransactions": 8,
    "pendingInquiries": 5,
    "totalPendingPayments": 450000,
    "currentMonthRevenue": 320000,
    "totalRevenue": 2500000
  }
}
```

#### Get Monthly Revenue
```http
GET /api/v1/dashboard/revenue/monthly?year=2024
Authorization: Bearer <token>
```

#### Get Agent Performance
```http
GET /api/v1/dashboard/performance/agents
Authorization: Bearer <token>
```

#### Get Service Performance
```http
GET /api/v1/dashboard/performance/services
Authorization: Bearer <token>
```

#### Get Recent Activities
```http
GET /api/v1/dashboard/activities?limit=10
Authorization: Bearer <token>
```

---

## User Roles & Permissions

### Admin
- Full access to all endpoints
- Can manage users, clients, transactions, and inquiries
- Access to all reports and analytics

### Manager
- Can manage clients, transactions, and inquiries
- Access to reports and analytics
- Cannot delete critical records

### Agent
- Can create and update clients and transactions
- Can view and respond to inquiries
- Limited access to reports

### Staff
- Can create and update basic records
- Limited access to sensitive data
- Cannot delete records

---

## Error Handling

All errors follow this format:

```json
{
  "success": false,
  "message": "Error description"
}
```

### HTTP Status Codes

- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `409` - Conflict (duplicate entry)
- `500` - Internal Server Error

---

## Security Best Practices

1. **Environment Variables**: Never commit `.env` file to version control
2. **JWT Secret**: Use a strong, random secret key in production
3. **Password Policy**: Enforce strong passwords (minimum 6 characters in this example)
4. **HTTPS**: Always use HTTPS in production
5. **Rate Limiting**: Consider adding rate limiting for production
6. **Input Validation**: Validate all user inputs
7. **SQL Injection**: Use parameterized queries (already implemented)

---

## Database Connection

The API uses Neon PostgreSQL connection pooling:

- **Connection Limit**: 10 concurrent connections
- **Auto-reconnect**: Enabled
- **Keep-alive**: Enabled

---

## Development

### Project Structure

```
backend/
├── config/
│   └── database.js          # Database configuration
├── controllers/
│   ├── authController.js    # Authentication logic
│   ├── clientController.js  # Client management
│   ├── transactionController.js
│   ├── contactController.js
│   └── dashboardController.js
├── middleware/
│   ├── auth.js              # JWT authentication
│   └── errorHandler.js      # Error handling
├── routes/
│   ├── authRoutes.js
│   ├── clientRoutes.js
│   ├── transactionRoutes.js
│   ├── contactRoutes.js
│   └── dashboardRoutes.js
├── .env.example
├── package.json
├── server.js                # Main entry point
└── README.md
```

### Adding New Endpoints

1. Create controller in `controllers/`
2. Create route file in `routes/`
3. Import and use route in `server.js`
4. Add authentication/authorization as needed

---

## Testing

### Manual Testing with cURL

**Login:**
```bash
curl -X POST http://localhost:5000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@redsea-brokerage.com","password":"password"}'
```

**Get Clients:**
```bash
curl -X GET http://localhost:5000/api/v1/clients \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### Testing with Postman

1. Import the API endpoints into Postman
2. Set up environment variables for base URL and token
3. Test each endpoint with different scenarios

---

## Deployment

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Use strong JWT secret
- [ ] Enable HTTPS
- [ ] Set up proper CORS origins
- [ ] Configure database with production credentials
- [ ] Set up logging and monitoring
- [ ] Enable rate limiting
- [ ] Set up automated backups
- [ ] Configure firewall rules
- [ ] Use process manager (PM2)

### Using PM2

```bash
npm install -g pm2
pm2 start server.js --name redsea-api
pm2 save
pm2 startup
```

---

## Troubleshooting

### Database Connection Issues

1. Verify `DATABASE_URL` in `.env` points to the intended Neon database.
2. Confirm the Neon database is reachable and contains the imported application schema.
3. Check backend startup logs for the Neon connection or schema error.

### Port Already in Use

```bash
# Find process using port 5000
lsof -i :5000

# Kill the process
kill -9 <PID>
```

### JWT Token Issues

- Ensure JWT_SECRET is set in `.env`
- Check token expiration time
- Verify token format in Authorization header

---

## Support

For issues or questions:
- Check the database documentation in `/database/README.md`
- Review the SQL schema in `/database/schema.sql`
- Check server logs for error details

---

## License

This project is part of the Red Sea Brokerage application.
