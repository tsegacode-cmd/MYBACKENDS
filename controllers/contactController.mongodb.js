import { getMongoDB, isMongoDBAvailable } from '../config/databaseManager.js';

// Get all contact inquiries
export const getAllInquiries = async (req, res, next) => {
  try {
    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available',
        data: [],
        pagination: { page: 1, limit: 10, total: 0, pages: 0 }
      });
    }

    const { status, inquiry_type, priority, page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const db = getMongoDB();
    const inquiriesCollection = db.collection('contact_inquiries');

    // Build query
    const query = {};
    if (status) query.status = status;
    if (inquiry_type) query.inquiry_type = inquiry_type;
    if (priority) query.priority = priority;

    // Get inquiries with pagination
    const inquiries = await inquiriesCollection
      .find(query)
      .sort({ priority: -1, created_at: -1 })
      .skip(parseInt(skip))
      .limit(parseInt(limit))
      .toArray();

    // Enrich with assigned user info
    for (const inquiry of inquiries) {
      if (inquiry.assigned_to) {
        const user = await db.collection('users').findOne({ _id: inquiry.assigned_to });
        inquiry.assigned_to_name = user?.full_name || null;
      }
    }

    // Get total count
    const total = await inquiriesCollection.countDocuments(query);

    res.json({
      success: true,
      data: inquiries,
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

// Get inquiry by ID
export const getInquiryById = async (req, res, next) => {
  try {
    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }

    const { id } = req.params;
    const db = getMongoDB();

    const inquiry = await db.collection('contact_inquiries').findOne({ _id: parseInt(id) });

    if (!inquiry) {
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    // Enrich with assigned user info
    if (inquiry.assigned_to) {
      const user = await db.collection('users').findOne({ _id: inquiry.assigned_to });
      inquiry.assigned_to_name = user?.full_name || null;
    }

    res.json({
      success: true,
      data: inquiry
    });
  } catch (error) {
    next(error);
  }
};

// Create new inquiry (public endpoint)
export const createInquiry = async (req, res, next) => {
  try {
    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }

    const {
      inquiry_type,
      full_name,
      email,
      phone,
      subject,
      message,
      priority
    } = req.body;

    const db = getMongoDB();
    const inquiriesCollection = db.collection('contact_inquiries');

    // Get next ID
    const lastInquiry = await inquiriesCollection.find().sort({ _id: -1 }).limit(1).toArray();
    const nextId = lastInquiry.length > 0 ? lastInquiry[0]._id + 1 : 1;

    const newInquiry = {
      _id: nextId,
      inquiry_type,
      full_name,
      email,
      phone,
      subject: subject || null,
      message,
      status: 'new',
      priority: priority || 'medium',
      assigned_to: null,
      response: null,
      responded_at: null,
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
      created_at: new Date(),
      updated_at: new Date()
    };

    await inquiriesCollection.insertOne(newInquiry);

    res.status(201).json({
      success: true,
      message: 'Inquiry submitted successfully. We will contact you soon.',
      data: { id: nextId }
    });
  } catch (error) {
    next(error);
  }
};

// Update inquiry (admin only)
export const updateInquiry = async (req, res, next) => {
  try {
    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }

    const { id } = req.params;
    const updates = req.body;

    const allowedFields = ['status', 'priority', 'assigned_to', 'response'];

    const updateDoc = {};

    Object.keys(updates).forEach(key => {
      if (allowedFields.includes(key)) {
        updateDoc[key] = updates[key];
      }
    });

    // Add responded_at if response is provided
    if (updates.response) {
      updateDoc.responded_at = new Date();
    }

    if (Object.keys(updateDoc).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    updateDoc.updated_at = new Date();

    const db = getMongoDB();
    const result = await db.collection('contact_inquiries').updateOne(
      { _id: parseInt(id) },
      { $set: updateDoc }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    res.json({
      success: true,
      message: 'Inquiry updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

// Delete inquiry
export const deleteInquiry = async (req, res, next) => {
  try {
    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available'
      });
    }

    const { id } = req.params;
    const db = getMongoDB();

    const result = await db.collection('contact_inquiries').deleteOne({ _id: parseInt(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Inquiry not found'
      });
    }

    res.json({
      success: true,
      message: 'Inquiry deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// Get inquiry statistics
export const getInquiryStats = async (req, res, next) => {
  try {
    if (!isMongoDBAvailable()) {
      return res.status(503).json({
        success: false,
        message: 'Database not available',
        data: []
      });
    }

    const db = getMongoDB();

    const stats = await db.collection('contact_inquiries').aggregate([
      {
        $group: {
          _id: '$inquiry_type',
          total: { $sum: 1 },
          new_count: {
            $sum: { $cond: [{ $eq: ['$status', 'new'] }, 1, 0] }
          },
          in_progress: {
            $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] }
          },
          resolved: {
            $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] }
          },
          closed: {
            $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] }
          }
        }
      },
      {
        $project: {
          inquiry_type: '$_id',
          total: 1,
          new_count: 1,
          in_progress: 1,
          resolved: 1,
          closed: 1,
          _id: 0
        }
      }
    ]).toArray();

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    next(error);
  }
};
