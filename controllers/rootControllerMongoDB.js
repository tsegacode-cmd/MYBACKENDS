import { getDatabaseStatus, autoFixDatabaseConnection } from '../config/databaseManager.js';
import { queryNeon } from '../config/neonDatabase.js';

const rootRequired = (req, res) => {
  if (req.user?.isRoot) return false;
  res.status(403).json({ success: false, message: 'Root access required' });
  return true;
};

const queryRows = async (sql, params = []) => (await queryNeon(sql, params)).rows;

export const getRootDashboardStatus = async (_req, res, next) => {
  try {
    const utilityTable = await queryRows("SELECT to_regclass('public.utility_payment_requests') AS table_name");
    const [result] = await queryRows(`
      SELECT
        (SELECT COUNT(*) FROM agent_products WHERE approval_status = 'pending') +
          (SELECT COUNT(*) FROM service_catalog_products WHERE approval_status = 'pending') AS pending_agent_products,
        (SELECT COUNT(*) FROM agent_package_requests WHERE status = 'pending') AS pending_package_requests,
        (SELECT COUNT(*) FROM boost_requests WHERE status = 'pending') AS pending_boost_requests,
        (SELECT COUNT(*) FROM clients WHERE LOWER(status) IN ('pending', 'pending_approval')) AS pending_partners,
        (SELECT COUNT(*) FROM service_catalog_products WHERE approval_status = 'pending') AS pending_services,
        (SELECT COUNT(*) FROM service_booking_requests WHERE status IN ('pending_approval', 'pending_payment')) AS pending_bookings,
        (SELECT COUNT(*) FROM service_booking_requests WHERE paymentstatus IN ('submitted', 'initiating', 'initiated')) AS pending_booking_payments,
        (SELECT COUNT(*) FROM agent_wallet_requests WHERE status = 'pending') +
          (SELECT COUNT(*) FROM wallet_deposits WHERE status = 'pending') +
          (SELECT COUNT(*) FROM wallet_withdrawals WHERE status = 'pending') AS pending_wallet_requests,
        (SELECT COUNT(*) FROM users WHERE created_at::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '60 seconds') AS new_users,
        (SELECT COUNT(*) FROM wallet_ledger
          WHERE amount > 0 AND created_at::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '60 seconds') +
        (SELECT COUNT(*) FROM platform_service_charge_ledger
          WHERE entry_type = 'service_charge'
            AND created_at::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '60 seconds') AS recent_income_count,
        (SELECT COALESCE(SUM(amount), 0) FROM wallet_ledger
          WHERE amount > 0 AND created_at::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '60 seconds') +
        (SELECT COALESCE(SUM(amount), 0) FROM platform_service_charge_ledger
          WHERE entry_type = 'service_charge'
            AND created_at::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '60 seconds') AS recent_income_amount
    `);
    const utilityPaymentCount = utilityTable[0]?.table_name
      ? Number((await queryRows("SELECT COUNT(*) AS count FROM utility_payment_requests WHERE status = 'request'"))[0].count)
      : 0;
    const number = key => Number(result[key] || 0);
    res.json({
      success: true,
      data: {
        badges: {
          users: number('new_users'),
          agents: number('pending_agent_products') + number('pending_package_requests'),
          'feed-management': number('pending_boost_requests'),
          finance: number('recent_income_count'),
          partners: number('pending_partners'),
          services: number('pending_services'),
          booked: number('pending_bookings'),
          payments: number('pending_booking_payments'),
          'utility-control': utilityPaymentCount,
          'wallet-management': number('pending_wallet_requests'),
          transactions: number('pending_wallet_requests'),
        },
        recentIncomeCount: number('recent_income_count'),
        recentIncomeAmount: number('recent_income_amount'),
        refreshedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getHealthStatus = async (_req, res, next) => {
  try {
    const dbStatus = getDatabaseStatus();
    const memory = process.memoryUsage();
    res.json({
      success: true,
      data: {
        server: {
          status: 'running',
          uptime: process.uptime(),
          memory: {
            used: Math.round(memory.heapUsed / 1024 / 1024),
            total: Math.round(memory.heapTotal / 1024 / 1024),
            unit: 'MB',
          },
        },
        database: {
          neon: {
            connected: dbStatus.neon?.connected || false,
            lastAttempt: dbStatus.neon?.lastAttempt || null,
            error: dbStatus.neon?.error || null,
          },
          primary: dbStatus.primaryDB,
        },
        timestamp: new Date(),
      },
    });
  } catch (error) {
    next(error);
  }
};

export const autoFixDatabase = async (_req, res, next) => {
  try {
    const results = await autoFixDatabaseConnection();
    const dbStatus = getDatabaseStatus();
    const success = Boolean(results.neon?.success);
    res.json({
      success,
      message: success ? 'Neon PostgreSQL connection restored successfully' : 'Could not restore the Neon PostgreSQL connection',
      data: { results, currentStatus: dbStatus },
    });
  } catch (error) {
    next(error);
  }
};

export const getDashboardStats = async (req, res, next) => {
  try {
    if (rootRequired(req, res)) return;
    const [stats] = await queryRows(`
      SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COUNT(*) FROM clients WHERE status = 'active') AS active_partners,
        (SELECT COALESCE(SUM(commission_amount), 0) FROM fixed_transactions WHERE status = 'completed') +
          (SELECT COALESCE(SUM(commission_amount), 0) FROM movable_transactions WHERE status = 'completed') AS total_revenue,
        (SELECT COUNT(*) FROM fixed_transactions WHERE status = 'pending') +
          (SELECT COUNT(*) FROM movable_transactions WHERE status = 'pending') AS pending_transactions
    `);
    res.json({
      success: true,
      data: {
        totalUsers: Number(stats.total_users),
        activePartners: Number(stats.active_partners),
        totalRevenue: Number(stats.total_revenue),
        pendingTransactions: Number(stats.pending_transactions),
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getRecentActivity = async (req, res, next) => {
  try {
    if (rootRequired(req, res)) return;
    const transactions = await queryRows(`
      SELECT t.status, t.commission_amount AS amount, t.created_at,
        COALESCE(NULLIF(c.company_name, ''), NULLIF(c.full_name, ''), 'Unknown') AS client_name
      FROM (
        SELECT client_id, status, commission_amount, created_at FROM fixed_transactions
        UNION ALL
        SELECT client_id, status, commission_amount, created_at FROM movable_transactions
      ) t
      LEFT JOIN clients c ON c._id = t.client_id
      ORDER BY t.created_at DESC
      LIMIT 5
    `);
    const users = await queryRows('SELECT email, username, created_at FROM users ORDER BY created_at DESC LIMIT 3');
    const clients = await queryRows('SELECT company_name, full_name, created_at FROM clients ORDER BY created_at DESC LIMIT 3');
    const activities = [
      ...transactions.map(item => ({
        icon: '💰',
        text: `Transaction ${item.status}: ${Number(item.amount || 0).toLocaleString()} - ${item.client_name}`,
        time: item.created_at,
        type: 'transaction',
      })),
      ...users.map(user => ({
        icon: '👤',
        text: `New user registered: ${user.email || user.username}`,
        time: user.created_at,
        type: 'user',
      })),
      ...clients.map(client => ({
        icon: '🤝',
        text: `New partnership created with ${client.company_name || client.full_name || 'Unknown'}`,
        time: client.created_at,
        type: 'partner',
      })),
    ];
    activities.sort((a, b) => new Date(b.time) - new Date(a.time));
    res.json({ success: true, data: activities.slice(0, 10) });
  } catch (error) {
    next(error);
  }
};

export const getAllUsers = async (req, res, next) => {
  try {
    if (rootRequired(req, res)) return;
    const users = await queryRows(`
      SELECT _id AS id, _id, username, email, full_name, role, position, phone, permissions,
        commission_settings, is_active, last_login, created_at, updated_at
      FROM users ORDER BY created_at DESC
    `);
    res.json({ success: true, data: users });
  } catch (error) {
    next(error);
  }
};

export const getAllPartners = async (req, res, next) => {
  try {
    if (rootRequired(req, res)) return;
    const partners = await queryRows('SELECT _id AS id, * FROM clients ORDER BY created_at DESC');
    res.json({ success: true, data: partners });
  } catch (error) {
    next(error);
  }
};

export const getAllTransactions = async (req, res, next) => {
  try {
    if (rootRequired(req, res)) return;
    const transactions = await queryRows(`
      SELECT t.*, c.company_name, u.full_name AS user_name
      FROM (
        SELECT _id, transaction_number, client_id, assigned_to AS user_id, commission_amount,
          status, transaction_date, payment_received, payment_status, created_at, 'fixed' AS category
        FROM fixed_transactions
        UNION ALL
        SELECT _id, transaction_number, client_id, assigned_to AS user_id, commission_amount,
          status, transaction_date, payment_received, payment_status, created_at, 'movable' AS category
        FROM movable_transactions
      ) t
      LEFT JOIN clients c ON c._id = t.client_id
      LEFT JOIN users u ON u._id = t.user_id
      ORDER BY t.created_at DESC
    `);
    res.json({ success: true, data: transactions });
  } catch (error) {
    next(error);
  }
};

export const getSystemLogs = async (req, res, next) => {
  try {
    if (rootRequired(req, res)) return;
    const dbStatus = getDatabaseStatus();
    const timestamp = new Date().toISOString();
    const databases = ['neon'];
    const databaseLogs = databases.map(database => {
      const status = dbStatus[database];
      const connected = Boolean(status?.connected);
      const isPrimary = dbStatus.primaryDB === database;
      return {
        id: `database-${database}`,
        level: connected ? 'info' : isPrimary ? 'error' : 'warning',
        message: `${database.toUpperCase()} ${connected ? 'connected' : 'disconnected'}${isPrimary ? ' (primary database)' : ''}${status?.error ? `: ${status.error}` : ''}`,
        timestamp: status?.lastAttempt ? new Date(status.lastAttempt).toISOString() : timestamp,
      };
    });
    const memory = process.memoryUsage();
    res.json({
      success: true,
      data: [
        {
          id: 'server-status',
          level: 'info',
          message: `Server running · uptime ${Math.floor(process.uptime() / 60)} minutes · memory ${Math.round(memory.heapUsed / 1024 / 1024)} MB`,
          timestamp,
        },
        ...databaseLogs,
        {
          id: 'primary-database',
          level: 'info',
          message: `Primary database: ${String(dbStatus.primaryDB || 'unknown').toUpperCase()}`,
          timestamp,
        },
      ],
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
  getSystemLogs,
};
