# Hito 06 — Hardening: Límites, Errores, Logging, Seguridad

## Checklist

- [ ] Implementar validación de tipo MIME y límite de tamaño en upload
- [ ] Agregar startup check para variables de entorno requeridas
- [ ] Mejorar manejo de errores en jobs (mensaje descriptivo en `error` field)
- [ ] Agregar logging de estado de jobs con timestamps
- [ ] Registrar tokens usados y estimación de costo en comparaciones
- [ ] Implementar rate limiting básico
- [ ] Implementar validación de `keyId` en headers
- [ ] (Opcional) Implementar deduplicación por sha256

---

## Límites de upload

### Variables de entorno

```dotenv
MAX_UPLOAD_MB=50           # Tamaño máximo por archivo (default: 50 MB)
MAX_DOCAI_MB=15            # Límite de Document AI inline API (default: 15 MB)
```

### Validaciones en el endpoint `POST /api/documents`

```js
// 1. MIME type
if (req.file.mimetype !== 'application/pdf') {
  return res.status(400).json({ error: 'Solo se aceptan archivos PDF' });
}

// 2. Tamaño
const maxBytes = (parseInt(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024;
if (req.file.size > maxBytes) {
  return res.status(400).json({
    error: `El archivo excede el límite de ${process.env.MAX_UPLOAD_MB || 50} MB`
  });
}

// 3. Advertencia para Document AI
const docaiMaxBytes = (parseInt(process.env.MAX_DOCAI_MB) || 15) * 1024 * 1024;
if (req.file.size > docaiMaxBytes) {
  console.warn(`[OCR] Archivo ${req.file.originalname} (${req.file.size} bytes) excede el límite inline de Document AI. Considerar usar GCS.`);
  // Aún así intentar; Document AI dará error si supera el límite
}
```

### Configuración de Multer

```js
const upload = multer({
  storage: gridfsStorage,
  limits: {
    fileSize: (parseInt(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      cb(new Error('Solo se aceptan archivos PDF'), false);
    } else {
      cb(null, true);
    }
  },
});
```

---

## Startup check — Variables de entorno

Al iniciar el servidor, verificar que las variables críticas están presentes:

```js
// src/server/config.js
const REQUIRED_ENV_VARS = [
  'MONGO_URI',
  'DOCAI_PROJECT_ID',
  'DOCAI_LOCATION',
  'DOCAI_PROCESSOR_ID',
];

function checkEnv() {
  const missing = REQUIRED_ENV_VARS.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error('❌ Variables de entorno faltantes:', missing.join(', '));
    console.error('   Copia .env.example a .env y completa los valores.');
    process.exit(1);
  }
  console.log('✅ Variables de entorno verificadas');
}

module.exports = { checkEnv };
```

Llamar en `index.js` antes de conectar a Mongo:

```js
const { checkEnv } = require('./config');
checkEnv();
```

---

## Manejo de errores en jobs

### Errores descriptivos

Los jobs deben guardar mensajes de error accionables en el campo `error`:

```js
// En ocr-job.js
} catch (err) {
  let errorMessage = err.message;

  // Errores conocidos de Document AI
  if (err.code === 3) errorMessage = 'PDF inválido o corrupto';
  if (err.code === 8) errorMessage = 'Cuota de Document AI agotada';
  if (err.message?.includes('file too large')) {
    errorMessage = `PDF demasiado grande para OCR inline (máx ${process.env.MAX_DOCAI_MB || 15} MB)`;
  }

  await Document.findByIdAndUpdate(documentId, {
    ocrStatus: 'ERROR',
    ocrError: errorMessage,
  });
  console.error(`[OCR] Error en doc ${documentId}:`, errorMessage);
}
```

### Reintentos simples (opcional)

Para errores transitorios (timeout de red, rate limit), un reintento simple:

```js
async function runWithRetry(fn, maxRetries = 2) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < maxRetries) {
        console.warn(`[Retry ${i+1}/${maxRetries}]:`, err.message);
        await new Promise(r => setTimeout(r, 2000 * (i + 1))); // backoff
      }
    }
  }
  throw lastErr;
}
```

---

## Logging

### Logging de jobs

```js
// Formato: [JOB_NAME] [STATUS] docId=... durationMs=...
console.log(`[OCR] STARTED docId=${documentId}`);
console.log(`[OCR] DONE docId=${documentId} pages=${pageCount} durationMs=${Date.now() - start}`);
console.error(`[OCR] ERROR docId=${documentId}:`, err.message);

console.log(`[COMPARE] STARTED compId=${comparisonId}`);
console.log(`[COMPARE] DONE compId=${comparisonId} diffs=${differences.length} tokens=${tokensUsed} durationMs=${duration}`);
```

