import 'dotenv/config';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import multer from 'multer';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const documentMimeTypes = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
]);

const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'redsea_brokerage',
    allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      callback(new Error('Only JPG, PNG, and WebP image files are allowed.'));
      return;
    }
    callback(null, true);
  },
});

const mediaStorage = new CloudinaryStorage({
  cloudinary,
  params: async (_req, file) => {
    const isDocument = documentMimeTypes.has(file.mimetype);

    return {
      folder: 'redsea_all_uploads',
      resource_type: isDocument ? 'raw' : 'auto',
      public_id: `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, '_')}`,
    };
  },
});

export const uploadMedia = multer({
  storage: mediaStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const isImage = file.mimetype.startsWith('image/') && file.mimetype !== 'image/svg+xml';
    const isVideo = file.mimetype.startsWith('video/');

    if (!isImage && !isVideo && !documentMimeTypes.has(file.mimetype)) {
      const error = new Error('Only image, video, PDF, Word, Excel, CSV, and plain text files are allowed.');
      error.statusCode = 415;
      callback(error);
      return;
    }

    callback(null, true);
  },
});

export { cloudinary };
