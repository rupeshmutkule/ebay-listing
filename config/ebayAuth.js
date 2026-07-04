require('dotenv').config();
const axios = require('axios');

// Production endpoints
const OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

// One token manager per seller account. Access tokens expire ~2 hours;
// we refresh proactively 5 minutes before expiry so a long migration run
// (800 items) never gets interrupted by an expired token mid-batch.
class SellerTokenManager {
  constructor(label, { clientId, clientSecret, refreshToken, ruName }) {
    this.label = label;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.ruName = ruName;
    this.accessToken = null;
    this.expiresAt = 0; // epoch ms
    this.refreshPromise = null; // in-flight refresh guard
  }

  async getToken() {
    const fiveMinutes = 5 * 60 * 1000;
    if (this.accessToken && Date.now() < this.expiresAt - fiveMinutes) {
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
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      // Scope must match what was granted originally. Adjust if your
      // refresh token was issued with a narrower/wider scope set.
      scope: 'https://api.ebay.com/oauth/api_scope/sell.inventory ' +
             'https://api.ebay.com/oauth/api_scope/sell.account ' +
             'https://api.ebay.com/oauth/api_scope'
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
      console.log(`[auth] Refreshed token for ${this.label}, expires in ${res.data.expires_in}s`);
      return this.accessToken;
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`Failed to refresh OAuth token for ${this.label}: ${detail}`);
    }
  }
}

const sellerA = new SellerTokenManager('Seller A', {
  clientId: process.env.EBAY_CLIENT_ID,
  clientSecret: process.env.EBAY_CLIENT_SECRET,
  refreshToken: process.env.SELLER_A_REFRESH_TOKEN,
  ruName: process.env.EBAY_RUNAME
});

const sellerB = new SellerTokenManager('Seller B', {
  clientId: process.env.EBAY_CLIENT_ID,
  clientSecret: process.env.EBAY_CLIENT_SECRET,
  refreshToken: process.env.SELLER_B_REFRESH_TOKEN,
  ruName: process.env.EBAY_RUNAME
});

module.exports = { sellerA, sellerB };