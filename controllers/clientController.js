import { query } from '../config/database.js';

// Get all clients
export const getAllClients = async (req, res, next) => {
  try {
    const { status, client_type, search, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    let sql = `
      SELECT 
        c.*,
        u.full_name AS created_by_name,
        COUNT(DISTINCT ft.id) AS fixed_transactions_count,
        COUNT(DISTINCT mt.id) AS movable_transactions_count,
        COALESCE(SUM(ft.commission_amount), 0) + COALESCE(SUM(mt.commission_amount), 0) AS total_commission
      FROM clients c
      LEFT JOIN users u ON c.created_by = u.id
      LEFT JOIN fixed_transactions ft ON c.id = ft.client_id
      LEFT JOIN movable_transactions mt ON c.id = mt.client_id
      WHERE 1=1
    `;

    const params = [];

    if (status) {
      sql += ' AND c.status = ?';
      params.push(status);
    }

    if (client_type) {
      sql += ' AND c.client_type = ?';
      params.push(client_type);
    }

    if (search) {
      sql += ' AND (c.full_name LIKE ? OR c.company_name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    sql += ' GROUP BY c.id ORDER BY c.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const clients = await query(sql, params);

    // Get total count
    let countSql = 'SELECT COUNT(*) as total FROM clients WHERE 1=1';
    const countParams = [];

    if (status) {
      countSql += ' AND status = ?';
      countParams.push(status);
    }

    if (client_type) {
      countSql += ' AND client_type = ?';
      countParams.push(client_type);
    }

    if (search) {
      countSql += ' AND (full_name LIKE ? OR company_name LIKE ? OR phone LIKE ? OR email LIKE ?)';
      const searchTerm = `%${search}%`;
      countParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    const [{ total }] = await query(countSql, countParams);

    res.json({
      success: true,
      data: clients,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
};

// Get client by ID
export const getClientById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const sql = `
      SELECT 
        c.*,
        u.full_name AS created_by_name
      FROM clients c
      LEFT JOIN users u ON c.created_by = u.id
      WHERE c.id = ?
    `;

    const clients = await query(sql, [id]);

    if (clients.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    res.json({
      success: true,
      data: clients[0]
    });
  } catch (error) {
    next(error);
  }
};

// Create new client
export const createClient = async (req, res, next) => {
  try {
    const {
      client_type,
      full_name,
      company_name,
      national_id,
      tax_number,
      email,
      phone,
      secondary_phone,
      address,
      city,
      country,
      notes,
      status
    } = req.body;

    const sql = `
      INSERT INTO clients (
        client_type, full_name, company_name, national_id, tax_number,
        email, phone, secondary_phone, address, city, country, notes,
        status, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const result = await query(sql, [
      client_type,
      full_name,
      company_name || null,
      national_id || null,
      tax_number || null,
      email || null,
      phone,
      secondary_phone || null,
      address || null,
      city || null,
      country || 'Sudan',
      notes || null,
      status || 'active',
      req.user.id
    ]);

    res.status(201).json({
      success: true,
      message: 'Client created successfully',
      data: { id: result.insertId }
    });
  } catch (error) {
    next(error);
  }
};

// Update client
export const updateClient = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const allowedFields = [
      'client_type', 'full_name', 'company_name', 'national_id', 'tax_number',
      'email', 'phone', 'secondary_phone', 'address', 'city', 'country', 'notes', 'status'
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

    const sql = `UPDATE clients SET ${fields.join(', ')} WHERE id = ?`;
    const result = await query(sql, values);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    res.json({
      success: true,
      message: 'Client updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// Delete client
export const deleteClient = async (req, res, next) => {
  try {
    const { id } = req.params;

    const sql = 'DELETE FROM clients WHERE id = ?';
    const result = await query(sql, [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    res.json({
      success: true,
      message: 'Client deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
