import { getMongoDB } from '../config/databaseManager.js';
import { ObjectId } from 'mongodb';

/**
 * MongoDB-only Data Registration Controller
 * All data persists to MongoDB - no in-memory fallback
 */

// Get MongoDB collection
const getRegistrationsCollection = () => {
  const db = getMongoDB();
  return db.collection('data_registrations');
};

// Create new data registration
export const createRegistration = async (req, res, next) => {
  try {
    const {
      work_type,
      staff_id,
      staff_username,
      staff_full_name,
      client_name,
      kebele,
      house_no,
      client_phone,
      tv_no,
      person,
      client_email,
      condition,
      sign,
      gov_letter,
      paid_amount,
      payment_status,
      round,
      registered_at
    } = req.body;
    const registrationRound = Number(round ?? 1);
    if (!Number.isInteger(registrationRound) || registrationRound < 1) {
      return res.status(400).json({ success: false, message: 'Round must be a positive whole number' });
    }

    // Validate required fields
    if (!work_type || !client_name || !kebele || !client_phone || !tv_no || !person || !condition || !sign) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: work_type, client_name, kebele, client_phone, tv_no, person, condition, sign'
      });
    }

    const registrations = getRegistrationsCollection();

    // Create registration document
    const newRegistration = {
      work_type,
      staff_id: staff_id || null,
      staff_username: staff_username || 'N/A',
      staff_full_name: staff_full_name || 'N/A',
      client_name,
      kebele,
      house_no: house_no || null,
      client_phone,
      tv_no,
      person,
      client_email: client_email || null,
      condition,
      sign,
      gov_letter: gov_letter || 'accept',
      paid_amount: paid_amount || null,
      payment_status: payment_status || 'unpaid',
      round: registrationRound,
      registered_at: registered_at ? new Date(registered_at) : new Date(),
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await registrations.insertOne(newRegistration);

    console.log(`✅ Registration saved to MongoDB (ID: ${result.insertedId})`);

    res.status(201).json({
      success: true,
      message: 'Data registration created successfully',
      data: {
        id: result.insertedId,
        ...newRegistration
      }
    });
  } catch (error) {
    next(error);
  }
};

// Get all data registrations
export const getAllRegistrations = async (req, res, next) => {
  try {
    const registrations = getRegistrationsCollection();
    
    const registrationList = await registrations
      .find({})
      .sort({ registered_at: -1, created_at: -1 })
      .toArray();

    console.log(`✅ Loaded ${registrationList.length} registrations from MongoDB`);

    res.json({
      success: true,
      data: registrationList
    });
  } catch (error) {
    next(error);
  }
};

// Get single registration by ID
export const getRegistrationById = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Validate ObjectId format
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid registration ID format'
      });
    }
    
    const registrations = getRegistrationsCollection();

    const registration = await registrations.findOne({ _id: new ObjectId(id) });

    if (!registration) {
      return res.status(404).json({
        success: false,
        message: 'Registration not found'
      });
    }

    res.json({
      success: true,
      data: registration
    });
  } catch (error) {
    next(error);
  }
};

