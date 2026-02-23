require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
}

const label = getArg('--label') || 'default';
const scopeArg = getArg('--scope') || 'read';
const scope = scopeArg.split(',').map((s) => s.trim()).filter(Boolean);

const apiKeySchema = new mongoose.Schema({
  key:        String,
  label:      String,
  scope:      [String],
  usageCount: { type: Number, default: 0 },
  active:     { type: Boolean, default: true },
  expiresAt:  Date,
  createdAt:  { type: Date, default: Date.now },
});

const ApiKey = mongoose.model('ApiKey', apiKeySchema);

async function main() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/spatial-docdiff';
  await mongoose.connect(uri);

  const key = crypto.randomBytes(32).toString('hex');
  await ApiKey.create({ key, label, scope });

  console.log(`Key creada: ${key}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
