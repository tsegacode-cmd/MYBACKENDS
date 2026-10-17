import { getRawSQLiteDB } from '../config/databaseManager.js';

const PROJECT_TITLE_SETTINGS_KEY = 'ebc_project_title_settings';
const MAX_PDF_BYTES = 4 * 1024 * 1024;
const MAX_REGISTRATION_IMAGE_BYTES = 2 * 1024 * 1024;

const isValidPdfDataUrl = value => {
  if (value == null || value === '') return true;
  if (typeof value !== 'string') return false;
  const match = value.match(/^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || Math.floor(match[1].length * 3 / 4) > MAX_PDF_BYTES) return false;
  return Buffer.from(match[1], 'base64').subarray(0, 5).toString('ascii') === '%PDF-';
};

const isValidRegistrationImageDataUrl = value => {
  if (value == null || value === '') return true;
  if (typeof value !== 'string') return false;
  const match = value.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return false;
  const imageBytes = Buffer.from(match[2], 'base64');
  if (imageBytes.length > MAX_REGISTRATION_IMAGE_BYTES) return false;

  switch (match[1].toLowerCase()) {
    case 'jpeg':
      return imageBytes.length >= 3 && imageBytes[0] === 0xff && imageBytes[1] === 0xd8 && imageBytes[2] === 0xff;
    case 'png':
      return imageBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'webp':
      return imageBytes.length >= 12 &&
        imageBytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        imageBytes.subarray(8, 12).toString('ascii') === 'WEBP';
    default:
      return false;
  }
};

