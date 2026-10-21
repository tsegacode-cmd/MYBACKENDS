import { getMongoDB } from '../config/databaseManager.js';
import { ObjectId } from 'mongodb';

/**
 * MongoDB-only Client Controller
 * All data persists to MongoDB - no MySQL fallback
 */

// Get MongoDB collection
const getClientsCollection = () => {
  const db = getMongoDB();
  return db.collection('clients');
};

// Get all clients
export const getAllClients = async (req, res, next) => {
  try {
    const { status, client_type, search, page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const clients = getClientsCollection();
    const query = {};

    if (status) query.status = status;
    if (client_type) query.client_type = client_type;
    if (search) {
      query.$or = [
        { full_name: { $regex: search, $options: 'i' } },
        { company_name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const [clientList, total] = await Promise.all([
      clients
        .find(query)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .toArray(),
      clients.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: clientList,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
};

// Get client by ID
export const getClientById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const clients = getClientsCollection();

    const client = await clients.findOne({ _id: new ObjectId(id) });

    if (!client) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    res.json({
      success: true,
      data: client
    });
  } catch (error) {
    next(error);
  }
};

// Create new client
export const createClient = async (req, res, next) => {
  try {
    const {
      client_type,
      full_name,
      company_name,
      national_id,
      tax_number,
      email,
      phone,
      secondary_phone,
      address,
      city,
      country,
      notes,
      status
    } = req.body;

    const clients = getClientsCollection();

    const newClient = {
      client_type,
      full_name,
      company_name: company_name || null,
      national_id: national_id || null,
      tax_number: tax_number || null,
      email: email || null,
      phone,
      secondary_phone: secondary_phone || null,
      address: address || null,
      city: city || null,
      country: country || 'Sudan',
      notes: notes || null,
      status: status || 'active',
      created_by: req.user?.id || null,
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await clients.insertOne(newClient);

    res.status(201).json({
      success: true,
      message: 'Client created successfully',
      data: { id: result.insertedId }
    });
  } catch (error) {
    next(error);
  }
};

// Update client
export const updateClient = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const allowedFields = [
      'client_type', 'full_name', 'company_name', 'national_id', 'tax_number',
      'email', 'phone', 'secondary_phone', 'address', 'city', 'country', 'notes', 'status'
    ];

    const updateDoc = { updated_at: new Date() };

    Object.keys(updates).forEach(key => {
      if (allowedFields.includes(key)) {
        updateDoc[key] = updates[key];
      }
    });

    if (Object.keys(updateDoc).length === 1) { // Only updated_at
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    const clients = getClientsCollection();
    const result = await clients.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateDoc }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    res.json({
      success: true,
      message: 'Client updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// Delete client
export const deleteClient = async (req, res, next) => {
  try {
    const { id } = req.params;
    const clients = getClientsCollection();

    const result = await clients.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Client not found'
      });
    }

    res.json({
      success: true,
      message: 'Client deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
