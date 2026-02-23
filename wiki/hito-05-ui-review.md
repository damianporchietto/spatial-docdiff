# Hito 05 — UI: Review Screen

## Checklist

- [ ] Crear `public/review.html` con layout de dos columnas
- [ ] Crear `public/review.js` con lógica de render
- [ ] Integrar PDF.js (CDN o local)
- [ ] Renderizar dos canvas PDF lado a lado
- [ ] Implementar overlay canvas encima de cada PDF
- [ ] Implementar panel lateral con lista de diferencias
- [ ] Implementar filtros por categoría (MODIFICADO/AGREGADO/ELIMINADO/ESTRUCTURAL)
- [ ] Implementar highlight al hacer click en diferencia
- [ ] Implementar navegación de páginas (prev/next)
- [ ] Verificar: highlights se alinean correctamente sobre el PDF

---

## `public/review.html` — Layout

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Review — spatial-docdiff</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- PDF.js -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script>
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  </script>
</head>
<body class="bg-gray-100 h-screen flex flex-col overflow-hidden">

  <!-- Header -->
  <header class="bg-white border-b px-6 py-3 flex items-center justify-between shrink-0">
    <a href="/" class="text-sm text-blue-600 hover:underline">← Volver</a>
    <h1 class="text-base font-semibold text-gray-900">Revisión de diferencias</h1>
    <div id="comparison-status" class="text-sm text-gray-500"></div>
  </header>

  <!-- Body: split view + sidebar -->
  <div class="flex flex-1 overflow-hidden">

    <!-- PDF Side-by-side -->
    <div class="flex-1 flex gap-4 p-4 overflow-hidden">

      <!-- Doc A -->
      <div class="flex-1 flex flex-col bg-white rounded border overflow-hidden">
        <div class="text-xs font-medium text-gray-500 px-3 py-2 border-b bg-gray-50">
          Documento A — <span id="docA-filename">-</span>
        </div>
        <div class="flex-1 relative overflow-auto" id="docA-container">
          <canvas id="docA-canvas" class="block mx-auto"></canvas>
          <canvas id="docA-overlay" class="absolute top-0 left-1/2 -translate-x-1/2 pointer-events-none"></canvas>
        </div>
      </div>

      <!-- Doc B -->
      <div class="flex-1 flex flex-col bg-white rounded border overflow-hidden">
        <div class="text-xs font-medium text-gray-500 px-3 py-2 border-b bg-gray-50">
          Documento B — <span id="docB-filename">-</span>
        </div>
        <div class="flex-1 relative overflow-auto" id="docB-container">
          <canvas id="docB-canvas" class="block mx-auto"></canvas>
          <canvas id="docB-overlay" class="absolute top-0 left-1/2 -translate-x-1/2 pointer-events-none"></canvas>
        </div>
      </div>
    </div>

    <!-- Sidebar -->
    <aside class="w-80 bg-white border-l flex flex-col overflow-hidden shrink-0">

      <!-- Pagination -->
      <div class="px-4 py-3 border-b flex items-center justify-between">
        <button id="btn-prev" class="text-sm px-3 py-1 rounded border hover:bg-gray-50 disabled:opacity-40">← Ant</button>
        <span class="text-sm text-gray-600">
          Página <span id="current-page">1</span> / <span id="total-pages">?</span>
        </span>
        <button id="btn-next" class="text-sm px-3 py-1 rounded border hover:bg-gray-50 disabled:opacity-40">Sig →</button>
      </div>

      <!-- Filters -->
      <div class="px-4 py-2 border-b flex flex-wrap gap-2">
        <label class="flex items-center gap-1 text-xs cursor-pointer">
          <input type="checkbox" class="filter-checkbox" value="MODIFICADO" checked>
          <span class="px-2 py-0.5 rounded bg-yellow-100 text-yellow-800">MODIFICADO</span>
        </label>
        <label class="flex items-center gap-1 text-xs cursor-pointer">
          <input type="checkbox" class="filter-checkbox" value="AGREGADO" checked>
          <span class="px-2 py-0.5 rounded bg-green-100 text-green-800">AGREGADO</span>
        </label>
        <label class="flex items-center gap-1 text-xs cursor-pointer">
          <input type="checkbox" class="filter-checkbox" value="ELIMINADO" checked>
          <span class="px-2 py-0.5 rounded bg-red-100 text-red-800">ELIMINADO</span>
        </label>
        <label class="flex items-center gap-1 text-xs cursor-pointer">
          <input type="checkbox" class="filter-checkbox" value="ESTRUCTURAL" checked>
          <span class="px-2 py-0.5 rounded bg-blue-100 text-blue-800">ESTRUCTURAL</span>
        </label>
      </div>

      <!-- Differences list -->
      <div class="flex-1 overflow-y-auto" id="diff-list">
        <p class="text-sm text-gray-400 p-4">Cargando...</p>
      </div>

    </aside>
  </div>

  <script src="/review.js"></script>
