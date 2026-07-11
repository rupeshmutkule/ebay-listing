const axios = require('axios');

const BASE_URL = 'https://api.ebay.com';

async function authHeaders(oauthToken) {
  return {
    'Authorization': `Bearer ${oauthToken}`,
    'Content-Type': 'application/json',
    'Content-Language': 'en-US'
  };
}

// Pulls Seller B's ACTUAL business policies rather than guessing/creating
// placeholder ones. Production listings should use the seller's real,
// already-configured payment/shipping/return policies.
async function getSellerPolicies(oauthToken, marketplaceId = 'EBAY_US') {
  const headers = await authHeaders(oauthToken);
  const [payment, fulfillment, returnPolicy] = await Promise.all([
    axios.get(`${BASE_URL}/sell/account/v1/payment_policy?marketplace_id=${marketplaceId}`, { headers }),
    axios.get(`${BASE_URL}/sell/account/v1/fulfillment_policy?marketplace_id=${marketplaceId}`, { headers }),
    axios.get(`${BASE_URL}/sell/account/v1/return_policy?marketplace_id=${marketplaceId}`, { headers })
  ]);

  const paymentPolicies = payment.data.paymentPolicies || [];
  const fulfillmentPolicies = fulfillment.data.fulfillmentPolicies || [];
  const returnPolicies = returnPolicy.data.returnPolicies || [];

  if (!paymentPolicies.length || !fulfillmentPolicies.length || !returnPolicies.length) {
    throw new Error(
      'Semi Equipment has no business policies configured for this marketplace. ' +
      'Set up Payment/Shipping/Return policies in Semi Equipment\'s eBay account (or via the Account API) before migrating.'
    );
  }

  // NOTE: if Seller B has multiple named policies (e.g. different shipping
  // tiers), you likely want to map specific policies per product category
  // rather than always taking [0]. Flag this with the client and adjust here.
  return {
    paymentPolicyId: paymentPolicies[0].paymentPolicyId,
    fulfillmentPolicyId: fulfillmentPolicies[0].fulfillmentPolicyId,
    returnPolicyId: returnPolicies[0].returnPolicyId,
    availablePolicies: { paymentPolicies, fulfillmentPolicies, returnPolicies } // for future per-category mapping
  };
}

module.exports = { getSellerPolicies };