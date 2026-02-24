/**
 * Map Gemini paragraph refs to highlight bboxes.
 *
 * @param {Array}  genaiChanges   - changes[] del response de Gemini
 * @param {Array}  doc1Paragraphs - ocrParagraphs del documento 1
 * @param {Array}  doc2Paragraphs - ocrParagraphs del documento 2
 * @returns {Array} differences[] — un objeto por cambio con doc1_highlights y doc2_highlights
 */
function mapRefsToHighlights(genaiChanges, doc1Paragraphs, doc2Paragraphs) {
  // Lookup maps para acceso O(1) por ID
  const doc1Map = new Map(doc1Paragraphs.map(p => [p.id, p]));
  const doc2Map = new Map(doc2Paragraphs.map(p => [p.id, p]));

  return genaiChanges.map(change => {
    const mapped = {
      category:    change.category,
      description: change.description,
      doc1_text:   change.doc1_text   ?? null,
      doc2_text:   change.doc2_text   ?? null,
    };

    // Resolver refs de doc1
    if (change.doc1_paragraph_refs?.length > 0) {
      const paras = change.doc1_paragraph_refs
        .map(ref => doc1Map.get(ref))
        .filter(Boolean);

      mapped.doc1_highlights = paras.length > 0
        ? paras.map(p => ({ page_number: p.page_number, bbox_percent: p.bbox_percent }))
        : [{ page_number: 1, bbox_percent: { x1: 0, y1: 0, x2: 0, y2: 0 } }]; // fallback
    } else {
      mapped.doc1_highlights = [];
    }

    // Resolver refs de doc2
    if (change.doc2_paragraph_refs?.length > 0) {
      const paras = change.doc2_paragraph_refs
        .map(ref => doc2Map.get(ref))
        .filter(Boolean);

      mapped.doc2_highlights = paras.length > 0
        ? paras.map(p => ({ page_number: p.page_number, bbox_percent: p.bbox_percent }))
        : [{ page_number: 1, bbox_percent: { x1: 0, y1: 0, x2: 0, y2: 0 } }]; // fallback
    } else {
      mapped.doc2_highlights = [];
    }

    return mapped;
  });
}

module.exports = { mapRefsToHighlights };