### Estimación de costo Gemini

```js
// Gemini 1.5 Pro (precios aproximados, verificar en Google Cloud)
const COST_PER_1K_INPUT_TOKENS  = 0.00125;  // USD
const COST_PER_1K_OUTPUT_TOKENS = 0.005;    // USD

function estimateCost(usage) {
  const inputCost  = (usage.promptTokenCount  / 1000) * COST_PER_1K_INPUT_TOKENS;
  const outputCost = (usage.candidatesTokenCount / 1000) * COST_PER_1K_OUTPUT_TOKENS;
  return {
    inputTokens:  usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens:  usage.totalTokenCount,
    estimatedUSD: (inputCost + outputCost).toFixed(6),
  };
}

// Loguear y guardar en comparación
const cost = estimateCost(result.response.usageMetadata);
console.log(`[COMPARE] COST compId=${comparisonId}`, cost);
await Comparison.findByIdAndUpdate(comparisonId, {
  tokensUsed: cost.totalTokens,
  estimatedCostUSD: parseFloat(cost.estimatedUSD),
});
```

---

## Deduplicación por sha256 (opcional)

Evitar procesar el mismo PDF dos veces:

```js
// En POST /api/documents
const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

// Buscar si ya existe
const existing = await Document.findOne({ sha256 });
if (existing) {
  return res.status(200).json({
    ...existing.toObject(),
    deduplicated: true,
  });
}
```

Requiere tener el buffer disponible antes de guardar en GridFS. Con `multer-gridfs-storage` el archivo se guarda directamente; para deduplicación hay que usar `multer` con `memoryStorage` primero, calcular el hash, y luego hacer el upload a GridFS manualmente si no es duplicado.

---

## Seguridad mínima

### Rate limiting

```bash
npm install express-rate-limit
```

```js
const rateLimit = require('express-rate-limit');

// Límite general de API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutos
  max: 100,
  message: { error: 'Demasiadas solicitudes, intenta más tarde' },
});
app.use('/api/', apiLimiter);

// Límite más estricto para uploads (costosos)
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hora
  max: 20,
  message: { error: 'Límite de uploads alcanzado' },
});
app.use('/api/documents', uploadLimiter);
```

### Validación de keyId en headers

Middleware para endpoints que requieren Gemini:

```js
async function requireApiKey(req, res, next) {
  const keyId = req.headers['x-api-key-id'];
  if (!keyId) {
    return res.status(401).json({ error: 'Se requiere X-API-Key-Id header' });
  }

  if (!mongoose.Types.ObjectId.isValid(keyId)) {
    return res.status(400).json({ error: 'keyId inválido' });
  }

  const apiKey = await ApiKey.findById(keyId).select('_id');
  if (!apiKey) {
    return res.status(401).json({ error: 'API key no encontrada' });
  }

  req.keyId = keyId;
  next();
}

// Usar en rutas que crean comparaciones
router.post('/', requireApiKey, createComparison);
router.post('/:id/run', requireApiKey, runComparison);
```

### Consideraciones adicionales

| Riesgo | Mitigación en prototipo |
|---|---|
| API keys en texto plano en Mongo | Aceptable para prototipo; en prod: cifrar con AES-256 o usar Secret Manager |
| CORS | Deshabilitar o restringir según necesidad de deploy |
| Validación de ObjectId | Usar `mongoose.Types.ObjectId.isValid()` antes de queries |
| Path traversal en filename | Sanitizar `req.file.originalname` antes de guardar en Mongo |
| Uploads de archivos no-PDF | Validar MIME type en multer fileFilter (ya incluido) |

---

## .env.example final (completo)

```dotenv
# MongoDB
MONGO_URI=mongodb://localhost:27017/spatial-docdiff

# Google Cloud Document AI
DOCAI_PROJECT_ID=your-gcp-project-id
DOCAI_LOCATION=us
DOCAI_PROCESSOR_ID=your-processor-id

# Servidor
PORT=3000
MAX_UPLOAD_MB=50
MAX_DOCAI_MB=15

# NOTA: GEMINI_API_KEY no va aquí — se ingresa en la UI y se guarda en MongoDB
# La API key de Gemini se gestiona a través de POST /api/apikeys
```
