require('dotenv').config();
const axios = require('axios');
const db = require('../config/db');

const BASE_URL = 'https://api.sandbox.ebay.com'; // switch to https://api.ebay.com for production
const CATEGORY_ID = '177';
const CONCURRENCY = 4; // how many products to process in parallel — keep low to avoid eBay rate limits

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

// ---------- SMALL HELPER: run many async jobs with limited concurrency ----------
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
      // fine, already exists
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

function buildOfferBody(sku, policies) {
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
    pricingSummary: { price: { value: '19.99', currency: 'USD' } }
  };
}

async function createOffer(headers, sku, policies) {
  const url = `${BASE_URL}/sell/inventory/v1/offer`;
  const res = await axios.post(url, buildOfferBody(sku, policies), { headers });
  return res.data.offerId;
}

async function updateOffer(headers, offerId, sku, policies) {
  const url = `${BASE_URL}/sell/inventory/v1/offer/${offerId}`;
  await axios.put(url, buildOfferBody(sku, policies), { headers });
  return offerId;
}

async function getOrCreateOffer(headers, sku, policies) {
  const existing = await findExistingOffer(headers, sku);
  if (existing) {
    if (existing.status === 'PUBLISHED') {
      return { offerId: existing.offerId, alreadyPublished: true };
    }
    await updateOffer(headers, existing.offerId, sku, policies);
    return { offerId: existing.offerId, alreadyPublished: false };
  }
  const offerId = await createOffer(headers, sku, policies);
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

async function ensureSeller(storeName, role) {
  const [rows] = await db.query('SELECT id FROM sellers WHERE store_name = ?', [storeName]);
  if (rows.length > 0) return rows[0].id;
  const [result] = await db.query(
    'INSERT INTO sellers (store_name, role, environment) VALUES (?, ?, ?)',
    [storeName, role, 'sandbox']
  );
  return result.insertId;
}

// =====================================================================
// BUTTON 1 — LIST ALL PRODUCTS CURRENTLY LIVE ON SELLER A
// GET /api/seller-a/products
// =====================================================================
exports.listSellerAProducts = async (req, res) => {
  try {
    const limit = 100;
    let offset = 0;
    let total = Infinity;
    const items = [];

    while (offset < total) {
      const url = `${BASE_URL}/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`;
      const response = await axios.get(url, { headers: headersA });
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
      if (batch.length === 0) break; // safety net
    }

    res.json({ success: true, count: items.length, products: items });
  } catch (err) {
    res.status(500).json({ error: err.response ? err.response.data : err.message });
  }
};

// =====================================================================
// BUTTON 2 — MOVE SELECTED SKUs FROM SELLER A INTO THE DATABASE (+ BACKUP)
// POST /api/move-to-database   body: { skus: ["SKU1","SKU2", ...] }
// =====================================================================
async function fetchOneProductFromSellerA(sku, sellerAId) {
  const invUrl = `${BASE_URL}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
  const invRes = await axios.get(invUrl, { headers: headersA });
  const inventoryItem = invRes.data;

  const offer = await findExistingOffer(headersA, sku);
  if (!offer) throw new Error(`No offer found on Seller A for SKU ${sku}`);

  const offerUrl = `${BASE_URL}/sell/inventory/v1/offer/${offer.offerId}`;
  const offerRes = await axios.get(offerUrl, { headers: headersA });
  const offerDetails = offerRes.data;
  const product = inventoryItem.product;

  const [existingRows] = await db.query('SELECT id FROM products WHERE sku = ?', [sku]);
  let productId;

  if (existingRows.length > 0) {
    productId = existingRows[0].id;
    await db.query(
      `UPDATE products SET title=?, description=?, price=?, quantity=?, condition_name=?,
       category_id=?, status=?, aspects=?, raw_inventory_json=?, raw_offer_json=? WHERE id=?`,
      [
        product.title, product.description,
        offerDetails.pricingSummary?.price?.value || 0,
        inventoryItem.availability?.shipToLocationAvailability?.quantity || 0,
        inventoryItem.condition, offerDetails.categoryId, 'fetched',
        JSON.stringify(product.aspects || {}),
        JSON.stringify(inventoryItem), JSON.stringify(offerDetails), productId
      ]
    );
  } else {
    const [result] = await db.query(
      `INSERT INTO products (source_account_id, ebay_item_id, sku, title, description, price,
       currency, quantity, condition_name, category_id, status, aspects, raw_inventory_json, raw_offer_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sellerAId, offer.offerId, sku, product.title, product.description,
        offerDetails.pricingSummary?.price?.value || 0,
        offerDetails.pricingSummary?.price?.currency || 'USD',
        inventoryItem.availability?.shipToLocationAvailability?.quantity || 0,
        inventoryItem.condition, offerDetails.categoryId, 'fetched',
        JSON.stringify(product.aspects || {}),
        JSON.stringify(inventoryItem), JSON.stringify(offerDetails)
      ]
    );
    productId = result.insertId;
  }

  await db.query('DELETE FROM product_images WHERE product_id = ?', [productId]);
  const imageUrls = product.imageUrls || [];
  for (let i = 0; i < imageUrls.length; i++) {
    await db.query(
      'INSERT INTO product_images (product_id, image_url, display_order) VALUES (?, ?, ?)',
      [productId, imageUrls[i], i]
    );
  }

  await db.query(
    'INSERT INTO product_backups (product_id, sku, backup_json) VALUES (?, ?, ?)',
    [productId, sku, JSON.stringify({ inventoryItem, offer: offerDetails })]
  );
  await db.query('UPDATE products SET status = ? WHERE id = ?', ['backed_up', productId]);

  await db.query(
    `INSERT INTO migration_log (product_id, sku, source_seller, status) VALUES (?, ?, ?, ?)`,
    [productId, sku, 'seller_a_sandbox', 'backed_up']
  );

  return { productId };
}

