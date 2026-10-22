import { queryNeon } from '../config/neonDatabase.js';

const queryRows = async (sql, params = []) => (await queryNeon(sql, params)).rows;
const parsePagination = (query) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 10));
  return { page, limit, offset: (page - 1) * limit };
};

const buildFilters = ({ status, client_type, search }) => {
  const conditions = [];
  const params = [];
  if (status) {
    params.push(status);
    conditions.push(`c.status = $${params.length}`);
  }
  if (client_type) {
    params.push(client_type);
    conditions.push(`c.client_type = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).slice(0, 200)}%`);
    conditions.push(`(c.full_name ILIKE $${params.length} OR c.company_name ILIKE $${params.length} OR c.phone ILIKE $${params.length} OR c.email ILIKE $${params.length})`);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
};

export const getAllClients = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { where, params } = buildFilters(req.query);
    const dataParams = [...params, limit, offset];
    const clients = await queryRows(`
      SELECT c.*, u.full_name AS created_by_name,
        (SELECT COUNT(*) FROM fixed_transactions ft WHERE ft.client_id = c._id) AS fixed_transactions_count,
        (SELECT COUNT(*) FROM movable_transactions mt WHERE mt.client_id = c._id) AS movable_transactions_count,
        (SELECT COALESCE(SUM(ft.commission_amount), 0) FROM fixed_transactions ft WHERE ft.client_id = c._id) +
        (SELECT COALESCE(SUM(mt.commission_amount), 0) FROM movable_transactions mt WHERE mt.client_id = c._id) AS total_commission
      FROM clients c
      LEFT JOIN users u ON c.created_by = u._id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `, dataParams);
    const [{ total }] = await queryRows(`SELECT COUNT(*) AS total FROM clients c ${where}`, params);
    res.json({
      success: true,
      data: clients,
      pagination: { page, limit, total: Number(total), pages: Math.ceil(Number(total) / limit) },
    });
  } catch (error) {
    next(error);
  }
};

export const getClientById = async (req, res, next) => {
  try {
    const clients = await queryRows(`
      SELECT c.*, u.full_name AS created_by_name
      FROM clients c
      LEFT JOIN users u ON c.created_by = u._id
      WHERE c._id = ?
    `, [req.params.id]);
    if (!clients.length) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, data: clients[0] });
  } catch (error) {
    next(error);
  }
};

export const createClient = async (req, res, next) => {
  try {
    const {
      client_type, full_name, company_name, national_id, tax_number, email, phone,
      secondary_phone, address, city, country, notes, status,
    } = req.body;
    const [client] = await queryRows(`
      INSERT INTO clients (
        client_type, full_name, company_name, national_id, tax_number, email, phone,
        secondary_phone, address, city, country, notes, status, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING _id
    `, [
      client_type, full_name, company_name || null, national_id || null, tax_number || null,
      email || null, phone, secondary_phone || null, address || null, city || null,
      country || 'Sudan', notes || null, status || 'active', req.user.id,
    ]);
    res.status(201).json({
      success: true,
      message: 'Client created successfully',
      data: { id: client._id },
    });
  } catch (error) {
    next(error);
  }
};

export const updateClient = async (req, res, next) => {
  try {
    const allowedFields = new Set([
      'client_type', 'full_name', 'company_name', 'national_id', 'tax_number',
      'email', 'phone', 'secondary_phone', 'address', 'city', 'country', 'notes', 'status',
    ]);
    const fields = Object.entries(req.body || {}).filter(([key]) => allowedFields.has(key));
    if (!fields.length) return res.status(400).json({ success: false, message: 'No valid fields to update' });
    const assignments = fields.map(([key], index) => `${key} = $${index + 1}`);
    const params = fields.map(([, value]) => value);
    params.push(req.params.id);
    const { rowCount } = await queryNeon(
      `UPDATE clients SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP::text WHERE _id = $${params.length}`,
      params,
    );
    if (!rowCount) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, message: 'Client updated successfully' });
  } catch (error) {
    next(error);
  }
};

export const deleteClient = async (req, res, next) => {
  try {
    const { rowCount } = await queryNeon('DELETE FROM clients WHERE _id = ?', [req.params.id]);
    if (!rowCount) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, message: 'Client deleted successfully' });
  } catch (error) {
    next(error);
  }
};
