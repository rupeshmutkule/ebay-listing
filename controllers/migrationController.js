require('dotenv').config();
const axios = require('axios');

const BASE_URL = 'https://api.sandbox.ebay.com'; // switch to https://api.ebay.com for production
const CATEGORY_ID = '177';
const CONCURRENCY = 4;

const headersA = {
  'Authorization': `Bearer ${process.env.SELLER_A_TOKEN}`,
  'Content-Type': 'application/json',
  'Content-Language': 'en-US'
};

const headersB = {
  'Authorization': `Bearer ${process.env.SELLER_B_TOKEN}`,
  'Content-Type': 'application/json',
  'Content-Language': 'en-US'
};

// ---------- CONCURRENCY HELPER ----------
async function runBatch(items, worker, concurrency = CONCURRENCY) {
  const results = [];
  let index = 0;

  async function next() {
    while (index < items.length) {
      const current = items[index++];
      try {
        const value = await worker(current);
        results.push({ sku: current, success: true, ...value });
      } catch (err) {
        results.push({
          sku: current,
          success: false,
          error: err.response ? err.response.data : err.message
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, next);
  await Promise.all(workers);
  return results;
}

// ---------- SHARED EBAY HELPERS ----------

async function createMerchantLocation(headers) {
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
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || '';
    if (err.response?.status === 409 || msg.includes('already exists')) {
      // fine
    } else {
      throw err;
    }
  }
}

async function optInToBusinessPolicies(headers) {
  const url = `${BASE_URL}/sell/account/v1/program/opt_in`;
  try {
    await axios.post(url, { programType: 'SELLING_POLICY_MANAGEMENT' }, { headers });
  } catch (err) {
    if (err.response?.status !== 409) throw err;
  }
}

async function getPolicies(headers) {
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

async function createPaymentPolicy(headers) {
  const url = `${BASE_URL}/sell/account/v1/payment_policy`;
  const body = {
    name: 'Default Payment Policy ' + Date.now(),
    marketplaceId: 'EBAY_US',
    categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES', default: true }],
    paymentMethods: [{ paymentMethodType: 'CREDIT_CARD', brands: ['VISA', 'MASTERCARD', 'AMERICAN_EXPRESS', 'DISCOVER'] }]
  };
  const res = await axios.post(url, body, { headers });
  return res.data.paymentPolicyId;
}

async function createFulfillmentPolicy(headers) {
  const url = `${BASE_URL}/sell/account/v1/fulfillment_policy`;
  const body = {
    name: 'Default Shipping Policy ' + Date.now(),
    marketplaceId: 'EBAY_US',
    categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES', default: true }],
    handlingTime: { value: 1, unit: 'DAY' },
    shippingOptions: [{
      optionType: 'DOMESTIC',
      costType: 'FLAT_RATE',
      shippingServices: [{
        sortOrder: 1,
        shippingCarrierCode: 'USPS',
        shippingServiceCode: 'USPSPriority',
        shippingCost: { value: '5.00', currency: 'USD' }
      }]
    }]
  };
  const res = await axios.post(url, body, { headers });
  return res.data.fulfillmentPolicyId;
}

async function createReturnPolicy(headers) {
  const url = `${BASE_URL}/sell/account/v1/return_policy`;
  const body = {
    name: 'Default Return Policy ' + Date.now(),
    marketplaceId: 'EBAY_US',
    categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES', default: true }],
    returnsAccepted: true,
    returnPeriod: { value: 30, unit: 'DAY' },
    refundMethod: 'MONEY_BACK',
    returnShippingCostPayer: 'BUYER'
  };
  const res = await axios.post(url, body, { headers });
  return res.data.returnPolicyId;
}

async function ensurePolicies(headers) {
  await optInToBusinessPolicies(headers);
  const existing = await getPolicies(headers);
  let { paymentPolicyId, fulfillmentPolicyId, returnPolicyId } = existing;
  if (!paymentPolicyId) paymentPolicyId = await createPaymentPolicy(headers);
  if (!fulfillmentPolicyId) fulfillmentPolicyId = await createFulfillmentPolicy(headers);
  if (!returnPolicyId) returnPolicyId = await createReturnPolicy(headers);
  return { paymentPolicyId, fulfillmentPolicyId, returnPolicyId };
}

async function findExistingOffer(headers, sku) {
  const url = `${BASE_URL}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`;
  try {
    const res = await axios.get(url, { headers });
    return res.data.offers?.[0] || null;
  } catch (err) {
    return null;
  }
}

async function getRequiredAspects(categoryId, headers) {
  const url = `${BASE_URL}/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${categoryId}`;
  try {
    const res = await axios.get(url, { headers });
    return res.data.aspects
      .filter(a => a.aspectConstraint?.aspectRequired)
      .map(a => a.localizedAspectName);
  } catch (err) {
    return [];
  }
}

const ASPECT_PLACEHOLDERS = {
  'Storage Capacity': '64 GB',
  'Screen Size': '15.6 in',
  'Model': 'Test Model',
  'Network': 'Unlocked',
  'Operating System': 'Android',
  'Connectivity': 'Wi-Fi',
  'Processor': 'Test Processor',
  'RAM Size': '8 GB',
  'Features': 'Test Feature',
  'Material': 'Plastic',
  'Style': 'Standard',
  'Size': 'One Size',
  'Department': 'Unisex Adult'
};

async function buildAspects(headers, categoryId, suppliedAspects = {}) {
  const requiredFields = await getRequiredAspects(categoryId, headers);
  const aspects = {
    Brand: ['TestBrand'],
    Type: ['Test Type'],
    MPN: ['Does Not Apply'],
    ...suppliedAspects
  };
  requiredFields.forEach(field => {
    if (!aspects[field]) aspects[field] = [ASPECT_PLACEHOLDERS[field] || 'N/A'];
  });
  return aspects;
}

function buildOfferBody(sku, policies, price) {
  return {
    sku,
    marketplaceId: 'EBAY_US',
    format: 'FIXED_PRICE',
    availableQuantity: 5,
    categoryId: CATEGORY_ID,
    merchantLocationKey: 'WAREHOUSE1',
    listingDescription: 'Migrated listing.',
    listingPolicies: {
      paymentPolicyId: policies.paymentPolicyId,
      fulfillmentPolicyId: policies.fulfillmentPolicyId,
      returnPolicyId: policies.returnPolicyId
    },
    pricingSummary: { price: { value: String(price || '19.99'), currency: 'USD' } }
  };
}

async function createOffer(headers, sku, policies, price) {
  const url = `${BASE_URL}/sell/inventory/v1/offer`;
  const res = await axios.post(url, buildOfferBody(sku, policies, price), { headers });
  return res.data.offerId;
}

async function updateOffer(headers, offerId, sku, policies, price) {
  const url = `${BASE_URL}/sell/inventory/v1/offer/${offerId}`;
  await axios.put(url, buildOfferBody(sku, policies, price), { headers });
  return offerId;
}

async function getOrCreateOffer(headers, sku, policies, price) {
  const existing = await findExistingOffer(headers, sku);
  if (existing) {
    if (existing.status === 'PUBLISHED') {
      return { offerId: existing.offerId, alreadyPublished: true };
    }
    await updateOffer(headers, existing.offerId, sku, policies, price);
    return { offerId: existing.offerId, alreadyPublished: false };
  }
  const offerId = await createOffer(headers, sku, policies, price);
  return { offerId, alreadyPublished: false };
}

async function publishOffer(headers, offerId) {
  const url = `${BASE_URL}/sell/inventory/v1/offer/${offerId}/publish`;
  const res = await axios.post(url, {}, { headers });
  return res.data.listingId;
}

async function withdrawOffer(headers, offerId) {
  const url = `${BASE_URL}/sell/inventory/v1/offer/${offerId}/withdraw`;
  await axios.post(url, {}, { headers });
}

async function deleteInventoryItem(headers, sku) {
  const url = `${BASE_URL}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
  await axios.delete(url, { headers });
}

// Shared: withdraw + delete a SKU from Seller A after it's live on Seller B
async function removeFromSellerA(sku) {
  let removedFromA = false;
  let removeError = null;
  try {
    const offerA = await findExistingOffer(headersA, sku);
    if (offerA && offerA.status === 'PUBLISHED') {
      await withdrawOffer(headersA, offerA.offerId);
    }
    await deleteInventoryItem(headersA, sku);
    removedFromA = true;
  } catch (err) {
    removeError = err.response ? err.response.data : err.message;
  }
  return { removedFromA, removeError };
}

// ---------- LIST INVENTORY (used by Fetch + View) ----------

async function listInventory(headers) {
  const limit = 100;
  let offset = 0;
  let total = Infinity;
  const items = [];

  while (offset < total) {
    const url = `${BASE_URL}/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`;
    const response = await axios.get(url, { headers });
    total = response.data.total || 0;
    const batch = response.data.inventoryItems || [];

    batch.forEach(item => {
      items.push({
        sku: item.sku,
        title: item.product?.title || '(no title)',
        image: item.product?.imageUrls?.[0] || null,
        quantity: item.availability?.shipToLocationAvailability?.quantity ?? 0,
        condition: item.condition || ''
      });
    });

    offset += limit;
    if (batch.length === 0) break;
  }

  return items;
}

// ===================== BUTTON 1: FETCH PRODUCTS FROM SELLER A =====================
// GET /api/seller-a/products
exports.listSellerAProducts = async (req, res) => {
  try {
    const items = await listInventory(headersA);
    res.json({ success: true, count: items.length, products: items });
  } catch (err) {
    res.status(500).json({ error: err.response ? err.response.data : err.message });
  }
};

// ===================== BUTTON 3: VIEW PRODUCTS LIVE ON SELLER B =====================
// GET /api/seller-b/products
exports.listSellerBProducts = async (req, res) => {
  try {
    const items = await listInventory(headersB);
    res.json({ success: true, count: items.length, products: items });
  } catch (err) {
    res.status(500).json({ error: err.response ? err.response.data : err.message });
  }
};

// ===================== BUTTON 2: MIGRATE SELECTED SKUs A → B (no DB) =====================
// POST /api/migrate   body: { skus: ["SKU1","SKU2", ...] }

async function fetchCompleteProduct(headers, sku) {
  const invUrl = `${BASE_URL}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
  const invRes = await axios.get(invUrl, { headers });
  const inventoryItem = invRes.data;

  const offer = await findExistingOffer(headers, sku);
  if (!offer) throw new Error(`No offer found on Seller A for SKU ${sku}`);

  const offerUrl = `${BASE_URL}/sell/inventory/v1/offer/${offer.offerId}`;
  const offerRes = await axios.get(offerUrl, { headers });

  return { inventoryItem, offer: offerRes.data };
}

async function migrateOneProduct(sku, policiesB) {
  const { inventoryItem, offer } = await fetchCompleteProduct(headersA, sku);
  const product = inventoryItem.product;

  const savedAspects = product.aspects || {};
  const aspects = await buildAspects(headersB, CATEGORY_ID, savedAspects);
  const price = offer.pricingSummary?.price?.value;
  const quantity = inventoryItem.availability?.shipToLocationAvailability?.quantity || 1;

  const invUrl = `${BASE_URL}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
  await axios.put(invUrl, {
    availability: { shipToLocationAvailability: { quantity } },
    condition: inventoryItem.condition || 'NEW',
    product: {
      title: product.title,
      description: product.description,
      imageUrls: product.imageUrls?.length
        ? product.imageUrls
        : ['https://i.ebayimg.com/images/g/8xkAAOSwiddj6zZW/s-l1600.jpg'],
      aspects
    }
  }, { headers: headersB });

  const { offerId, alreadyPublished } = await getOrCreateOffer(headersB, sku, policiesB, price);
  let listingId = null;
  if (!alreadyPublished) {
    listingId = await publishOffer(headersB, offerId);
  }

  const { removedFromA, removeError } = await removeFromSellerA(sku);

  return { offerId, listingId, removedFromA, removeError };
}

exports.migrateProducts = async (req, res) => {
  const skus = req.body.skus;
  if (!Array.isArray(skus) || skus.length === 0) {
    return res.status(400).json({ error: 'Provide skus: string[] in the request body' });
  }
  try {
    await createMerchantLocation(headersB);
    const policiesB = await ensurePolicies(headersB);

    const results = await runBatch(skus, sku => migrateOneProduct(sku, policiesB));

    res.json({
      success: true,
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    });
  } catch (err) {
    res.status(500).json({ error: err.response ? err.response.data : err.message });
  }
};

// ===================== CLEANUP: remove a stuck SKU from Seller B =====================
// POST /api/seller-b/delete   body: { sku: "SOME-SKU" }
exports.deleteFromSellerB = async (req, res) => {
  const { sku } = req.body;
  if (!sku) return res.status(400).json({ error: 'Provide sku in the request body' });
  try {
    const offer = await findExistingOffer(headersB, sku);
    if (offer && offer.status === 'PUBLISHED') {
      await withdrawOffer(headersB, offer.offerId);
    }
    await deleteInventoryItem(headersB, sku);
    res.json({ success: true, sku, message: 'Removed from Seller B' });
  } catch (err) {
    res.status(500).json({ error: err.response ? err.response.data : err.message });
  }
};