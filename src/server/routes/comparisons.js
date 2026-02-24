const express = require('express');
const { Document, Comparison } = require('../services/mongo');
const { requireScope } = require('../middlewares/auth');
const { runCompareJob } = require('../jobs/compare-job');

const router = express.Router();

// POST / — create comparison and fire job
router.post('/', requireScope('write'), async (req, res) => {
  try {
    const { docAId, docBId } = req.body;

    if (!docAId || !docBId) {
      return res.status(400).json({ error: 'docAId and docBId are required' });
    }

    const [docA, docB] = await Promise.all([
      Document.findById(docAId).lean(),
      Document.findById(docBId).lean(),
    ]);

    if (!docA || !docB) {
      return res.status(404).json({ error: 'One or both documents not found' });
    }

    if (docA.ocrStatus !== 'DONE' || docB.ocrStatus !== 'DONE') {
      return res.status(409).json({
        error: 'OCR not ready on one or both documents',
        docA: { ocrStatus: docA.ocrStatus },
        docB: { ocrStatus: docB.ocrStatus },
      });
    }

    const comp = await Comparison.create({ docAId, docBId });

    // fire-and-forget
    runCompareJob(comp._id).catch((err) => console.error('[comparisons] compare-job error:', err));

    return res.status(201).json({
      _id:       comp._id,
      docAId:    comp.docAId,
      docBId:    comp.docBId,
      status:    comp.status,
      createdAt: comp.createdAt,
    });
  } catch (err) {
    console.error('[comparisons] create error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /:id/run — re-trigger compare job
router.post('/:id/run', requireScope('write'), async (req, res) => {
  try {
    const comp = await Comparison.findById(req.params.id);
    if (!comp) return res.status(404).json({ error: 'Not found' });

    // fire-and-forget
    runCompareJob(comp._id).catch((err) => console.error('[comparisons] compare-job error:', err));

    return res.status(202).json({ status: 'COMPARE_RUNNING' });
  } catch (err) {
    console.error('[comparisons] run error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET / — list comparisons
router.get('/', requireScope('read'), async (req, res) => {
  try {
    const comps = await Comparison.find()
      .populate('docAId', '_id filename')
      .populate('docBId', '_id filename')
      .sort({ createdAt: -1 })
      .lean();

    const result = comps.map(c => ({
      _id:       c._id,
      docAId:    c.docAId,
      docBId:    c.docBId,
      status:    c.status,
      createdAt: c.createdAt,
      diffCount: (c.differences || []).length,
    }));

    return res.json(result);
  } catch (err) {
    console.error('[comparisons] list error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id — full detail with differences
router.get('/:id', requireScope('read'), async (req, res) => {
  try {
    const comp = await Comparison.findById(req.params.id)
      .populate('docAId', '_id filename')
      .populate('docBId', '_id filename')
      .lean();

    if (!comp) return res.status(404).json({ error: 'Not found' });

    return res.json(comp);
  } catch (err) {
    console.error('[comparisons] get error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /:id/render-metadata — metadata for review screen
router.get('/:id/render-metadata', requireScope('read'), async (req, res) => {
  try {
    const comp = await Comparison.findById(req.params.id)
      .populate('docAId', '_id filename pageCount')
      .populate('docBId', '_id filename pageCount')
      .lean();

    if (!comp) return res.status(404).json({ error: 'Not found' });

    return res.json({
      comparisonId: comp._id,
      docA: {
        _id:       comp.docAId._id,
        filename:  comp.docAId.filename,
        pageCount: comp.docAId.pageCount,
        pdfUrl:    `/api/documents/${comp.docAId._id}/pdf`,
      },
      docB: {
        _id:       comp.docBId._id,
        filename:  comp.docBId.filename,
        pageCount: comp.docBId.pageCount,
        pdfUrl:    `/api/documents/${comp.docBId._id}/pdf`,
      },
      differences: comp.differences || [],
    });
  } catch (err) {
    console.error('[comparisons] render-metadata error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