</body>
</html>
```

---

## `public/review.js` — Estructura

### Estado global

```js
const state = {
  comparisonId: new URLSearchParams(window.location.search).get('id'),
  metadata: null,          // render-metadata del backend
  pdfDocA: null,           // instancia PDF.js DocA
  pdfDocB: null,           // instancia PDF.js DocB
  currentPage: 0,          // índice 0-based
  differences: [],
  activeFilters: new Set(['MODIFICADO', 'AGREGADO', 'ELIMINADO', 'ESTRUCTURAL']),
  selectedDiff: null,
  pollInterval: null,
};
```

### Ciclo de vida

```js
async function init() {
  // 1. Cargar metadata (pollear si aún no está DONE)
  await loadMetadata();

  if (state.metadata.status !== 'DONE') {
    startComparisonPolling();
    return;
  }

  // 2. Cargar PDFs con PDF.js
  [state.pdfDocA, state.pdfDocB] = await Promise.all([
    pdfjsLib.getDocument(state.metadata.docA.pdfUrl).promise,
    pdfjsLib.getDocument(state.metadata.docB.pdfUrl).promise,
  ]);

  // 3. Render primera página
  await renderPage(0);

  // 4. Render lista de diferencias
  renderDiffList();

  // 5. Setup event listeners
  setupPagination();
  setupFilters();
}
```

---

## Render de páginas y overlay

### Renderizar una página

```js
async function renderPage(pageIndex) {
  state.currentPage = pageIndex;

  // Renderizar ambos canvases en paralelo
  const [canvasA, canvasB] = await Promise.all([
    renderPdfPage(state.pdfDocA, pageIndex, 'docA-canvas'),
    renderPdfPage(state.pdfDocB, pageIndex, 'docB-canvas'),
  ]);

  // Ajustar overlay al tamaño del canvas
  syncOverlaySize('docA-overlay', canvasA);
  syncOverlaySize('docB-overlay', canvasB);

  // Dibujar highlights de diferencias en la página actual
  drawHighlights(pageIndex);

  // Actualizar numeración
  document.getElementById('current-page').textContent = pageIndex + 1;
}

async function renderPdfPage(pdfDoc, pageIndex, canvasId) {
  const page = await pdfDoc.getPage(pageIndex + 1); // PDF.js usa 1-based
  const viewport = page.getViewport({ scale: 1.5 });

  const canvas = document.getElementById(canvasId);
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({
    canvasContext: canvas.getContext('2d'),
    viewport,
  }).promise;

  return canvas;
}
```

### Dibujar highlights en el overlay

```js
// Categorías en español tal como las devuelve Gemini
const COLORS = {
  MODIFICADO:  'rgba(250, 204, 21, 0.4)',   // amarillo
  AGREGADO:    'rgba(34, 197, 94, 0.4)',    // verde
  ELIMINADO:   'rgba(239, 68, 68, 0.4)',    // rojo
  ESTRUCTURAL: 'rgba(59, 130, 246, 0.4)',   // azul
};

const BORDER_COLORS = {
  MODIFICADO:  'rgba(202, 138, 4, 0.9)',
  AGREGADO:    'rgba(22, 163, 74, 0.9)',
  ELIMINADO:   'rgba(185, 28, 28, 0.9)',
  ESTRUCTURAL: 'rgba(29, 78, 216, 0.9)',
};

function drawHighlights(pageIndex) {
  drawHighlightsOnCanvas('docA-overlay', pageIndex, 'A');
  drawHighlightsOnCanvas('docB-overlay', pageIndex, 'B');
}

function drawHighlightsOnCanvas(overlayId, pageIndex, side) {
  const canvas = document.getElementById(overlayId);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // page_number es 1-based; pageIndex es 0-based
  const pageNumber = pageIndex + 1;
  const highlightsKey = side === 'A' ? 'doc1_highlights' : 'doc2_highlights';

  for (const diff of state.differences) {
    if (!state.activeFilters.has(diff.category)) continue;

    const highlights = diff[highlightsKey] || [];
    const pageHighlights = highlights.filter(h => h.page_number === pageNumber);
    if (!pageHighlights.length) continue;

    const isSelected = diff === state.selectedDiff;

    for (const h of pageHighlights) {
      const bp = h.bbox_percent;

      // Convertir bbox_percent (0-100) a píxeles del canvas
      const x = (bp.x1 / 100) * canvas.width;
      const y = (bp.y1 / 100) * canvas.height;
      const w = ((bp.x2 - bp.x1) / 100) * canvas.width;
      const hh = ((bp.y2 - bp.y1) / 100) * canvas.height;

      ctx.fillStyle = COLORS[diff.category];
      ctx.fillRect(x, y, w, hh);

      ctx.strokeStyle = BORDER_COLORS[diff.category];
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.strokeRect(x, y, w, hh);
    }
  }
}
```

---

## Panel lateral: lista de diferencias

```js
function renderDiffList() {
  const container = document.getElementById('diff-list');
  const visible = state.differences.filter(d => state.activeFilters.has(d.category));

  if (!visible.length) {
    container.innerHTML = '<p class="text-sm text-gray-400 p-4">Sin diferencias para mostrar.</p>';
    return;
  }

  container.innerHTML = visible.map((diff, idx) => `
    <div
      class="diff-item px-4 py-3 border-b cursor-pointer hover:bg-gray-50 ${
        diff === state.selectedDiff ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''
      }"
      data-diff-index="${idx}"
    >
      <div class="flex items-center gap-2 mb-1">
        <span class="text-xs px-1.5 py-0.5 rounded ${typeBadgeClass(diff.category)}">${diff.category}</span>
      </div>
      <p class="text-xs text-gray-700 line-clamp-3">${diff.description}</p>
      ${diff.doc1_text ? `<p class="text-xs text-red-600 mt-1 line-clamp-1">- ${diff.doc1_text}</p>` : ''}
      ${diff.doc2_text ? `<p class="text-xs text-green-600 mt-0.5 line-clamp-1">+ ${diff.doc2_text}</p>` : ''}
    </div>
  `).join('');

  // Click handler — usa índice en lugar de id
  const visibleDiffs = visible; // cierre sobre la lista filtrada
  container.querySelectorAll('.diff-item').forEach(el => {
    el.addEventListener('click', () => selectDiff(visibleDiffs[+el.dataset.diffIndex]));
  });
}

