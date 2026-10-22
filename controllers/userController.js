import bcrypt from 'bcryptjs';
import { queryNeon } from '../config/neonDatabase.js';

const normalizePhoneNumber = phone => String(phone || '').replace(/\D/g, '');

const findUserWithPhone = async (phone, excludedUserId = null) => {
  const phoneDigits = normalizePhoneNumber(phone);
  if (!phoneDigits) return null;

  const params = [phoneDigits];
  const excludeUser = excludedUserId != null;
  if (excludeUser) params.push(String(excludedUserId));

  const { rows } = await queryNeon(`
    SELECT _id
    FROM users
    WHERE regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?
      ${excludeUser ? 'AND CAST(_id AS TEXT) <> ?' : ''}
    LIMIT 1
  `, params);
  return rows[0] || null;
};

export const createUser = async (req, res, next) => {
  try {
    const { username, email, password, full_name, role, position, phone, permissions } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required' });
    }

    const { rows: existingUsers } = await queryNeon(
      'SELECT _id FROM users WHERE username = ? OR email = ? LIMIT 1',
      [username, email || null]
    );
    if (existingUsers.length > 0) {
      return res.status(409).json({ success: false, message: 'Username or email already exists' });
    }

    if (phone && await findUserWithPhone(phone)) {
      return res.status(409).json({ success: false, message: 'Phone number already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const creatorId = req.user?.id == null ? null : String(req.user.id);
    const creatorRole = req.user?.role == null ? null : String(req.user.role);
    const { rows } = await queryNeon(`
      INSERT INTO users (
        username, email, password_hash, full_name, role, permissions, position, phone,
        is_active, created_at, created_by_user_id, created_by_role
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP::text, ?, ?)
      RETURNING _id AS id, created_at
    `, [
      username,
      email || null,
      passwordHash,
      full_name || null,
      role || 'user',
      permissions ? JSON.stringify(permissions) : null,
      position || null,
      phone || null,
      creatorId,
      creatorRole
    ]);
    const created = rows[0];

    return res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: {
        id: created.id,
        _id: created.id,
        username,
        email: email || null,
        full_name: full_name || null,
        role: role || 'user',
        permissions: permissions || null,
        position: position || null,
        phone: phone || null,
        is_active: true,
        created_at: created.created_at,
        created_by_user_id: creatorId,
        created_by_role: creatorRole,
        created_by_username: req.user?.username || null
      }
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Username or email already exists' });
    }
    return next(error);
  }
};

export const getAllUsers = async (req, res, next) => {
  try {
    const isAgentAccount = String(req.user?.role || '').toLowerCase() === 'agent';
    const { rows } = await queryNeon(`
      SELECT u._id AS id, u.username, u.email, u.full_name, u.role, u.permissions,
        u.commission_settings, u.position, u.phone, u.is_active, u.last_login, u.created_at,
        u.created_by_user_id, u.created_by_role, creator.username AS created_by_username,
        EXISTS(
          SELECT 1 FROM social_presence presence
          WHERE presence.user_id = CAST(u._id AS TEXT)
            AND presence.last_seen::timestamptz >= NOW() - INTERVAL '90 seconds'
        ) AS is_online
      FROM users u
      LEFT JOIN users creator ON CAST(creator._id AS TEXT) = u.created_by_user_id
      ${isAgentAccount ? 'WHERE u.created_by_user_id = ? OR CAST(u._id AS TEXT) = ?' : ''}
      ORDER BY u.created_at DESC
    `, isAgentAccount ? [String(req.user.id), String(req.user.id)] : []);
    return res.json({ success: true, data: rows });
  } catch (error) {
    return next(error);
  }
};

export const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      username, email, password, full_name, role, position, phone, permissions, commission_settings
    } = req.body;
    const updates = [];
    const values = [];
    const addUpdate = (column, value) => {
      updates.push(`${column} = ?`);
      values.push(value);
    };

    if (commission_settings !== undefined) {
      addUpdate('commission_settings', typeof commission_settings === 'string'
        ? commission_settings
        : JSON.stringify(commission_settings));
    }
    if (username) addUpdate('username', username);
    if (email !== undefined) addUpdate('email', email || null);
    if (password) addUpdate('password_hash', await bcrypt.hash(password, 10));
    if (full_name !== undefined) addUpdate('full_name', full_name || null);
    if (role) addUpdate('role', role);
    if (position !== undefined) addUpdate('position', position || null);
    if (phone !== undefined) addUpdate('phone', phone || null);
    if (permissions !== undefined) addUpdate('permissions', JSON.stringify(permissions));

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    if (phone && await findUserWithPhone(phone, id)) {
      return res.status(409).json({ success: false, message: 'Phone number already exists' });
    }

    values.push(id);
    const { rowCount } = await queryNeon(
      `UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP::text WHERE _id = ?`,
      values
    );
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.json({ success: true, message: 'User updated successfully' });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Username or email already exists' });
    }
    return next(error);
  }
};

export const toggleUserStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rowCount } = await queryNeon(
      'UPDATE users SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP::text WHERE _id = ?',
      [id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.json({ success: true, message: 'User status updated successfully' });
  } catch (error) {
    return next(error);
  }
};

export const deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rowCount } = await queryNeon('DELETE FROM users WHERE _id = ?', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    return next(error);
  }
};
