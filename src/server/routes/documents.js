const express = require('express');
const crypto = require('crypto');
const { Document } = require('../services/mongo');
const { upload, storeFile, streamFile } = require('../services/storage-gridfs');
const { requireScope } = require('../middlewares/auth');
const { runOcrJob } = require('../jobs/ocr-job');

const router = express.Router();

// POST / — upload PDF
router.post('/', requireScope('write'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const buffer = req.file.buffer;
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    const gridfsId = await storeFile(buffer, req.file.originalname);

    const doc = await Document.create({
      filename:  req.file.originalname,
      gridfsId,
      sha256,
      mimeType:  req.file.mimetype,
      ocrStatus: 'PENDING',
    });

    // fire-and-forget
    runOcrJob(doc._id).catch((err) => console.error('[documents] ocr-job error:', err));

    return res.status(201).json({
      _id:        doc._id,
      filename:   doc.filename,
      ocrStatus:  doc.ocrStatus,
      uploadedAt: doc.uploadedAt,
    });
  } catch (err) {
    console.error('[documents] upload error:', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// Handle multer errors (e.g. file too large, wrong mime)
router.use((err, _req, res, _next) => {
  if (err && err.status === 400) {
    return res.status(400).json({ error: err.message });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large' });
  }
  console.error('[documents] middleware error:', err);
  return res.status(500).json({ error: 'Internal server error' });
});

// GET /:id — metadata
router.get('/:id', requireScope('read'), async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });

    return res.json({
      _id:        doc._id,
      filename:   doc.filename,
      ocrStatus:  doc.ocrStatus,
      pageCount:  doc.pageCount,
      uploadedAt: doc.uploadedAt,
    });
  } catch (err) {
    console.error('[documents] get error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/pdf — stream PDF from GridFS
router.get('/:id/pdf', requireScope('read'), async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${doc.filename}"`);
    streamFile(doc.gridfsId, res);
  } catch (err) {
    console.error('[documents] pdf stream error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/ocr — OCR result
router.get('/:id/ocr', requireScope('read'), async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });

    if (doc.ocrStatus !== 'DONE') {
      return res.status(409).json({ error: 'OCR not ready', ocrStatus: doc.ocrStatus });
    }

    return res.json({
      pageCount: doc.pageCount,
      encoding:  doc.ocrEncoding,
      canonical: doc.ocrCanonical,
    });
  } catch (err) {
    console.error('[documents] ocr error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
