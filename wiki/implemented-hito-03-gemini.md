# Hito 03 — Comparación con Gemini (Implementado)

## Resumen

Pipeline de comparación de documentos usando Gemini 1.5 Pro con structured output.
Recibe los `ocrTextPayload` de dos documentos (generados en Hito 02), los envía a Gemini,
decodifica las paragraph refs en highlights con bounding boxes, y expone endpoints REST.

## Archivos creados/modificados

| Archivo | Acción | Descripción |
|---------|--------|-------------|
| `src/server/services/gemini.js` | Creado | Wrapper Gemini — `compareDocuments(doc1TextPayload, doc2TextPayload)` |
| `src/server/services/diff-decode.js` | Creado | `mapRefsToHighlights()` — refs → bbox highlights |
| `src/server/jobs/compare-job.js` | Creado | Job asíncrono de comparación |
| `src/server/routes/comparisons.js` | Reescrito | 5 endpoints REST |
| `package.json` | Modificado | Agregado `@google/generative-ai` |

## Decisiones de diseño

- **GEMINI_API_KEY es server-side**: Se usa `process.env.GEMINI_API_KEY` directamente,
  no se resuelve desde MongoDB. Las `api_keys` de Mongo son tokens de auth propios.
- **Fire-and-forget**: El POST que crea la comparación dispara el job sin esperar resultado.
  El frontend hace polling con GET /:id.
- **Retry con backoff exponencial**: 3 reintentos (2s, 4s, 8s) para errores transitorios
  (429, 502, 503, 504, connection errors).
- **Fallback bbox**: Si Gemini referencia un paragraph ID que no existe en ocrParagraphs,
  se usa `{x1:0, y1:0, x2:0, y2:0}` como fallback en lugar de fallar.

## Endpoints

| Método | Ruta | Scope | Descripción |
|--------|------|-------|-------------|
| POST | `/api/comparisons` | write | Crear comparación + fire-and-forget job |
| POST | `/api/comparisons/:id/run` | write | Re-disparar compare job |
| GET | `/api/comparisons` | read | Listar comparaciones con diffCount |
| GET | `/api/comparisons/:id` | read | Detalle completo con differences[] |
| GET | `/api/comparisons/:id/render-metadata` | read | Metadata para review screen |

## Flujo de estados

```
CREATED → COMPARE_RUNNING → DONE
                           → ERROR
```

## Variables de entorno requeridas

```
GEMINI_API_KEY=<tu-gemini-api-key>
```

## Verificación

```bash
# Crear comparación (ambos docs deben tener ocrStatus=DONE)
curl -s -X POST http://localhost:3000/api/comparisons \
  -H "Content-Type: application/json" -H "X-Api-Key: $KEY" \
  -d '{"docAId":"...","docBId":"..."}'

# Polling
curl -s -H "X-Api-Key: $KEY" http://localhost:3000/api/comparisons/$COMP_ID

# Render metadata
curl -s -H "X-Api-Key: $KEY" http://localhost:3000/api/comparisons/$COMP_ID/render-metadata
```
