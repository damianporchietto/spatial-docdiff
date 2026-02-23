# Hito 02 — OCR con Document AI

## Checklist

- [ ] Configurar credenciales GCP (`GOOGLE_APPLICATION_CREDENTIALS` o Application Default Credentials)
- [ ] Crear procesador Document AI en GCP (tipo: OCR / Document OCR)
- [ ] Completar `.env` con `DOCAI_PROJECT_ID`, `DOCAI_LOCATION`, `DOCAI_PROCESSOR_ID`
- [ ] Instalar dependencia `@google-cloud/documentai`
- [ ] Implementar `src/server/services/docai.js`
- [ ] Implementar `src/server/services/ocr-paragraph-index.js`
- [ ] Implementar `src/server/jobs/ocr-job.js`
- [ ] Agregar endpoint `GET /api/documents/:id/ocr`
- [ ] Verificar: upload PDF → esperar → polling → ver OCR

---

## Dependencias npm

```bash
npm install @google-cloud/documentai
```

---

## `src/server/services/docai.js`

Wrapper sobre el cliente de Document AI. Retorna las páginas crudas de Document AI.

**Función principal**: `processDocument(pdfBuffer)`

```js
const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;

const client = new DocumentProcessorServiceClient();
const processorName = `projects/${process.env.DOCAI_PROJECT_ID}/locations/${process.env.DOCAI_LOCATION}/processors/${process.env.DOCAI_PROCESSOR_ID}`;

async function processDocument(pdfBuffer) {
  const [result] = await client.processDocument({
    name: processorName,
    rawDocument: {
      content: pdfBuffer.toString('base64'),
      mimeType: 'application/pdf',
    },
  });
  // Devuelve las páginas crudas para que ocr-paragraph-index las procese
  return result.document.pages;
}

module.exports = { processDocument };
```

**Consideraciones**:
- Document AI tiene límite de 15 MB por request en la API inline. Para PDFs más grandes usar GCS.
- Para el prototipo asumimos PDFs ≤ 15 MB; agregar validación en el upload.

---

## `src/server/services/ocr-paragraph-index.js`

Transforma las páginas crudas de Document AI en dos artefactos que se guardan en Mongo:

1. **`paragraphs`** — array de objetos con ID, texto y `bbox_percent` para lookup post-Gemini
2. **`textPayload`** — string formateado con IDs en corchetes para enviar a Gemini

### Formato del paragraph index (`ocrParagraphs` en Mongo)

```js
[
  {
    id: "P1_0_0",           // P{page}_{blockIdx}_{paraIdx} — page es 1-based
    page_number: 1,
    block_index: 0,
    paragraph_index: 0,
    text: "Cláusula 1. Objeto del contrato",
    bbox_percent: { x1: 10, y1: 5, x2: 90, y2: 8 }  // porcentaje 0-100
  },
  ...
]
```

**Nota importante**: las bboxes NO van en el payload enviado a Gemini. Se guardan en el índice
y se usan para hacer lookup *después* de que Gemini devuelva los IDs de párrafos afectados.

### Formato del text payload (`ocrTextPayload` en Mongo)

```
=== DOCUMENTO ===

--- Pagina 1 ---

[P1_0_0] Cláusula 1. Objeto del contrato

[P1_0_1] Los servicios objeto del presente contrato consisten en...

--- Pagina 2 ---

[P2_0_0] Cláusula 2. Obligaciones de las partes...
```

### Implementación

```js
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
```

---

## `src/server/jobs/ocr-job.js`

### Estados

```
PENDING → RUNNING → DONE
                  → ERROR
```

### Flujo

