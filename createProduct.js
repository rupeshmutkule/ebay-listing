require('dotenv').config();
const axios = require('axios');

const SKU = 'TESTSKU001';
const BASE_URL = 'https://api.sandbox.ebay.com';

const headers = {
  'Authorization': `Bearer ${process.env.SELLER_A_TOKEN}`,
  'Content-Type': 'application/json',
  'Content-Language': 'en-US'
};

// Step 1: Create a merchant location (required before offers can be published)
async function createMerchantLocation() {
  const url = `${BASE_URL}/sell/inventory/v1/location/WAREHOUSE1`;
  const body = {
    location: {
      address: {
        addressLine1: '123 Main Street',
        city: 'San Jose',
        stateOrProvince: 'CA',
        postalCode: '95125',
        country: 'US'
      }
    },
    locationTypes: ['WAREHOUSE'],
    name: 'Main Warehouse'
  };

  try {
    await axios.post(url, body, { headers });
    console.log('✅ Merchant location created');
  } catch (err) {
    if (err.response && err.response.status === 409) {
      console.log('ℹ️ Merchant location already exists, continuing');
    } else {
      throw err;
    }
  }
}

// Step 2: Create the inventory item (the product itself)
async function createInventoryItem() {
  const url = `${BASE_URL}/sell/inventory/v1/inventory_item/${SKU}`;

  const body = {
    availability: {
      shipToLocationAvailability: { quantity: 5 }
    },
    condition: 'NEW',
    product: {
      title: 'Test Product - Migration Demo',
      description: 'This is a test product created via API for migration testing.',
      imageUrls: ['https://i.ebayimg.com/images/g/8xkAAOSwiddj6zZW/s-l1600.jpg'],
      aspects: {
        Brand: ['TestBrand']
      }
    }
  };

  await axios.put(url, body, { headers });
  console.log('✅ Inventory item created');
}

// Step 3: Fetch existing business policies (payment/shipping/return) needed for the offer
async function getPolicies() {
  const base = `${BASE_URL}/sell/account/v1`;

  const [payment, fulfillment, returnPolicy] = await Promise.all([
    axios.get(`${base}/payment_policy?marketplace_id=EBAY_US`, { headers }),
    axios.get(`${base}/fulfillment_policy?marketplace_id=EBAY_US`, { headers }),
    axios.get(`${base}/return_policy?marketplace_id=EBAY_US`, { headers })
  ]);

  return {
    paymentPolicyId: payment.data.paymentPolicies?.[0]?.paymentPolicyId,
    fulfillmentPolicyId: fulfillment.data.fulfillmentPolicies?.[0]?.fulfillmentPolicyId,
    returnPolicyId: returnPolicy.data.returnPolicies?.[0]?.returnPolicyId
  };
}

// Step 4: Create the offer (listing draft)
async function createOffer(policies) {
  const url = `${BASE_URL}/sell/inventory/v1/offer`;

  const body = {
    sku: SKU,
    marketplaceId: 'EBAY_US',
    format: 'FIXED_PRICE',
    availableQuantity: 5,
    categoryId: '9355',
    merchantLocationKey: 'WAREHOUSE1',
    listingDescription: 'Test product for migration workflow testing.',
    listingPolicies: {
      paymentPolicyId: policies.paymentPolicyId,
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
      returnPolicyId: policies.returnPolicyId
    },
    pricingSummary: {
      price: { value: '19.99', currency: 'USD' }
    }
  };

  const res = await axios.post(url, body, { headers });
  console.log('✅ Offer created:', res.data.offerId);
  return res.data.offerId;
}

// Step 5: Publish the offer to make it a live Sandbox listing
async function publishOffer(offerId) {
  const url = `${BASE_URL}/sell/inventory/v1/offer/${offerId}/publish`;
  const res = await axios.post(url, {}, { headers });
  console.log('✅ Offer published! Listing ID:', res.data.listingId);
}

async function run() {
  try {
    await createMerchantLocation();
    await createInventoryItem();
    const policies = await getPolicies();

    if (!policies.paymentPolicyId || !policies.fulfillmentPolicyId || !policies.returnPolicyId) {
      console.log('⚠️ Missing business policies on this account.');
      console.log('Policies found:', policies);
      console.log('You need to create Payment, Fulfillment, and Return policies for this Sandbox seller before an offer can be published.');
      return;
    }

    const offerId = await createOffer(policies);
    await publishOffer(offerId);

    console.log('🎉 Test product fully created and live on Seller A (Sandbox)');
  } catch (err) {
    console.error('❌ Error:', err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
  }
}

run();