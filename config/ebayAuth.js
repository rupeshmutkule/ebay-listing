require('dotenv').config();
const axios = require('axios');

const EBAY_ENV = (process.env.EBAY_ENV || 'production').toLowerCase();
const OAUTH_URL =
  process.env.EBAY_TOKEN_URL ||
  (EBAY_ENV === 'sandbox'
    ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
    : 'https://api.ebay.com/identity/v1/oauth2/token');

const GLOBAL_TOKEN_MODE = (process.env.EBAY_TOKEN_MODE || 'auto').toLowerCase();
const ALLOW_STATIC_FALLBACK = String(process.env.EBAY_ALLOW_STATIC_TOKEN_FALLBACK || 'true').toLowerCase() !== 'false';
const OAUTH_SCOPES = (process.env.EBAY_OAUTH_SCOPES || [
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account'
].join(' ')).trim();

// One token manager per seller account. Access tokens expire ~2 hours;
// we refresh proactively 5 minutes before expiry so a long migration run
// (800 items) never gets interrupted by an expired token mid-batch.
class SellerTokenManager {
  constructor(label, { clientId, clientSecret, refreshToken, accessToken, tokenMode, ruName }) {
    this.label = label;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.accessToken = accessToken || null;
    this.tokenMode = (tokenMode || GLOBAL_TOKEN_MODE || 'auto').toLowerCase();
    this.ruName = ruName;
    this.expiresAt = 0; // epoch ms
    this.refreshPromise = null; // in-flight refresh guard
  }

  async getToken() {
    if (this.tokenMode === 'access') {
      if (this.accessToken) {
        return this.accessToken;
      }
      if (this.refreshToken) {
        console.warn(`[auth] ${this.label} is configured for direct access-token mode; using the configured token as-is.`);
        this.accessToken = this.refreshToken;
        this.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
        return this.accessToken;
      }
      throw new Error(`Missing direct access token for ${this.label}. Set ${this.label.replace(/\s+/g, '_').toUpperCase()}_ACCESS_TOKEN or switch EBAY_TOKEN_MODE.`);
    }

    const fiveMinutes = 5 * 60 * 1000;
    if (this.accessToken && Date.now() < this.expiresAt - fiveMinutes) {
      return this.accessToken;
    }
    if (this.accessToken && this.tokenMode !== 'refresh') {
      return this.accessToken;
    }
    // Prevent multiple concurrent refreshes for the same account under load
    if (!this.refreshPromise) {
      this.refreshPromise = this._refresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async _refresh() {
    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      throw new Error(
        `Missing eBay auth config for ${this.label}. ` +
        `Check EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and seller refresh token env vars.`
      );
    }

    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      // Scope must match what was granted originally. Adjust if your
      // refresh token was issued with a narrower/wider scope set.
      scope: OAUTH_SCOPES
    });

    try {
      const res = await axios.post(OAUTH_URL, body.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${basicAuth}`
        }
      });
      this.accessToken = res.data.access_token;
      this.expiresAt = Date.now() + res.data.expires_in * 1000;
      console.log(`[auth] Refreshed token for ${this.label} via ${EBAY_ENV} endpoint, expires in ${res.data.expires_in}s`);
      return this.accessToken;
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      const errorCode = err.response?.data?.error;
      const errorDescription = err.response?.data?.error_description || '';

      if (
        this.tokenMode === 'auto' &&
        ALLOW_STATIC_FALLBACK &&
        errorCode === 'invalid_grant' &&
        this.refreshToken &&
        !this.accessToken
      ) {
        this.accessToken = this.refreshToken;
        this.expiresAt = Date.now() + 2 * 60 * 60 * 1000;
        console.warn(
          `[auth] Refresh failed for ${this.label} with invalid_grant; ` +
          `falling back to the configured token as a direct access token. ` +
          `If this keeps failing, regenerate the user token for this exact app/environment.`
        );
        return this.accessToken;
      }

      throw new Error(`Failed to refresh OAuth token for ${this.label}: ${detail}`);
    }
  }
}

const sellerA = new SellerTokenManager('Seller A', {
  clientId: process.env.EBAY_CLIENT_ID,
  clientSecret: process.env.EBAY_CLIENT_SECRET,
  refreshToken: process.env.SELLER_A_REFRESH_TOKEN,
  accessToken: process.env.SELLER_A_ACCESS_TOKEN,
  tokenMode: process.env.SELLER_A_TOKEN_MODE,
  ruName: process.env.EBAY_RUNAME
});

const sellerB = new SellerTokenManager('Seller B', {
  clientId: process.env.EBAY_CLIENT_ID,
  clientSecret: process.env.EBAY_CLIENT_SECRET,
  refreshToken: process.env.SELLER_B_REFRESH_TOKEN,
  accessToken: process.env.SELLER_B_ACCESS_TOKEN,
  tokenMode: process.env.SELLER_B_TOKEN_MODE,
  ruName: process.env.EBAY_RUNAME
});

module.exports = { sellerA, sellerB };