function typeBadgeClass(category) {
  return {
    MODIFICADO:  'bg-yellow-100 text-yellow-800',
    AGREGADO:    'bg-green-100 text-green-800',
    ELIMINADO:   'bg-red-100 text-red-800',
    ESTRUCTURAL: 'bg-blue-100 text-blue-800',
  }[category] || '';
}
```

---

## Selección de diferencia

```js
async function selectDiff(diff) {
  if (!diff) return;

  state.selectedDiff = diff;

  // Tomar la primera página de cualquiera de los dos lados (1-based → 0-based)
  const firstHighlight = diff.doc1_highlights?.[0] ?? diff.doc2_highlights?.[0];
  const targetPage = firstHighlight ? firstHighlight.page_number - 1 : state.currentPage;

  if (targetPage !== state.currentPage) {
    await renderPage(targetPage);
  } else {
    drawHighlights(state.currentPage); // redibujar con highlight activo
  }

  renderDiffList(); // actualizar selección visual en lista
}
```

---

## Paginación

```js
function setupPagination() {
  const maxPage = Math.max(
    state.metadata.docA.pageCount,
    state.metadata.docB.pageCount
  ) - 1;

  document.getElementById('total-pages').textContent = maxPage + 1;

  document.getElementById('btn-prev').addEventListener('click', async () => {
    if (state.currentPage > 0) await renderPage(state.currentPage - 1);
  });

  document.getElementById('btn-next').addEventListener('click', async () => {
    if (state.currentPage < maxPage) await renderPage(state.currentPage + 1);
  });
}
```

---

## Polling para comparación en curso

Si se navega a `/review.html?id=:compId` mientras la comparación aún corre:

```js
function startComparisonPolling() {
  document.getElementById('comparison-status').textContent = 'Comparando...';

  state.pollInterval = setInterval(async () => {
    const res = await fetch(`/api/comparisons/${state.comparisonId}`);
    const comp = await res.json();

    if (comp.status === 'DONE') {
      clearInterval(state.pollInterval);
      state.metadata = await fetchMetadata();
      state.differences = state.metadata.differences;
      await initPdfs();
      renderDiffList();
      document.getElementById('comparison-status').textContent =
        `${comp.differences.length} diferencias encontradas`;
    } else if (comp.status === 'ERROR') {
      clearInterval(state.pollInterval);
      document.getElementById('comparison-status').textContent =
        `Error: ${comp.error}`;
    }
  }, 3000);
}
```

---

## Consideraciones técnicas

### Alineación del overlay
- El `overlay` canvas debe tener exactamente el mismo tamaño en píxeles que el `pdf` canvas.
- Usar `position: absolute` con el mismo `top`/`left` del canvas PDF.
- El overlay tiene `pointer-events: none` para no bloquear scroll/zoom del usuario.

### Escalado del bbox
- Los bboxes en Mongo usan `bbox_percent: { x1, y1, x2, y2 }` en porcentaje **0-100**.
- Al convertir a píxeles: `x_px = (bp.x1 / 100) * canvas.width`, `w_px = ((bp.x2 - bp.x1) / 100) * canvas.width`.
- Si PDF.js renderiza con `scale: 1.5`, el canvas ya tiene el tamaño escalado; el porcentaje funciona igual.
- `page_number` en los highlights es **1-based**; `pageIndex` en el estado es **0-based** (`pageNumber = pageIndex + 1`).

### Páginas de distinto tamaño
- Si DocA tiene más páginas que DocB (o viceversa), mostrar el canvas vacío para el lado sin página.

### Performance
- No re-renderizar el PDF en cada redibujado de highlights: mantener el canvas PDF separado del overlay.
- Solo redibujar el overlay al cambiar selección o filtros.
