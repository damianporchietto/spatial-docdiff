const mongoose = require('mongoose');

async function connectMongo() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/spatial-docdiff';
  await mongoose.connect(uri);
  console.log('[mongo] connected to', uri);
  mongoose.connection.on('error', (err) => console.error('[mongo] error:', err));
}

const documentSchema = new mongoose.Schema({
  filename:     String,
  gridfsId:     mongoose.Schema.Types.ObjectId,
  sha256:       String,
  mimeType:     String,
  uploadedAt:   { type: Date, default: Date.now },
  ocrStatus:    { type: String, enum: ['PENDING', 'RUNNING', 'DONE', 'ERROR'], default: 'PENDING' },
  ocrError:     String,
  ocrParagraphs:  [mongoose.Schema.Types.Mixed],
  ocrTextPayload: String,
  pageCount:    Number,
});

const comparisonSchema = new mongoose.Schema({
  docAId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
  docBId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
  createdAt:   { type: Date, default: Date.now },
  status:      { type: String, enum: ['CREATED', 'COMPARE_RUNNING', 'DONE', 'ERROR'], default: 'CREATED' },
  error:       String,
  differences: [mongoose.Schema.Types.Mixed],
  tokensUsed:  Number,
  durationMs:  Number,
});

const apiKeySchema = new mongoose.Schema({
  key:        String,
  label:      String,
  scope:      [String],
  usageCount: { type: Number, default: 0 },
  active:     { type: Boolean, default: true },
  expiresAt:  Date,
  createdAt:  { type: Date, default: Date.now },
});

const Document   = mongoose.model('Document',   documentSchema);
const Comparison = mongoose.model('Comparison', comparisonSchema);
const ApiKey     = mongoose.model('ApiKey',     apiKeySchema);

module.exports = { connectMongo, Document, Comparison, ApiKey, mongoose };
