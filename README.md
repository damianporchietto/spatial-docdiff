# Método de comparación documental multimodal indirecta mediante codificación compacta de OCR con anclaje geométrico, habilitando detección de diferencias semánticas con reproyección espacial precisa

Este repositorio documenta e implementa el método descripto en el título. El objetivo es comparar dos versiones de un documento PDF e identificar diferencias de contenido con localización exacta sobre el documento original, sin procesamiento visual directo y sin transmitir metadatos espaciales al modelo de lenguaje.

---

## Motivación

Comparar dos versiones de un documento —un contrato modificado, una resolución con enmiendas, un pliego corregido— es una tarea frecuente y costosa. Los enfoques existentes tienen limitaciones estructurales:

**Diff sobre texto plano**: captura cambios de línea pero pierde toda referencia a páginas, párrafos y posición en el documento. El output es difícil de contrastar con el original.

**Comparación visual pixel a pixel**: detecta diferencias gráficas pero no comprende semántica. Un reflow de párrafo o un cambio de interlineado genera falsos positivos; una sustitución de término en el mismo bloque pasa inadvertida.

**LLMs con imágenes de página**: viable con modelos multimodales recientes, pero el costo de tokens por imagen es alto, la precisión de localización depende de la capacidad de razonamiento espacial del modelo, y escalar a documentos de muchas páginas es costoso e impredecible.

**Comparación manual**: precisa y semántica, pero no escala y es propensa a omisiones en documentos extensos.

El problema central es que la comprensión semántica y la localización espacial son capacidades que residen en herramientas distintas y habitualmente incompatibles. Este método las combina sin requerir que ninguna herramienta haga lo que no sabe hacer bien.

---

## El método

### Principio fundamental

Un modelo de lenguaje puede determinar con alta fidelidad *qué* cambió entre dos textos. Lo que no puede es decir *dónde* está ese cambio en el espacio físico de la página. Inversamente, el OCR de un documento produce coordenadas absolutas para cada elemento del texto, pero no entiende significado.

El método separa estas dos responsabilidades y las ejecuta en etapas independientes, conectadas por un sistema de identificadores que viajan con el texto pero mantienen la información espacial en un índice paralelo.

### Etapa 1 — Codificación compacta con anclaje geométrico

El procesamiento OCR produce, para cada documento, dos artefactos:

**Índice de párrafos**: un array estructurado donde cada entrada contiene el texto, el número de página y el bounding box del párrafo expresado en porcentaje respecto al tamaño de página. Este índice se almacena localmente y nunca se transmite al modelo de lenguaje.

**Payload de texto**: una representación plana del documento donde cada párrafo lleva un identificador único entre corchetes del formato `[P{página}_{bloque}_{párrafo}]`, seguido del texto limpio. Este payload es el único que viaja al LLM.

El identificador es el "ancla geométrica": vincula cada fragmento de texto con su posición en el espacio físico del documento, sin exponer esa posición en el canal de comunicación con el modelo.

### Etapa 2 — Comparación semántica indirecta

El modelo de lenguaje recibe los payloads de texto de ambos documentos. Opera exclusivamente en el espacio semántico: identifica qué párrafos fueron modificados, cuáles fueron agregados, cuáles eliminados, y cuáles fueron movidos estructuralmente. Para cada diferencia detectada, devuelve referencias a los identificadores de párrafo afectados.

La comparación es *indirecta* porque el modelo nunca accede al PDF, nunca ve las imágenes de página, y nunca ve coordenadas. El output son pares de referencias del tipo `doc1_paragraph_refs: ["P2_0_0"]` con la categoría del cambio y el texto exacto de cada lado.

La ausencia de metadatos espaciales en el payload tiene beneficios concretos: el costo de tokens es significativamente menor que con imágenes; el modelo no confunde cambios de formato con cambios de contenido; y la precisión semántica no depende de capacidad de razonamiento espacial del modelo.

### Etapa 3 — Reproyección espacial precisa

Las referencias de párrafo devueltas por el modelo se resuelven contra el índice. Para cada identificador, se recupera el bounding box correspondiente. El resultado es un conjunto de coordenadas exactas —por página y por porcentaje de posición— que se superponen como highlights sobre el PDF original.

La precisión de la reproyección depende de la calidad del OCR, no de inferencia del LLM. El modelo solo necesita acertar en *qué párrafo* cambió; la posición exacta es una propiedad determinista del índice pre-calculado.

### Propiedades del método

- La información espacial y la información semántica viajan por canales separados y se reúnen únicamente en la etapa de reproyección.
- El modelo de lenguaje opera sobre texto estructurado, no sobre imágenes, reduciendo costo y aumentando reproducibilidad.
- La localización del cambio en el documento original es exacta y determinista.
- El método es independiente del layout: un reflow de párrafo entre versiones no produce diferencias espurias.

---

## Implementación de referencia

Este repositorio contiene una implementación completa del método como servicio web. La documentación técnica detallada está en el directorio `wiki/`:

| Documento | Contenido |
|-----------|-----------|
| `wiki/hito-00-diseno.md` | Arquitectura general, esquema de datos, flujo de autenticación |
| `wiki/hito-01-setup.md` | Servidor Express, almacenamiento GridFS, endpoints de documentos |
| `wiki/hito-02-docai.md` | Integración Document AI, construcción del índice y payload OCR |
| `wiki/hito-03-gemini.md` | Integración Gemini, prompt, schema de respuesta, decodificación de diferencias |
| `wiki/hito-04-ui-history.md` | Pantalla de historial y carga de documentos |
| `wiki/hito-05-ui-review.md` | Pantalla de revisión con PDF.js y overlay de highlights |
| `wiki/hito-06-hardening.md` | Límites, manejo de errores, logging y estimación de costos |

### Stack tecnológico

| Capa | Tecnología |
|------|------------|
| Backend | Node.js + Express |
| Base de datos | MongoDB + Mongoose |
| Almacenamiento de PDFs | MongoDB GridFS |
| OCR y extracción de párrafos | Google Cloud Document AI |
| Comparación semántica | Google Gemini |
| Frontend | HTML + Tailwind CSS (CDN) + Vanilla JS |
| Renderizado de PDF | PDF.js |

---

## Requerimientos

**Runtime**
- Node.js 18 o superior
- MongoDB 6 o superior

**Servicios externos**
- Google Cloud Document AI — procesador de tipo *Document OCR* con facturación activa en GCP
- Google Gemini API — modelo `gemini-1.5-pro` o superior

**Credenciales**
- Application Default Credentials (ADC) de GCP configuradas, o `GOOGLE_APPLICATION_CREDENTIALS` apuntando a un service account con permisos sobre Document AI
- Archivo `.env` configurado a partir de `.env.example`

**Límites conocidos del entorno de referencia**
- Document AI acepta hasta 15 MB por request en modalidad inline
- Para documentos muy extensos puede ser necesario segmentar el payload a Gemini por secciones

---

## Uso

```bash
# Instalar dependencias
npm install

# Configurar variables de entorno
cp .env.example .env

# Crear una API key de acceso
node scripts/seed-key.js --label "cliente" --scope admin

# Iniciar el servidor
npm run dev
```

El flujo de uso es: subir DocA y DocB vía `POST /api/documents`, esperar a que ambos tengan `ocrStatus: DONE`, crear una comparación vía `POST /api/comparisons`, y navegar a `/review.html?id=:comparisonId` para visualizar las diferencias sobre el PDF original.

Todos los endpoints requieren el header `X-Api-Key: <token>` excepto `GET /api/health`.
