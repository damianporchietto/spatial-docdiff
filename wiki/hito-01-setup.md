# Hito 01 — Setup: Express + Mongo + GridFS + Upload

## Checklist

- [ ] Inicializar proyecto Node.js (`package.json`)
- [ ] Instalar dependencias
- [ ] Crear `.env` a partir de `.env.example`
- [ ] Levantar MongoDB local (Docker o instalación directa)
- [ ] Implementar `src/server/services/mongo.js`
- [ ] Implementar `src/server/services/storage-gridfs.js`
- [ ] Implementar `src/server/middlewares/auth.js`
- [ ] Implementar rutas de documents (`routes/documents.js`)
- [ ] Implementar `src/server/index.js`
- [ ] Implementar `scripts/seed-key.js`
- [ ] Crear key de test con seed-key.js
- [ ] Verificar con curl: upload + metadata + stream (con X-Api-Key)
- [ ] Verificar healthcheck (sin auth)

---

## Dependencias npm

```json
{
  "dependencies": {
    "express": "^4.18.0",
    "mongoose": "^8.0.0",
    "multer": "^1.4.5-lts.1",
    "dotenv": "^16.0.0",
    "morgan": "^1.10.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.0"
  }
}
```

> `gridfs-stream` y `multer-gridfs-storage` **no se usan**: son incompatibles con mongoose v8 + MongoDB driver v6. Se usa `multer` con `memoryStorage()` + `GridFSBucket` nativo del driver de MongoDB (incluido con mongoose). `crypto` y `stream` son built-in de Node.

Instalar:

```bash
npm install express mongoose multer dotenv morgan
npm install -D nodemon
```

---

## `src/server/index.js` — Esquema

```js
require('dotenv').config();
const express = require('express');
const { connectMongo } = require('./services/mongo');

const app = express();
app.use(express.json());
app.use(require('morgan')('dev'));

// Rutas
app.use('/api/documents', require('./routes/documents'));
app.use('/api/comparisons', require('./routes/comparisons'));

// Static files
app.use(express.static('public'));

// Healthcheck
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// Start
const PORT = process.env.PORT || 3000;
connectMongo().then(() => {
  app.listen(PORT, () => console.log(`Server running on :${PORT}`));
});
```

---

## `src/server/services/mongo.js`

Responsabilidades:
- Conectar a MongoDB con Mongoose usando `MONGO_URI` del .env
- Exportar los modelos: `Document`, `Comparison`, `ApiKey`
- Exportar `mongoose` (para acceder a `mongoose.connection.db` en GridFS)

```js
// Esquema Document
const documentSchema = new mongoose.Schema({
  filename:    String,
  gridfsId:    mongoose.Schema.Types.ObjectId,
  sha256:      String,
  mimeType:    String,
  uploadedAt:  { type: Date, default: Date.now },
  ocrStatus:   { type: String, enum: ['PENDING','RUNNING','DONE','ERROR'], default: 'PENDING' },
  ocrError:    String,
  ocrCanonical: mongoose.Schema.Types.Mixed,
  ocrEncoding:  String,
  pageCount:    Number,
});

// Esquema Comparison
const comparisonSchema = new mongoose.Schema({
  docAId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
  docBId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
  createdAt: { type: Date, default: Date.now },
  status:    { type: String, enum: ['CREATED','COMPARE_RUNNING','DONE','ERROR'], default: 'CREATED' },
  error:     String,
  differences: [mongoose.Schema.Types.Mixed],
  tokensUsed:  Number,
  durationMs:  Number,
});

// Esquema ApiKey (keys propias de la solución — se seedean con scripts/seed-key.js)
const apiKeySchema = new mongoose.Schema({
  key:        String,                              // token hex 32 bytes
  label:      String,                              // nombre del cliente
  scope:      [String],                            // ['read', 'write', 'admin']
  usageCount: { type: Number, default: 0 },
  active:     { type: Boolean, default: true },
  expiresAt:  Date,                                // null = sin vencimiento
  createdAt:  { type: Date, default: Date.now },
});
```

---

## `src/server/services/storage-gridfs.js`

Responsabilidades:
- Exportar `upload` middleware de Multer con `memoryStorage()` (límite: `MAX_UPLOAD_MB`, fileFilter: solo PDF)
- Exportar `storeFile(buffer, filename)`: async, sube buffer a GridFS usando `GridFSBucket` nativo, devuelve `gridfsId`
- Exportar `streamFile(gridfsId, res)`: abre download stream del bucket y hace pipe a `res`

Consideraciones:
- El bucket de GridFS se llama `pdfs`
- Usar `mongoose.connection.db` con `new GridFSBucket(db, { bucketName: 'pdfs' })`
- `multer.memoryStorage()` permite calcular sha256 del buffer antes de persistir

