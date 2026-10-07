const requireApiKey = require('./requireApiKey');

module.exports = function requireListingApiKey(req, res, next) {
  const configuredKey = process.env.MIGRATION_TOOL_API_KEY || process.env.API_KEY || process.env.SHARED_SECRET;
  if (!configuredKey) {
    return res.status(503).json({ error: 'Configure MIGRATION_TOOL_API_KEY, API_KEY, or SHARED_SECRET before enabling listing endpoints.' });
  }
  return requireApiKey(req, res, next);
};
