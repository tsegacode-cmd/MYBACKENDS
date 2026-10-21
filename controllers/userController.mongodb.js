import bcrypt from 'bcryptjs';
import { getMongoDB } from '../config/databaseManager.js';
import { ObjectId } from 'mongodb';

/**
 * MongoDB-only User Controller
 * All data persists to MongoDB - no in-memory fallback
 */

// Get MongoDB collection
const getUsersCollection = () => {
  const db = getMongoDB();
  return db.collection('users');
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

    const users = getUsersCollection();

    // Check if username already exists
    const existingUser = await users.findOne({ username });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Username already exists'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user document
    const newUser = {
      username,
      email: email || null,
      password_hash: hashedPassword,
      full_name: full_name || null,
      role: role || 'user',
      permissions: permissions || null,
      position: position || null,
      phone: phone || null,
      is_active: true,
      last_login: null,
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await users.insertOne(newUser);

    console.log(`✅ User saved to MongoDB: ${username} (ID: ${result.insertedId})`);

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: {
        id: result.insertedId,
        username,
        email: email || null,
        full_name: full_name || null,
        role: role || 'user',
        permissions: permissions || null,
        position: position || null,
        phone: phone || null,
        is_active: true
      }
    });
  } catch (error) {
    next(error);
  }
};

// Get all users
export const getAllUsers = async (req, res, next) => {
  try {
    const users = getUsersCollection();
    
    const userList = await users
      .find({})
      .project({ password_hash: 0 }) // Exclude password hash
      .sort({ created_at: -1 })
      .toArray();

    console.log(`✅ Loaded ${userList.length} users from MongoDB`);

    res.json({
      success: true,
      data: userList
    });
  } catch (error) {
    next(error);
  }
};

// Get user by ID
export const getUserById = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Validate ObjectId format
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID format'
      });
    }
    
    const users = getUsersCollection();

    const user = await users.findOne(
      { _id: new ObjectId(id) },
      { projection: { password_hash: 0 } }
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

// Update user
export const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Validate ObjectId format
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID format'
      });
    }
    
    const { username, email, password, full_name, role, position, phone, permissions, commission_settings } = req.body;

    const users = getUsersCollection();
    const updates = { updated_at: new Date() };

    if (username) updates.username = username;
    if (email !== undefined) updates.email = email || null;
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      updates.password_hash = hashedPassword;
    }
    if (full_name !== undefined) updates.full_name = full_name || null;
    if (role) updates.role = role;
    if (position !== undefined) updates.position = position || null;
    if (phone !== undefined) updates.phone = phone || null;
    if (permissions !== undefined) updates.permissions = permissions || null;
    if (commission_settings !== undefined) updates.commission_settings = commission_settings || null;

    const result = await users.updateOne(
      { _id: new ObjectId(id) },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'User updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// Toggle user status
export const toggleUserStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Validate ObjectId format
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID format'
      });
    }
    
    const users = getUsersCollection();

    const user = await users.findOne({ _id: new ObjectId(id) });
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    await users.updateOne(
      { _id: new ObjectId(id) },
      { 
        $set: { 
          is_active: !user.is_active,
          updated_at: new Date()
        } 
      }
    );

    res.json({
      success: true,
      message: 'User status updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// Delete user
export const deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Validate ObjectId format
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID format'
      });
    }
    
    const users = getUsersCollection();

    const result = await users.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
