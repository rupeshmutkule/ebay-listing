const crypto = require('crypto');

function safeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

module.exports = function requireApiKey(req, res, next) {
  const expectedKey =
    process.env.MIGRATION_TOOL_API_KEY ||
    process.env.API_KEY ||
    process.env.SHARED_SECRET;

  if (!expectedKey) {
    return next();
  }

  const providedKey = req.get('X-Api-Key');
  if (!safeEquals(providedKey, expectedKey)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
};
