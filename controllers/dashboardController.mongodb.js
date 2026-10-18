import { getMongoDB, isMongoDBAvailable } from '../config/databaseManager.js';

// Get dashboard statistics
export const getDashboardStats = async (req, res, next) => {
  try {
    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available',
        data: {
          activeClients: 0,
          activeContracts: 0,
          pendingTransactions: 0,
          pendingInquiries: 0,
          totalPendingPayments: 0,
          currentMonthRevenue: 0,
          totalRevenue: 0
        }
      });
    }

    const db = getMongoDB();
    const stats = {};

    // Active clients
    stats.activeClients = await db.collection('clients').countDocuments({ status: 'active' });

    // Active contracts
    stats.activeContracts = await db.collection('brokerage_contracts').countDocuments({ status: 'active' });

    // Pending transactions
    const pendingFixed = await db.collection('fixed_transactions').countDocuments({
      status: { $in: ['pending', 'in_progress'] }
    });
    const pendingMovable = await db.collection('movable_transactions').countDocuments({
      status: { $in: ['pending', 'in_progress'] }
    });
    stats.pendingTransactions = pendingFixed + pendingMovable;

    // Pending inquiries
    stats.pendingInquiries = await db.collection('contact_inquiries').countDocuments({
      status: { $in: ['new', 'in_progress'] }
    });

    // Total pending payments
    const pendingPaymentsFixed = await db.collection('fixed_transactions').aggregate([
      { $match: { payment_status: { $ne: 'paid' } } },
      { $group: { _id: null, total: { $sum: { $subtract: ['$commission_amount', '$payment_received'] } } } }
    ]).toArray();

    const pendingPaymentsMovable = await db.collection('movable_transactions').aggregate([
      { $match: { payment_status: { $ne: 'paid' } } },
      { $group: { _id: null, total: { $sum: { $subtract: ['$commission_amount', '$payment_received'] } } } }
    ]).toArray();

    stats.totalPendingPayments = 
      (pendingPaymentsFixed[0]?.total || 0) + 
      (pendingPaymentsMovable[0]?.total || 0);

    // Current month revenue
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const monthRevenueFixed = await db.collection('fixed_transactions').aggregate([
      {
        $match: {
          status: 'completed',
          transaction_date: { $gte: startOfMonth, $lte: endOfMonth }
        }
      },
      { $group: { _id: null, total: { $sum: '$commission_amount' } } }
    ]).toArray();

    const monthRevenueMovable = await db.collection('movable_transactions').aggregate([
      {
        $match: {
          status: 'completed',
          transaction_date: { $gte: startOfMonth, $lte: endOfMonth }
        }
      },
      { $group: { _id: null, total: { $sum: '$commission_amount' } } }
    ]).toArray();

    stats.currentMonthRevenue = 
      (monthRevenueFixed[0]?.total || 0) + 
      (monthRevenueMovable[0]?.total || 0);

    // Total revenue (all time)
    const totalRevenueFixed = await db.collection('fixed_transactions').aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$commission_amount' } } }
    ]).toArray();

    const totalRevenueMovable = await db.collection('movable_transactions').aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$commission_amount' } } }
    ]).toArray();

    stats.totalRevenue = 
      (totalRevenueFixed[0]?.total || 0) + 
      (totalRevenueMovable[0]?.total || 0);

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
    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available',
        data: []
      });
    }

    const { year = new Date().getFullYear() } = req.query;
    const db = getMongoDB();

    const startOfYear = new Date(parseInt(year), 0, 1);
    const endOfYear = new Date(parseInt(year), 11, 31, 23, 59, 59);

    // Fixed transactions
    const fixedRevenue = await db.collection('fixed_transactions').aggregate([
      {
        $match: {
          status: 'completed',
          transaction_date: { $gte: startOfYear, $lte: endOfYear }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$transaction_date' },
            month: { $month: '$transaction_date' }
          },
          category: { $first: 'Fixed' },
          transactions: { $sum: 1 },
          total_commission: { $sum: '$commission_amount' },
          total_received: { $sum: '$payment_received' },
          pending_amount: { $sum: { $subtract: ['$commission_amount', '$payment_received'] } }
        }
      },
      {
        $project: {
          month: {
            $concat: [
              { $toString: '$_id.year' },
              '-',
              { $cond: [{ $lt: ['$_id.month', 10] }, { $concat: ['0', { $toString: '$_id.month' }] }, { $toString: '$_id.month' }] }
            ]
          },
          category: 1,
          transactions: 1,
          total_commission: 1,
          total_received: 1,
          pending_amount: 1
        }
      }
    ]).toArray();

    // Movable transactions
    const movableRevenue = await db.collection('movable_transactions').aggregate([
      {
        $match: {
          status: 'completed',
          transaction_date: { $gte: startOfYear, $lte: endOfYear }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$transaction_date' },
            month: { $month: '$transaction_date' }
          },
          category: { $first: 'Movable' },
          transactions: { $sum: 1 },
          total_commission: { $sum: '$commission_amount' },
          total_received: { $sum: '$payment_received' },
          pending_amount: { $sum: { $subtract: ['$commission_amount', '$payment_received'] } }
        }
      },
      {
        $project: {
          month: {
            $concat: [
              { $toString: '$_id.year' },
              '-',
              { $cond: [{ $lt: ['$_id.month', 10] }, { $concat: ['0', { $toString: '$_id.month' }] }, { $toString: '$_id.month' }] }
            ]
          },
          category: 1,
          transactions: 1,
          total_commission: 1,
          total_received: 1,
          pending_amount: 1
        }
      }
    ]).toArray();

    const revenue = [...fixedRevenue, ...movableRevenue].sort((a, b) => {
      if (a.month > b.month) return -1;
      if (a.month < b.month) return 1;
      return a.category.localeCompare(b.category);
    });

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
    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available',
        data: []
      });
    }

    const db = getMongoDB();

    // Get all agents and managers
    const agents = await db.collection('users').find({
      role: { $in: ['agent', 'manager'] },
      is_active: true
    }).toArray();

    const performance = [];

    for (const agent of agents) {
      // Fixed transactions
      const fixedStats = await db.collection('fixed_transactions').aggregate([
        { $match: { assigned_to: agent._id, status: 'completed' } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            commission: { $sum: '$commission_amount' }
          }
        }
      ]).toArray();

      // Movable transactions
      const movableStats = await db.collection('movable_transactions').aggregate([
        { $match: { assigned_to: agent._id, status: 'completed' } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            commission: { $sum: '$commission_amount' }
          }
        }
      ]).toArray();

      const fixedCount = fixedStats[0]?.count || 0;
      const fixedCommission = fixedStats[0]?.commission || 0;
      const movableCount = movableStats[0]?.count || 0;
      const movableCommission = movableStats[0]?.commission || 0;

      performance.push({
        id: agent._id,
        agent_name: agent.full_name,
        role: agent.role,
        fixed_transactions: fixedCount,
        fixed_commission: fixedCommission,
        movable_transactions: movableCount,
        movable_commission: movableCommission,
        total_commission: fixedCommission + movableCommission
      });
    }

    // Sort by total commission
    performance.sort((a, b) => b.total_commission - a.total_commission);

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
    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available',
        data: []
      });
    }

    const db = getMongoDB();

    // Get all active service types
    const serviceTypes = await db.collection('service_types').find({
      is_active: true
    }).toArray();

    const performance = [];

    for (const service of serviceTypes) {
      let fixedCount = 0;
      let movableCount = 0;
      let totalCommission = 0;

      if (service.category === 'fixed') {
        const fixedStats = await db.collection('fixed_transactions').aggregate([
          { $match: { service_type_id: service._id, status: 'completed' } },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              commission: { $sum: '$commission_amount' }
            }
          }
        ]).toArray();

        fixedCount = fixedStats[0]?.count || 0;
        totalCommission = fixedStats[0]?.commission || 0;
      } else if (service.category === 'movable') {
        const movableStats = await db.collection('movable_transactions').aggregate([
          { $match: { service_type_id: service._id, status: 'completed' } },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              commission: { $sum: '$commission_amount' }
            }
          }
        ]).toArray();

        movableCount = movableStats[0]?.count || 0;
        totalCommission = movableStats[0]?.commission || 0;
      }

      performance.push({
        id: service._id,
        service_name: service.service_name,
        category: service.category,
        fixed_count: fixedCount,
        movable_count: movableCount,
        total_commission: totalCommission
      });
    }

    // Sort by total commission
    performance.sort((a, b) => b.total_commission - a.total_commission);

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
    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available',
        data: []
      });
    }

    const { limit = 10 } = req.query;
    const db = getMongoDB();

    const activities = [];

    // Fixed transactions
    const fixedTransactions = await db.collection('fixed_transactions')
      .find()
      .sort({ created_at: -1 })
      .limit(parseInt(limit))
      .toArray();

    for (const ft of fixedTransactions) {
      const client = await db.collection('clients').findOne({ _id: ft.client_id });
      activities.push({
        activity_type: 'fixed_transaction',
        id: ft._id,
        reference: ft.transaction_number,
        client_name: client?.full_name || 'Unknown',
        commission_amount: ft.commission_amount,
        status: ft.status,
        created_at: ft.created_at
      });
    }

    // Movable transactions
    const movableTransactions = await db.collection('movable_transactions')
      .find()
      .sort({ created_at: -1 })
      .limit(parseInt(limit))
      .toArray();

    for (const mt of movableTransactions) {
      const client = await db.collection('clients').findOne({ _id: mt.client_id });
      activities.push({
        activity_type: 'movable_transaction',
        id: mt._id,
        reference: mt.transaction_number,
        client_name: client?.full_name || 'Unknown',
        commission_amount: mt.commission_amount,
        status: mt.status,
        created_at: mt.created_at
      });
    }

    // Contracts
    const contracts = await db.collection('brokerage_contracts')
      .find()
      .sort({ created_at: -1 })
      .limit(parseInt(limit))
      .toArray();

    for (const bc of contracts) {
      const client = await db.collection('clients').findOne({ _id: bc.client_id });
      activities.push({
        activity_type: 'contract',
        id: bc._id,
        reference: bc.contract_number,
        client_name: client?.full_name || 'Unknown',
        commission_amount: bc.commission_amount,
        status: bc.status,
        created_at: bc.created_at
      });
    }

    // Sort by created_at and limit
    activities.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const limitedActivities = activities.slice(0, parseInt(limit));

    res.json({
      success: true,
      data: limitedActivities
    });
  } catch (error) {
    next(error);
  }
};
