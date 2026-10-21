import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
// ከ SQLite ፋንታ የ Neon PostgreSQL Pool ማገናኛን እናስገባለን (የፋይልዎን ትክክለኛ የ database path ያስተካክሉ)
import { pool } from '../config/databaseManager.js'; 
import { awardDailyLoginCoins } from './socialController.js';

// PostgreSQL Helper to execute queries
const query = async (sql, params = []) => {
  try {
    const result = await pool.query(sql, params);
    return result.rows;
  } catch (error) {
    console.error('❌ PostgreSQL Query Error:', error.message);
    console.error('   SQL:', sql);
    console.error('   Params:', params);
    throw error;
  }
};

// User login
export const login = async (req, res, next) => {
  try {
    const { identifier, email, password, username } = req.body;
    
    const loginIdentifier = String(identifier || email || username || '').trim();

    console.log('=== LOGIN ATTEMPT ===');
    console.log('Identifier:', loginIdentifier);

    if (!loginIdentifier || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username/Email/Phone and password are required'
      });
    }

    // PostgreSQL placeholders ($1, $2, $3)
    const sql = `
      SELECT _id as id, username, email, password_hash, full_name, role, permissions, position, phone, is_active, last_login, created_at 
      FROM users 
      WHERE (LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2) OR phone = $3) 
      AND is_active = 1
    `;
    const users = await query(sql, [loginIdentifier, loginIdentifier, loginIdentifier]);

    console.log('Users found:', users.length);

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const user = users[0];
    console.log('User found:', user.username);

    if (user.permissions && typeof user.permissions === 'string') {
      try {
        user.permissions = JSON.parse(user.permissions);
      } catch (e) {
        console.error('Failed to parse permissions:', e);
        user.permissions = null;
      }
    }

    let isPasswordValid = false;
    
    if (user.password_hash) {
      try {
        isPasswordValid = await bcrypt.compare(password, user.password_hash);
      } catch (e) {
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

    // Update last login (PostgreSQL NOW())
    await query('UPDATE users SET last_login = NOW() WHERE _id = $1', [user.id]);
    awardDailyLoginCoins(user.id);

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
    const sql = 'SELECT _id as id, username, email, full_name, role, permissions, position, phone, is_active, last_login, created_at FROM users WHERE _id = $1';
    const users = await query(sql, [req.user.id]);

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = users[0];

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
    let paramIndex = 1;

    if (full_name) {
      updates.push(`full_name = $${paramIndex++}`);
      values.push(full_name);
    }

    if (phone) {
      updates.push(`phone = $${paramIndex++}`);
      values.push(phone);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(req.user.id);

    const sql = `UPDATE users SET ${updates.join(', ')} WHERE _id = $${paramIndex}`;
    await query(sql, values);

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

    const users = await query('SELECT password_hash FROM users WHERE _id = $1', [req.user.id]);

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const isPasswordValid = await bcrypt.compare(current_password, users[0].password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    const hashedPassword = await bcrypt.hash(new_password, 10);

    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE _id = $2', [hashedPassword, req.user.id]);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('❌ Change password error:', error);
    next(error);
  }
};

// Root login
export const rootLogin = async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required'
      });
    }

    const users = await query(`
      SELECT _id as id, username, email, password_hash, full_name, role, permissions,
             position, phone, is_active
      FROM users
      WHERE LOWER(username) = LOWER($1) AND is_active = 1
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
    await query("UPDATE users SET last_login = NOW() WHERE _id = $1", [user.id]);
    
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
};import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
// ከ SQLite ፋንታ የ Neon PostgreSQL Pool ማገናኛን እናስገባለን (የፋይልዎን ትክክለኛ የ database path ያስተካክሉ)
import { pool } from '../config/databaseManager.js'; 
import { awardDailyLoginCoins } from './socialController.js';

// PostgreSQL Helper to execute queries
const query = async (sql, params = []) => {
  try {
    const result = await pool.query(sql, params);
    return result.rows;
  } catch (error) {
    console.error('❌ PostgreSQL Query Error:', error.message);
    console.error('   SQL:', sql);
    console.error('   Params:', params);
    throw error;
  }
};

// User login
export const login = async (req, res, next) => {
  try {
    const { identifier, email, password, username } = req.body;
    
    const loginIdentifier = String(identifier || email || username || '').trim();

    console.log('=== LOGIN ATTEMPT ===');
    console.log('Identifier:', loginIdentifier);

    if (!loginIdentifier || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username/Email/Phone and password are required'
      });
    }

    // PostgreSQL placeholders ($1, $2, $3)
    const sql = `
      SELECT _id as id, username, email, password_hash, full_name, role, permissions, position, phone, is_active, last_login, created_at 
      FROM users 
      WHERE (LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2) OR phone = $3) 
      AND is_active = 1
    `;
    const users = await query(sql, [loginIdentifier, loginIdentifier, loginIdentifier]);

    console.log('Users found:', users.length);

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    const user = users[0];
    console.log('User found:', user.username);

    if (user.permissions && typeof user.permissions === 'string') {
      try {
        user.permissions = JSON.parse(user.permissions);
      } catch (e) {
        console.error('Failed to parse permissions:', e);
        user.permissions = null;
      }
    }

    let isPasswordValid = false;
    
    if (user.password_hash) {
      try {
        isPasswordValid = await bcrypt.compare(password, user.password_hash);
      } catch (e) {
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

    // Update last login (PostgreSQL NOW())
    await query('UPDATE users SET last_login = NOW() WHERE _id = $1', [user.id]);
    awardDailyLoginCoins(user.id);

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
    const sql = 'SELECT _id as id, username, email, full_name, role, permissions, position, phone, is_active, last_login, created_at FROM users WHERE _id = $1';
    const users = await query(sql, [req.user.id]);

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = users[0];

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
    let paramIndex = 1;

    if (full_name) {
      updates.push(`full_name = $${paramIndex++}`);
      values.push(full_name);
    }

    if (phone) {
      updates.push(`phone = $${paramIndex++}`);
      values.push(phone);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(req.user.id);

    const sql = `UPDATE users SET ${updates.join(', ')} WHERE _id = $${paramIndex}`;
    await query(sql, values);

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

    const users = await query('SELECT password_hash FROM users WHERE _id = $1', [req.user.id]);

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const isPasswordValid = await bcrypt.compare(current_password, users[0].password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    const hashedPassword = await bcrypt.hash(new_password, 10);

    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE _id = $2', [hashedPassword, req.user.id]);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
    console.error('❌ Change password error:', error);
    next(error);
  }
};

// Root login
export const rootLogin = async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required'
      });
    }

    const users = await query(`
      SELECT _id as id, username, email, password_hash, full_name, role, permissions,
             position, phone, is_active
      FROM users
      WHERE LOWER(username) = LOWER($1) AND is_active = 1
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
    await query("UPDATE users SET last_login = NOW() WHERE _id = $1", [user.id]);
    
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
