import { getMongoDB, isMongoDBAvailable, getDatabaseStatus, autoFixDatabaseConnection } from '../config/databaseManager.js';
import { getRawSQLiteDB } from '../config/sqliteDatabase.js';

export const getRootDashboardStatus = (_req, res, next) => {
  try {
    const db = getRawSQLiteDB();
    const count = sql => Number(db.prepare(sql).get().count || 0);
    const hasTable = table => Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(table));
    const pendingAgentProducts = count(`
      SELECT
        (SELECT COUNT(*) FROM agent_products WHERE approval_status = 'pending') +
        (SELECT COUNT(*) FROM service_catalog_products WHERE approval_status = 'pending') AS count
    `);
    const pendingWalletRequests = count(`
      SELECT
        (SELECT COUNT(*) FROM agent_wallet_requests WHERE status = 'pending') +
        (SELECT COUNT(*) FROM wallet_deposits WHERE status = 'pending') +
        (SELECT COUNT(*) FROM wallet_withdrawals WHERE status = 'pending') AS count
    `);
    const income = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
      FROM (
        SELECT amount FROM wallet_ledger
        WHERE amount > 0 AND datetime(created_at) >= datetime('now', '-60 seconds')
        UNION ALL
        SELECT amount FROM platform_service_charge_ledger
        WHERE entry_type = 'service_charge'
          AND datetime(created_at) >= datetime('now', '-60 seconds')
      )
    `).get();
    const badges = {
      users: count("SELECT COUNT(*) AS count FROM users WHERE datetime(created_at) >= datetime('now', '-60 seconds')"),
      agents: pendingAgentProducts + count("SELECT COUNT(*) AS count FROM agent_package_requests WHERE status = 'pending'"),
      'feed-management': count("SELECT COUNT(*) AS count FROM boost_requests WHERE status = 'pending'"),
      finance: Number(income.count || 0),
      partners: count("SELECT COUNT(*) AS count FROM clients WHERE LOWER(status) IN ('pending', 'pending_approval')"),
      services: count("SELECT COUNT(*) AS count FROM service_catalog_products WHERE approval_status = 'pending'"),
      booked: count("SELECT COUNT(*) AS count FROM service_booking_requests WHERE status IN ('pending_approval', 'pending_payment')"),
      payments: count("SELECT COUNT(*) AS count FROM service_booking_requests WHERE paymentStatus IN ('submitted', 'initiating', 'initiated')"),
      'utility-control': hasTable('utility_payment_requests')
        ? count("SELECT COUNT(*) AS count FROM utility_payment_requests WHERE status = 'request'")
        : 0,
      'wallet-management': pendingWalletRequests,
      transactions: pendingWalletRequests,
    };
    return res.json({
      success: true,
      data: {
        badges,
        recentIncomeCount: Number(income.count || 0),
        recentIncomeAmount: Number(income.amount || 0),
        refreshedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    return next(error);
  }
};

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

    if (getDatabaseStatus().primaryDB === 'sqlite') {
      const db = getRawSQLiteDB();
      const stats = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM users) AS totalUsers,
          (SELECT COUNT(*) FROM clients WHERE status = 'active') AS activePartners,
          (
            SELECT COALESCE(SUM(commission_amount), 0)
            FROM (
              SELECT commission_amount FROM fixed_transactions WHERE status = 'completed'
              UNION ALL
              SELECT commission_amount FROM movable_transactions WHERE status = 'completed'
            )
          ) AS totalRevenue,
          (
            SELECT COUNT(*)
            FROM (
              SELECT _id FROM fixed_transactions WHERE status = 'pending'
              UNION ALL
              SELECT _id FROM movable_transactions WHERE status = 'pending'
            )
          ) AS pendingTransactions
      `).get();

      return res.json({
        success: true,
        data: {
          totalUsers: Number(stats.totalUsers),
          activePartners: Number(stats.activePartners),
          totalRevenue: Number(stats.totalRevenue),
          pendingTransactions: Number(stats.pendingTransactions)
        }
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

    if (getDatabaseStatus().primaryDB === 'sqlite') {
      const db = getRawSQLiteDB();
      const activities = [];
      const recentTransactions = db.prepare(`
        SELECT
          transactions.status,
          transactions.commission_amount AS amount,
          transactions.created_at,
          COALESCE(NULLIF(clients.company_name, ''), NULLIF(clients.full_name, ''), 'Unknown') AS client_name
        FROM (
          SELECT client_id, status, commission_amount, created_at
          FROM fixed_transactions
          UNION ALL
          SELECT client_id, status, commission_amount, created_at
          FROM movable_transactions
        ) AS transactions
        LEFT JOIN clients ON clients._id = transactions.client_id
        ORDER BY transactions.created_at DESC
        LIMIT 5
      `).all();

      recentTransactions.forEach(transaction => {
        activities.push({
          icon: '💰',
          text: `Transaction ${transaction.status}: ${Number(transaction.amount || 0).toLocaleString()} - ${transaction.client_name}`,
          time: transaction.created_at,
          type: 'transaction'
        });
      });

      const recentUsers = db.prepare(
        'SELECT email, username, created_at FROM users ORDER BY created_at DESC LIMIT 3'
      ).all();

      recentUsers.forEach(user => {
        activities.push({
          icon: '👤',
          text: `New user registered: ${user.email || user.username}`,
          time: user.created_at,
          type: 'user'
        });
      });

      const recentClients = db.prepare(
        'SELECT company_name, created_at FROM clients ORDER BY created_at DESC LIMIT 3'
      ).all();

      recentClients.forEach(client => {
        activities.push({
          icon: '🤝',
          text: `New partnership created with ${client.company_name}`,
          time: client.created_at,
          type: 'partner'
        });
      });

      activities.sort((a, b) => new Date(b.time) - new Date(a.time));

      return res.json({
        success: true,
        data: activities.slice(0, 10)
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
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    const dbStatus = getDatabaseStatus();
    const timestamp = new Date().toISOString();
    const databaseLogs = ['sqlite', 'mongodb', 'mysql', 'filedb'].map(database => {
      const status = dbStatus[database];
      const connected = Boolean(status?.connected);
      const isPrimary = dbStatus.primaryDB === database;
      return {
        id: `database-${database}`,
        level: connected ? 'info' : isPrimary ? 'error' : 'warning',
        message: `${database.toUpperCase()} ${connected ? 'connected' : 'disconnected'}${isPrimary ? ' (primary database)' : ''}${status?.error ? `: ${status.error}` : ''}`,
        timestamp: status?.lastAttempt ? new Date(status.lastAttempt).toISOString() : timestamp
      };
    });
    const memory = process.memoryUsage();
    const logs = [
      {
        id: 'server-status',
        level: 'info',
        message: `Server running · uptime ${Math.floor(process.uptime() / 60)} minutes · memory ${Math.round(memory.heapUsed / 1024 / 1024)} MB`,
        timestamp
      },
      ...databaseLogs,
      {
        id: 'primary-database',
        level: 'info',
        message: `Primary database: ${String(dbStatus.primaryDB || 'unknown').toUpperCase()}`,
        timestamp
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
