const { ApiKey } = require('../services/mongo');

function requireScope(scope) {
  return async function (req, res, next) {
    const token = req.headers['x-api-key'];
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const doc = await ApiKey.findOne({ key: token });

      if (!doc || !doc.active) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (doc.expiresAt && doc.expiresAt <= new Date()) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!doc.scope.includes(scope) && !doc.scope.includes('admin')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // fire-and-forget
      ApiKey.updateOne({ _id: doc._id }, { $inc: { usageCount: 1 } }).catch(() => {});

      req.apiKey = doc;
      next();
    } catch (err) {
      console.error('[auth] error:', err);
      return res.status(401).json({ error: 'Unauthorized' });
    }
  };
}

module.exports = { requireScope };
