const { DocumentProcessorServiceClient } = require('@google-cloud/documentai').v1;

const client = new DocumentProcessorServiceClient();
const processorName = `projects/${process.env.DOCAI_PROJECT_ID}/locations/${process.env.DOCAI_LOCATION}/processors/${process.env.DOCAI_PROCESSOR_ID}`;

async function processDocument(pdfBuffer) {
  const [result] = await client.processDocument({
    name: processorName,
    rawDocument: {
      content: pdfBuffer.toString('base64'),
      mimeType: 'application/pdf',
    },
  });
  return result.document.pages;
}

module.exports = { processDocument };
