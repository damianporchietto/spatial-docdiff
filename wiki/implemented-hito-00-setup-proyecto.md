# Hito 00 — Implementado: Setup de proyecto

**Fecha**: 2026-02-23
**Estado**: ✅ Completo

---

## Qué se implementó

La estructura base del proyecto: `package.json`, carpetas y archivos placeholder necesarios para que los hitos siguientes puedan construir sobre ellos.

---

## Archivos creados

| Archivo | Descripción |
|---------|-------------|
| `package.json` | Dependencias, scripts `start` y `dev` |
| `public/index.html` | Placeholder "coming soon" — se reemplaza en hito-04 |

---

## `package.json` — detalles

```json
{
  "name": "spatial-docdiff",
  "version": "1.0.0",
  "main": "src/server/index.js",
  "scripts": {
    "start": "node src/server/index.js",
    "dev": "nodemon src/server/index.js"
  }
}
```

**Dependencias de producción:**
- `express ^4.18` — servidor HTTP
- `mongoose ^8.0` — ODM para MongoDB
- `multer ^1.4.5-lts.1` — manejo de multipart/form-data
- `dotenv ^16` — carga de variables de entorno
- `morgan ^1.10` — logging de requests HTTP

**DevDependencies:**
- `nodemon ^3.0` — restart automático en desarrollo

> `gridfs-stream` y `multer-gridfs-storage` **no se usan**: son incompatibles con mongoose v8 + MongoDB driver v6. Se usa `GridFSBucket` nativo del driver (incluido con mongoose).

---

## Estructura de carpetas establecida

```
spatial-docdiff/
├── src/server/
│   ├── index.js
│   ├── middlewares/
│   ├── routes/
│   ├── services/
│   └── jobs/
├── public/
│   └── index.html        ← placeholder
├── scripts/
├── wiki/
├── .env.example
└── package.json
```

---

## Verificación

```bash
npm install
# → 141 packages instalados, 0 vulnerabilities
```
