import { query } from '../config/database.js';

// Get dashboard statistics
export const getDashboardStats = async (req, res, next) => {
  try {
    const stats = {};

    // Active clients
    const [clientStats] = await query(
      'SELECT COUNT(*) as count FROM clients WHERE status = "active"'
    );
    stats.activeClients = clientStats.count;

    // Active contracts
    const [contractStats] = await query(
      'SELECT COUNT(*) as count FROM brokerage_contracts WHERE status = "active"'
    );
    stats.activeContracts = contractStats.count;

    // Pending transactions
    const [pendingFixed] = await query(
      'SELECT COUNT(*) as count FROM fixed_transactions WHERE status IN ("pending", "in_progress")'
    );
    const [pendingMovable] = await query(
      'SELECT COUNT(*) as count FROM movable_transactions WHERE status IN ("pending", "in_progress")'
    );
    stats.pendingTransactions = pendingFixed.count + pendingMovable.count;

    // Pending inquiries
    const [inquiryStats] = await query(
      'SELECT COUNT(*) as count FROM contact_inquiries WHERE status IN ("new", "in_progress")'
    );
    stats.pendingInquiries = inquiryStats.count;

    // Total pending payments
    const [pendingPaymentsFixed] = await query(
      'SELECT COALESCE(SUM(commission_amount - payment_received), 0) as total FROM fixed_transactions WHERE payment_status != "paid"'
    );
    const [pendingPaymentsMovable] = await query(
      'SELECT COALESCE(SUM(commission_amount - payment_received), 0) as total FROM movable_transactions WHERE payment_status != "paid"'
    );
    stats.totalPendingPayments = parseFloat(pendingPaymentsFixed.total) + parseFloat(pendingPaymentsMovable.total);

    // Current month revenue
    const [monthRevenueFixed] = await query(
      'SELECT COALESCE(SUM(commission_amount), 0) as total FROM fixed_transactions WHERE status = "completed" AND MONTH(transaction_date) = MONTH(CURDATE()) AND YEAR(transaction_date) = YEAR(CURDATE())'
    );
    const [monthRevenueMovable] = await query(
      'SELECT COALESCE(SUM(commission_amount), 0) as total FROM movable_transactions WHERE status = "completed" AND MONTH(transaction_date) = MONTH(CURDATE()) AND YEAR(transaction_date) = YEAR(CURDATE())'
    );
    stats.currentMonthRevenue = parseFloat(monthRevenueFixed.total) + parseFloat(monthRevenueMovable.total);

    // Total revenue (all time)
    const [totalRevenueFixed] = await query(
      'SELECT COALESCE(SUM(commission_amount), 0) as total FROM fixed_transactions WHERE status = "completed"'
    );
    const [totalRevenueMovable] = await query(
      'SELECT COALESCE(SUM(commission_amount), 0) as total FROM movable_transactions WHERE status = "completed"'
    );
    stats.totalRevenue = parseFloat(totalRevenueFixed.total) + parseFloat(totalRevenueMovable.total);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    next(error);
  }
};

// Get monthly revenue report
export const getMonthlyRevenue = async (req, res, next) => {
  try {
    const { year = new Date().getFullYear() } = req.query;

    const sql = `
      SELECT 
        DATE_FORMAT(transaction_date, '%Y-%m') AS month,
        'Fixed' AS category,
        COUNT(*) AS transactions,
        SUM(commission_amount) AS total_commission,
        SUM(payment_received) AS total_received,
        SUM(commission_amount - payment_received) AS pending_amount
      FROM fixed_transactions
      WHERE status = 'completed' AND YEAR(transaction_date) = ?
      GROUP BY DATE_FORMAT(transaction_date, '%Y-%m')

      UNION ALL

      SELECT 
        DATE_FORMAT(transaction_date, '%Y-%m') AS month,
        'Movable' AS category,
        COUNT(*) AS transactions,
        SUM(commission_amount) AS total_commission,
        SUM(payment_received) AS total_received,
        SUM(commission_amount - payment_received) AS pending_amount
      FROM movable_transactions
      WHERE status = 'completed' AND YEAR(transaction_date) = ?
      GROUP BY DATE_FORMAT(transaction_date, '%Y-%m')

      ORDER BY month DESC, category
    `;

    const revenue = await query(sql, [year, year]);

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
    const sql = `
      SELECT 
        u.id,
        u.full_name AS agent_name,
        u.role,
        COUNT(DISTINCT ft.id) AS fixed_transactions,
        COALESCE(SUM(ft.commission_amount), 0) AS fixed_commission,
        COUNT(DISTINCT mt.id) AS movable_transactions,
        COALESCE(SUM(mt.commission_amount), 0) AS movable_commission,
        COALESCE(SUM(ft.commission_amount), 0) + COALESCE(SUM(mt.commission_amount), 0) AS total_commission
      FROM users u
      LEFT JOIN fixed_transactions ft ON u.id = ft.assigned_to AND ft.status = 'completed'
      LEFT JOIN movable_transactions mt ON u.id = mt.assigned_to AND mt.status = 'completed'
      WHERE u.role IN ('agent', 'manager') AND u.is_active = TRUE
      GROUP BY u.id, u.full_name, u.role
      ORDER BY total_commission DESC
    `;

    const performance = await query(sql);

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
    const sql = `
      SELECT 
        st.id,
        st.service_name,
        st.category,
        COUNT(DISTINCT CASE WHEN st.category = 'fixed' THEN ft.id END) AS fixed_count,
        COUNT(DISTINCT CASE WHEN st.category = 'movable' THEN mt.id END) AS movable_count,
        COALESCE(SUM(ft.commission_amount), 0) + COALESCE(SUM(mt.commission_amount), 0) AS total_commission
      FROM service_types st
      LEFT JOIN fixed_transactions ft ON st.id = ft.service_type_id AND ft.status = 'completed'
      LEFT JOIN movable_transactions mt ON st.id = mt.service_type_id AND mt.status = 'completed'
      WHERE st.is_active = TRUE
      GROUP BY st.id, st.service_name, st.category
      ORDER BY total_commission DESC
    `;

    const performance = await query(sql);

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
    const { limit = 10 } = req.query;

    const sql = `
      SELECT 
        'fixed_transaction' AS activity_type,
        ft.id,
        ft.transaction_number AS reference,
        c.full_name AS client_name,
        ft.commission_amount,
        ft.status,
        ft.created_at
      FROM fixed_transactions ft
      JOIN clients c ON ft.client_id = c.id

      UNION ALL

      SELECT 
        'movable_transaction' AS activity_type,
        mt.id,
        mt.transaction_number AS reference,
        c.full_name AS client_name,
        mt.commission_amount,
        mt.status,
        mt.created_at
      FROM movable_transactions mt
      JOIN clients c ON mt.client_id = c.id

      UNION ALL

      SELECT 
        'contract' AS activity_type,
        bc.id,
        bc.contract_number AS reference,
        c.full_name AS client_name,
        bc.commission_amount,
        bc.status,
        bc.created_at
      FROM brokerage_contracts bc
      JOIN clients c ON bc.client_id = c.id

      ORDER BY created_at DESC
      LIMIT ?
    `;

    const activities = await query(sql, [parseInt(limit)]);

    res.json({
      success: true,
      data: activities
    });
  } catch (error) {
    next(error);
  }
};
