import express from 'express';
import multer from 'multer';
import { uploadMedia } from '../config/cloudinary.js';

const router = express.Router();
const parseMediaUpload = uploadMedia.single('file');

router.post('/upload', (req, res, next) => {
  parseMediaUpload(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error instanceof multer.MulterError) {
      const statusCode = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      res.status(statusCode).json({ success: false, message: error.message });
      return;
    }

    if (error.statusCode === 415) {
      res.status(415).json({ success: false, message: error.message });
      return;
    }

    next(error);
  });
}, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Please select a file to upload.' });
  }

  res.json({
    success: true,
    message: 'File uploaded successfully.',
    fileUrl: req.file.path,
    format: req.file.mimetype,
  });
});

export default router;
