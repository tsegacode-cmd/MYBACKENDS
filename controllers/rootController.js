import { query } from '../config/database.js';

// Get root dashboard statistics
export const getDashboardStats = async (req, res, next) => {
  try {
    // Verify root access
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    // Get total users
    const totalUsersResult = await query('SELECT COUNT(*) as count FROM users');
    const totalUsers = totalUsersResult[0].count;

    // Get active partners
    const activePartnersResult = await query("SELECT COUNT(*) as count FROM clients WHERE status = 'active'");
    const activePartners = activePartnersResult[0].count;

    // Get total revenue
    const totalRevenueResult = await query("SELECT SUM(amount) as total FROM transactions WHERE status = 'completed'");
    const totalRevenue = totalRevenueResult[0].total || 0;

    // Get pending transactions
    const pendingTransactionsResult = await query("SELECT COUNT(*) as count FROM transactions WHERE status = 'pending'");
    const pendingTransactions = pendingTransactionsResult[0].count;

    res.json({
      success: true,
      data: {
        totalUsers,
        activePartners,
        totalRevenue: parseFloat(totalRevenue),
        pendingTransactions
      }
    });
  } catch (error) {
    next(error);
  }
};

// Get recent activity
export const getRecentActivity = async (req, res, next) => {
  try {
    // Verify root access
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    const activities = [];

    // Get recent transactions
    const recentTransactions = await query(
      `SELECT t.*, c.company_name 
       FROM transactions t 
       LEFT JOIN clients c ON t.client_id = c.id 
       ORDER BY t.created_at DESC 
       LIMIT 5`
    );

    recentTransactions.forEach(transaction => {
      activities.push({
        icon: '💰',
        text: `Transaction ${transaction.status}: $${transaction.amount.toLocaleString()} - ${transaction.company_name || 'Unknown'}`,
        time: transaction.created_at,
        type: 'transaction'
      });
    });

    // Get recent users
    const recentUsers = await query(
      'SELECT * FROM users ORDER BY created_at DESC LIMIT 3'
    );

    recentUsers.forEach(user => {
      activities.push({
        icon: '👤',
        text: `New user registered: ${user.email}`,
        time: user.created_at,
        type: 'user'
      });
    });

    // Get recent clients
    const recentClients = await query(
      'SELECT * FROM clients ORDER BY created_at DESC LIMIT 3'
    );

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
    next(error);
  }
};

// Get all users
export const getAllUsers = async (req, res, next) => {
  try {
    // Verify root access
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    const users = await query(
      'SELECT id, username, email, full_name, role, phone, is_active, last_login, created_at FROM users ORDER BY created_at DESC'
    );

    res.json({
      success: true,
      data: users
    });
  } catch (error) {
    next(error);
  }
};

// Get all partners
export const getAllPartners = async (req, res, next) => {
  try {
    // Verify root access
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    const partners = await query(
      'SELECT * FROM clients ORDER BY created_at DESC'
    );

    res.json({
      success: true,
      data: partners
    });
  } catch (error) {
    next(error);
  }
};

// Get all transactions
export const getAllTransactions = async (req, res, next) => {
  try {
    // Verify root access
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    const transactions = await query(
      `SELECT t.*, c.company_name, u.full_name as user_name
       FROM transactions t
       LEFT JOIN clients c ON t.client_id = c.id
       LEFT JOIN users u ON t.user_id = u.id
       ORDER BY t.created_at DESC`
    );

    res.json({
      success: true,
      data: transactions
    });
  } catch (error) {
    next(error);
  }
};

// Get system logs
export const getSystemLogs = async (req, res, next) => {
  try {
    // Verify root access
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    // Mock system logs (in production, implement proper logging system)
    const logs = [
      {
        id: 1,
        level: 'info',
        message: 'System started successfully',
        timestamp: new Date(Date.now() - 3600000).toISOString()
      },
      {
        id: 2,
        level: 'info',
        message: 'Database connection established',
        timestamp: new Date(Date.now() - 3500000).toISOString()
      },
      {
        id: 3,
        level: 'warning',
        message: 'High memory usage detected',
        timestamp: new Date(Date.now() - 1800000).toISOString()
      },
      {
        id: 4,
        level: 'info',
        message: 'Backup completed successfully',
        timestamp: new Date(Date.now() - 900000).toISOString()
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

// Get active user sessions
export const getActiveSessions = async (req, res, next) => {
  try {
    // Verify root access
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    // Get all users with their last login information
    const users = await query(
      `SELECT id, username, full_name, email, role, last_login, is_active
       FROM users
       WHERE is_active = 1 AND last_login IS NOT NULL
       ORDER BY last_login DESC`
    );

    // Format sessions data
    const sessions = users.map(user => ({
      id: user.id,
      username: user.username,
      fullName: user.full_name || '-',
      email: user.email || '-',
      role: user.role,
      loginTime: user.last_login,
      isActive: user.is_active === 1,
      // Mock data for additional session info (in production, track these in a sessions table)
      ipAddress: '192.168.1.' + Math.floor(Math.random() * 255),
      device: 'Web Browser',
      lastActivity: user.last_login
    }));

    res.json({
      success: true,
      data: sessions
    });
  } catch (error) {
    next(error);
  }
};