const saveRegistrationImage = (db, registrationId, imageData) => {
  if (imageData) {
    db.prepare(`
      INSERT INTO registration_image_documents (registration_id, image_data, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(registration_id) DO UPDATE SET image_data = excluded.image_data, updated_at = excluded.updated_at
    `).run(registrationId, imageData, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM registration_image_documents WHERE registration_id = ?').run(registrationId);
  }
};

export const getProjectDocuments = async (req, res, next) => {
  try {
    const db = getRawSQLiteDB();
    const documents = db.prepare('SELECT project_title, pdf_data FROM project_documents ORDER BY project_title').all();
    return res.json({ success: true, data: documents });
  } catch (error) {
    return next(error);
  }
};

export const getBankReceiptDocument = async (req, res, next) => {
  try {
    const db = getRawSQLiteDB();
    const row = db.prepare('SELECT pdf_data FROM bank_receipt_documents WHERE registration_id = ?')
      .get(req.params.id);
    return res.json({ success: true, data: row?.pdf_data || null });
  } catch (error) {
    return next(error);
  }
};

export const getOwnerReceiptDocument = async (req, res, next) => {
  try {
    const db = getRawSQLiteDB();
    const row = db.prepare('SELECT pdf_data FROM owner_receipt_documents WHERE registration_id = ?')
      .get(req.params.id);
    return res.json({ success: true, data: row?.pdf_data || null });
  } catch (error) {
    return next(error);
  }
};

const saveRegistrationDocument = (db, table, id, pdfData) => {
  if (pdfData) {
    db.prepare(`
      INSERT INTO ${table} (registration_id, pdf_data, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(registration_id) DO UPDATE SET pdf_data = excluded.pdf_data, updated_at = excluded.updated_at
    `).run(id, pdfData, new Date().toISOString());
  } else {
    db.prepare(`DELETE FROM ${table} WHERE registration_id = ?`).run(id);
  }
};

export const saveProjectDocument = async (req, res, next) => {
  try {
    const projectTitle = String(req.params.title || '').trim();
    const pdfData = req.body?.pdf_data;
    if (!projectTitle || projectTitle.length > 200 || !isValidPdfDataUrl(pdfData) || !pdfData) {
      return res.status(400).json({ success: false, message: 'Provide a project title and a PDF file no larger than 4 MB.' });
    }
    const db = getRawSQLiteDB();
    db.prepare(`
      INSERT INTO project_documents (project_title, pdf_data, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(project_title) DO UPDATE SET pdf_data = excluded.pdf_data, updated_at = excluded.updated_at
    `).run(projectTitle, pdfData, new Date().toISOString());
    return res.json({ success: true, data: { project_title: projectTitle, pdf_data: pdfData } });
  } catch (error) {
    return next(error);
  }
};

export const deleteProjectDocument = async (req, res, next) => {
  try {
    const db = getRawSQLiteDB();
    db.prepare('DELETE FROM project_documents WHERE project_title = ?').run(String(req.params.title || '').trim());
    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
};

export const getProjectTitleSettings = async (_req, res, next) => {
  try {
    const db = getRawSQLiteDB();
    const row = db.prepare('SELECT configJson FROM service_payment_settings WHERE configKey = ?')
      .get(PROJECT_TITLE_SETTINGS_KEY);
    const settings = row ? JSON.parse(row.configJson) : { titles: [], defaultTitle: '' };
    return res.json({ success: true, data: settings });
  } catch (error) {
    return next(error);
  }
};

export const saveProjectTitleSettings = async (req, res, next) => {
  try {
    const { titles, defaultTitle } = req.body || {};
    if (
      !Array.isArray(titles) ||
      titles.length > 200 ||
      titles.some(title => typeof title !== 'string' || !title.trim() || title.trim().length > 200) ||
      typeof defaultTitle !== 'string' ||
      (defaultTitle && !titles.some(title => title.trim() === defaultTitle.trim()))
    ) {
      return res.status(400).json({ success: false, message: 'Provide a valid project title list and a default title from that list.' });
    }

    const normalizedTitles = [...new Set(titles.map(title => title.trim()))];
    const normalizedDefault = defaultTitle.trim();
    const settings = {
      titles: normalizedTitles,
      defaultTitle: normalizedTitles.includes(normalizedDefault) ? normalizedDefault : (normalizedTitles[0] || ''),
    };
    const db = getRawSQLiteDB();
    db.prepare(`
      INSERT INTO service_payment_settings (configKey, configJson, updatedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(configKey) DO UPDATE SET configJson = excluded.configJson, updatedAt = excluded.updatedAt
    `).run(PROJECT_TITLE_SETTINGS_KEY, JSON.stringify(settings), new Date().toISOString());
    if (normalizedTitles.length > 0) {
      const placeholders = normalizedTitles.map(() => '?').join(', ');
      db.prepare(`DELETE FROM project_documents WHERE project_title NOT IN (${placeholders})`).run(...normalizedTitles);
    } else {
      db.prepare('DELETE FROM project_documents').run();
    }

    return res.json({ success: true, data: settings });
  } catch (error) {
    return next(error);
  }
};

// Get all data registrations
export const getAllRegistrations = async (req, res, next) => {
  try {
    const db = getRawSQLiteDB();
    
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database not available'
      });
    }

    const registrations = db.prepare(`
      SELECT registration.*,
        EXISTS (
          SELECT 1 FROM registration_image_documents image
          WHERE image.registration_id = registration._id
        ) AS has_registration_image
      FROM data_registrations registration
      ORDER BY registration.created_at DESC
    `).all();
    
    // Convert _id to id for frontend compatibility
    const formattedRegistrations = registrations.map(reg => ({
      ...reg,
      id: reg._id,
      has_registration_image: Boolean(reg.has_registration_image)
    }));

    res.json({
      success: true,
      data: formattedRegistrations
    });
  } catch (error) {
    console.error('Failed to get registrations:', error);
    next(error);
  }
};

// Get single registration by ID
export const getRegistrationById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const db = getRawSQLiteDB();
    
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database not available'
      });
    }

    const registration = db.prepare('SELECT * FROM data_registrations WHERE _id = ?').get(id);

    if (!registration) {
      return res.status(404).json({
        success: false,
        message: 'Registration not found'
      });
    }

    res.json({
      success: true,
      data: {
        ...registration,
        id: registration._id,
        has_registration_image: Boolean(db.prepare(
          'SELECT 1 FROM registration_image_documents WHERE registration_id = ?'
        ).get(id)),
        bank_receipt_pdf: db.prepare('SELECT pdf_data FROM bank_receipt_documents WHERE registration_id = ?').get(id)?.pdf_data || null
      }
    });
  } catch (error) {
    console.error('Failed to get registration:', error);
    next(error);
  }
};

