import { getMongoDB } from '../config/databaseManager.js';
import { ObjectId } from 'mongodb';

/**
 * MongoDB-only Transaction Controller
 * All data persists to MongoDB - no MySQL fallback
 */

// Get MongoDB collections
const getFixedTransactionsCollection = () => {
  const db = getMongoDB();
  return db.collection('fixed_transactions');
};

const getMovableTransactionsCollection = () => {
  const db = getMongoDB();
  return db.collection('movable_transactions');
};

// Get all transactions (fixed and movable combined)
export const getAllTransactions = async (req, res, next) => {
  try {
    const { type, status, payment_status, page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    let transactions = [];

    if (!type || type === 'fixed') {
      const fixedTransactions = getFixedTransactionsCollection();
      const query = {};
      if (status) query.status = status;
      if (payment_status) query.payment_status = payment_status;

      const fixed = await fixedTransactions
        .find(query)
        .sort({ transaction_date: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .toArray();

      transactions = [...transactions, ...fixed.map(t => ({ ...t, transaction_type: 'fixed' }))];
    }

    if (!type || type === 'movable') {
      const movableTransactions = getMovableTransactionsCollection();
      const query = {};
      if (status) query.status = status;
      if (payment_status) query.payment_status = payment_status;

      const movable = await movableTransactions
        .find(query)
        .sort({ transaction_date: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .toArray();

      transactions = [...transactions, ...movable.map(t => ({ ...t, transaction_type: 'movable' }))];
    }

    // Sort by date
    transactions.sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date));

    res.json({
      success: true,
      data: transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    next(error);
  }
};

// Get fixed transaction by ID
export const getFixedTransactionById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const fixedTransactions = getFixedTransactionsCollection();

    const transaction = await fixedTransactions.findOne({ _id: new ObjectId(id) });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      data: transaction
    });
  } catch (error) {
    next(error);
  }
};

// Get movable transaction by ID
export const getMovableTransactionById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const movableTransactions = getMovableTransactionsCollection();

    const transaction = await movableTransactions.findOne({ _id: new ObjectId(id) });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      data: transaction
    });
  } catch (error) {
    next(error);
  }
};

// Create fixed transaction
export const createFixedTransaction = async (req, res, next) => {
  try {
    const {
      transaction_number,
      contract_id,
      client_id,
      service_type_id,
      property_type,
      property_address,
      property_area,
      area_unit,
      sale_price,
      commission_amount,
      commission_percentage,
      currency,
      transaction_date,
      payment_received,
      payment_status,
      status,
      notes,
      assigned_to
    } = req.body;

    const fixedTransactions = getFixedTransactionsCollection();

    const newTransaction = {
      transaction_number,
      contract_id: contract_id || null,
      client_id,
      service_type_id,
      property_type,
      property_address,
      property_area: property_area || null,
      area_unit: area_unit || 'sqm',
      sale_price,
      commission_amount,
      commission_percentage: commission_percentage || null,
      currency: currency || 'SDG',
      transaction_date: new Date(transaction_date),
      payment_received: payment_received || 0,
      payment_status: payment_status || 'pending',
      status: status || 'pending',
      notes: notes || null,
      assigned_to: assigned_to || null,
      created_by: req.user?.id || null,
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await fixedTransactions.insertOne(newTransaction);

    res.status(201).json({
      success: true,
      message: 'Fixed transaction created successfully',
      data: { id: result.insertedId }
    });
  } catch (error) {
    next(error);
  }
};

// Create movable transaction
export const createMovableTransaction = async (req, res, next) => {
  try {
    const {
      transaction_number,
      contract_id,
      client_id,
      service_type_id,
      item_type,
      item_description,
      item_specifications,
      quantity,
      unit_price,
      total_value,
      commission_amount,
      commission_percentage,
      currency,
      transaction_date,
      payment_received,
      payment_status,
      status,
      notes,
      assigned_to
    } = req.body;

    const movableTransactions = getMovableTransactionsCollection();

    const newTransaction = {
      transaction_number,
      contract_id: contract_id || null,
      client_id,
      service_type_id,
      item_type,
      item_description,
      item_specifications: item_specifications || null,
      quantity: quantity || 1,
      unit_price: unit_price || null,
      total_value,
      commission_amount,
      commission_percentage: commission_percentage || null,
      currency: currency || 'SDG',
      transaction_date: new Date(transaction_date),
      payment_received: payment_received || 0,
      payment_status: payment_status || 'pending',
      status: status || 'pending',
      notes: notes || null,
      assigned_to: assigned_to || null,
      created_by: req.user?.id || null,
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await movableTransactions.insertOne(newTransaction);

    res.status(201).json({
      success: true,
      message: 'Movable transaction created successfully',
      data: { id: result.insertedId }
    });
  } catch (error) {
    next(error);
  }
};

// Update fixed transaction
export const updateFixedTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const allowedFields = [
      'property_type', 'property_address', 'property_area', 'area_unit',
      'sale_price', 'commission_amount', 'commission_percentage',
      'payment_received', 'payment_status', 'status', 'notes', 'assigned_to'
    ];

    const updateDoc = { updated_at: new Date() };

    Object.keys(updates).forEach(key => {
      if (allowedFields.includes(key)) {
        updateDoc[key] = updates[key];
      }
    });

    if (Object.keys(updateDoc).length === 1) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    const fixedTransactions = getFixedTransactionsCollection();
    const result = await fixedTransactions.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateDoc }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      message: 'Transaction updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// Update movable transaction
export const updateMovableTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const allowedFields = [
      'item_type', 'item_description', 'item_specifications', 'quantity',
      'unit_price', 'total_value', 'commission_amount', 'commission_percentage',
      'payment_received', 'payment_status', 'status', 'notes', 'assigned_to'
    ];

    const updateDoc = { updated_at: new Date() };

    Object.keys(updates).forEach(key => {
      if (allowedFields.includes(key)) {
        updateDoc[key] = updates[key];
      }
    });

    if (Object.keys(updateDoc).length === 1) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    const movableTransactions = getMovableTransactionsCollection();
    const result = await movableTransactions.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateDoc }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      message: 'Transaction updated successfully'
    });
  } catch (error) {
    next(error);
  }
};
