require('dotenv').config();
const express = require('express');
const { connectMongo } = require('./services/mongo');

const app = express();
app.use(express.json());
app.use(require('morgan')('dev'));

app.use('/api/documents',   require('./routes/documents'));
app.use('/api/comparisons', require('./routes/comparisons'));

app.use(express.static('public'));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
connectMongo().then(() => {
  app.listen(PORT, () => console.log(`Server running on :${PORT}`));
}).catch((err) => {
  console.error('[startup] failed to connect to MongoDB:', err);
  process.exit(1);
});
