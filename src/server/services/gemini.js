const { GoogleGenerativeAI } = require('@google/generative-ai');

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Eres un experto comparador de documentos.

Tu tarea es comparar dos documentos y encontrar las diferencias entre ellos.

FORMATO DE LOS DOCUMENTOS:
- Cada parrafo tiene un ID unico al inicio: [P1_0_0] significa pagina 1, bloque 0, parrafo 0
- Usa estos IDs para referenciar exactamente donde se encuentran las diferencias

REGLAS CRITICAS:
1. Devuelve los fragmentos de texto EXACTAMENTE como aparecen en cada documento, sin modificar ni una letra
2. Ignora diferencias menores de formato, puntuacion o espaciado
3. Ignora diferencias causadas por OCR (caracteres mal reconocidos obvios)
4. Enfocate en diferencias de CONTENIDO real
5. SIEMPRE incluye los IDs de los parrafos afectados en doc1_paragraph_refs y doc2_paragraph_refs
6. GRANULARIDAD: Cada cambio debe referenciar MAXIMO 1-2 parrafos. Si hay muchos parrafos modificados,
   crea MULTIPLES cambios separados en lugar de agruparlos en uno solo.

CATEGORIAS DE CAMBIOS:
- MODIFICADO: Texto que cambio entre documentos (ambos doc1_text y doc2_text tendran valores)
- AGREGADO: Texto que existe solo en el Documento 2 (doc1_text sera null, doc1_paragraph_refs sera vacio)
- ELIMINADO: Texto que existe solo en el Documento 1 (doc2_text sera null, doc2_paragraph_refs sera vacio)
- ESTRUCTURAL: Cambios en la estructura del documento (secciones movidas, reorganizacion)

IMPORTANTE: Los IDs de parrafo son OBLIGATORIOS para poder ubicar las diferencias en el documento.`;

// ---------------------------------------------------------------------------
// Response schema (structured output)
// ---------------------------------------------------------------------------

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['MODIFICADO', 'AGREGADO', 'ELIMINADO', 'ESTRUCTURAL'],
          },
          doc1_paragraph_refs: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs de parrafos en Documento 1. MAXIMO 1-2 IDs por cambio.',
          },
          doc2_paragraph_refs: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs de parrafos en Documento 2. MAXIMO 1-2 IDs por cambio.',
          },
          doc1_text: {
            type: 'string',
            nullable: true,
            description: 'Texto EXACTO como aparece en Documento 1 (null si no existe en doc1)',
          },
          doc2_text: {
            type: 'string',
            nullable: true,
            description: 'Texto EXACTO como aparece en Documento 2 (null si no existe en doc2)',
          },
          description: {
            type: 'string',
            description: 'Breve descripcion del cambio',
          },
        },
        required: ['category', 'description', 'doc1_paragraph_refs', 'doc2_paragraph_refs'],
      },
    },
    summary: {
      type: 'object',
      properties: {
        total_changes:    { type: 'integer' },
        modified_count:   { type: 'integer' },
        added_count:      { type: 'integer' },
        removed_count:    { type: 'integer' },
        structural_count: { type: 'integer' },
      },
    },
  },
  required: ['changes', 'summary'],
};

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

async function compareDocuments(doc1TextPayload, doc2TextPayload) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set in environment variables');
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-pro',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.1,
    },
  });

  const userPrompt = buildUserPrompt(doc1TextPayload, doc2TextPayload);

  const raw = await callWithRetry(() => model.generateContent(userPrompt));

  const parsed = JSON.parse(raw.response.text());
  return {
    genaiChanges: parsed.changes || [],
    summary: parsed.summary || {},
    tokensUsed: raw.response.usageMetadata?.totalTokenCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

function buildUserPrompt(doc1TextPayload, doc2TextPayload) {
  return `Compara los siguientes dos documentos y encuentra las diferencias.

IMPORTANTE:
- Cada parrafo tiene un ID unico entre corchetes (ej: [P1_0_0]). Usa estos IDs en doc1_paragraph_refs y doc2_paragraph_refs.
- GRANULARIDAD CRITICA: Cada cambio debe referenciar MAXIMO 1-2 parrafos. Si detectas muchos cambios, crea MULTIPLES entradas separadas en el array "changes".

${doc1TextPayload}

${doc2TextPayload}

Analiza ambos documentos y devuelve las diferencias encontradas. Recuerda: maximo 1-2 parrafos por cambio.`;
}

// ---------------------------------------------------------------------------
// Retry logic — backoff exponencial con detección de errores retryables
// ---------------------------------------------------------------------------

const MAX_RETRIES  = 3;
const BASE_DELAY_MS = 2000;

async function callWithRetry(fn) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === MAX_RETRIES;

      const message = error.message || '';
      const isRetryable = (
        message.includes('504') || message.includes('Gateway Timeout')  ||
        message.includes('502') || message.includes('Bad Gateway')      ||
        message.includes('503') || message.includes('Service Unavailable') ||
        message.includes('429') || message.includes('Too Many Requests') ||
        message.includes('socket hang up')                              ||
        message.toLowerCase().includes('overloaded')                    ||
        message.toLowerCase().includes('resource exhausted')           ||
        message.toLowerCase().includes('rate limit')                    ||
        error.code === 'ECONNRESET'                                     ||
        error.code === 'ETIMEDOUT'                                      ||
        error.code === 'ECONNABORTED'
      );

      if (!isRetryable || isLastAttempt) throw error;

      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt); // 2s, 4s, 8s
      console.warn(`Gemini call failed, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${message}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

module.exports = { compareDocuments };