export const getRegistrationImage = async (req, res, next) => {
  try {
    const db = getRawSQLiteDB();
    const row = db.prepare('SELECT image_data FROM registration_image_documents WHERE registration_id = ?')
      .get(req.params.id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Registration image not found' });
    }
    return res.json({ success: true, data: row.image_data });
  } catch (error) {
    return next(error);
  }
};

// Create new data registration

// Create new data registration - BULLETPROOF VERSION
export const createRegistration = async (req, res, next) => {
  try {
    console.log('🔴 BULLETPROOF INSERT - Received fields:', Object.keys(req.body));

    const registrationRound = Number(req.body.round ?? 1);
    if (!Number.isInteger(registrationRound) || registrationRound < 1) {
      return res.status(400).json({ success: false, message: 'Round must be a positive whole number' });
    }
    if (!isValidPdfDataUrl(req.body?.bank_receipt_pdf) || !isValidPdfDataUrl(req.body?.owner_receipt_pdf)) {
      return res.status(400).json({ success: false, message: 'Receipt attachments must be PDFs no larger than 4 MB.' });
    }
    if (!isValidRegistrationImageDataUrl(req.body?.registration_image)) {
      return res.status(400).json({ success: false, message: 'Registration images must be JPEG, PNG, or WebP and no larger than 2 MB.' });
    }
    if (req.body?.transaction_number != null && (
      typeof req.body.transaction_number !== 'string' || req.body.transaction_number.length > 2000
    )) {
      return res.status(400).json({ success: false, message: 'Transaction number must be text no longer than 2000 characters.' });
    }
    
    const db = getRawSQLiteDB();
    if (!db) {
      return res.status(500).json({ success: false, message: 'Database not available' });
    }

    // Get actual database columns dynamically
    const tableInfo = db.prepare('PRAGMA table_info(data_registrations)').all();
    const dbColumns = tableInfo.map(col => col.name);
    console.log('🔍 Database has', dbColumns.length, 'columns:', dbColumns);

    // BULLETPROOF: Only use columns that exist in database (excluding auto fields)
    const autoFields = ['_id', 'created_at', 'updated_at'];
    const insertableColumns = dbColumns.filter(col => !autoFields.includes(col));
    
    console.log('🟢 Insertable columns:', insertableColumns.length, insertableColumns);

    // Build data object with only insertable columns
    const insertData = {};
    insertableColumns.forEach(column => {
      if (column === 'round') {
        insertData[column] = registrationRound;
      } else if (req.body[column] !== undefined) {
        insertData[column] = req.body[column];
      } else {
        // Set defaults for missing fields
        switch (column) {
          case 'work_type': insertData[column] = req.body.work_type || null; break;
          case 'staff_id': insertData[column] = req.body.staff_id || null; break;
          case 'staff_username': insertData[column] = req.body.staff_username || 'N/A'; break;
          case 'staff_full_name': insertData[column] = req.body.staff_full_name || 'N/A'; break;
          case 'client_name': insertData[column] = req.body.client_name || req.body.payer_name || ''; break;
          case 'city': insertData[column] = req.body.city || 'Harar'; break;
          case 'kebele': insertData[column] = req.body.kebele || ''; break;
          case 'house_no': insertData[column] = req.body.house_no || null; break;
          case 'receipt_no': insertData[column] = req.body.receipt_no || null; break;
          case 'client_phone': insertData[column] = req.body.client_phone || ''; break;
          case 'tv_no': insertData[column] = req.body.tv_no || '1'; break;
          case 'person': insertData[column] = req.body.person || 'personal'; break;
          case 'client_email': insertData[column] = req.body.client_email || null; break;
          case 'condition': insertData[column] = req.body.condition || 'new'; break;
          case 'sign': insertData[column] = req.body.sign || 'sign'; break;
          case 'gov_letter': insertData[column] = req.body.gov_letter || 'accept'; break;
          case 'paid_amount': insertData[column] = req.body.paid_amount || null; break;
          case 'payment_status': insertData[column] = req.body.payment_status || 'unpaid'; break;
          case 'round': insertData[column] = registrationRound; break;
          case 'payment_period_type': insertData[column] = req.body.payment_period_type || '2014-2018'; break;
          case 'payment_period_from': insertData[column] = req.body.payment_period_from || null; break;
          case 'payment_period_to': insertData[column] = req.body.payment_period_to || null; break;
          case 'commission_period_amount': insertData[column] = req.body.commission_period_amount || null; break;
          case 'commission_fee': insertData[column] = req.body.commission_fee || null; break;
          case 'commission_total': insertData[column] = req.body.commission_total || null; break;
          case 'collected_amount': insertData[column] = req.body.collected_amount || null; break;
          case 'registration_datetime': insertData[column] = req.body.registration_datetime || null; break;
          case 'registered_at': insertData[column] = new Date().toISOString(); break;
          default: insertData[column] = null;
        }
      }
    });

    // Validate required fields (flexible - works with client_name)
    const nameField = insertData.client_name;
    if (!nameField || !insertData.kebele || !insertData.client_phone) {
      console.log('❌ Missing required fields');
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: Payer Name, Kebele, Client Phone',
        debug: { 
          client_name: nameField, 
          kebele: insertData.kebele, 
          client_phone: insertData.client_phone,
          received_fields: Object.keys(req.body)
        }
      });
    }

    const finalColumns = Object.keys(insertData);
    const finalValues = Object.values(insertData);
    
    console.log('🎯 FINAL INSERT:');
    console.log('   Columns:', finalColumns.length);
    console.log('   Values:', finalValues.length);
    console.log('   Column names:', finalColumns);

    // BULLETPROOF INSERT
    const placeholders = finalColumns.map(() => '?').join(', ');
    const sql = `INSERT INTO data_registrations (${finalColumns.join(', ')}) VALUES (${placeholders})`;
    
    console.log('📝 SQL:', sql);
    
    const stmt = db.prepare(sql);
    const result = stmt.run(...finalValues);
    if (req.body.bank_receipt_pdf) {
      saveRegistrationDocument(db, 'bank_receipt_documents', result.lastInsertRowid, req.body.bank_receipt_pdf);
    }
    if (req.body.owner_receipt_pdf) {
      saveRegistrationDocument(db, 'owner_receipt_documents', result.lastInsertRowid, req.body.owner_receipt_pdf);
    }
    if (req.body.registration_image) {
      saveRegistrationImage(db, result.lastInsertRowid, req.body.registration_image);
    }
    const savedRegistration = db
      .prepare('SELECT * FROM data_registrations WHERE _id = ?')
      .get(result.lastInsertRowid);

    if (Number(savedRegistration?.round) !== registrationRound) {
      throw new Error(`Database saved Round ${savedRegistration?.round}; expected Round ${registrationRound}`);
    }

    console.log('✅ BULLETPROOF INSERT SUCCESS - ID:', result.lastInsertRowid, 'Round:', savedRegistration.round);
    res.status(201).json({
      success: true,
      message: 'Registration created successfully',
      data: { ...savedRegistration, id: savedRegistration._id }
    });

  } catch (error) {
    console.error('❌ BULLETPROOF INSERT FAILED:', error);
    res.status(500).json({ success: false, message: 'Insert failed: ' + error.message });
  }
};