exports.moveToDatabase = async (req, res) => {
  const skus = req.body.skus;
  if (!Array.isArray(skus) || skus.length === 0) {
    return res.status(400).json({ error: 'Provide skus: string[] in the request body' });
  }
  try {
    const sellerAId = await ensureSeller('seller_a_sandbox', 'source');
    const results = await runBatch(skus, sku => fetchOneProductFromSellerA(sku, sellerAId));
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

// =====================================================================
// BUTTON 3 — PUSH SELECTED SKUs FROM DATABASE TO SELLER B, THEN REMOVE FROM SELLER A
// POST /api/migrate-to-seller-b   body: { skus: ["SKU1","SKU2", ...] }
// =====================================================================
async function migrateOneProductToSellerB(sku, sellerBId, policiesB) {
  const [rows] = await db.query('SELECT * FROM products WHERE sku = ?', [sku]);
  if (rows.length === 0) throw new Error(`SKU ${sku} not found in database — move it to the database first`);
  const dbProduct = rows[0];

  const [imageRows] = await db.query(
    'SELECT image_url FROM product_images WHERE product_id = ? ORDER BY display_order',
    [dbProduct.id]
  );
  const imageUrls = imageRows.map(r => r.image_url);
  const aspects = JSON.parse(dbProduct.aspects || '{}');

  // Create + publish on Seller B, using the SAME sku
  const invUrl = `${BASE_URL}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
  await axios.put(invUrl, {
    availability: { shipToLocationAvailability: { quantity: dbProduct.quantity || 1 } },
    condition: dbProduct.condition_name || 'NEW',
    product: {
      title: dbProduct.title,
      description: dbProduct.description,
      imageUrls: imageUrls.length ? imageUrls : undefined,
      aspects
    }
  }, { headers: headersB });

  const { offerId, alreadyPublished } = await getOrCreateOffer(headersB, sku, policiesB);
  let listingId = null;
  if (!alreadyPublished) {
    listingId = await publishOffer(headersB, offerId);
  }

  await db.query(
    `UPDATE migration_log SET target_seller=?, status=?, target_offer_id=?, target_listing_id=?
     WHERE product_id = ? ORDER BY id DESC LIMIT 1`,
    ['seller_b_sandbox', 'migrated', offerId, listingId, dbProduct.id]
  );
  await db.query('UPDATE products SET status = ? WHERE id = ?', ['migrated', dbProduct.id]);

  // Remove the listing from Seller A now that it lives on Seller B
  let removedFromA = false;
  let removeError = null;
  try {
    const offerA = await findExistingOffer(headersA, sku);
    if (offerA) {
      if (offerA.status === 'PUBLISHED') {
        await withdrawOffer(headersA, offerA.offerId);
      }
    }
    await deleteInventoryItem(headersA, sku);
    removedFromA = true;
  } catch (err) {
    removeError = err.response ? err.response.data : err.message;
  }

  return { offerId, listingId, removedFromA, removeError };
}

exports.migrateToSellerB = async (req, res) => {
  const skus = req.body.skus;
  if (!Array.isArray(skus) || skus.length === 0) {
    return res.status(400).json({ error: 'Provide skus: string[] in the request body' });
  }
  try {
    const sellerBId = await ensureSeller('seller_b_sandbox', 'destination');
    await createMerchantLocation(headersB);
    const policiesB = await ensurePolicies(headersB); // fetched/created once for the whole batch

    const results = await runBatch(skus, sku => migrateOneProductToSellerB(sku, sellerBId, policiesB));

    // Mark failures in migration_log
    for (const r of results) {
      if (!r.success) {
        await db.query(
          `UPDATE migration_log SET status=?, error_message=? WHERE sku = ? ORDER BY id DESC LIMIT 1`,
          ['failed', JSON.stringify(r.error), r.sku]
        ).catch(() => {});
      }
    }

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

// =====================================================================
// BUTTON 4 (optional) — VIEW MIGRATION LOG / STATUS
// GET /api/migration-status
// =====================================================================
exports.getMigrationStatus = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT p.sku, p.title, p.status, ml.source_seller, ml.target_seller,
              ml.target_offer_id, ml.target_listing_id, ml.error_message, ml.updated_at
       FROM products p
       LEFT JOIN migration_log ml ON ml.product_id = p.id
       ORDER BY ml.updated_at DESC`
    );
    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};