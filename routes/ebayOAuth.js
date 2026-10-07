const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const requireApiKey = require('../middleware/requireListingApiKey');
const { sellerB } = require('../config/ebayAuth');
const { createOAuthState, consumeOAuthState, saveSellerBRefreshToken, checkMongoStorage } = require('../services/oauthStorage');

const router = express.Router();
const STATE_TTL_MS = 10 * 60 * 1000;
const environment = (process.env.EBAY_ENV || 'production').toLowerCase();
const tokenUrl = process.env.EBAY_TOKEN_URL || (environment === 'sandbox'
  ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
  : 'https://api.ebay.com/identity/v1/oauth2/token');
const scopes = (process.env.EBAY_OAUTH_SCOPES || [
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account'
].join(' ')).trim();

function callbackUrl() {
  const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (!base) throw new Error('Set PUBLIC_BASE_URL to the public HTTPS address of this app.');
  const url = new URL(`${base}/ebay-listings/oauth/callback`);
  if (environment === 'production' && url.protocol !== 'https:') {
    throw new Error('Production eBay authorization requires a public HTTPS callback URL.');
  }
  return url.toString();
}

function resultPage(ok, message) {
  const title = ok ? 'eBay connected' : 'eBay authorization not completed';
  const color = ok ? '#147d45' : '#b42318';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px Arial,sans-serif;background:#f5f2ec;color:#17202a;margin:0;padding:48px 20px}.box{max-width:620px;margin:auto;background:white;border:1px solid #ddd5ca;border-radius:16px;padding:28px}h1{font-size:24px;color:${color}}p{line-height:1.55}</style></head><body><main class="box"><h1>${title}</h1><p>${message}</p><p>You may close this page and return to the listing app.</p></main></body></html>`;
}

// The listing UI calls this protected endpoint, then sends the seller to eBay.
router.post('/authorize', requireApiKey, async (req, res) => {
  try {
    const clientId = process.env.EBAY_CLIENT_ID;
    const ruName = process.env.EBAY_RUNAME;
    if (!clientId || !ruName || !process.env.EBAY_CLIENT_SECRET) {
      return res.status(503).json({ error: 'Configure the Production eBay client ID, client secret, and RuName first.' });
    }
    await checkMongoStorage();
    const returnUrl = callbackUrl();
    // eBay's RuName must be configured in the Developer Portal to return to this URL.
    const state = crypto.randomBytes(32).toString('hex');
    await createOAuthState(state, Date.now() + STATE_TTL_MS);
    const authorize = new URL(environment === 'sandbox'
      ? 'https://auth.sandbox.ebay.com/oauth2/authorize'
      : 'https://auth.ebay.com/oauth2/authorize');
    authorize.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: ruName,
      response_type: 'code',
      scope: scopes,
      state,
      prompt: 'login'
    }).toString();
    res.json({ authorizationUrl: authorize.toString(), callbackUrl: returnUrl });
  } catch (error) {
    console.error('[ebay oauth] Could not initialize OAuth flow:', error.message);
    res.status(503).json({ error: 'OAuth storage or callback configuration is not ready. Check the server setup and try again.' });
  }
});

// eBay sends the browser here via the RuName accept URL after consent.
router.get('/callback', async (req, res) => {
  const state = String(req.query.state || '');
  let validState = false;
  try {
    validState = await consumeOAuthState(state);
  } catch (error) {
    console.error('[ebay oauth] MongoDB state lookup failed.');
    return res.status(503).send(resultPage(false, 'OAuth storage is unavailable. Contact the app administrator.'));
  }
  if (!validState) {
    return res.status(400).send(resultPage(false, 'This authorization link expired or was already used. Start again from the listing app.'));
  }
  if (req.query.error || !req.query.code) {
    return res.status(400).send(resultPage(false, 'eBay authorization was declined or did not return a code. Start again from the listing app.'));
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const ruName = process.env.EBAY_RUNAME;
  if (!clientId || !clientSecret || !ruName) {
    return res.status(503).send(resultPage(false, 'The app is missing its eBay Production OAuth configuration. Contact the app administrator.'));
  }

  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(req.query.code),
      redirect_uri: ruName
    });
    const response = await axios.post(tokenUrl, body.toString(), {
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000
    });
    if (!response.data?.refresh_token) throw new Error('eBay did not return a refresh token.');
    await saveSellerBRefreshToken(response.data.refresh_token);
    sellerB.refreshToken = response.data.refresh_token;
    sellerB.accessToken = null;
    sellerB.expiresAt = 0;
    return res.send(resultPage(true, 'Semi Equipment has been connected. The app securely saved its refresh token and can renew access when needed.'));
  } catch (error) {
    // Never log or return token values, authorization codes, client secrets, or request bodies.
    const status = error.response?.status;
    console.error(`[ebay oauth] Seller B authorization-code exchange failed${status ? ` (HTTP ${status})` : ''}.`);
    return res.status(502).send(resultPage(false, 'The app could not complete the token exchange. Contact the app administrator and ask them to check the server configuration.'));
  }
});

module.exports = router;
