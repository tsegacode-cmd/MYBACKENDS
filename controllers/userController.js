import bcrypt from 'bcryptjs';
import { getPostgreSQLPool } from '../config/databaseManager.js';

// Helper to execute PostgreSQL queries
const query = async (sql, params = []) => {
  const pool = getPostgreSQLPool();
  if (!pool) {
    throw new Error('PostgreSQL database pool not available');
  }
  try {
    const result = await pool.query(sql, params);
    return result;
  } catch (error) {
    console.error('❌ PostgreSQL Query Error:', error.message);
    console.error('   SQL:', sql);
    console.error('   Params:', params);
    throw error;
  }
};

const normalizePhoneNumber = phone => String(phone || '').replace(/\D/g, '');

const hasDuplicatePhoneNumber = async (pool, phone, excludedUserId = null) => {
  const phoneDigits = normalizePhoneNumber(phone);
  if (!phoneDigits) return false;
  
  const res = await pool.query('SELECT id, phone FROM users WHERE phone IS NOT NULL');
  return res.rows.some(user =>
    String(user.id) !== String(excludedUserId) &&
    normalizePhoneNumber(user.phone) === phoneDigits
  );
};

// Helper to check if database is available
const isDatabaseAvailable = () => {
  try {
    const pool = getPostgreSQLPool();
    return pool !== null;
  } catch (error) {
    console.error('❌ Database availability check failed:', error.message);
    return false;
  }
};

// Create new user
export const createUser = async (req, res, next) => {
  try {
    const { username, email, password, full_name, role, position, phone, permissions, commission_settings } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required'
      });
    }

    if (!isDatabaseAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }

    const pool = getPostgreSQLPool();

    // Check if username already exists
    const existingCheck = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existingCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Username already exists'
      });
    }

    // Check duplicate phone number
    if (await hasDuplicatePhoneNumber(pool, phone)) {
      return res.status(400).json({
        success: false,
        message: 'Phone number already exists'
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const permissionsJson = permissions ? JSON.stringify(permissions) : null;
    const commissionSettingsJson = commission_settings ? (typeof commission_settings === 'string' ? commission_settings : JSON.stringify(commission_settings)) : null;
    const creatorId = req.user?.id == null ? null : String(req.user.id);
    const creatorRole = req.user?.role == null ? null : String(req.user.role);

    const sql = `
      INSERT INTO users (
        username, email, password_hash, full_name, role, permissions, commission_settings, position, phone,
        is_active, created_at, created_by_user_id, created_by_role
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, CURRENT_TIMESTAMP, $10, $11)
      RETURNING id, created_at;
    `;

    const result = await pool.query(sql, [
      username,
      email || null,
      hashedPassword,
      full_name || null,
      role || 'user',
      permissionsJson,
      commissionSettingsJson,
      position || null,
      phone || null,
      creatorId,
      creatorRole
    ]);

    const newUserId = result.rows[0].id;
    console.log(`✅ User saved to PostgreSQL database with commission settings: ${username} (ID: ${newUserId})`);

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: {
        id: newUserId,
        _id: newUserId,
        username,
        email: email || null,
        full_name: full_name || null,
        role: role || 'user',
        permissions: permissions || null,
        commission_settings: commission_settings || null,
        position: position || null,
        phone: phone || null,
        is_active: true,
        created_at: result.rows[0].created_at,
        created_by_user_id: creatorId,
        created_by_role: creatorRole,
        created_by_username: req.user?.username || null
      }
    });
  } catch (error) {
    console.error('❌ Create user error:', error);
    next(error);
  }
};

