# Hito 03 — Comparación con Gemini

## Checklist

- [ ] Instalar dependencia `@google/generative-ai`
- [ ] Implementar `src/server/services/gemini.js` (usa `process.env.GEMINI_API_KEY`)
- [ ] Definir system prompt y user payload
- [ ] Implementar `src/server/services/diff-decode.js` (`mapRefsToHighlights`)
- [ ] Implementar `src/server/jobs/compare-job.js`
- [ ] Implementar rutas de comparisons (`routes/comparisons.js`)
- [ ] Verificar: comparar dos PDFs con diferencias conocidas

---

## Dependencias npm

```bash
npm install @google/generative-ai
```

---

## `src/server/services/gemini.js`

Wrapper sobre el cliente de Gemini. Usa `process.env.GEMINI_API_KEY` directamente (secreto del servidor).

**Función principal**: `compareDocuments(doc1TextPayload, doc2TextPayload)`

Los parámetros son los `ocrTextPayload` ya construidos por `ocr-paragraph-index.js`
(strings con separadores de página y `[PX_Y_Z]` refs).

```js
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Eres un experto comparador de documentos.

Tu tarea es comparar dos documentos y encontrar las diferencias entre ellos.

FORMATO DE LOS DOCUMENTOS:
- Cada parrafo tiene un ID unico al inicio: [P1_0_0] significa pagina 1, bloque 0, parrafo 0
- Usa estos IDs para referenciar exactamente donde se encuentran las diferencias

REGLAS CRITICAS:
1. Devuelve los fragmentos de texto EXACTAMENTE como aparecen en cada documento, sin modificar ni una letra
2. Ignora diferencias menores de formato, puntuacion o espaciado
3. Ignora diferencias causadas por OCR (caracteres mal reconocidos obvios)
4. Enfocate en diferencias de CONTENIDO real
5. SIEMPRE incluye los IDs de los parrafos afectados en doc1_paragraph_refs y doc2_paragraph_refs
6. GRANULARIDAD: Cada cambio debe referenciar MAXIMO 1-2 parrafos. Si hay muchos parrafos modificados,
   crea MULTIPLES cambios separados en lugar de agruparlos en uno solo.

CATEGORIAS DE CAMBIOS:
- MODIFICADO: Texto que cambio entre documentos (ambos doc1_text y doc2_text tendran valores)
- AGREGADO: Texto que existe solo en el Documento 2 (doc1_text sera null, doc1_paragraph_refs sera vacio)
- ELIMINADO: Texto que existe solo en el Documento 1 (doc2_text sera null, doc2_paragraph_refs sera vacio)
- ESTRUCTURAL: Cambios en la estructura del documento (secciones movidas, reorganizacion)

IMPORTANTE: Los IDs de parrafo son OBLIGATORIOS para poder ubicar las diferencias en el documento.`;

// ---------------------------------------------------------------------------
// Response schema (structured output)
// ---------------------------------------------------------------------------

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['MODIFICADO', 'AGREGADO', 'ELIMINADO', 'ESTRUCTURAL'],
          },
          doc1_paragraph_refs: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs de parrafos en Documento 1. MAXIMO 1-2 IDs por cambio.',
          },
          doc2_paragraph_refs: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs de parrafos en Documento 2. MAXIMO 1-2 IDs por cambio.',
          },
          doc1_text: {
            type: 'string',
            nullable: true,
            description: 'Texto EXACTO como aparece en Documento 1 (null si no existe en doc1)',
          },
          doc2_text: {
            type: 'string',
            nullable: true,
            description: 'Texto EXACTO como aparece en Documento 2 (null si no existe en doc2)',
          },
          description: {
            type: 'string',
            description: 'Breve descripcion del cambio',
          },
        },
        required: ['category', 'description', 'doc1_paragraph_refs', 'doc2_paragraph_refs'],
      },
    },
    summary: {
      type: 'object',
      properties: {
        total_changes:    { type: 'integer' },
        modified_count:   { type: 'integer' },
        added_count:      { type: 'integer' },
        removed_count:    { type: 'integer' },
        structural_count: { type: 'integer' },
      },
    },
  },
  required: ['changes', 'summary'],
};

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

