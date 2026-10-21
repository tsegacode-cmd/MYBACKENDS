import bcrypt from 'bcryptjs';
import { getRawSQLiteDB } from '../config/sqliteDatabase.js';
import { getDatabaseStatus } from '../config/databaseManager.js';
import { queryNeon } from '../config/neonDatabase.js';

const getDB = () => getRawSQLiteDB();
const isNeonAvailable = () => getDatabaseStatus().neon.connected;

// Helper to execute SQLite queries
const query = (sql, params = []) => {
  try {
    const database = getDB();
    
    // Check if it's a SELECT query
    if (sql.trim().toUpperCase().startsWith('SELECT')) {
      const stmt = database.prepare(sql);
      return stmt.all(...params);
    }
    
    // For INSERT, UPDATE, DELETE
    const stmt = database.prepare(sql);
    const result = stmt.run(...params);
    return result;
  } catch (error) {
    console.error('❌ SQLite Query Error:', error.message);
    console.error('   SQL:', sql);
    console.error('   Params:', params);
    throw error;
  }
};

const normalizePhoneNumber = phone => String(phone || '').replace(/\D/g, '');
const hasDuplicatePhoneNumber = (phone, excludedUserId = null) => {
  const phoneDigits = normalizePhoneNumber(phone);
  if (!phoneDigits) return false;
  return query('SELECT _id, phone FROM users WHERE phone IS NOT NULL').some(user =>
    String(user._id) !== String(excludedUserId) &&
    normalizePhoneNumber(user.phone) === phoneDigits
  );
};

// Helper to check if database is available
const isDatabaseAvailable = () => {
  try {
    const database = getDB();
    return database !== null;
  } catch (error) {
    console.error('❌ Database availability check failed:', error.message);
    return false;
  }
};

// Create new user
export const createUser = async (req, res, next) => {
  try {
    const { username, email, password, full_name, role, position, phone, permissions } = req.body;

    // Validate required fields
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required'
      });
    }

    if (isNeonAvailable()) {
      const { rows: existingUsers } = await queryNeon(
        'SELECT _id FROM users WHERE username = ? OR email = ? LIMIT 1',
        [username, email || null]
      );
      if (existingUsers.length > 0) {
        return res.status(409).json({ success: false, message: 'Username or email already exists' });
      }

      if (phone) {
        const normalizedPhone = normalizePhoneNumber(phone);
        const { rows: existingPhones } = await queryNeon(
          "SELECT _id FROM users WHERE regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ? LIMIT 1",
          [normalizedPhone]
        );
        if (existingPhones.length > 0) {
          return res.status(409).json({ success: false, message: 'Phone number already exists' });
        }
      }

      const hashedPassword = await bcrypt.hash(password, 10);
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
        hashedPassword,
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
    }

    const dbAvailable = isDatabaseAvailable();

    if (dbAvailable) {
      console.log('✅ Using SQLite database for user storage');
      
      // Check if username already exists
      const existingUsers = query('SELECT _id FROM users WHERE username = ?', [username]);
      if (existingUsers.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Username already exists'
        });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Prepare permissions JSON
      const permissionsJson = permissions ? JSON.stringify(permissions) : null;

      // Insert user
      const creatorId = req.user?.id == null ? null : String(req.user.id);
      const creatorRole = req.user?.role == null ? null : String(req.user.role);
      const sql = `
        INSERT INTO users (
          username, email, password_hash, full_name, role, permissions, position, phone,
          is_active, created_at, created_by_user_id, created_by_role
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), ?, ?)
      `;
      
      const result = getDB().transaction(() => {
        if (hasDuplicatePhoneNumber(phone)) return null;
        return query(sql, [
          username,
          email || null,
          hashedPassword,
          full_name || null,
          role || 'user',
          permissionsJson,
          position || null,
          phone || null,
          creatorId,
          creatorRole
        ]);
      })();
      if (!result) {
        return res.status(400).json({
          success: false,
          message: 'Phone number already exists'
        });
      }

      console.log(`✅ User saved to SQLite database: ${username} (ID: ${result.lastInsertRowid})`);

      res.status(201).json({
        success: true,
        message: 'User created successfully',
        data: {
          id: result.lastInsertRowid,
          _id: result.lastInsertRowid,
          username,
          email: email || null,
          full_name: full_name || null,
          role: role || 'user',
          permissions: permissions || null,
          position: position || null,
          phone: phone || null,
          is_active: true,
          created_at: new Date().toISOString(),
          created_by_user_id: creatorId,
          created_by_role: creatorRole,
          created_by_username: req.user?.username || null
        }
      });
    } else {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }
  } catch (error) {
    console.error('❌ Create user error:', error);
    next(error);
  }
};

