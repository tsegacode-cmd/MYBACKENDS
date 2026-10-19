import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getRawSQLiteDB } from '../config/databaseManager.js';
import { awardDailyLoginCoins } from './socialController.js';

// Helper to execute SQLite queries
const query = (sql, params = []) => {
  try {
    const database = getRawSQLiteDB();
    
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

// User login
export const login = async (req, res, next) => {
  try {
    const { identifier, email, password, username } = req.body;
    
    // Accept either 'identifier' (from new login form) or 'email'/'username' (from old forms)
    const loginIdentifier = String(identifier || email || username || '').trim();

    console.log('=== LOGIN ATTEMPT ===');
    console.log('Identifier:', loginIdentifier);

    if (!loginIdentifier || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username/Email/Phone and password are required'
      });
    }

    // Find active accounts by username, email, or phone for both staff and users.
    const sql = `
      SELECT _id as id, username, email, password_hash, full_name, role, permissions, position, phone, is_active, last_login, created_at 
      FROM users 
      WHERE (LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?) OR phone = ?) 
      AND is_active = 1
    `;
    const users = query(sql, [loginIdentifier, loginIdentifier, loginIdentifier]);

    console.log('Users found:', users.length);

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const user = users[0];
    console.log('User found:', user.username);

    // Parse permissions if stored as JSON string
    if (user.permissions && typeof user.permissions === 'string') {
      try {
        user.permissions = JSON.parse(user.permissions);
      } catch (e) {
        console.error('Failed to parse permissions:', e);
        user.permissions = null;
      }
    }

    // Verify password - handle both hashed and plain text passwords
    let isPasswordValid = false;
    
    if (user.password_hash) {
      // Try bcrypt comparison for hashed passwords
      try {
        isPasswordValid = await bcrypt.compare(password, user.password_hash);
      } catch (e) {
        // If bcrypt fails, might be plain text
        isPasswordValid = user.password_hash === password;
      }
    }

    console.log('Password valid:', isPasswordValid);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Update last login
    query('UPDATE users SET last_login = datetime(\'now\') WHERE _id = ?', [user.id]);
    awardDailyLoginCoins(user.id);

    // Generate JWT token
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Remove password from response
    delete user.password_hash;

    console.log('✅ Login successful for user:', user.username);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user,
        token
      }
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    next(error);
  }
};

// Get current user profile
export const getProfile = async (req, res, next) => {
  try {
    const sql = 'SELECT _id as id, username, email, full_name, role, permissions, position, phone, is_active, last_login, created_at FROM users WHERE _id = ?';
    const users = query(sql, [req.user.id]);

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = users[0];

    // Parse permissions if stored as JSON string
    if (user.permissions && typeof user.permissions === 'string') {
      try {
        user.permissions = JSON.parse(user.permissions);
      } catch (e) {
        console.error('Failed to parse permissions:', e);
        user.permissions = null;
      }
    }

    res.json({
      success: true,
      data: user
    });
  } catch (error) {
    console.error('❌ Get profile error:', error);
    next(error);
  }
};

// Update user profile
export const updateProfile = async (req, res, next) => {
  try {
    const { full_name, phone } = req.body;

    const updates = [];
    const values = [];

    if (full_name) {
      updates.push('full_name = ?');
      values.push(full_name);
    }

    if (phone) {
      updates.push('phone = ?');
      values.push(phone);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    values.push(req.user.id);

    const sql = `UPDATE users SET ${updates.join(', ')}, updated_at = datetime('now') WHERE _id = ?`;
    query(sql, values);

    res.json({
      success: true,
      message: 'Profile updated successfully'
    });
  } catch (error) {
    console.error('❌ Update profile error:', error);
    next(error);
  }
};

// Change password
export const changePassword = async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }

    if (new_password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters long'
      });
    }

    // Get current user
    const users = query('SELECT password_hash FROM users WHERE _id = ?', [req.user.id]);

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(current_password, users[0].password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(new_password, 10);

    // Update password
    query('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE _id = ?', [hashedPassword, req.user.id]);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('❌ Change password error:', error);
    next(error);
  }
};

// Root login (special authentication for root portal)
export const rootLogin = async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required'
      });
    }

    const users = query(`
      SELECT _id as id, username, email, password_hash, full_name, role, permissions,
             position, phone, is_active
      FROM users
      WHERE LOWER(username) = LOWER(?) AND is_active = 1
    `, [String(username).trim()]);
    const user = users[0];
    if (!user || !['root', 'admin'].includes(String(user.role).toLowerCase())) {
      return res.status(401).json({ success: false, message: 'Invalid root credentials.' });
    }

    const passwordValid = await bcrypt.compare(String(password), user.password_hash || '');
    if (!passwordValid) {
      return res.status(401).json({ success: false, message: 'Invalid root credentials.' });
    }

    const token = jwt.sign({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      isRoot: true
    }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
    delete user.password_hash;
    query("UPDATE users SET last_login = datetime('now') WHERE _id = ?", [user.id]);
    return res.json({
      success: true,
      message: 'Root login successful.',
      data: { user: { ...user, isRoot: true }, token }
    });
  } catch (error) {
    next(error);
  }
};

// Verify root token
export const verifyRoot = async (req, res, next) => {
  try {
    if (!req.user || !req.user.isRoot) {
      return res.status(403).json({
        success: false,
        message: 'Root access required'
      });
    }

    res.json({
      success: true,
      message: 'Root access verified',
      data: {
        user: req.user
      }
    });
  } catch (error) {
    next(error);
  }
};