async function compareDocuments(doc1TextPayload, doc2TextPayload) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set in environment variables');
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-pro',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.1,
    },
  });

  // 3. Construir user prompt
  const userPrompt = buildUserPrompt(doc1TextPayload, doc2TextPayload);

  // 4. Llamar a Gemini con retry + backoff exponencial
  const raw = await callWithRetry(() => model.generateContent(userPrompt));

  // 5. Parsear y devolver
  const parsed = JSON.parse(raw.response.text());
  return {
    genaiChanges: parsed.changes || [],
    summary: parsed.summary || {},
    tokensUsed: raw.response.usageMetadata?.totalTokenCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

function buildUserPrompt(doc1TextPayload, doc2TextPayload) {
  return `Compara los siguientes dos documentos y encuentra las diferencias.

IMPORTANTE:
- Cada parrafo tiene un ID unico entre corchetes (ej: [P1_0_0]). Usa estos IDs en doc1_paragraph_refs y doc2_paragraph_refs.
- GRANULARIDAD CRITICA: Cada cambio debe referenciar MAXIMO 1-2 parrafos. Si detectas muchos cambios, crea MULTIPLES entradas separadas en el array "changes".

${doc1TextPayload}

${doc2TextPayload}

Analiza ambos documentos y devuelve las diferencias encontradas. Recuerda: maximo 1-2 parrafos por cambio.`;
}

// ---------------------------------------------------------------------------
// Retry logic — backoff exponencial con detección de errores retryables
// ---------------------------------------------------------------------------

const MAX_RETRIES  = 3;
const BASE_DELAY_MS = 2000;

async function callWithRetry(fn) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === MAX_RETRIES;

      const message = error.message || '';
      const isRetryable = (
        message.includes('504') || message.includes('Gateway Timeout')  ||
        message.includes('502') || message.includes('Bad Gateway')      ||
        message.includes('503') || message.includes('Service Unavailable') ||
        message.includes('429') || message.includes('Too Many Requests') ||
        message.includes('socket hang up')                              ||
        message.toLowerCase().includes('overloaded')                    ||
        message.toLowerCase().includes('resource exhausted')           ||
        message.toLowerCase().includes('rate limit')                    ||
        error.code === 'ECONNRESET'                                     ||
        error.code === 'ETIMEDOUT'                                      ||
        error.code === 'ECONNABORTED'
      );

      if (!isRetryable || isLastAttempt) throw error;

      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt); // 2s, 4s, 8s
      console.warn(`Gemini call failed, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${message}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

module.exports = { compareDocuments };
```

---

## Contrato JSON de output (Gemini)

Gemini devuelve un objeto JSON con este esquema:

```json
{
  "changes": [
    {
      "category": "MODIFICADO",
      "doc1_paragraph_refs": ["P1_0_2"],
      "doc2_paragraph_refs": ["P1_0_2"],
      "doc1_text": "El plazo del contrato es de 12 meses",
      "doc2_text": "El plazo del contrato es de 24 meses",
      "description": "El plazo cambió de 12 a 24 meses"
    },
    {
      "category": "AGREGADO",
      "doc1_paragraph_refs": [],
      "doc2_paragraph_refs": ["P2_1_0"],
      "doc1_text": null,
      "doc2_text": "Cláusula 4. Penalidades por incumplimiento",
      "description": "Se agregó cláusula de penalidades"
    },
    {
      "category": "ELIMINADO",
      "doc1_paragraph_refs": ["P3_0_1"],
      "doc2_paragraph_refs": [],
      "doc1_text": "Ver anexo A para detalles adicionales",
      "doc2_text": null,
      "description": "Se eliminó referencia al anexo A"
    }
  ],
  "summary": {
    "total_changes": 3,
    "modified_count": 1,
    "added_count": 1,
    "removed_count": 1,
    "structural_count": 0
  }
}
```

**Categorías de cambio**:
| Categoría | `doc1_paragraph_refs` | `doc2_paragraph_refs` | Descripción |
|---|---|---|---|
| `MODIFICADO` | con IDs | con IDs | Texto cambió de doc1 a doc2 |
| `AGREGADO` | `[]` vacío | con IDs | Texto solo en doc2 |
| `ELIMINADO` | con IDs | `[]` vacío | Texto solo en doc1 |
| `ESTRUCTURAL` | con IDs | con IDs | Secciones movidas / reorganizadas |

---

## `src/server/services/diff-decode.js`

Transforma el output de Gemini (con `paragraph_refs`) en objetos con `highlights[]` listos
para que el frontend dibuje los bounding boxes.

```js
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
```

### Formato de salida por cambio

```js
{
  category:        "MODIFICADO",
  description:     "El plazo cambió de 12 a 24 meses",
  doc1_text:       "El plazo del contrato es de 12 meses",
  doc2_text:       "El plazo del contrato es de 24 meses",
  doc1_highlights: [
    { page_number: 1, bbox_percent: { x1: 10, y1: 45, x2: 85, y2: 48 } }
  ],
  doc2_highlights: [
    { page_number: 1, bbox_percent: { x1: 10, y1: 45, x2: 85, y2: 48 } }
  ]
}
```

- `page_number` es **1-based** (mismo que Document AI)
- `bbox_percent` usa `{x1, y1, x2, y2}` en porcentaje **0-100**
- `doc1_highlights` / `doc2_highlights` son **arrays** — un elemento por párrafo referenciado
  (sin combinar bboxes, para evitar rectángulos gigantes cuando los párrafos están dispersos)

---

## `src/server/jobs/compare-job.js`

### Estados

```
CREATED → COMPARE_RUNNING → DONE
                           → ERROR
```

### Flujo

```js
const gemini      = require('../services/gemini');
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
  } catch (err) {
    await Comparison.findByIdAndUpdate(comparisonId, {
      status: 'ERROR',
      error: err.message,
    });
  }
}

module.exports = { runCompareJob };
```

---

## Endpoints

### `POST /api/comparisons`

Crea una nueva comparación y dispara el compare job (fire-and-forget).

**Headers**: `X-Api-Key: <token>` (auth propia de la solución)

**Request body**:
```json
{ "docAId": "64abc...", "docBId": "64def..." }
```

**Validaciones**:
- Ambos `docAId` y `docBId` deben existir en Mongo
- Ambos documentos deben tener `ocrStatus === 'DONE'` (si no, devolver 409)

**Response** `201`:
```json
{
  "_id": "64ghi...",
  "docAId": "64abc...",
  "docBId": "64def...",
  "status": "CREATED",
  "createdAt": "2024-01-15T10:05:00Z"
}
```

---

### `POST /api/comparisons/:id/run`

Dispara el compare job para una comparación existente.

**Response** `202`:
```json
{ "status": "COMPARE_RUNNING" }
```

El job corre en background; usar polling en `GET /api/comparisons/:id` para monitorear.

---

### `GET /api/comparisons`

Lista todas las comparaciones.

**Response** `200`:
```json
[
  {
    "_id": "64ghi...",
    "docAId": { "_id": "...", "filename": "contrato-v1.pdf" },
    "docBId": { "_id": "...", "filename": "contrato-v2.pdf" },
    "status": "DONE",
    "createdAt": "...",
    "diffCount": 3
  }
]
```

---

### `GET /api/comparisons/:id`

Devuelve el detalle completo, incluyendo `differences[]`.

**Response** `200`:
```json
{
  "_id": "64ghi...",
  "status": "DONE",
  "differences": [
    {
      "category": "MODIFICADO",
      "description": "El plazo cambió de 12 a 24 meses",
      "doc1_text": "El plazo del contrato es de 12 meses",
      "doc2_text": "El plazo del contrato es de 24 meses",
      "doc1_highlights": [{ "page_number": 1, "bbox_percent": { "x1": 10, "y1": 45, "x2": 85, "y2": 48 } }],
      "doc2_highlights": [{ "page_number": 1, "bbox_percent": { "x1": 10, "y1": 45, "x2": 85, "y2": 48 } }]
    }
  ],
  "tokensUsed": 4200,
  "durationMs": 8500
}
```

---

### `GET /api/comparisons/:id/render-metadata`

Devuelve los datos necesarios para que el frontend configure el render.

**Response** `200`:
```json
{
  "comparisonId": "64ghi...",
  "docA": {
    "_id": "64abc...",
    "filename": "contrato-v1.pdf",
    "pageCount": 5,
    "pdfUrl": "/api/documents/64abc.../pdf"
  },
  "docB": {
    "_id": "64def...",
    "filename": "contrato-v2.pdf",
    "pageCount": 5,
    "pdfUrl": "/api/documents/64def.../pdf"
  },
  "differences": [...]
}
```

---

## Verificación

```bash
# 1. Asegurarse de tener dos docs con ocrStatus=DONE
DOCA_ID="64abc..."
DOCB_ID="64def..."
KEY="mi-api-key-token"

# 2. Crear comparación (dispara job automáticamente)
COMP=$(curl -s -X POST http://localhost:3000/api/comparisons \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d "{\"docAId\": \"$DOCA_ID\", \"docBId\": \"$DOCB_ID\"}")
COMP_ID=$(echo $COMP | jq -r '._id')
echo "Comparison ID: $COMP_ID"

# 3. Polling hasta DONE
watch -n 3 "curl -s -H 'X-Api-Key: $KEY' http://localhost:3000/api/comparisons/$COMP_ID | jq '{status, diffCount: (.differences | length)}'"

# 4. Ver diferencias
curl -s -H "X-Api-Key: $KEY" http://localhost:3000/api/comparisons/$COMP_ID | jq '.differences'
```

**Señales de éxito**:
- `status` pasa de `CREATED` → `COMPARE_RUNNING` → `DONE`
- `differences[]` contiene objetos con `doc1_highlights` / `doc2_highlights`
- Cada highlight tiene `page_number` (1-based) y `bbox_percent` con valores en 0-100
- Las categorías son `MODIFICADO`, `AGREGADO`, `ELIMINADO`, o `ESTRUCTURAL`
