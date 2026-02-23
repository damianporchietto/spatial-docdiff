# Hito 00 — Diseño y Arquitectura

## Decisiones de diseño

### SPA mínima con Express

- Express sirve los archivos estáticos de `public/` y expone la API REST bajo `/api/`.
- No hay framework de frontend: HTML vanilla + Tailwind CDN + JS puro.
- Dos pantallas: **History** (`index.html`) y **Review** (`review.html`).
- No hay SSR; toda la lógica de presentación está en el cliente.

### Procesamiento asíncrono por job

El flujo tiene dos etapas costosas que corren fuera del request HTTP:

1. **OCR job** (`ocr-job.js`): llama a Document AI, canonicaliza y codifica el resultado.
2. **Compare job** (`compare-job.js`): llama a Gemini con los encodings de ambos documentos y decodifica las diferencias.

Cada job actualiza el campo `status` del documento/comparación en Mongo. La UI hace polling hasta que el estado es `DONE` o `ERROR`.

### Autenticación por API Key propia

No existe sistema de login. En cambio, la solución usa sus propias API keys para autenticar clientes:

- Las keys son generadas por el operador y **seedeadas directamente en MongoDB** (no hay endpoint de creación).
- Todos los endpoints (excepto `/api/health`) requieren el header `X-Api-Key: <key>`.
- El middleware de auth valida: key existente, `active: true`, no expirada, scope correcto.
- Cada request válido incrementa el contador `usageCount` de la key.

La **Gemini API key** va en `.env` como `GEMINI_API_KEY` y es un secreto del servidor — no la gestiona el cliente.

---

## Auth Flow — Detalle

```
Operador (setup)
     │
     ▼
node scripts/seed-key.js --label "cliente-A" --scope write,read
     │
     ▼
MongoDB: apiKeys
{
  _id: ObjectId,
  key: "a3f8c2...",   ← hex aleatorio 32 bytes
  label: "cliente-A",
  scope: ["write", "read"],
  usageCount: 0,
  active: true,
  expiresAt: null,
  createdAt: Date
}
     │
     ▼ (operador entrega la key al cliente)

Cliente HTTP
     │
     │  Header: X-Api-Key: a3f8c2...
     ▼
Express middleware (auth.js)
     │
     ├── busca key en MongoDB
     ├── valida active, expiresAt, scope
     ├── incrementa usageCount (fire-and-forget)
     └── next() → handler del endpoint

                    .env (secreto del servidor)
                    GEMINI_API_KEY=AIzaSy...
                         │
                         ▼ (solo en compare-job)
                    gemini.call(process.env.GEMINI_API_KEY, payload)
```

---

## Persistencia MongoDB — Esquema de colecciones

### Colección: `documents`

```js
{
  _id: ObjectId,
  filename: String,          // nombre original del archivo
  gridfsId: ObjectId,        // referencia al archivo en GridFS
  sha256: String,            // hash del contenido (para deduplicación futura)
  mimeType: String,          // "application/pdf"
  uploadedAt: Date,
  ocrStatus: {
    type: String,
    enum: ['PENDING', 'RUNNING', 'DONE', 'ERROR'],
    default: 'PENDING'
  },
  ocrError: String,          // mensaje de error si ocrStatus === 'ERROR'
  ocrCanonical: Object,      // resultado canonicalizado de DocAI
  ocrEncoding: String,       // encoding compacto para Gemini
  pageCount: Number
}
```

### Colección: `comparisons`

```js
{
  _id: ObjectId,
  docAId: ObjectId,          // ref → documents
  docBId: ObjectId,          // ref → documents
  createdAt: Date,
  status: {
    type: String,
    enum: ['CREATED', 'COMPARE_RUNNING', 'DONE', 'ERROR'],
    default: 'CREATED'
  },
  error: String,
  differences: [             // array vacío hasta DONE
    {
      id: String,            // "diff-001"
      type: String,          // 'MODIFIED' | 'ADDED' | 'REMOVED' | 'MOVED'
      pageA: Number,         // índice de página (0-based) en DocA
      pageB: Number,         // índice de página (0-based) en DocB
      bboxA: {               // bbox normalizado [0,1] en DocA
        x: Number, y: Number, w: Number, h: Number
      },
      bboxB: {               // bbox normalizado [0,1] en DocB
        x: Number, y: Number, w: Number, h: Number
      },
      textA: String,         // texto original (DocA)
      textB: String,         // texto nuevo (DocB)
      summary: String        // descripción breve de la diferencia
    }
  ],
  tokensUsed: Number,        // para estimación de costo
  durationMs: Number
}
```