// Get all users
export const getAllUsers = async (req, res, next) => {
  try {
    if (isNeonAvailable()) {
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
    }

    const dbAvailable = isDatabaseAvailable();

    if (dbAvailable) {
      console.log('✅ Loading users from SQLite database');
      const isAgentAccount = String(req.user?.role || '').toLowerCase() === 'agent';
      const sql = `
        SELECT u._id as id, u.username, u.email, u.full_name, u.role, u.permissions,
          u.commission_settings, u.position, u.phone, u.is_active, u.last_login, u.created_at,
          u.created_by_user_id, u.created_by_role, creator.username AS created_by_username,
          EXISTS(
            SELECT 1 FROM social_presence presence
            WHERE presence.user_id = CAST(u._id AS TEXT)
              AND presence.last_seen >= datetime('now', '-90 seconds')
          ) AS is_online
        FROM users u
        LEFT JOIN users creator ON CAST(creator._id AS TEXT) = u.created_by_user_id
        ${isAgentAccount ? 'WHERE u.created_by_user_id = ? OR CAST(u._id AS TEXT) = ?' : ''}
        ORDER BY u.created_at DESC
      `;
      const users = query(sql, isAgentAccount ? [String(req.user.id), String(req.user.id)] : []);

      console.log(`✅ Loaded ${users.length} users from SQLite database`);

      res.json({
        success: true,
        data: users
      });
    } else {
      return res.status(503).json({
        success: false,
        message: 'Database not available',
        data: []
      });
    }
  } catch (error) {
    console.error('❌ Get all users error:', error);
    next(error);
  }
};

