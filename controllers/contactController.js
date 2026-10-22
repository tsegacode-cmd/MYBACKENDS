import { queryNeon } from '../config/neonDatabase.js';

const queryRows = async (sql, params = []) => (await queryNeon(sql, params)).rows;
const parsePagination = (query) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 10));
  return { page, limit, offset: (page - 1) * limit };
};

const buildFilters = ({ status, inquiry_type, priority }) => {
  const conditions = [];
  const params = [];
  for (const [column, value] of [['status', status], ['inquiry_type', inquiry_type], ['priority', priority]]) {
    if (value) {
      params.push(value);
      conditions.push(`ci.${column} = $${params.length}`);
    }
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
};

export const getAllInquiries = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { where, params } = buildFilters(req.query);
    const inquiries = await queryRows(`
      SELECT ci.*, u.full_name AS assigned_to_name
      FROM contact_inquiries ci
      LEFT JOIN users u ON ci.assigned_to = u._id
      ${where}
      ORDER BY CASE ci.priority
        WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4
      END, ci.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);
    const [{ total }] = await queryRows(
      `SELECT COUNT(*) AS total FROM contact_inquiries ci ${where}`,
      params,
    );
    res.json({
      success: true,
      data: inquiries,
      pagination: { page, limit, total: Number(total), pages: Math.ceil(Number(total) / limit) },
    });
  } catch (error) {
    next(error);
  }
};

export const getInquiryById = async (req, res, next) => {
  try {
    const inquiries = await queryRows(`
      SELECT ci.*, u.full_name AS assigned_to_name
      FROM contact_inquiries ci
      LEFT JOIN users u ON ci.assigned_to = u._id
      WHERE ci._id = ?
    `, [req.params.id]);
    if (!inquiries.length) return res.status(404).json({ success: false, message: 'Inquiry not found' });
    res.json({ success: true, data: inquiries[0] });
  } catch (error) {
    next(error);
  }
};

export const createInquiry = async (req, res, next) => {
  try {
    const { inquiry_type, full_name, email, phone, subject, message, priority } = req.body;
    const [inquiry] = await queryRows(`
      INSERT INTO contact_inquiries (
        inquiry_type, full_name, email, phone, subject, message, priority, ip_address, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING _id
    `, [
      inquiry_type, full_name, email, phone, subject || null, message,
      priority || 'medium', req.ip, req.get('user-agent'),
    ]);
    res.status(201).json({
      success: true,
      message: 'Inquiry submitted successfully. We will contact you soon.',
      data: { id: inquiry._id },
    });
  } catch (error) {
    next(error);
  }
};

export const updateInquiry = async (req, res, next) => {
  try {
    const allowedFields = new Set(['status', 'priority', 'assigned_to', 'response']);
    const fields = Object.entries(req.body || {}).filter(([key]) => allowedFields.has(key));
    if (!fields.length) return res.status(400).json({ success: false, message: 'No valid fields to update' });
    const assignments = fields.map(([key], index) => `${key} = $${index + 1}`);
    const params = fields.map(([, value]) => value);
    if (fields.some(([key, value]) => key === 'response' && value)) {
      assignments.push('responded_at = CURRENT_TIMESTAMP::text');
    }
    params.push(req.params.id);
    const { rowCount } = await queryNeon(
      `UPDATE contact_inquiries SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP::text WHERE _id = $${params.length}`,
      params,
    );
    if (!rowCount) return res.status(404).json({ success: false, message: 'Inquiry not found' });
    res.json({ success: true, message: 'Inquiry updated successfully' });
  } catch (error) {
    next(error);
  }
};

export const deleteInquiry = async (req, res, next) => {
  try {
    const { rowCount } = await queryNeon('DELETE FROM contact_inquiries WHERE _id = ?', [req.params.id]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Inquiry not found' });
    res.json({ success: true, message: 'Inquiry deleted successfully' });
  } catch (error) {
    next(error);
  }
};

export const getInquiryStats = async (_req, res, next) => {
  try {
    const stats = await queryRows(`
      SELECT inquiry_type, COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'new') AS new_count,
        COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
        COUNT(*) FILTER (WHERE status = 'resolved') AS resolved,
        COUNT(*) FILTER (WHERE status = 'closed') AS closed
      FROM contact_inquiries
      GROUP BY inquiry_type
    `);
    res.json({ success: true, data: stats });
  } catch (error) {
    next(error);
  }
};
