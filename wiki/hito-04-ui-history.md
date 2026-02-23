# Hito 04 — UI: History Screen

## Checklist

- [ ] Crear `public/index.html` con layout Tailwind
- [ ] Crear `public/app.js` con lógica de la pantalla
- [ ] Implementar sección de API Key (modal o sidebar)
- [ ] Implementar form de upload de dos PDFs
- [ ] Implementar polling de estado OCR
- [ ] Implementar botón Compare (habilitado cuando ambos `DONE`)
- [ ] Implementar tabla de comparaciones previas
- [ ] Implementar navegación a `/review.html?id=:compId`

---

## `public/index.html` — Layout

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>spatial-docdiff</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen">

  <!-- Header -->
  <header class="bg-white border-b px-6 py-4 flex items-center justify-between">
    <h1 class="text-xl font-bold text-gray-900">spatial-docdiff</h1>
    <button id="btn-api-key" class="text-sm text-blue-600 hover:underline">
      ⚙ API Key
    </button>
  </header>

  <!-- Modal API Key -->
  <div id="modal-apikey" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50">
    <div class="bg-white rounded-lg p-6 w-full max-w-md shadow-xl">
      <h2 class="text-lg font-semibold mb-4">Gemini API Key</h2>
      <input id="input-apikey" type="password"
        placeholder="AIzaSy..."
        class="w-full border rounded px-3 py-2 text-sm mb-2 font-mono">
      <input id="input-keylabel" type="text"
        placeholder="Etiqueta (opcional)"
        class="w-full border rounded px-3 py-2 text-sm mb-4">
      <div id="apikey-status" class="text-sm text-gray-500 mb-3"></div>
      <div class="flex gap-2 justify-end">
        <button id="btn-apikey-cancel" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
        <button id="btn-apikey-save" class="px-4 py-2 text-sm bg-blue-600 text-white rounded">Guardar</button>
      </div>
    </div>
  </div>

  <!-- Main content -->
  <main class="max-w-4xl mx-auto px-6 py-8 space-y-8">

    <!-- Upload section -->
    <section class="bg-white rounded-lg border p-6">
      <h2 class="text-base font-semibold mb-4">Nueva comparación</h2>
      <div class="grid grid-cols-2 gap-4 mb-4">
        <!-- Doc A -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Documento A</label>
          <input id="input-docA" type="file" accept="application/pdf"
            class="block w-full text-sm text-gray-500 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700">
          <div id="status-docA" class="mt-1 text-xs text-gray-400"></div>
        </div>
        <!-- Doc B -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Documento B</label>
          <input id="input-docB" type="file" accept="application/pdf"
            class="block w-full text-sm text-gray-500 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700">
          <div id="status-docB" class="mt-1 text-xs text-gray-400"></div>
        </div>
      </div>
      <button id="btn-compare"
        disabled
        class="px-6 py-2 bg-blue-600 text-white text-sm rounded font-medium disabled:opacity-40 disabled:cursor-not-allowed">
        Comparar
      </button>
      <div id="compare-error" class="mt-2 text-sm text-red-600 hidden"></div>
    </section>

    <!-- Comparisons history table -->
    <section class="bg-white rounded-lg border p-6">
      <h2 class="text-base font-semibold mb-4">Comparaciones previas</h2>
      <div id="comparisons-list">
        <p class="text-sm text-gray-400">Cargando...</p>
      </div>
    </section>

  </main>

  <script src="/app.js"></script>
</body>
</html>
```

---

## `public/app.js` — Estructura

```js
// Estado global
const state = {
  apiKeyId: localStorage.getItem('apiKeyId') || null,
  docA: null,   // { id, filename, ocrStatus }
  docB: null,
  pollIntervals: {},
};

// ─── API Key ───────────────────────────────────────────────────────────────

async function saveApiKey(key, label) {
  const res = await fetch('/api/apikeys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, label }),
  });
  if (!res.ok) throw new Error('Error guardando API key');
  const data = await res.json();
  state.apiKeyId = data._id;
  localStorage.setItem('apiKeyId', data._id);
  return data;
}

// ─── Upload ────────────────────────────────────────────────────────────────

async function uploadDoc(file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/documents', { method: 'POST', body: form });
  if (!res.ok) throw new Error('Error subiendo documento');
  return res.json();  // { _id, filename, ocrStatus }
}

// ─── OCR Polling ───────────────────────────────────────────────────────────

function startOcrPolling(docSlot, docId, statusEl) {
  const interval = setInterval(async () => {
    const res = await fetch(`/api/documents/${docId}`);
    const doc = await res.json();

    state[docSlot].ocrStatus = doc.ocrStatus;
    updateOcrStatusBadge(statusEl, doc.ocrStatus);

    if (doc.ocrStatus === 'DONE' || doc.ocrStatus === 'ERROR') {
      clearInterval(interval);
      updateCompareButton();
    }
  }, 3000);

  state.pollIntervals[docSlot] = interval;
}

