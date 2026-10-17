import { getMongoDB, isMongoDBAvailable, getDatabaseStatus, autoFixDatabaseConnection } from '../config/databaseManager.js';

/**
 * Get database and server health status
 */
export const getHealthStatus = async (req, res, next) => {
  try {
    const dbStatus = getDatabaseStatus();
    const serverStatus = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date()
    };

    res.json({
      success: true,
      data: {
        server: {
          status: 'running',
          uptime: serverStatus.uptime,
          memory: {
            used: Math.round(serverStatus.memory.heapUsed / 1024 / 1024),
            total: Math.round(serverStatus.memory.heapTotal / 1024 / 1024),
            unit: 'MB'
          }
        },
        database: {
          sqlite: {
            connected: dbStatus.sqlite?.connected || false,
            lastAttempt: dbStatus.sqlite?.lastAttempt || null,
            error: dbStatus.sqlite?.error || null
          },
          mongodb: {
            connected: dbStatus.mongodb.connected,
            lastAttempt: dbStatus.mongodb.lastAttempt,
            error: dbStatus.mongodb.error
          },
          mysql: {
            connected: dbStatus.mysql.connected,
            lastAttempt: dbStatus.mysql.lastAttempt,
            error: dbStatus.mysql.error
          },
          primary: dbStatus.primaryDB
        },
        timestamp: serverStatus.timestamp
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Auto-fix database connection
 */
export const autoFixDatabase = async (req, res, next) => {
  try {
    console.log('🔧 Auto-fix requested from root portal');
    
    const results = await autoFixDatabaseConnection();
    const dbStatus = getDatabaseStatus();

    const anySuccess = results.sqlite?.success || results.mongodb?.success || results.mysql?.success;

    res.json({
      success: anySuccess,
      message: anySuccess
        ? 'Database connection restored successfully' 
        : 'Failed to connect to any database',
      data: {
        results,
        currentStatus: dbStatus
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get root dashboard statistics
 */
export const getDashboardStats = async (req, res, next) => {
  try {
    // Verify root access
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    // Check if MongoDB is available
    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not connected',
        error: 'ECONNREFUSED',
        data: {
          totalUsers: 0,
          activePartners: 0,
          totalRevenue: 0,
          pendingTransactions: 0
        }
      });
    }

    const db = getMongoDB();

    // Get total users
    const totalUsers = await db.collection('users').countDocuments();

    // Get active partners
    const activePartners = await db.collection('clients').countDocuments({ status: 'active' });

    // Get total revenue from completed transactions
    const revenueResult = await db.collection('transactions').aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const totalRevenue = revenueResult.length > 0 ? revenueResult[0].total : 0;

    // Get pending transactions
    const pendingTransactions = await db.collection('transactions').countDocuments({ status: 'pending' });

    res.json({
      success: true,
      data: {
        totalUsers,
        activePartners,
        totalRevenue: parseFloat(totalRevenue) || 0,
        pendingTransactions
      }
    });
  } catch (error) {
    console.error('Error in getDashboardStats:', error);
    
    // Return graceful error with default values
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard statistics',
      error: error.message,
      data: {
        totalUsers: 0,
        activePartners: 0,
        totalRevenue: 0,
        pendingTransactions: 0
      }
    });
  }
};

/**
 * Get recent activity
 */
export const getRecentActivity = async (req, res, next) => {
  try {
    // Verify root access
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not connected',
        data: []
      });
    }

    const db = getMongoDB();
    const activities = [];

    // Get recent transactions
    const recentTransactions = await db.collection('transactions')
      .find()
      .sort({ created_at: -1 })
      .limit(5)
      .toArray();

    for (const transaction of recentTransactions) {
      let clientName = 'Unknown';
      if (transaction.client_id) {
        const client = await db.collection('clients').findOne({ _id: transaction.client_id });
        clientName = client?.company_name || 'Unknown';
      }

      activities.push({
        icon: '💰',
        text: `Transaction ${transaction.status}: ${transaction.amount?.toLocaleString() || 0} - ${clientName}`,
        time: transaction.created_at,
        type: 'transaction'
      });
    }

    // Get recent users
    const recentUsers = await db.collection('users')
      .find()
      .sort({ created_at: -1 })
      .limit(3)
      .toArray();

    recentUsers.forEach(user => {
      activities.push({
        icon: '👤',
        text: `New user registered: ${user.email || user.username}`,
        time: user.created_at,
        type: 'user'
      });
    });

    // Get recent clients
    const recentClients = await db.collection('clients')
      .find()
      .sort({ created_at: -1 })
      .limit(3)
      .toArray();

    recentClients.forEach(client => {
      activities.push({
        icon: '🤝',
        text: `New partnership created with ${client.company_name}`,
        time: client.created_at,
        type: 'partner'
      });
    });

    // Sort by time and limit to 10
    activities.sort((a, b) => new Date(b.time) - new Date(a.time));
    const limitedActivities = activities.slice(0, 10);

    res.json({
      success: true,
      data: limitedActivities
    });
  } catch (error) {
    console.error('Error in getRecentActivity:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch recent activity',
      data: []
    });
  }
};

