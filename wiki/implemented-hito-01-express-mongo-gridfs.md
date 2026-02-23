# Hito 01 — Implementado: Express + MongoDB + GridFS + Upload

**Fecha**: 2026-02-23
**Estado**: ✅ Completo

---

## Qué se implementó

Backend completo con Express, conexión a MongoDB vía Mongoose, almacenamiento de PDFs en GridFS, autenticación por API Key propia y los cuatro endpoints de documentos.

---

## Archivos creados

| Archivo | Descripción |
|---------|-------------|
| `src/server/index.js` | Entry point: Express + morgan + rutas + healthcheck + startup |
| `src/server/services/mongo.js` | `connectMongo()` + modelos Mongoose |
| `src/server/services/storage-gridfs.js` | multer upload + `storeFile()` + `streamFile()` |
| `src/server/middlewares/auth.js` | `requireScope(scope)` factory |
| `src/server/routes/documents.js` | 4 endpoints de documentos |
| `src/server/routes/comparisons.js` | Stub — TODO hito-03 |
| `src/server/jobs/ocr-job.js` | Stub — TODO hito-02 |
| `scripts/seed-key.js` | CLI para crear API keys |

---

## `src/server/index.js`

- `dotenv.config()` al inicio
- Middlewares globales: `express.json()`, `morgan('dev')`
- Rutas montadas en `/api/documents` y `/api/comparisons`
- `express.static('public')` para la SPA
- `GET /api/health` sin autenticación → `{ status: 'ok', ts: '...' }`
- Conecta a Mongo antes de levantar el listener; si falla → `process.exit(1)`

---

## `src/server/services/mongo.js`

### `connectMongo()`
Conecta a `MONGO_URI` (default: `mongodb://localhost:27017/spatial-docdiff`). Registra handler de error en la conexión.

### Modelos

**`Document`**
```
filename, gridfsId (ObjectId), sha256, mimeType, uploadedAt,
ocrStatus (PENDING|RUNNING|DONE|ERROR), ocrError,
ocrCanonical (Mixed), ocrEncoding, pageCount
```

**`Comparison`**
```
docAId, docBId, createdAt,
status (CREATED|COMPARE_RUNNING|DONE|ERROR),
error, differences[] (Mixed), tokensUsed, durationMs
```

**`ApiKey`**
```
key, label, scope[], usageCount, active, expiresAt, createdAt
```

Exports: `connectMongo`, `Document`, `Comparison`, `ApiKey`, `mongoose`

---

## `src/server/services/storage-gridfs.js`

### `upload` (multer middleware)
- `memoryStorage()` — el buffer queda en `req.file.buffer` para calcular sha256 antes de persistir
- `fileFilter`: rechaza cualquier MIME que no sea `application/pdf` → error con `status: 400`
- `limits.fileSize`: `MAX_UPLOAD_MB * 1024 * 1024` (default 50 MB desde `.env`)

### `storeFile(buffer, filename) → gridfsId`
- Crea `GridFSBucket(mongoose.connection.db, { bucketName: 'pdfs' })`
- Wrappea el buffer en un `Readable` y hace pipe al `uploadStream`
- Devuelve el `ObjectId` asignado por GridFS

### `streamFile(gridfsId, res)`
- Abre `openDownloadStream(gridfsId)` y hace pipe directo a `res`

---

## `src/server/middlewares/auth.js`

Exporta `requireScope(scope)` → middleware Express.

**Flujo de validación:**
1. Lee `req.headers['x-api-key']`
2. Busca en `ApiKey` por campo `key`
3. Valida: existe · `active: true` · `expiresAt == null || expiresAt <= now` · tiene el scope requerido o `'admin'`
4. ✅ OK: incrementa `usageCount` (fire-and-forget, sin await), setea `req.apiKey = doc`, `next()`
5. ❌ Falla: `401 { error: 'Unauthorized' }`

---

## `src/server/routes/documents.js`

### `POST /api/documents` — `requireScope('write')` + `upload.single('file')`
1. Calcula sha256 del `req.file.buffer`
2. `storeFile()` → `gridfsId`
3. Crea `Document` con `ocrStatus: 'PENDING'`
4. Dispara `runOcrJob(doc._id)` sin await (stub hasta hito-02)
5. Responde `201 { _id, filename, ocrStatus, uploadedAt }`

El router tiene un error handler local para capturar errores de multer (MIME inválido, archivo muy grande).

### `GET /api/documents/:id` — `requireScope('read')`
Devuelve `{ _id, filename, ocrStatus, pageCount, uploadedAt }` o `404`.

### `GET /api/documents/:id/pdf` — `requireScope('read')`
Setea `Content-Type: application/pdf` + `Content-Disposition: inline; filename="..."`, luego `streamFile(doc.gridfsId, res)`.

### `GET /api/documents/:id/ocr` — `requireScope('read')`
- Si `ocrStatus !== 'DONE'` → `409 { error: 'OCR not ready', ocrStatus }`
- Si DONE → `{ pageCount, encoding, canonical }`

---

## `scripts/seed-key.js`

Script standalone (no requiere el servidor corriendo).

```bash
node scripts/seed-key.js --label "dev" --scope admin
# → Key creada: a3f8c2d1e5b7...

node scripts/seed-key.js --label "cliente-readonly" --scope read
node scripts/seed-key.js --label "cliente-upload" --scope write,read
```

- Conecta directo a Mongo con `MONGO_URI` del `.env`
- Genera `crypto.randomBytes(32).toString('hex')`
- Inserta en `ApiKey` y desconecta

---

## Verificación con curl

```bash
# 1. Crear .env y key de test
cp .env.example .env
node scripts/seed-key.js --label "dev" --scope admin
# → Key creada: <HEX>

# 2. Arrancar servidor
npm run dev
# → [mongo] connected to mongodb://localhost:27017/spatial-docdiff
# → Server running on :3000

# 3. Healthcheck (sin auth)
curl http://localhost:3000/api/health
# → {"status":"ok","ts":"2026-02-23T..."}

# 4. Sin key → 401
curl http://localhost:3000/api/documents
# → {"error":"Unauthorized"}

# 5. Upload PDF
curl -H "X-Api-Key: <HEX>" \
  -F "file=@/path/to/doc.pdf" \
  http://localhost:3000/api/documents
# → {"_id":"...","filename":"doc.pdf","ocrStatus":"PENDING","uploadedAt":"..."}
# → [ocr-job] stub - hito-02 pendiente docId=...

# 6. Metadata
curl -H "X-Api-Key: <HEX>" http://localhost:3000/api/documents/<id>

# 7. Stream PDF
curl -H "X-Api-Key: <HEX>" http://localhost:3000/api/documents/<id>/pdf -o out.pdf

# 8. OCR (aún PENDING → 409)
curl -H "X-Api-Key: <HEX>" http://localhost:3000/api/documents/<id>/ocr
# → {"error":"OCR not ready","ocrStatus":"PENDING"}
```

---

## Pendiente (próximos hitos)

| Hito | Qué falta |
|------|-----------|
| hito-02 | Implementar `ocr-job.js` con Document AI |
| hito-03 | Implementar `comparisons.js` + `compare-job.js` con Gemini |
| hito-04/05 | UI: History screen + Review screen con PDF.js |