function updateOcrStatusBadge(el, status) {
  const colors = {
    PENDING:  'bg-gray-100 text-gray-600',
    RUNNING:  'bg-yellow-100 text-yellow-700',
    DONE:     'bg-green-100 text-green-700',
    ERROR:    'bg-red-100 text-red-700',
  };
  el.className = `mt-1 text-xs px-2 py-0.5 rounded inline-block ${colors[status] || ''}`;
  el.textContent = status;
}

// ─── Compare button ────────────────────────────────────────────────────────

function updateCompareButton() {
  const ready = state.docA?.ocrStatus === 'DONE' && state.docB?.ocrStatus === 'DONE';
  document.getElementById('btn-compare').disabled = !ready || !state.apiKeyId;
}

// ─── Compare flow ──────────────────────────────────────────────────────────

async function startComparison() {
  if (!state.apiKeyId) {
    showCompareError('Primero configura tu Gemini API Key');
    return;
  }

  // 1. Crear comparación
  const createRes = await fetch('/api/comparisons', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key-Id': state.apiKeyId,
    },
    body: JSON.stringify({ docAId: state.docA.id, docBId: state.docB.id }),
  });
  const comp = await createRes.json();

  // 2. Disparar comparación
  await fetch(`/api/comparisons/${comp._id}/run`, { method: 'POST' });

  // 3. Navegar a review (polling continuará allí)
  window.location.href = `/review.html?id=${comp._id}`;
}

// ─── Comparisons table ─────────────────────────────────────────────────────

async function loadComparisons() {
  const res = await fetch('/api/comparisons');
  const comps = await res.json();
  renderComparisonsTable(comps);
}

function renderComparisonsTable(comps) {
  const container = document.getElementById('comparisons-list');
  if (!comps.length) {
    container.innerHTML = '<p class="text-sm text-gray-400">Sin comparaciones previas.</p>';
    return;
  }

  container.innerHTML = `
    <table class="w-full text-sm">
      <thead class="text-left text-gray-500 border-b">
        <tr>
          <th class="pb-2">Documento A</th>
          <th class="pb-2">Documento B</th>
          <th class="pb-2">Estado</th>
          <th class="pb-2">Diferencias</th>
          <th class="pb-2"></th>
        </tr>
      </thead>
      <tbody>
        ${comps.map(c => `
          <tr class="border-b last:border-0">
            <td class="py-2 pr-4">${c.docAId?.filename ?? '-'}</td>
            <td class="py-2 pr-4">${c.docBId?.filename ?? '-'}</td>
            <td class="py-2 pr-4">
              <span class="text-xs px-2 py-0.5 rounded ${statusColor(c.status)}">${c.status}</span>
            </td>
            <td class="py-2 pr-4">${c.diffCount ?? '-'}</td>
            <td class="py-2">
              ${c.status === 'DONE'
                ? `<a href="/review.html?id=${c._id}" class="text-blue-600 hover:underline">Ver</a>`
                : '—'}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function statusColor(status) {
  return {
    CREATED:          'bg-gray-100 text-gray-600',
    COMPARE_RUNNING:  'bg-yellow-100 text-yellow-700',
    DONE:             'bg-green-100 text-green-700',
    ERROR:            'bg-red-100 text-red-700',
  }[status] || '';
}

// ─── Init ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadComparisons();
  updateCompareButton();

  // Indicar si ya hay API key guardada
  if (state.apiKeyId) {
    document.getElementById('btn-api-key').textContent = '✓ API Key';
  }

  // Event listeners (modal, uploads, compare button)
  // ...
});
```

---

## Flujo de interacción completo

```
Usuario abre /
    │
    ├─ ¿Tiene apiKeyId en localStorage?
    │   ├─ SÍ → mostrar "✓ API Key" en header
    │   └─ NO → mostrar "⚙ API Key" (invitar a configurar)
    │
    ├─ Selecciona Doc A (file input)
    │       └─ onChange → uploadDoc(file)
    │                       └─ POST /api/documents
    │                           └─ startOcrPolling(docA, id, statusEl)
    │                               └─ cada 3s: GET /api/documents/:id
    │                                   └─ actualiza badge → checkCompareButton
    │
    ├─ Selecciona Doc B (file input) → mismo flujo
    │
    ├─ Cuando ambos ocrStatus === DONE → habilitar botón "Comparar"
    │
    └─ Click "Comparar"
            └─ POST /api/comparisons (X-API-Key-Id header)
                └─ POST /api/comparisons/:id/run
                    └─ redirect → /review.html?id=:compId
```

---

## Notas de implementación

- **Sin bundler**: todo es JS vanilla en un solo archivo `app.js`. Mantener simple.
- **Tailwind CDN**: `<script src="https://cdn.tailwindcss.com">` — sin build step.
- **localStorage**: solo guarda `apiKeyId` (el ID de Mongo, no la key en sí).
- **Polling**: usar `setInterval` con 3 segundos. Limpiar el interval al desmontar o cuando llegue a estado final.
- **Upload inmediato**: los archivos se suben al seleccionarlos (no esperar al click de comparar). Esto permite que el OCR corra en paralelo mientras el usuario selecciona el segundo archivo.
- **Error handling**: mostrar mensajes descriptivos si el upload falla o si la API key no está configurada.
