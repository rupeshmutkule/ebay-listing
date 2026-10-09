const crypto = require('crypto');

module.exports = function requireListingAccessPassword(req, res, next) {
  const expected = String(process.env.IBM_LISTING_ACCESS_PASSWORD || '');
  const supplied = String(req.get('x-listing-password') || '');
  if (!expected) return res.status(503).json({ error: 'Live publishing is disabled. Configure IBM_LISTING_ACCESS_PASSWORD.' });
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  const match = expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
  if (!match) return res.status(401).json({ error: 'Enter the authorized listing password to publish products.' });
  return next();
};
