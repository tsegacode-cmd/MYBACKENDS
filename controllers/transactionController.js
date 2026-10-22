import { queryNeon } from '../config/neonDatabase.js';

const queryRows = async (sql, params = []) => (await queryNeon(sql, params)).rows;

// Get all transactions (fixed and movable combined)
export const getAllTransactions = async (req, res, next) => {
  try {
    const { type, status, payment_status, page = 1, limit = 10 } = req.query;
    const normalizedPage = Math.max(1, Number.parseInt(page, 10) || 1);
    const normalizedLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 10));
    const offset = (normalizedPage - 1) * normalizedLimit;

    let transactions = [];

    if (!type || type === 'fixed') {
      const fixedSql = `
        SELECT 
          'fixed' AS transaction_type,
          ft.*,
          c.full_name AS client_name,
          c.phone AS client_phone,
          st.service_name,
          u.full_name AS assigned_agent
        FROM fixed_transactions ft
        JOIN clients c ON ft.client_id = c._id
        JOIN service_types st ON ft.service_type_id = st._id
        LEFT JOIN users u ON ft.assigned_to = u._id
        WHERE 1=1
        ${status ? 'AND ft.status = ?' : ''}
        ${payment_status ? 'AND ft.payment_status = ?' : ''}
        ORDER BY ft.transaction_date DESC
        LIMIT ? OFFSET ?
      `;

      const params = [];
      if (status) params.push(status);
      if (payment_status) params.push(payment_status);
      params.push(normalizedLimit, offset);

      const fixed = await queryRows(fixedSql, params);
      transactions = [...transactions, ...fixed];
    }

    if (!type || type === 'movable') {
      const movableSql = `
        SELECT 
          'movable' AS transaction_type,
          mt.*,
          c.full_name AS client_name,
          c.phone AS client_phone,
          st.service_name,
          u.full_name AS assigned_agent
        FROM movable_transactions mt
        JOIN clients c ON mt.client_id = c._id
        JOIN service_types st ON mt.service_type_id = st._id
        LEFT JOIN users u ON mt.assigned_to = u._id
        WHERE 1=1
        ${status ? 'AND mt.status = ?' : ''}
        ${payment_status ? 'AND mt.payment_status = ?' : ''}
        ORDER BY mt.transaction_date DESC
        LIMIT ? OFFSET ?
      `;

      const params = [];
      if (status) params.push(status);
      if (payment_status) params.push(payment_status);
      params.push(normalizedLimit, offset);

      const movable = await queryRows(movableSql, params);
      transactions = [...transactions, ...movable];
    }

    // Sort by date
    transactions.sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date));

    res.json({
      success: true,
      data: transactions,
      pagination: {
        page: normalizedPage,
        limit: normalizedLimit
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

    const sql = `
      SELECT 
        ft.*,
        c.full_name AS client_name,
        c.phone AS client_phone,
        c.email AS client_email,
        st.service_name,
        u.full_name AS assigned_agent,
        creator.full_name AS created_by_name
      FROM fixed_transactions ft
      JOIN clients c ON ft.client_id = c._id
      JOIN service_types st ON ft.service_type_id = st._id
      LEFT JOIN users u ON ft.assigned_to = u._id
      LEFT JOIN users creator ON ft.created_by = creator._id
      WHERE ft._id = ?
    `;

    const transactions = await queryRows(sql, [id]);

    if (transactions.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      data: transactions[0]
    });
  } catch (error) {
    next(error);
  }
};

// Get movable transaction by ID
export const getMovableTransactionById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const sql = `
      SELECT 
        mt.*,
        c.full_name AS client_name,
        c.phone AS client_phone,
        c.email AS client_email,
        st.service_name,
        u.full_name AS assigned_agent,
        creator.full_name AS created_by_name
      FROM movable_transactions mt
      JOIN clients c ON mt.client_id = c._id
      JOIN service_types st ON mt.service_type_id = st._id
      LEFT JOIN users u ON mt.assigned_to = u._id
      LEFT JOIN users creator ON mt.created_by = creator._id
      WHERE mt._id = ?
    `;

    const transactions = await queryRows(sql, [id]);

    if (transactions.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    res.json({
      success: true,
      data: transactions[0]
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

    const sql = `
      INSERT INTO fixed_transactions (
        transaction_number, contract_id, client_id, service_type_id,
        property_type, property_address, property_area, area_unit,
        sale_price, commission_amount, commission_percentage, currency,
        transaction_date, payment_received, payment_status, status,
        notes, assigned_to, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING _id
    `;

    const [result] = await queryRows(sql, [
      transaction_number,
      contract_id || null,
      client_id,
      service_type_id,
      property_type,
      property_address,
      property_area || null,
      area_unit || 'sqm',
      sale_price,
      commission_amount,
      commission_percentage || null,
      currency || 'SDG',
      transaction_date,
      payment_received || 0,
      payment_status || 'pending',
      status || 'pending',
      notes || null,
      assigned_to || null,
      req.user.id
    ]);

    res.status(201).json({
      success: true,
      message: 'Fixed transaction created successfully',
      data: { id: result._id }
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

    const sql = `
      INSERT INTO movable_transactions (
        transaction_number, contract_id, client_id, service_type_id,
        item_type, item_description, item_specifications, quantity,
        unit_price, total_value, commission_amount, commission_percentage,
        currency, transaction_date, payment_received, payment_status,
        status, notes, assigned_to, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING _id
    `;

    const [result] = await queryRows(sql, [
      transaction_number,
      contract_id || null,
      client_id,
      service_type_id,
      item_type,
      item_description,
      item_specifications || null,
      quantity || 1,
      unit_price || null,
      total_value,
      commission_amount,
      commission_percentage || null,
      currency || 'SDG',
      transaction_date,
      payment_received || 0,
      payment_status || 'pending',
      status || 'pending',
      notes || null,
      assigned_to || null,
      req.user.id
    ]);

    res.status(201).json({
      success: true,
      message: 'Movable transaction created successfully',
      data: { id: result._id }
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

    const fields = [];
    const values = [];

    Object.keys(updates).forEach(key => {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = ?`);
        values.push(updates[key]);
      }
    });

    if (fields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    values.push(id);

    const sql = `UPDATE fixed_transactions SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP::text WHERE _id = ?`;
    const { rowCount } = await queryNeon(sql, values);

    if (rowCount === 0) {
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

    const fields = [];
    const values = [];

    Object.keys(updates).forEach(key => {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = ?`);
        values.push(updates[key]);
      }
    });

    if (fields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    values.push(id);

    const sql = `UPDATE movable_transactions SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP::text WHERE _id = ?`;
    const { rowCount } = await queryNeon(sql, values);

    if (rowCount === 0) {
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
