import { queryNeon } from '../config/neonDatabase.js';

const normalizeNumericFields = result => {
  for (const row of result.rows) {
    for (const field of result.fields) {
      if (![20, 1700].includes(field.dataTypeID) || typeof row[field.name] !== 'string') continue;
      const value = Number(row[field.name]);
      if (Number.isFinite(value) && (field.dataTypeID === 1700 || Number.isSafeInteger(value))) {
        row[field.name] = value;
      }
    }
  }
  return result.rows;
};

const queryRows = async (sql, params = []) =>
  normalizeNumericFields(await queryNeon(sql, params));

// Get dashboard statistics (Fixed with Promise.all to completely avoid syntax/parenthesis errors)
export const getDashboardStats = async (req, res, next) => {
  try {
    const [
      activeClientsRes,
      activeContractsRes,
      pendingFixedRes,
      pendingMovableRes,
      pendingInquiriesRes,
      pendingFixedPayRes,
      pendingMovablePayRes,
      currentMonthFixedRevRes,
      currentMonthMovableRevRes,
      totalFixedRevRes,
      totalMovableRevRes
    ] = await Promise.all([
      queryNeon("SELECT COUNT(*) FROM clients WHERE status = 'active'"),
      queryNeon("SELECT COUNT(*) FROM brokerage_contracts WHERE status = 'active'"),
      queryNeon("SELECT COUNT(*) FROM fixed_transactions WHERE status IN ('pending', 'in_progress')"),
      queryNeon("SELECT COUNT(*) FROM movable_transactions WHERE status IN ('pending', 'in_progress')"),
      queryNeon("SELECT COUNT(*) FROM contact_inquiries WHERE status IN ('new', 'in_progress')"),
      queryNeon("SELECT COALESCE(SUM(commission_amount - payment_received), 0) FROM fixed_transactions WHERE payment_status <> 'paid'"),
      queryNeon("SELECT COALESCE(SUM(commission_amount - payment_received), 0) FROM movable_transactions WHERE payment_status <> 'paid'"),
      queryNeon("SELECT COALESCE(SUM(commission_amount), 0) FROM fixed_transactions WHERE status = 'completed' AND NULLIF(transaction_date, '')::timestamp >= date_trunc('month', CURRENT_TIMESTAMP) AND NULLIF(transaction_date, '')::timestamp < date_trunc('month', CURRENT_TIMESTAMP) + INTERVAL '1 month'"),
      queryNeon("SELECT COALESCE(SUM(commission_amount), 0) FROM movable_transactions WHERE status = 'completed' AND NULLIF(transaction_date, '')::timestamp >= date_trunc('month', CURRENT_TIMESTAMP) AND NULLIF(transaction_date, '')::timestamp < date_trunc('month', CURRENT_TIMESTAMP) + INTERVAL '1 month'"),
      queryNeon("SELECT COALESCE(SUM(commission_amount), 0) FROM fixed_transactions WHERE status = 'completed'"),
      queryNeon("SELECT COALESCE(SUM(commission_amount), 0) FROM movable_transactions WHERE status = 'completed'")
    ]);

    const activeClients = Number(activeClientsRes.rows[0]?.count || 0);
    const activeContracts = Number(activeContractsRes.rows[0]?.count || 0);
    const pendingTransactions = Number(pendingFixedRes.rows[0]?.count || 0) + Number(pendingMovableRes.rows[0]?.count || 0);
    const pendingInquiries = Number(pendingInquiriesRes.rows[0]?.count || 0);
    const totalPendingPayments = Number(pendingFixedPayRes.rows[0]?.coalesce || 0) + Number(pendingMovablePayRes.rows[0]?.coalesce || 0);
    const currentMonthRevenue = Number(currentMonthFixedRevRes.rows[0]?.coalesce || 0) + Number(currentMonthMovableRevRes.rows[0]?.coalesce || 0);
    const totalRevenue = Number(totalFixedRevRes.rows[0]?.coalesce || 0) + Number(totalMovableRevRes.rows[0]?.coalesce || 0);

    res.json({
      success: true,
      data: {
        activeClients,
        activeContracts,
        pendingTransactions,
        pendingInquiries,
        totalPendingPayments,
        currentMonthRevenue,
        totalRevenue,
      }
    });
  } catch (error) {
    console.error('❌ Get dashboard stats error:', error.message);
    next(error);
  }
};

// Get dashboard status (Added to fix 500 error on dashboard-status API)
export const getDashboardStatus = async (req, res, next) => {
  try {
    const totalUsersResult = await queryRows('SELECT COUNT(*) as count FROM users');
    const totalUsers = Number(totalUsersResult[0]?.count || 0);

    const pendingTransactionsResult = await queryRows(`
      SELECT 
        (SELECT COUNT(*) FROM fixed_transactions WHERE status = 'pending') +
        (SELECT COUNT(*) FROM movable_transactions WHERE status = 'pending') as count
    `);
    const pendingTransactions = Number(pendingTransactionsResult[0]?.count || 0);

    res.json({
      success: true,
      data: {
        totalUsers,
        pendingTransactions,
        status: 'active'
      }
    });
  } catch (error) {
    console.error('❌ Get dashboard status error:', error.message);
    next(error);
  }
};