export const updateRegistration = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };
    if (
      (Object.prototype.hasOwnProperty.call(updates, 'bank_receipt_pdf') && !isValidPdfDataUrl(updates.bank_receipt_pdf)) ||
      (Object.prototype.hasOwnProperty.call(updates, 'owner_receipt_pdf') && !isValidPdfDataUrl(updates.owner_receipt_pdf))
    ) {
      return res.status(400).json({ success: false, message: 'Receipt attachments must be PDFs no larger than 4 MB.' });
    }
    const bankReceiptPdf = updates.bank_receipt_pdf;
    const ownerReceiptPdf = updates.owner_receipt_pdf;
    const registrationImage = updates.registration_image;
    if (Object.prototype.hasOwnProperty.call(updates, 'registration_image') && !isValidRegistrationImageDataUrl(registrationImage)) {
      return res.status(400).json({ success: false, message: 'Registration images must be JPEG, PNG, or WebP and no larger than 2 MB.' });
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'transaction_number') && updates.transaction_number != null && (
      typeof updates.transaction_number !== 'string' || updates.transaction_number.length > 2000
    )) {
      return res.status(400).json({ success: false, message: 'Transaction number must be text no longer than 2000 characters.' });
    }
    delete updates.bank_receipt_pdf;
    delete updates.owner_receipt_pdf;
    delete updates.registration_image;

    const db = getRawSQLiteDB();
    
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database not available'
      });
    }

    // Get existing columns from the table
    const tableInfo = db.prepare('PRAGMA table_info(data_registrations)').all();
    const existingColumns = new Set(tableInfo.map(col => col.name));

    // Filter updates to only include fields that exist in the database
    const filteredUpdates = {};
    const skippedFields = [];
    
    for (const [key, value] of Object.entries(updates)) {
      if (existingColumns.has(key)) {
        if (key === 'round') {
          const registrationRound = Number(value);
          if (!Number.isInteger(registrationRound) || registrationRound < 1) {
            return res.status(400).json({ success: false, message: 'Round must be a positive whole number' });
          }
          filteredUpdates[key] = registrationRound;
        } else {
          filteredUpdates[key] = value;
        }
      } else {
        skippedFields.push(key);
      }
    }

    // Log skipped fields for debugging
    if (skippedFields.length > 0) {
      console.log(`Skipped non-existent columns: ${skippedFields.join(', ')}`);
    }

    // Build dynamic UPDATE query with filtered fields
    const fields = [];
    const values = [];

    for (const [key, value] of Object.entries(filteredUpdates)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }

    if (fields.length === 0 && bankReceiptPdf === undefined && ownerReceiptPdf === undefined && registrationImage === undefined) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }

    let result = { changes: 0 };
    if (fields.length > 0) {
      fields.push('updated_at = datetime(\'now\')');
      values.push(id);
      const stmt = db.prepare(`
        UPDATE data_registrations
        SET ${fields.join(', ')}
        WHERE _id = ?
      `);
      result = stmt.run(...values);
    } else {
      result = { changes: db.prepare('SELECT 1 FROM data_registrations WHERE _id = ?').get(id) ? 1 : 0 };
    }

    if (result.changes === 0) {
      return res.status(404).json({
        success: false,
        message: 'Registration not found'
      });
    }
    if (bankReceiptPdf !== undefined) saveRegistrationDocument(db, 'bank_receipt_documents', id, bankReceiptPdf);
    if (ownerReceiptPdf !== undefined) saveRegistrationDocument(db, 'owner_receipt_documents', id, ownerReceiptPdf);
    if (registrationImage !== undefined) saveRegistrationImage(db, id, registrationImage);

    const updatedRegistration = db
      .prepare('SELECT * FROM data_registrations WHERE _id = ?')
      .get(id);
    res.json({
      success: true,
      message: 'Registration updated successfully',
      data: { ...updatedRegistration, id: updatedRegistration._id },
      skippedFields: skippedFields.length > 0 ? skippedFields : undefined
    });
  } catch (error) {
    console.error('Failed to update registration:', error);
    next(error);
  }
};

// Delete data registration
export const deleteRegistration = async (req, res, next) => {
  try {
    const { id } = req.params;
    const db = getRawSQLiteDB();
    
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Database not available'
      });
    }

    const stmt = db.prepare('DELETE FROM data_registrations WHERE _id = ?');
    const result = stmt.run(id);

    if (result.changes === 0) {
      return res.status(404).json({
        success: false,
        message: 'Registration not found'
      });
    }
    db.prepare('DELETE FROM bank_receipt_documents WHERE registration_id = ?').run(id);
    db.prepare('DELETE FROM owner_receipt_documents WHERE registration_id = ?').run(id);
    db.prepare('DELETE FROM registration_image_documents WHERE registration_id = ?').run(id);

    res.json({
      success: true,
      message: 'Registration deleted successfully'
    });
  } catch (error) {
    console.error('Failed to delete registration:', error);
    next(error);
  }
};