### Colección: `apiKeys`

```js
{
  _id: ObjectId,
  key: String,               // token hex aleatorio (32 bytes) — generado por seed-key.js
  label: String,             // nombre del cliente/usuario
  scope: [String],           // permisos: 'read' | 'write' | 'admin'
  usageCount: Number,        // contador de requests autenticados con esta key
  active: Boolean,           // false = key revocada
  expiresAt: Date,           // null = sin vencimiento
  createdAt: Date
}
```

Scopes:
- `read` — acceso a GET de documentos, comparaciones
- `write` — upload de PDFs, creación de comparaciones
- `admin` — todos los permisos anteriores

> **Nota de seguridad**: Las keys se guardan en texto plano. Para producción considerar hash (bcrypt/argon2) o cifrado en reposo. Para el prototipo, esto es aceptable.

---

## Plantilla .env.example

```dotenv
# MongoDB
MONGO_URI=mongodb://localhost:27017/spatial-docdiff

# Google Cloud Document AI
DOCAI_PROJECT_ID=your-gcp-project-id
DOCAI_LOCATION=us               # us o eu
DOCAI_PROCESSOR_ID=your-processor-id

# Google Gemini (secreto del servidor, NO se expone al cliente)
GEMINI_API_KEY=your-gemini-api-key

# Servidor
PORT=3000
MAX_UPLOAD_MB=50
```

---

## UI — Dos pantallas

### History (`/`)

- Tabla de comparaciones anteriores (status, resumen, links)
- Form para subir DocA y DocB (2 file inputs)
- Badges de estado OCR para cada documento subido
- Botón "Comparar" (habilitado cuando ambos docs tienen `ocrStatus: DONE`)
- La API key del cliente se configura en el cliente HTTP (no en la UI)

### Review (`/review.html?id=:compId`)

- Dos canvas PDF lado a lado (DocA / DocB)
- Overlay canvas transparente encima de cada uno para los highlights
- Panel lateral con lista de diferencias filtrable por tipo
- Click en diferencia → scroll a la página correcta + highlight del bbox

---

## Estructura de carpetas del proyecto (objetivo)

```
spatial-docdiff/
├── src/
│   └── server/
│       ├── index.js              ← entry point Express
│       ├── middlewares/
│       │   └── auth.js           ← valida X-Api-Key contra colección apiKeys
│       ├── routes/
│       │   ├── documents.js      ← upload, metadata, stream, OCR endpoint
│       │   └── comparisons.js    ← create, run, status, render-metadata
│       ├── services/
│       │   ├── mongo.js          ← conexión y modelos Mongoose
│       │   ├── storage-gridfs.js ← upload/download de archivos en GridFS
│       │   ├── docai.js          ← wrapper Google Document AI
│       │   ├── ocr-canonicalize.js ← normaliza output DocAI → canonical model
│       │   ├── ocr-encode.js     ← canonical → encoding string para Gemini
│       │   ├── gemini.js         ← wrapper Gemini, usa GEMINI_API_KEY del .env
│       │   └── diff-decode.js    ← output Gemini → differences[] con bboxes
│       └── jobs/
│           ├── ocr-job.js        ← orquesta OCR: pending → running → done/error
│           └── compare-job.js   ← orquesta comparación
├── public/
│   ├── index.html
│   ├── app.js
│   ├── review.html
│   └── review.js
├── scripts/
│   └── seed-key.js               ← CLI para crear API keys manualmente
├── wiki/
├── .env.example
├── package.json
└── LICENSE
```
