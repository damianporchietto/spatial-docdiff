const multer = require('multer');
const { Readable } = require('stream');
const { GridFSBucket } = require('mongodb');
const { mongoose } = require('./mongo');

const MAX_MB = parseInt(process.env.MAX_UPLOAD_MB || '50', 10);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('Only PDF files are allowed'), { status: 400 }));
    }
  },
});

function getBucket() {
  return new GridFSBucket(mongoose.connection.db, { bucketName: 'pdfs' });
}

async function storeFile(buffer, filename) {
  const bucket = getBucket();
  const readable = Readable.from(buffer);
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename);
    readable.pipe(uploadStream)
      .on('error', reject)
      .on('finish', () => resolve(uploadStream.id));
  });
}

function streamFile(gridfsId, res) {
  const bucket = getBucket();
  bucket.openDownloadStream(gridfsId).pipe(res);
}

module.exports = { upload, storeFile, streamFile };
