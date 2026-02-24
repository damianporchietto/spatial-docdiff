const gemini = require('../services/gemini');
const { mapRefsToHighlights } = require('../services/diff-decode');
const { Comparison } = require('../services/mongo');

async function runCompareJob(comparisonId) {
  const comp = await Comparison.findById(comparisonId)
    .populate('docAId').populate('docBId');

  await Comparison.findByIdAndUpdate(comparisonId, { status: 'COMPARE_RUNNING' });

  try {
    const start = Date.now();

    // Verificar OCR completo en ambos documentos
    if (comp.docAId.ocrStatus !== 'DONE' || comp.docBId.ocrStatus !== 'DONE') {
      throw new Error('One or both documents have not completed OCR');
    }

    // Llamar a Gemini con los text payloads
    const { genaiChanges, summary, tokensUsed } = await gemini.compareDocuments(
      comp.docAId.ocrTextPayload,
      comp.docBId.ocrTextPayload,
    );

    // Resolver paragraph refs → highlights con bbox_percent
    const differences = mapRefsToHighlights(
      genaiChanges,
      comp.docAId.ocrParagraphs,
      comp.docBId.ocrParagraphs,
    );

    await Comparison.findByIdAndUpdate(comparisonId, {
      status: 'DONE',
      differences,
      tokensUsed,
      durationMs: Date.now() - start,
    });

    console.log(`[compare-job] DONE compId=${comparisonId} diffs=${differences.length} tokens=${tokensUsed}`);
  } catch (err) {
    console.error(`[compare-job] ERROR compId=${comparisonId}:`, err.message);
    await Comparison.findByIdAndUpdate(comparisonId, {
      status: 'ERROR',
      error: err.message,
    });
  }
}

module.exports = { runCompareJob };
