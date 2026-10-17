import bcrypt from 'bcryptjs';
import { getCollection, isMongoDBAvailable } from '../config/mongodb.js';
import { ObjectId } from 'mongodb';

// Large in-memory storage with capacity for thousands of records (fallback)
const IN_MEMORY_STORAGE = {
  users: new Map(),
  nextUserId: 1,
  maxCapacity: 10000,
  
  addUser(user) {
    if (this.users.size >= this.maxCapacity) {
      throw new Error('In-memory storage capacity reached');
    }
    const id = this.nextUserId++;
    const userWithId = { ...user, id };
    this.users.set(id, userWithId);
    return userWithId;
  },
  
  getUser(id) {
    return this.users.get(id);
  },
  
  getAllUsers() {
    return Array.from(this.users.values());
  },
  
  updateUser(id, updates) {
    const user = this.users.get(id);
    if (!user) return null;
    const updated = { ...user, ...updates };
    this.users.set(id, updated);
    return updated;
  },
  
  deleteUser(id) {
    return this.users.delete(id);
  },
  
  findByUsername(username) {
    return this.getAllUsers().find(u => u.username === username);
  },
  
  getStats() {
    return {
      total: this.users.size,
      capacity: this.maxCapacity,
      available: this.maxCapacity - this.users.size,
      percentUsed: ((this.users.size / this.maxCapacity) * 100).toFixed(2)
    };
  }
};

// Storage capacity warning system
const checkStorageCapacity = () => {
  const stats = IN_MEMORY_STORAGE.getStats();
  
  if (stats.percentUsed > 90) {
    console.warn('⚠️  WARNING: In-memory storage is ' + stats.percentUsed + '% full!');
    console.warn('⚠️  Please connect to MongoDB to avoid data loss');
  } else if (stats.percentUsed > 75) {
    console.warn('⚠️  In-memory storage is ' + stats.percentUsed + '% full');
  }
  
  return stats;
};

// Create new user
export const createUser = async (req, res, next) => {
  try {
    const { username, email, password, full_name, role, position, phone, permissions } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required'
      });
    }

    const dbAvailable = await isMongoDBAvailable();

    if (dbAvailable) {
      console.log('✅ Using MongoDB for user storage');
      const usersCollection = getCollection('users');
      
      // Check if username already exists
      const existingUser = await usersCollection.findOne({ username });
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
        position: position || null,
        phone: phone || null,
        permissions: permissions || null,
        is_active: true,
        last_login: null,
        created_at: new Date(),
        updated_at: new Date()
      };

      const result = await usersCollection.insertOne(newUser);
      
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
    } else {
      console.warn('⚠️  Falling back to in-memory storage - DATA WILL NOT PERSIST!');
      
      checkStorageCapacity();
      
      if (IN_MEMORY_STORAGE.findByUsername(username)) {
        return res.status(400).json({
          success: false,
          message: 'Username already exists'
        });
      }

      try {
        const newUser = IN_MEMORY_STORAGE.addUser({
          username,
          email: email || null,
          full_name: full_name || null,
          role: role || 'user',
          permissions: permissions || null,
          position: position || null,
          phone: phone || null,
          is_active: true,
          created_at: new Date().toISOString(),
          last_login: null
        });

        console.warn(`⚠️  User saved to in-memory storage (temporary): ${username}`);

        res.status(201).json({
          success: true,
          message: 'User created successfully (in-memory - will not persist)',
          data: newUser
        });
      } catch (error) {
        return res.status(507).json({
          success: false,
          message: error.message
        });
      }
    }
  } catch (error) {
    next(error);
  }
};

// Get all users
export const getAllUsers = async (req, res, next) => {
  try {
    const dbAvailable = await isMongoDBAvailable();

    if (dbAvailable) {
      console.log('✅ Loading users from MongoDB');
      const usersCollection = getCollection('users');
      
      const users = await usersCollection
        .find({}, { projection: { password_hash: 0 } })
        .sort({ created_at: -1 })
        .toArray();

      console.log(`✅ Loaded ${users.length} users from MongoDB`);

      res.json({
        success: true,
        data: users
      });
    } else {
      console.warn('⚠️  Loading users from in-memory storage');
      res.json({
        success: true,
        data: IN_MEMORY_STORAGE.getAllUsers()
      });
    }
  } catch (error) {
    next(error);
  }
};

// Update user
export const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { username, email, password, full_name, role, position, phone, permissions } = req.body;

    const dbAvailable = await isMongoDBAvailable();

    if (dbAvailable) {
      const usersCollection = getCollection('users');
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

      const result = await usersCollection.updateOne(
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
    } else {
      const updates = {};
      if (username) updates.username = username;
      if (email !== undefined) updates.email = email || null;
      if (full_name !== undefined) updates.full_name = full_name || null;
      if (role) updates.role = role;
      if (position !== undefined) updates.position = position || null;
      if (phone !== undefined) updates.phone = phone || null;
      if (permissions !== undefined) updates.permissions = permissions || null;

      const updatedUser = IN_MEMORY_STORAGE.updateUser(parseInt(id), updates);
      
      if (!updatedUser) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      res.json({
        success: true,
        message: 'User updated successfully (in-memory)'
      });
    }
  } catch (error) {
    next(error);
  }
};

// Toggle user status
export const toggleUserStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbAvailable = await isMongoDBAvailable();

    if (dbAvailable) {
      const usersCollection = getCollection('users');
      
      const user = await usersCollection.findOne({ _id: new ObjectId(id) });
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { is_active: !user.is_active, updated_at: new Date() } }
      );

      res.json({
        success: true,
        message: 'User status updated successfully'
      });
    } else {
      const user = IN_MEMORY_STORAGE.getUser(parseInt(id));
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      IN_MEMORY_STORAGE.updateUser(parseInt(id), { is_active: !user.is_active });

      res.json({
        success: true,
        message: 'User status updated successfully (in-memory)'
      });
    }
  } catch (error) {
    next(error);
  }
};

// Delete user
export const deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbAvailable = await isMongoDBAvailable();

    if (dbAvailable) {
      const usersCollection = getCollection('users');
      const result = await usersCollection.deleteOne({ _id: new ObjectId(id) });

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
    } else {
      const deleted = IN_MEMORY_STORAGE.deleteUser(parseInt(id));
      
      if (!deleted) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }

      res.json({
        success: true,
        message: 'User deleted successfully (in-memory)'
      });
    }
  } catch (error) {
    next(error);
  }
};

// Export in-memory data to JSON
export const exportMemoryData = () => {
  return {
    users: IN_MEMORY_STORAGE.getAllUsers(),
    stats: IN_MEMORY_STORAGE.getStats(),
    exportedAt: new Date().toISOString()
  };
};

// Import data to in-memory storage
export const importMemoryData = (data) => {
  if (data.users) {
    data.users.forEach(user => {
      IN_MEMORY_STORAGE.users.set(user.id, user);
      if (user.id >= IN_MEMORY_STORAGE.nextUserId) {
        IN_MEMORY_STORAGE.nextUserId = user.id + 1;
      }
    });
  }
};

// Get storage statistics
export const getStorageStats = () => {
  return IN_MEMORY_STORAGE.getStats();
};
