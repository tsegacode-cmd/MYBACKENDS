import { query } from '../config/database.js';

// Get all contact inquiries
export const getAllInquiries = async (req, res, next) => {
  try {
    const { status, inquiry_type, priority, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    let sql = `
      SELECT 
        ci.*,
        u.full_name AS assigned_to_name
      FROM contact_inquiries ci
      LEFT JOIN users u ON ci.assigned_to = u.id
      WHERE 1=1
    `;

    const params = [];

    if (status) {
      sql += ' AND ci.status = ?';
      params.push(status);
    }

    if (inquiry_type) {
      sql += ' AND ci.inquiry_type = ?';
      params.push(inquiry_type);
    }

    if (priority) {
      sql += ' AND ci.priority = ?';
      params.push(priority);
    }

    sql += ` 
      ORDER BY 
        FIELD(ci.priority, 'urgent', 'high', 'medium', 'low'),
        ci.created_at DESC
      LIMIT ? OFFSET ?
    `;
    params.push(parseInt(limit), parseInt(offset));

    const inquiries = await query(sql, params);

    // Get total count
    let countSql = 'SELECT COUNT(*) as total FROM contact_inquiries WHERE 1=1';
    const countParams = [];

    if (status) {
      countSql += ' AND status = ?';
      countParams.push(status);
    }

    if (inquiry_type) {
      countSql += ' AND inquiry_type = ?';
      countParams.push(inquiry_type);
    }

    if (priority) {
      countSql += ' AND priority = ?';
      countParams.push(priority);
    }

    const [{ total }] = await query(countSql, countParams);

    res.json({
      success: true,
      data: inquiries,
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

// Get inquiry by ID
export const getInquiryById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const sql = `
      SELECT 
        ci.*,
        u.full_name AS assigned_to_name
      FROM contact_inquiries ci
      LEFT JOIN users u ON ci.assigned_to = u.id
      WHERE ci.id = ?
    `;

    const inquiries = await query(sql, [id]);

    if (inquiries.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    res.json({
      success: true,
      data: inquiries[0]
    });
  } catch (error) {
    next(error);
  }
};

// Create new inquiry (public endpoint)
export const createInquiry = async (req, res, next) => {
  try {
    const {
      inquiry_type,
      full_name,
      email,
      phone,
      subject,
      message,
      priority
    } = req.body;

    const sql = `
      INSERT INTO contact_inquiries (
        inquiry_type, full_name, email, phone, subject, message,
        priority, ip_address, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const result = await query(sql, [
      inquiry_type,
      full_name,
      email,
      phone,
      subject || null,
      message,
      priority || 'medium',
      req.ip,
      req.get('user-agent')
    ]);

    res.status(201).json({
      success: true,
      message: 'Inquiry submitted successfully. We will contact you soon.',
      data: { id: result.insertId }
    });
  } catch (error) {
    next(error);
  }
};

// Update inquiry (admin only)
export const updateInquiry = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const allowedFields = ['status', 'priority', 'assigned_to', 'response'];

    const fields = [];
    const values = [];

    Object.keys(updates).forEach(key => {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = ?`);
        values.push(updates[key]);
      }
    });

    // Add responded_at if response is provided
    if (updates.response) {
      fields.push('responded_at = NOW()');
    }

    if (fields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    values.push(id);

    const sql = `UPDATE contact_inquiries SET ${fields.join(', ')} WHERE id = ?`;
    const result = await query(sql, values);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    res.json({
      success: true,
      message: 'Inquiry updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// Delete inquiry
export const deleteInquiry = async (req, res, next) => {
  try {
    const { id } = req.params;

    const sql = 'DELETE FROM contact_inquiries WHERE id = ?';
    const result = await query(sql, [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    res.json({
      success: true,
      message: 'Inquiry deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// Get inquiry statistics
export const getInquiryStats = async (req, res, next) => {
  try {
    const sql = `
      SELECT 
        inquiry_type,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_count,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed
      FROM contact_inquiries
      GROUP BY inquiry_type
    `;

    const stats = await query(sql);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    next(error);
  }
};