// Update data registration
export const updateRegistration = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Aggressive logging
    console.log('🔧 UPDATE REGISTRATION BACKEND');
    console.log('Received ID:', id);
    console.log('ID type:', typeof id);
    console.log('ID length:', id ? id.length : 0);
    console.log('ID value:', JSON.stringify(id));
    
    // Sanitize ID - remove any whitespace or special characters
    const cleanId = String(id).trim();
    
    console.log('Cleaned ID:', cleanId);
    console.log('Cleaned ID length:', cleanId.length);
    
    // Validate ObjectId format
    if (!ObjectId.isValid(cleanId)) {
      console.error('❌ INVALID OBJECTID FORMAT');
      console.error('ID must be a 24-character hex string');
      console.error('Received:', cleanId);
      console.error('Length:', cleanId.length);
      
      return res.status(400).json({
        success: false,
        message: `Invalid registration ID format. Expected 24-character hex string, got: ${cleanId} (length: ${cleanId.length})`
      });
    }
    
    const {
      work_type,
      staff_id,
      staff_username,
      staff_full_name,
      client_name,
      kebele,
      house_no,
      client_phone,
      tv_no,
      person,
      client_email,
      condition,
      sign,
      gov_letter,
      paid_amount,
      payment_status,
      round,
      product_service,
      amount,
      commission_rate,
      notes
    } = req.body;

    const registrations = getRegistrationsCollection();
    const updates = { updated_at: new Date() };

    if (work_type) updates.work_type = work_type;
    if (staff_id !== undefined) updates.staff_id = staff_id || null;
    if (staff_username) updates.staff_username = staff_username;
    if (staff_full_name) updates.staff_full_name = staff_full_name;
    if (client_name) updates.client_name = client_name;
    if (kebele) updates.kebele = kebele;
    if (house_no !== undefined) updates.house_no = house_no || null;
    if (client_phone) updates.client_phone = client_phone;
    if (tv_no) updates.tv_no = tv_no;
    if (person) updates.person = person;
    if (client_email !== undefined) updates.client_email = client_email || null;
    if (condition) updates.condition = condition;
    if (sign) updates.sign = sign;
    if (gov_letter) updates.gov_letter = gov_letter;
    if (paid_amount !== undefined) updates.paid_amount = paid_amount || null;
    if (payment_status) updates.payment_status = payment_status;
    if (round !== undefined) {
      const registrationRound = Number(round);
      if (!Number.isInteger(registrationRound) || registrationRound < 1) {
        return res.status(400).json({ success: false, message: 'Round must be a positive whole number' });
      }
      updates.round = registrationRound;
    }
    if (product_service) updates.product_service = product_service;
    if (amount !== undefined) updates.amount = amount;
    if (commission_rate !== undefined) updates.commission_rate = commission_rate || null;
    if (notes !== undefined) updates.notes = notes || null;

    console.log('✅ Creating ObjectId from:', cleanId);
    const result = await registrations.updateOne(
      { _id: new ObjectId(cleanId) },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Registration not found'
      });
    }

    const updatedRegistration = await registrations.findOne({ _id: new ObjectId(cleanId) });
    console.log('✅ Registration updated successfully');
    res.json({
      success: true,
      message: 'Registration updated successfully',
      data: updatedRegistration
    });
  } catch (error) {
    console.error('❌ UPDATE REGISTRATION ERROR:', error);
    next(error);
  }
};

// Delete data registration
export const deleteRegistration = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // Aggressive logging
    console.log('🗑️ DELETE REGISTRATION BACKEND');
    console.log('Received ID:', id);
    console.log('ID type:', typeof id);
    console.log('ID length:', id ? id.length : 0);
    console.log('ID value:', JSON.stringify(id));
    
    // Sanitize ID - remove any whitespace or special characters
    const cleanId = String(id).trim();
    
    console.log('Cleaned ID:', cleanId);
    console.log('Cleaned ID length:', cleanId.length);
    
    // Validate ObjectId format
    if (!ObjectId.isValid(cleanId)) {
      console.error('❌ INVALID OBJECTID FORMAT');
      console.error('ID must be a 24-character hex string');
      console.error('Received:', cleanId);
      console.error('Length:', cleanId.length);
      
      return res.status(400).json({
        success: false,
        message: `Invalid registration ID format. Expected 24-character hex string, got: ${cleanId} (length: ${cleanId.length})`
      });
    }
    
    const registrations = getRegistrationsCollection();

    console.log('✅ Creating ObjectId from:', cleanId);
    const result = await registrations.deleteOne({ _id: new ObjectId(cleanId) });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Registration not found'
      });
    }

    res.json({
      success: true,
      message: 'Registration deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// Get registration statistics
export const getRegistrationStats = async (req, res, next) => {
  try {
    const registrations = getRegistrationsCollection();

    const stats = await registrations.aggregate([
      {
        $facet: {
          total: [{ $count: 'count' }],
          byWorkType: [
            { $group: { _id: '$work_type', count: { $sum: 1 } } }
          ],
          byPaymentStatus: [
            { $group: { _id: '$payment_status', count: { $sum: 1 } } }
          ],
          totalPaid: [
            { 
              $group: { 
                _id: null, 
                total: { $sum: { $ifNull: ['$paid_amount', 0] } } 
              } 
            }
          ]
        }
      }
    ]).toArray();

    res.json({
      success: true,
      data: stats[0]
    });
  } catch (error) {
    next(error);
  }
};
