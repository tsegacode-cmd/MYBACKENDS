import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getMongoDB, isMongoDBAvailable } from '../config/databaseManager.js';

// User login
export const login = async (req, res, next) => {
  try {
    const { identifier, email, password, username } = req.body;
    
    // Accept either 'identifier' (from new login form) or 'email'/'username' (from old forms)
    const loginIdentifier = identifier || email || username;

    if (!loginIdentifier || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username/Email/Phone and password are required'
      });
    }

    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }

    const db = getMongoDB();
    const usersCollection = db.collection('users');

    // Find user by username, email, or phone
    const user = await usersCollection.findOne({
      $or: [
        { username: loginIdentifier },
        { email: loginIdentifier },
        { phone: loginIdentifier }
      ],
      is_active: true
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
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
    } else if (user.password) {
      // Plain text password (from Root Dashboard)
      isPasswordValid = user.password === password;
    }

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Update last login
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { last_login: new Date() } }
    );

    // Generate JWT token
    const token = jwt.sign(
      {
        id: user._id.toString(),
        email: user.email,
        username: user.username,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Remove password from response
    delete user.password_hash;
    delete user.password;

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user,
        token
      }
    });
  } catch (error) {
    next(error);
  }
};

// Get current user profile
export const getProfile = async (req, res, next) => {
  try {
    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }

    const db = getMongoDB();
    const usersCollection = db.collection('users');

    const user = await usersCollection.findOne(
      { _id: req.user.id },
      {
        projection: {
          password_hash: 0,
          password: 0
        }
      }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: user
    });
  } catch (error) {
    next(error);
  }
};

// Update user profile
export const updateProfile = async (req, res, next) => {
  try {
    const { full_name, phone } = req.body;

    const updates = {};

    if (full_name) updates.full_name = full_name;
    if (phone) updates.phone = phone;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }

    const db = getMongoDB();
    const usersCollection = db.collection('users');

    updates.updated_at = new Date();

    await usersCollection.updateOne(
      { _id: req.user.id },
      { $set: updates }
    );

    res.json({
      success: true,
      message: 'Profile updated successfully'
    });
  } catch (error) {
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

    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }

    const db = getMongoDB();
    const usersCollection = db.collection('users');

    // Get current user
    const user = await usersCollection.findOne({ _id: req.user.id });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Verify current password
    const isPasswordValid = await bcrypt.compare(current_password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(new_password, 10);

    // Update password
    await usersCollection.updateOne(
      { _id: req.user.id },
      { $set: { password_hash: hashedPassword, updated_at: new Date() } }
    );

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (error) {
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

    // First, check hardcoded root credentials (backward compatibility)
    const ROOT_USERNAME = process.env.ROOT_USERNAME || 'root';
    const ROOT_PASSWORD = process.env.ROOT_PASSWORD || 'redsea@2024';

    if (username === ROOT_USERNAME && password === ROOT_PASSWORD) {
      // Generate root JWT token for hardcoded root
      const token = jwt.sign(
        {
          id: 'root',
          username: ROOT_USERNAME,
          role: 'root',
          isRoot: true
        },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      return res.json({
        success: true,
        message: 'Root login successful',
        data: {
          user: {
            username: ROOT_USERNAME,
            role: 'root',
            isRoot: true
          },
          token
        }
      });
    }

    // Check database for users with "root" role
    if (!isMongoDBAvailable()) {
      return res.status(401).json({
        success: false,
        message: 'Invalid root credentials'
      });
    }

    const db = getMongoDB();
    const usersCollection = db.collection('users');

    // Find user with root role
    const user = await usersCollection.findOne({
      username: username,
      role: 'root',
      is_active: true
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid root credentials'
      });
    }

    // Verify password
    let isPasswordValid = false;
    
    if (user.password_hash) {
      try {
        isPasswordValid = await bcrypt.compare(password, user.password_hash);
      } catch (e) {
        isPasswordValid = user.password_hash === password;
      }
    } else if (user.password) {
      isPasswordValid = user.password === password;
    }

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid root credentials'
      });
    }

    // Update last login
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { last_login: new Date() } }
    );

    // Generate root JWT token
    const token = jwt.sign(
      {
        id: user._id.toString(),
        username: user.username,
        role: 'root',
        isRoot: true
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      message: 'Root login successful',
      data: {
        user: {
          id: user._id.toString(),
          username: user.username,
          full_name: user.full_name,
          email: user.email,
          role: 'root',
          isRoot: true
        },
        token
      }
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