// Update user
export const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    console.log('📝 ========== UPDATE USER REQUEST ==========');
    console.log('📝 User ID:', id);
    console.log('📝 Request Body:', JSON.stringify(req.body, null, 2));
    console.log('📝 Body Keys:', Object.keys(req.body));
    
    const { username, email, password, full_name, role, position, phone, permissions, commission_settings } = req.body;

    if (isNeonAvailable()) {
      const updates = [];
      const values = [];
      const addUpdate = (column, value) => {
        values.push(value);
        updates.push(`${column} = ?`);
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

      if (phone) {
        const normalizedPhone = normalizePhoneNumber(phone);
        const { rows: existingPhones } = await queryNeon(
          "SELECT _id FROM users WHERE _id <> ? AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ? LIMIT 1",
          [id, normalizedPhone]
        );
        if (existingPhones.length > 0) {
          return res.status(409).json({ success: false, message: 'Phone number already exists' });
        }
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
    }

    const dbAvailable = isDatabaseAvailable();

    if (!dbAvailable) {
      console.log('❌ Database not available');
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }

    const updates = [];
    const values = [];

    // PRIORITY: Handle commission_settings FIRST
    if (commission_settings !== undefined) {
      console.log('✅ FOUND commission_settings in request!');
      console.log('✅ Value:', commission_settings);
      console.log('✅ Type:', typeof commission_settings);
      updates.push('commission_settings = ?');
      values.push(typeof commission_settings === 'string' ? commission_settings : JSON.stringify(commission_settings));
    }

    if (username) {
      updates.push('username = ?');
      values.push(username);
    }
    if (email !== undefined) {
      updates.push('email = ?');
      values.push(email || null);
    }
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      updates.push('password_hash = ?');
      values.push(hashedPassword);
    }
    if (full_name !== undefined) {
      updates.push('full_name = ?');
      values.push(full_name || null);
    }
    if (role) {
      updates.push('role = ?');
      values.push(role);
    }
    if (position !== undefined) {
      updates.push('position = ?');
      values.push(position || null);
    }
    if (phone !== undefined) {
      updates.push('phone = ?');
      values.push(phone || null);
    }
    if (permissions !== undefined) {
      updates.push('permissions = ?');
      values.push(JSON.stringify(permissions));
    }

    console.log('📝 Total updates to make:', updates.length);
    console.log('📝 Update fields:', updates);
    console.log('📝 Update values:', values);

    if (updates.length === 0) {
      console.log('❌ NO FIELDS TO UPDATE!');
      return res.status(400).json({
        success: false,
        message: 'No fields to update'
      });
    }

    values.push(id);

    const sql = `UPDATE users SET ${updates.join(', ')}, updated_at = datetime('now') WHERE _id = ?`;
    
    console.log('📝 Final SQL:', sql);
    console.log('📝 Final Values:', JSON.stringify(values));
    
    try {
      const result = getDB().transaction(() => {
        if (phone !== undefined && hasDuplicatePhoneNumber(phone, id)) return null;
        return query(sql, values);
      })();
      if (!result) {
        return res.status(400).json({
          success: false,
          message: 'Phone number already exists'
        });
      }
      console.log(`✅ SUCCESS! User updated: ID ${id}, changes: ${result.changes}`);
      
      // Verify the update
      const verifyStmt = query('SELECT commission_settings FROM users WHERE _id = ?', [id]);
      console.log('✅ Verification - Saved commission_settings:', verifyStmt[0]?.commission_settings);
      
      res.json({
        success: true,
        message: 'User updated successfully'
      });
    } catch (sqlError) {
      console.error('❌ SQL Execution Error:', sqlError.message);
      console.error('❌ SQL Code:', sqlError.code);
      throw sqlError;
    }
  } catch (error) {
    console.error('❌ Update user error:', error);
    console.error('❌ Error stack:', error.stack);
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

    if (isNeonAvailable()) {
      const { rowCount } = await queryNeon(
        'UPDATE users SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP::text WHERE _id = ?',
        [id]
      );
      if (rowCount === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      return res.json({ success: true, message: 'User status updated successfully' });
    }

    const dbAvailable = isDatabaseAvailable();

    if (dbAvailable) {
      const sql = 'UPDATE users SET is_active = NOT is_active, updated_at = datetime(\'now\') WHERE _id = ?';
      query(sql, [id]);

      console.log(`✅ User status toggled in SQLite database: ID ${id}`);

      res.json({
        success: true,
        message: 'User status updated successfully'
      });
    } else {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }
  } catch (error) {
    console.error('❌ Toggle user status error:', error);
    next(error);
  }
};

// Delete user
export const deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (isNeonAvailable()) {
      const { rowCount } = await queryNeon('DELETE FROM users WHERE _id = ?', [id]);
      if (rowCount === 0) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
      return res.json({ success: true, message: 'User deleted successfully' });
    }

    const dbAvailable = isDatabaseAvailable();

    if (dbAvailable) {
      const sql = 'DELETE FROM users WHERE _id = ?';
      query(sql, [id]);

      console.log(`✅ User deleted from SQLite database: ID ${id}`);

      res.json({
        success: true,
        message: 'User deleted successfully'
      });
    } else {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }
  } catch (error) {
    console.error('❌ Delete user error:', error);
    next(error);
  }
};
