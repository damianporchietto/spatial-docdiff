# Hito 02 — Implementado: OCR con Document AI

**Fecha**: 2026-02-24
**Estado**: Completo

---

## Que se implemento

Pipeline completo de OCR: envio de PDF a Google Document AI, construccion de indice de parrafos con bounding boxes en porcentaje, y almacenamiento del resultado en MongoDB para consumo posterior por Gemini (hito-03).

---

## Archivos creados

| Archivo | Descripcion |
|---------|-------------|
| `src/server/services/docai.js` | Wrapper sobre Document AI `processDocument(pdfBuffer)` |
| `src/server/services/ocr-paragraph-index.js` | `buildParagraphIndex()` + `buildTextPayload()` con helpers |

## Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `package.json` | Agregado `@google-cloud/documentai` |
| `src/server/services/mongo.js` | Schema: `ocrCanonical`/`ocrEncoding` reemplazados por `ocrParagraphs`/`ocrTextPayload` |
| `src/server/services/storage-gridfs.js` | Agregado `getFileBuffer(gridfsId)` para leer PDF como buffer |
| `src/server/jobs/ocr-job.js` | Reemplazado stub por pipeline completo: GridFS -> Document AI -> paragraph index -> Mongo |
| `src/server/routes/documents.js` | Endpoint `GET /:id/ocr` actualizado para devolver paragraphs y textPayload |

---

## `src/server/services/docai.js`

Wrapper minimo sobre `DocumentProcessorServiceClient`. Lee configuracion de env vars:
- `DOCAI_PROJECT_ID`
- `DOCAI_LOCATION`
- `DOCAI_PROCESSOR_ID`

Funcion `processDocument(pdfBuffer)`: convierte buffer a base64, llama a `client.processDocument()`, retorna `result.document.pages` crudas.

---

## `src/server/services/ocr-paragraph-index.js`

### `buildParagraphIndex(docaiPages)`
Itera pages -> blocks -> paragraphs de Document AI. Para cada parrafo no vacio:
- Extrae texto uniendo words/symbols
- Calcula bbox absoluto desde vertices (soporta normalizados y absolutos)
- Convierte a `bbox_percent` (0-100)
- Asigna ID `P{page}_{blockIdx}_{paraIdx}` (page 1-based)

Retorna `{ paragraphs, pageDimensions }`.

### `buildTextPayload(paragraphs, docLabel)`
Genera string formateado con headers de pagina y `[PX_Y_Z] texto` por parrafo, listo para enviar a Gemini.

### Helpers
- `extractParagraphText` — une words/symbols en string
- `calculateParagraphBbox` — calcula bbox absoluto, detecta si vertices son normalizados (0-1) o absolutos (px)
- `verticesToAbsoluteBbox` — convierte vertices a {x1,y1,x2,y2}
- `bboxToPercent` — convierte bbox absoluto a porcentaje 0-100

---

## `src/server/jobs/ocr-job.js`

### Flujo
1. `ocrStatus` -> `RUNNING`
2. Lee PDF buffer de GridFS via `getFileBuffer()`
3. `docai.processDocument(pdfBuffer)` -> paginas crudas
4. `buildParagraphIndex(docaiPages)` -> paragraphs con bbox
5. `buildTextPayload(paragraphs, 'DOCUMENTO')` -> texto formateado
6. Guarda `ocrParagraphs`, `ocrTextPayload`, `pageCount`, `ocrStatus: 'DONE'`
7. En error: `ocrStatus: 'ERROR'` + `ocrError: err.message`

### Estados
```
PENDING -> RUNNING -> DONE
                   -> ERROR
```

---

## Schema Mongo actualizado — campos OCR en `documents`

| Campo | Tipo | Descripcion |
|---|---|---|
| `ocrStatus` | String | `PENDING \| RUNNING \| DONE \| ERROR` |
| `ocrParagraphs` | [Mixed] | Paragraph index con id, text, bbox_percent |
| `ocrTextPayload` | String | Texto con `[PX_Y_Z] texto` para Gemini |
| `ocrError` | String | Mensaje de error si status === ERROR |
| `pageCount` | Number | Numero de paginas detectadas |

---

## Endpoint `GET /api/documents/:id/ocr`

**Cuando `ocrStatus !== 'DONE'`** -> `409`:
```json
{ "error": "OCR not ready", "ocrStatus": "RUNNING" }
```

**Cuando `ocrStatus === 'DONE'`** -> `200`:
```json
{
  "pageCount": 5,
  "paragraphCount": 142,
  "textPayload": "=== DOCUMENTO ===\n\n--- Pagina 1 ---\n\n[P1_0_0] Clausula 1...",
  "paragraphs": [
    {
      "id": "P1_0_0", "page_number": 1, "block_index": 0, "paragraph_index": 0,
      "text": "Clausula 1. Objeto del contrato",
      "bbox_percent": { "x1": 10, "y1": 5, "x2": 90, "y2": 8 }
    }
  ]
}
```

---

## Configuracion requerida

Variables de entorno (agregar a `.env`):
```
DOCAI_PROJECT_ID=<gcp-project-id>
DOCAI_LOCATION=<us|eu>
DOCAI_PROCESSOR_ID=<processor-id>
GOOGLE_APPLICATION_CREDENTIALS=<path-to-service-account.json>
```

---

## Verificacion

```bash
# 1. Subir PDF
curl -H "X-Api-Key: <KEY>" -F "file=@test.pdf" http://localhost:3000/api/documents

# 2. Polling status
curl -H "X-Api-Key: <KEY>" http://localhost:3000/api/documents/<id>
# Esperar ocrStatus: DONE

# 3. Ver OCR
curl -H "X-Api-Key: <KEY>" http://localhost:3000/api/documents/<id>/ocr
# Verificar: pageCount, paragraphCount > 0, paragraphs[0].bbox_percent con valores 0-100
```

---

## Pendiente (proximos hitos)

| Hito | Que falta |
|------|-----------|
| hito-03 | Implementar comparisons + compare-job con Gemini |
| hito-04/05 | UI: History screen + Review screen con PDF.js |
