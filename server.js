import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { pathToFileURL } from 'url';
import { initializeDatabases, getDatabaseStatus } from './config/databaseManager.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

// Import routes
import authRoutes from './routes/authRoutes.js';
import clientRoutes from './routes/clientRoutes.js';
import transactionRoutes from './routes/transactionRoutes.js';
import contactRoutes from './routes/contactRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import rootRoutes from './routes/rootRoutes.js';
import userRoutes from './routes/userRoutes.js';
import dataRegistrationRoutes from './routes/dataRegistrationRoutes.js';
import serviceBookingRoutes from './routes/serviceBookingRoutes.js';
import socialRoutes from './routes/socialRoutes.js';
import liveChatRoutes from './routes/liveChatRoutes.js';
import marketplaceRoutes from './routes/marketplaceRoutes.js';
import agentRoutes from './routes/agentRoutes.js';
import miniRideRoutes from './routes/miniRideRoutes.js';
import uploadRoutes from './routes/uploadRoutes.js';

// Load environment variables
dotenv.config();

// Initialize express app
const app = express();
const PORT = process.env.PORT || 5000;
const API_PREFIX = process.env.API_PREFIX || '/api/v1';

// Middleware
app.use(helmet()); // Security headers

// CORS Configuration - Allow access from any device on the network
const corsOrigin = process.env.CORS_ORIGIN === '*' ? true : (process.env.CORS_ORIGIN || 'http://localhost:5173');
app.use(cors({
  exposedHeaders: ['Content-Disposition'],
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(morgan('dev')); // Logging
app.use(express.json({ limit: '12mb' })); // Registration requests may include small PDF attachments.
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// DEBUG MIDDLEWARE - Log all PUT requests to /users
app.use((req, res, next) => {
  if (req.method === 'PUT' && req.url.includes('/users/')) {
    console.log('🔍 ========== PUT REQUEST TO /users/ ==========');
    console.log('🔍 URL:', req.url);
    console.log('🔍 Method:', req.method);
    console.log('🔍 Headers:', req.headers);
    console.log('🔍 Body:', req.body);
    console.log('🔍 Body type:', typeof req.body);
    console.log('🔍 Body keys:', Object.keys(req.body || {}));
    console.log('🔍 ==========================================');
  }
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Red Sea Brokerage API is running',
    timestamp: new Date().toISOString()
  });
});

// API health check endpoint (for frontend)
app.get(`${API_PREFIX}/health`, (req, res) => {
  res.json({
    success: true,
    message: 'Red Sea Brokerage API is running',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    status: 'healthy'
  });
});

// API routes
app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/clients`, clientRoutes);
app.use(`${API_PREFIX}/transactions`, transactionRoutes);
app.use(`${API_PREFIX}/contact`, contactRoutes);
app.use(`${API_PREFIX}/dashboard`, dashboardRoutes);
app.use(`${API_PREFIX}/root`, rootRoutes);
app.use(`${API_PREFIX}/users`, userRoutes);
app.use(`${API_PREFIX}/data-registrations`, dataRegistrationRoutes);
app.use(`${API_PREFIX}/service-bookings`, serviceBookingRoutes);
app.use(`${API_PREFIX}/social`, socialRoutes);
app.use(`${API_PREFIX}/live-chat`, liveChatRoutes);
app.use(`${API_PREFIX}/marketplace`, marketplaceRoutes);
app.use(`${API_PREFIX}/agent`, agentRoutes);
app.use(`${API_PREFIX}/mini-ride`, miniRideRoutes);
app.use(API_PREFIX, uploadRoutes);

// 404 handler
app.use(notFound);

// Error handler
app.use(errorHandler);

// Start server
const startServer = async () => {
  try {
    // Initialize database connections
    console.log('🔄 Initializing database connections...');
    console.log('');
    
    await initializeDatabases();
    
    const dbStatus = getDatabaseStatus();
    const HOST = process.env.HOST || '0.0.0.0';
    
    // Get local IP address
    const os = await import('os');
    const interfaces = os.networkInterfaces();
    let localIP = 'localhost';
    
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIP = iface.address;
          break;
        }
      }
    }
    
    // Start listening on all network interfaces
    app.listen(PORT, HOST, () => {
      console.log('='.repeat(50));
      console.log('🚀 Red Sea Brokerage API Server');
      console.log('='.repeat(50));
      console.log(`📡 Server running on port ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔗 Local: http://localhost:${PORT}${API_PREFIX}`);
      console.log(`🌐 Network: http://${localIP}:${PORT}${API_PREFIX}`);
      console.log(`💚 Health Check: http://${localIP}:${PORT}/health`);
      console.log(`🔧 Root Health: http://${localIP}:${PORT}${API_PREFIX}/root/health`);
      console.log('');
      console.log('📱 Access from mobile/other devices:');
      console.log(`   Open: http://${localIP}:5173`);
      console.log(`   (Make sure devices are on the same WiFi)`);
      console.log('');
      console.log('📊 Database Status:');

      console.log(dbStatus.neon.connected
        ? '   ✅ Neon PostgreSQL: Connected'
        : '   ❌ Neon PostgreSQL: Not connected');
      
      console.log('');
      console.log('✅ Server started successfully');
      console.log('='.repeat(50));
    });
  } catch (error) {
    console.error('');
    console.error('='.repeat(50));
    console.error('❌ FAILED TO START SERVER');
    console.error('='.repeat(50));
    console.error('Error:', error.message);
    console.error('');
    console.error('The server requires a working Neon PostgreSQL connection.');
    console.error('Set DATABASE_URL and import the application schema/data into Neon before starting.');
    console.error('');
    console.error('='.repeat(50));
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Promise Rejection:', err);
  process.exit(1);
});

export { app, startServer };
export default app;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