/**
 * Get all users
 */
export const getAllUsers = async (req, res, next) => {
  try {
    // Verify root access
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not connected',
        data: []
      });
    }

    const db = getMongoDB();
    const users = await db.collection('users')
      .find({}, {
        projection: {
          password_hash: 0 // Exclude password hash
        }
      })
      .sort({ created_at: -1 })
      .toArray();

    res.json({
      success: true,
      data: users
    });
  } catch (error) {
    console.error('Error in getAllUsers:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      data: []
    });
  }
};

/**
 * Get all partners
 */
export const getAllPartners = async (req, res, next) => {
  try {
    // Verify root access
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not connected',
        data: []
      });
    }

    const db = getMongoDB();
    const partners = await db.collection('clients')
      .find()
      .sort({ created_at: -1 })
      .toArray();

    res.json({
      success: true,
      data: partners
    });
  } catch (error) {
    console.error('Error in getAllPartners:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch partners',
      data: []
    });
  }
};

/**
 * Get all transactions
 */
export const getAllTransactions = async (req, res, next) => {
  try {
    // Verify root access
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not connected',
        data: []
      });
    }

    const db = getMongoDB();
    const transactions = await db.collection('transactions')
      .find()
      .sort({ created_at: -1 })
      .toArray();

    // Enrich with client and user information
    for (const transaction of transactions) {
      if (transaction.client_id) {
        const client = await db.collection('clients').findOne({ _id: transaction.client_id });
        transaction.company_name = client?.company_name || null;
      }
      if (transaction.user_id) {
        const user = await db.collection('users').findOne({ _id: transaction.user_id });
        transaction.user_name = user?.full_name || user?.username || null;
      }
    }

    res.json({
      success: true,
      data: transactions
    });
  } catch (error) {
    console.error('Error in getAllTransactions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch transactions',
      data: []
    });
  }
};

/**
 * Get system logs
 */
export const getSystemLogs = async (req, res, next) => {
  try {
    // Verify root access
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    const dbStatus = getDatabaseStatus();

    // Generate system logs based on current status
    const logs = [
      {
        id: 1,
        level: 'info',
        message: 'System started successfully',
        timestamp: new Date(Date.now() - 3600000).toISOString()
      },
      {
        id: 2,
        level: dbStatus.mongodb.connected ? 'info' : 'error',
        message: dbStatus.mongodb.connected 
          ? 'MongoDB connection established' 
          : `MongoDB connection failed: ${dbStatus.mongodb.error || 'Unknown error'}`,
        timestamp: dbStatus.mongodb.lastAttempt || new Date().toISOString()
      },
      {
        id: 3,
        level: dbStatus.mysql.connected ? 'info' : 'warning',
        message: dbStatus.mysql.connected 
          ? 'MySQL connection established' 
          : `MySQL connection failed: ${dbStatus.mysql.error || 'Unknown error'}`,
        timestamp: dbStatus.mysql.lastAttempt || new Date().toISOString()
      },
      {
        id: 4,
        level: 'info',
        message: `Primary database: ${dbStatus.primaryDB.toUpperCase()}`,
        timestamp: new Date().toISOString()
      }
    ];

    res.json({
      success: true,
      data: logs
    });
  } catch (error) {
    next(error);
  }
};

export default {
  getHealthStatus,
  autoFixDatabase,
  getDashboardStats,
  getRecentActivity,
  getAllUsers,
  getAllPartners,
  getAllTransactions,
  getSystemLogs
};