---

## Middleware: `src/server/middlewares/auth.js`

Exporta `requireScope(scope)` — factory que devuelve un middleware Express:

1. Lee header `X-Api-Key`
2. Busca en `ApiKey` por campo `key`
3. Valida: existe, `active: true`, no expirada (`expiresAt == null || expiresAt > Date.now()`), tiene el `scope` requerido o tiene `'admin'`
4. Si OK: incrementa `usageCount` (fire-and-forget, sin await), setea `req.apiKey = doc`, llama `next()`
5. Si falla: `401 { error: 'Unauthorized' }`

---

## `scripts/seed-key.js`

Script standalone (no depende del servidor corriendo):

```bash
node scripts/seed-key.js --label "dev-local" --scope admin
# → Key creada: a3f8c2d1...  (hex 32 bytes)

node scripts/seed-key.js --label "cliente-readonly" --scope read
node scripts/seed-key.js --label "cliente-upload" --scope write,read
```

Conecta a Mongo usando `MONGO_URI` del `.env`, genera token aleatorio, inserta en `apiKeys`, imprime la key generada.

---

## Endpoints

> Todos los endpoints (excepto `/api/health`) requieren header `X-Api-Key: <token>`.
> Sin key válida → `401 Unauthorized`.

### `POST /api/documents`

Sube un PDF a GridFS y crea el documento en Mongo.

**Auth**: `requireScope('write')`

**Request**: `multipart/form-data` con campo `file` (PDF)

**Response** `201`:
```json
{
  "_id": "64abc123...",
  "filename": "contrato-v1.pdf",
  "ocrStatus": "PENDING",
  "uploadedAt": "2024-01-15T10:00:00Z"
}
```

**Validaciones**:
- MIME type debe ser `application/pdf`
- Tamaño máximo: `MAX_UPLOAD_MB` (default 50 MB)

**Flujo interno**:
1. Multer carga el archivo en memoria (`memoryStorage`)
2. Calcular sha256 del buffer
3. `storeFile(buffer, filename)` → sube a GridFS, devuelve `gridfsId`
4. Crear doc en Mongo con `ocrStatus: PENDING`
5. Disparar `ocr-job.js` en background (no await)
6. Devolver el documento creado

---

### `GET /api/documents/:id`

**Auth**: `requireScope('read')`

Devuelve metadata del documento (sin el PDF).

**Response** `200`:
```json
{
  "_id": "64abc123...",
  "filename": "contrato-v1.pdf",
  "ocrStatus": "DONE",
  "pageCount": 5,
  "uploadedAt": "2024-01-15T10:00:00Z"
}
```

---

### `GET /api/documents/:id/pdf`

**Auth**: `requireScope('read')`

Hace stream del PDF desde GridFS.

**Headers de respuesta**:
- `Content-Type: application/pdf`
- `Content-Disposition: inline; filename="..."`

---

### `GET /api/documents/:id/ocr`

**Auth**: `requireScope('read')`

Devuelve el resultado OCR canonicalizado (solo disponible cuando `ocrStatus === 'DONE'`).

**Response** `200`:
```json
{
  "pageCount": 5,
  "encoding": "0|0.1,0.05,0.8,0.03|Cláusula 1...\n...",
  "canonical": { ... }
}
```

---

### `GET /api/health`

**Response** `200`:
```json
{ "status": "ok", "ts": "2024-01-15T10:00:00Z" }
```

---

## Verificación

```bash
# 1. Crear key de test (con servidor detenido o en otra terminal)
node scripts/seed-key.js --label "dev" --scope admin
# → Key creada: a3f8c2d1e5b7...  ← copiar este valor

# 2. Healthcheck (sin auth — debe responder 200)
curl http://localhost:3000/api/health

# 3. Sin key → debe dar 401
curl http://localhost:3000/api/documents

# 4. Upload PDF
curl -H "X-Api-Key: <key>" \
  -F "file=@/path/to/doc.pdf" \
  http://localhost:3000/api/documents
# → { "_id": "...", "filename": "doc.pdf", "ocrStatus": "PENDING", ... }

# 5. Metadata
curl -H "X-Api-Key: <key>" http://localhost:3000/api/documents/<id>

# 6. Stream PDF
curl -H "X-Api-Key: <key>" \
  http://localhost:3000/api/documents/<id>/pdf -o descargado.pdf
# → archivo PDF descargado correctamente
```

Verificar en MongoDB Compass (o mongosh):
```js
use spatial-docdiff
db.documents.find()
db.pdfs.files.find()   // archivos GridFS
db.apikeys.find()      // keys seedeadas
```