// Get all users
export const getAllUsers = async (req, res, next) => {
  try {
    if (!isDatabaseAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available',
        data: []
      });
    }

    const pool = getPostgreSQLPool();

    // Ensure commission_settings column exists safely in PostgreSQL
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_settings TEXT;
    `).catch(() => {});

    console.log('✅ Loading users with commission settings from PostgreSQL database');
    const isAgentAccount = String(req.user?.role || '').toLowerCase() === 'agent';
    
    let sql = `
      SELECT u.id, u.id as _id, u.username, u.email, u.full_name, u.role, u.permissions,
        u.commission_settings, u.position, u.phone, u.is_active, u.last_login, u.created_at,
        u.created_by_user_id, u.created_by_role, creator.username AS created_by_username,
        EXISTS(
          SELECT 1 FROM social_presence presence
          WHERE presence.user_id = CAST(u.id AS TEXT)
            AND presence.last_seen >= NOW() - INTERVAL '90 seconds'
        ) AS is_online
      FROM users u
      LEFT JOIN users creator ON CAST(creator.id AS TEXT) = u.created_by_user_id
    `;
    
    let params = [];
    if (isAgentAccount) {
      sql += ` WHERE u.created_by_user_id = $1 OR CAST(u.id AS TEXT) = $2`;
      params = [String(req.user.id), String(req.user.id)];
    }
    sql += ` ORDER BY u.created_at DESC`;

    const result = await query(sql, params);
    
    // Parse commission_settings JSON for frontend if it's stored as string
    const formattedRows = result.rows.map(user => {
      if (user.commission_settings && typeof user.commission_settings === 'string') {
        try {
          user.commission_settings = JSON.parse(user.commission_settings);
        } catch (e) {
          // Keep as is if not valid JSON
        }
      }
      return user;
    });

    console.log(`✅ Loaded ${formattedRows.length} users with full details from PostgreSQL`);

    res.json({
      success: true,
      data: formattedRows
    });
  } catch (error) {
    console.error('❌ Get all users error:', error);
    next(error);
  }
};

// Update user
export const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { username, email, password, full_name, role, position, phone, permissions, commission_settings } = req.body;

    if (!isDatabaseAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }

    const pool = getPostgreSQLPool();

    // Ensure commission_settings column exists safely
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_settings TEXT;
    `).catch(() => {});

    if (phone !== undefined && await hasDuplicatePhoneNumber(pool, phone, id)) {
      return res.status(400).json({
        success: false,
        message: 'Phone number already exists'
      });
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (commission_settings !== undefined) {
      updates.push(`commission_settings = $${paramIndex++}`);
      values.push(typeof commission_settings === 'string' ? commission_settings : JSON.stringify(commission_settings));
    }
    if (username) {
      updates.push(`username = $${paramIndex++}`);
      values.push(username);
    }
    if (email !== undefined) {
      updates.push(`email = $${paramIndex++}`);
      values.push(email || null);
    }
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      updates.push(`password_hash = $${paramIndex++}`);
      values.push(hashedPassword);
    }
    if (full_name !== undefined) {
      updates.push(`full_name = $${paramIndex++}`);
      values.push(full_name || null);
    }
    if (role) {
      updates.push(`role = $${paramIndex++}`);
      values.push(role);
    }
    if (position !== undefined) {
      updates.push(`position = $${paramIndex++}`);
      values.push(position || null);
    }
    if (phone !== undefined) {
      updates.push(`phone = $${paramIndex++}`);
      values.push(phone || null);
    }
    if (permissions !== undefined) {
      updates.push(`permissions = $${paramIndex++}`);
      values.push(JSON.stringify(permissions));
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex}`;
    
    await pool.query(sql, values);
    console.log(`✅ SUCCESS! User updated with commission settings: ID ${id}`);

    res.json({
      success: true,
      message: 'User updated successfully'
    });
  } catch (error) {
    console.error('❌ Update user error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Toggle user status
export const toggleUserStatus = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isDatabaseAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }

    const sql = 'UPDATE users SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP WHERE id = $1';
    await query(sql, [id]);

    console.log(`✅ User status toggled in PostgreSQL database: ID ${id}`);

    res.json({
      success: true,
      message: 'User status updated successfully'
    });
  } catch (error) {
    console.error('❌ Toggle user status error:', error);
    next(error);
  }
};

// Delete user
export const deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!isDatabaseAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }

    const sql = 'DELETE FROM users WHERE id = $1';
    await query(sql, [id]);

    console.log(`✅ User deleted from PostgreSQL database: ID ${id}`);

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('❌ Delete user error:', error);
    next(error);
  }
};

export default {
  createUser,
  getAllUsers,
  updateUser,
  toggleUserStatus,
  deleteUser
};
