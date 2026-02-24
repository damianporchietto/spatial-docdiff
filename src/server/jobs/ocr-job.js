const docai = require('../services/docai');
const { buildParagraphIndex, buildTextPayload } = require('../services/ocr-paragraph-index');
const { getFileBuffer } = require('../services/storage-gridfs');
const { Document } = require('../services/mongo');

async function runOcrJob(documentId) {
  await Document.findByIdAndUpdate(documentId, { ocrStatus: 'RUNNING' });

  try {
    const doc = await Document.findById(documentId);
    const pdfBuffer = await getFileBuffer(doc.gridfsId);

    const docaiPages = await docai.processDocument(pdfBuffer);

    const { paragraphs } = buildParagraphIndex(docaiPages);

    const textPayload = buildTextPayload(paragraphs, 'DOCUMENTO');

    await Document.findByIdAndUpdate(documentId, {
      ocrStatus: 'DONE',
      ocrParagraphs: paragraphs,
      ocrTextPayload: textPayload,
      pageCount: new Set(paragraphs.map(p => p.page_number)).size,
    });

    console.log(`[ocr-job] DONE docId=${documentId} paragraphs=${paragraphs.length}`);
  } catch (err) {
    console.error(`[ocr-job] ERROR docId=${documentId}:`, err.message);
    await Document.findByIdAndUpdate(documentId, {
      ocrStatus: 'ERROR',
      ocrError: err.message,
    });
  }
}

module.exports = { runOcrJob };
