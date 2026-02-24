/**
 * Build paragraph index from Document AI pages.
 * Returns one entry per non-empty paragraph with pre-calculated bbox_percent.
 * @param {Array} docaiPages - pages from Document AI (result.document.pages)
 * @returns {{ paragraphs: Array, pageDimensions: Array }}
 */
function buildParagraphIndex(docaiPages) {
  const paragraphs = [];
  const pageDimensions = [];

  docaiPages.forEach((page, pageIndex) => {
    const pageWidth  = page.dimension?.width  || 1;
    const pageHeight = page.dimension?.height || 1;

    pageDimensions.push({ page_number: pageIndex + 1, width: pageWidth, height: pageHeight });

    page.blocks?.forEach((block, blockIdx) => {
      block.paragraphs?.forEach((paragraph, paraIdx) => {
        const text = extractParagraphText(paragraph);
        const trimmedText = text.trim();
        if (!trimmedText) return;

        const bbox = calculateParagraphBbox(paragraph, pageWidth, pageHeight);
        const bboxPercent = bboxToPercent(bbox, pageWidth, pageHeight);

        paragraphs.push({
          id: `P${pageIndex + 1}_${blockIdx}_${paraIdx}`,
          page_number: pageIndex + 1,
          block_index: blockIdx,
          paragraph_index: paraIdx,
          text: trimmedText,
          bbox_percent: bboxPercent,
        });
      });
    });
  });

  return { paragraphs, pageDimensions };
}

/**
 * Build text payload with [PX_Y_Z] refs for Gemini.
 * @param {Array} paragraphs - output of buildParagraphIndex
 * @param {string} docLabel  - e.g. "DOCUMENTO 1"
 * @returns {string}
 */
function buildTextPayload(paragraphs, docLabel) {
  let payload = `=== ${docLabel} ===\n\n`;
  let currentPage = 0;

  for (const para of paragraphs) {
    if (para.page_number !== currentPage) {
      currentPage = para.page_number;
      payload += `--- Pagina ${currentPage} ---\n\n`;
    }
    payload += `[${para.id}] ${para.text}\n\n`;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Une words/symbols de un párrafo Document AI en un string. */
function extractParagraphText(paragraph) {
  return paragraph.words?.map(w =>
    w.symbols?.map(s => s.text).join('')
  ).join(' ') || '';
}

/**
 * Calcula bbox absoluto del párrafo.
 * Intenta boundingBox del párrafo; si no tiene, agrega los vértices de cada word.
 * Detecta automáticamente si los vértices son normalizados (0-1) o absolutos (px).
 */
function calculateParagraphBbox(paragraph, pageWidth, pageHeight) {
  const normalizedVerts = paragraph.boundingBox?.normalizedVertices;
  const absoluteVerts   = paragraph.boundingBox?.vertices;
  let vertices = (normalizedVerts?.length > 0) ? normalizedVerts
               : (absoluteVerts?.length > 0)   ? absoluteVerts
               : [];

  if (vertices.length === 0) {
    const allVerts = [];
    for (const word of paragraph.words || []) {
      const wn = word.boundingBox?.normalizedVertices;
      const wa = word.boundingBox?.vertices;
      const wv = (wn?.length > 0) ? wn : (wa?.length > 0) ? wa : [];
      allVerts.push(...wv);
    }
    vertices = allVerts;
  }

  if (vertices.length === 0) return { x1: 0, y1: 0, x2: 0, y2: 0 };

  // Si max(x) <= 1 y max(y) <= 1 → coordenadas normalizadas
  const maxX = Math.max(...vertices.map(v => v.x || 0));
  const maxY = Math.max(...vertices.map(v => v.y || 0));
  const isNormalized = maxX <= 1 && maxY <= 1;

  return verticesToAbsoluteBbox(
    vertices,
    isNormalized ? pageWidth  : 1,
    isNormalized ? pageHeight : 1
  );
}

/** Convierte array de vértices [{x,y}] a bbox absoluto {x1,y1,x2,y2}. */
function verticesToAbsoluteBbox(vertices, pageWidth = 1, pageHeight = 1) {
  if (!vertices?.length) return { x1: 0, y1: 0, x2: 0, y2: 0 };
  const xs = vertices.map(v => (v.x || 0) * pageWidth);
  const ys = vertices.map(v => (v.y || 0) * pageHeight);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

/** Convierte bbox absoluto a porcentaje 0-100. */
function bboxToPercent(bbox, pageWidth, pageHeight) {
  return {
    x1: (bbox.x1 / pageWidth)  * 100,
    y1: (bbox.y1 / pageHeight) * 100,
    x2: (bbox.x2 / pageWidth)  * 100,
    y2: (bbox.y2 / pageHeight) * 100,
  };
}

module.exports = { buildParagraphIndex, buildTextPayload };