// Get monthly revenue report
export const getMonthlyRevenue = async (req, res, next) => {
  try {
    const year = Number.parseInt(req.query.year ?? new Date().getFullYear(), 10);
    if (!Number.isInteger(year) || year < 1 || year > 9999) {
      return res.status(400).json({ success: false, message: 'Choose a valid year.' });
    }

    const revenue = await queryRows(`
      SELECT
        TO_CHAR(NULLIF(transaction_date, '')::timestamp, 'YYYY-MM') AS month,
        'Fixed' AS category,
        COUNT(*) AS transactions,
        SUM(commission_amount) AS total_commission,
        SUM(payment_received) AS total_received,
        SUM(commission_amount - payment_received) AS pending_amount
      FROM fixed_transactions
      WHERE status = 'completed' AND EXTRACT(YEAR FROM NULLIF(transaction_date, '')::timestamp) = $1
      GROUP BY TO_CHAR(NULLIF(transaction_date, '')::timestamp, 'YYYY-MM')

      UNION ALL

      SELECT
        TO_CHAR(NULLIF(transaction_date, '')::timestamp, 'YYYY-MM') AS month,
        'Movable' AS category,
        COUNT(*) AS transactions,
        SUM(commission_amount) AS total_commission,
        SUM(payment_received) AS total_received,
        SUM(commission_amount - payment_received) AS pending_amount
      FROM movable_transactions
      WHERE status = 'completed' AND EXTRACT(YEAR FROM NULLIF(transaction_date, '')::timestamp) = $1
      GROUP BY TO_CHAR(NULLIF(transaction_date, '')::timestamp, 'YYYY-MM')

      ORDER BY month DESC, category
    `, [year]);

    res.json({
      success: true,
      data: revenue
    });
  } catch (error) {
    next(error);
  }
};

// Get agent performance
export const getAgentPerformance = async (req, res, next) => {
  try {
    const performance = await queryRows(`
      WITH fixed_totals AS (
        SELECT assigned_to, COUNT(*) AS transaction_count,
          COALESCE(SUM(commission_amount), 0) AS commission
        FROM fixed_transactions
        WHERE status = 'completed' AND assigned_to IS NOT NULL
        GROUP BY assigned_to
      ),
      movable_totals AS (
        SELECT assigned_to, COUNT(*) AS transaction_count,
          COALESCE(SUM(commission_amount), 0) AS commission
        FROM movable_transactions
        WHERE status = 'completed' AND assigned_to IS NOT NULL
        GROUP BY assigned_to
      )
      SELECT
        u._id AS id,
        u.full_name AS agent_name,
        u.role,
        COALESCE(ft.transaction_count, 0) AS fixed_transactions,
        COALESCE(ft.commission, 0) AS fixed_commission,
        COALESCE(mt.transaction_count, 0) AS movable_transactions,
        COALESCE(mt.commission, 0) AS movable_commission,
        COALESCE(ft.commission, 0) + COALESCE(mt.commission, 0) AS total_commission
      FROM users u
      LEFT JOIN fixed_totals ft ON u._id = ft.assigned_to
      LEFT JOIN movable_totals mt ON u._id = mt.assigned_to
      WHERE u.role IN ('agent', 'manager') AND (u.is_active = 1 OR u.is_active IS TRUE)
      ORDER BY total_commission DESC
    `);

    res.json({
      success: true,
      data: performance
    });
  } catch (error) {
    next(error);
  }
};

// Get service type performance
export const getServicePerformance = async (req, res, next) => {
  try {
    const performance = await queryRows(`
      WITH fixed_totals AS (
        SELECT service_type_id, COUNT(*) AS transaction_count,
          COALESCE(SUM(commission_amount), 0) AS commission
        FROM fixed_transactions
        WHERE status = 'completed' AND service_type_id IS NOT NULL
        GROUP BY service_type_id
      ),
      movable_totals AS (
        SELECT service_type_id, COUNT(*) AS transaction_count,
          COALESCE(SUM(commission_amount), 0) AS commission
        FROM movable_transactions
        WHERE status = 'completed' AND service_type_id IS NOT NULL
        GROUP BY service_type_id
      )
      SELECT
        st._id AS id,
        st.service_name,
        st.category,
        CASE WHEN st.category = 'fixed' THEN COALESCE(ft.transaction_count, 0) ELSE 0 END AS fixed_count,
        CASE WHEN st.category = 'movable' THEN COALESCE(mt.transaction_count, 0) ELSE 0 END AS movable_count,
        COALESCE(ft.commission, 0) + COALESCE(mt.commission, 0) AS total_commission
      FROM service_types st
      LEFT JOIN fixed_totals ft ON st._id = ft.service_type_id
      LEFT JOIN movable_totals mt ON st._id = mt.service_type_id
      WHERE (st.is_active = 1 OR st.is_active IS TRUE)
      ORDER BY total_commission DESC
    `);

    res.json({
      success: true,
      data: performance
    });
  } catch (error) {
    next(error);
  }
};

// Get recent activities
export const getRecentActivities = async (req, res, next) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit ?? 10, 10);
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 10;

    const activities = await queryRows(`
      SELECT
        'fixed_transaction' AS activity_type,
        ft._id AS id,
        ft.transaction_number AS reference,
        c.full_name AS client_name,
        ft.commission_amount,
        ft.status,
        ft.created_at
      FROM fixed_transactions ft
      JOIN clients c ON ft.client_id = c._id

      UNION ALL

      SELECT
        'movable_transaction' AS activity_type,
        mt._id AS id,
        mt.transaction_number AS reference,
        c.full_name AS client_name,
        mt.commission_amount,
        mt.status,
        mt.created_at
      FROM movable_transactions mt
      JOIN clients c ON mt.client_id = c._id

      UNION ALL

      SELECT
        'contract' AS activity_type,
        bc._id AS id,
        bc.contract_number AS reference,
        c.full_name AS client_name,
        bc.commission_amount,
        bc.status,
        bc.created_at
      FROM brokerage_contracts bc
      JOIN clients c ON bc.client_id = c._id

      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);

    res.json({
      success: true,
      data: activities
    });
  } catch (error) {
    next(error);
  }
};