```js
const docai     = require('../services/docai');
const { buildParagraphIndex, buildTextPayload } = require('../services/ocr-paragraph-index');
const storage   = require('../services/storage');
const Document  = require('../models/document');

async function runOcrJob(documentId) {
  await Document.findByIdAndUpdate(documentId, { ocrStatus: 'RUNNING' });

  try {
    // 1. Obtener PDF de GridFS
    const doc = await Document.findById(documentId);
    const pdfBuffer = await storage.getFileBuffer(doc.gridfsId);

    // 2. OCR → páginas crudas de Document AI
    const docaiPages = await docai.processDocument(pdfBuffer);

    // 3. Construir paragraph index con bbox pre-calculados
    const { paragraphs } = buildParagraphIndex(docaiPages);

    // 4. Construir text payload con IDs en corchetes
    const textPayload = buildTextPayload(paragraphs, 'DOCUMENTO');

    // 5. Guardar en Mongo
    await Document.findByIdAndUpdate(documentId, {
      ocrStatus: 'DONE',
      ocrParagraphs:   paragraphs,   // para lookup post-Gemini
      ocrTextPayload:  textPayload,  // para enviar a Gemini
      pageCount: new Set(paragraphs.map(p => p.page_number)).size,
    });
  } catch (err) {
    await Document.findByIdAndUpdate(documentId, {
      ocrStatus: 'ERROR',
      ocrError: err.message,
    });
  }
}

module.exports = { runOcrJob };
```

El job se dispara en el endpoint `POST /api/documents` sin await (fuego y olvido):

```js
// En documents route, después de crear el doc:
ocr_job.runOcrJob(newDoc._id).catch(console.error);
```

---

## Schema Mongo — campos OCR en `documents`

| Campo | Tipo | Descripción |
|---|---|---|
| `ocrStatus` | String | `PENDING \| RUNNING \| DONE \| ERROR` |
| `ocrParagraphs` | Array | paragraphIndex — usado para lookup post-Gemini |
| `ocrTextPayload` | String | texto con `[PX_Y_Z] texto` — enviado a Gemini |
| `ocrError` | String | mensaje de error si `status === ERROR` |
| `pageCount` | Number | número de páginas detectadas |

---

## Endpoint adicional: `GET /api/documents/:id/ocr`

**Respuesta cuando `ocrStatus !== 'DONE'`** → `409 Conflict`:
```json
{ "error": "OCR not ready", "status": "RUNNING" }
```

**Respuesta cuando `ocrStatus === 'DONE'`** → `200 OK`:
```json
{
  "pageCount": 5,
  "paragraphCount": 142,
  "textPayload": "=== DOCUMENTO ===\n\n--- Pagina 1 ---\n\n[P1_0_0] Cláusula 1...",
  "paragraphs": [
    {
      "id": "P1_0_0", "page_number": 1, "block_index": 0, "paragraph_index": 0,
      "text": "Cláusula 1. Objeto del contrato",
      "bbox_percent": { "x1": 10, "y1": 5, "x2": 90, "y2": 8 }
    }
  ]
}
```

---

## Verificación

```bash
# 1. Subir PDF
RESPONSE=$(curl -s -F "file=@/path/to/contrato.pdf" http://localhost:3000/api/documents)
DOC_ID=$(echo $RESPONSE | jq -r '._id')
echo "Doc ID: $DOC_ID"

# 2. Polling hasta DONE (cada 3 segundos)
watch -n 3 "curl -s http://localhost:3000/api/documents/$DOC_ID | jq '.ocrStatus'"

# 3. Ver OCR cuando esté DONE
curl -s http://localhost:3000/api/documents/$DOC_ID/ocr | jq '{pageCount, paragraphCount}'
curl -s http://localhost:3000/api/documents/$DOC_ID/ocr | jq '.textPayload' | head -30
```

Verificar en Mongo que `ocrParagraphs` está poblado correctamente:
```js
db.documents.findOne(
  { _id: ObjectId("...") },
  { ocrStatus: 1, pageCount: 1, ocrParagraphs: { $slice: 3 } }
)
```

**Señales de éxito**:
- `ocrStatus` pasa de `PENDING` → `RUNNING` → `DONE`
- `ocrParagraphs[0]` tiene `id: "P1_0_0"` y `bbox_percent` con valores razonables (0-100)
- `ocrTextPayload` contiene líneas con el formato `[P1_0_0] texto del párrafo`
- `pageCount` coincide con las páginas reales del PDF
