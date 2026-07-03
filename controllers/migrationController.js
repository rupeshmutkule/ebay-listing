require('dotenv').config();
const axios = require('axios');
const db = require('../config/db');

const SKU = 'TESTSKU001';
const BASE_URL = 'https://api.sandbox.ebay.com';
const CATEGORY_ID = '177';

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

// ---------- SELLER A: CREATE TEST PRODUCT (existing flow) ----------

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
    console.log('✅ Merchant location created');
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || '';
    if (err.response?.status === 409 || msg.includes('already exists')) {
      console.log('ℹ️ Merchant location already exists, continuing');
    } else {
      throw err;
    }
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

async function buildAspects(headers) {
  const requiredFields = await getRequiredAspects(CATEGORY_ID, headers);
  const aspects = {
    Brand: ['TestBrand'],
    Color: ['Black'],
    Type: ['Test Type'],
    MPN: ['Does Not Apply']
  };
  const placeholders = {
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
  requiredFields.forEach(field => {
    if (!aspects[field]) aspects[field] = [placeholders[field] || 'N/A'];
  });
  return aspects;
}

async function createInventoryItem(headers, sku) {
  const url = `${BASE_URL}/sell/inventory/v1/inventory_item/${sku}`;
  const aspects = await buildAspects(headers);
  const body = {
    availability: { shipToLocationAvailability: { quantity: 5 } },
    condition: 'NEW',
    product: {
      title: 'Television -T.V.',
      description: 'This is a test product created via API for migration testing.',
      imageUrls: ['https://www.practical-tips.com/wp-content/uploads/2025/05/8s-1.jpeg'],
      aspects
    }
  };
  await axios.put(url, body, { headers });
  console.log('✅ Inventory item created/updated');
  return body.product;
}

async function optInToBusinessPolicies(headers) {
  const url = `${BASE_URL}/sell/account/v1/program/opt_in`;
  try {
    await axios.post(url, { programType: 'SELLING_POLICY_MANAGEMENT' }, { headers });
    console.log('✅ Opted in to Business Policies');
  } catch (err) {
    if (err.response?.status === 409) {
      console.log('ℹ️ Already opted in to Business Policies');
    } else {
      throw err;
    }
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
  console.log('✅ Payment policy created');
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
  console.log('✅ Fulfillment policy created');
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
  console.log('✅ Return policy created');
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
  const url = `${BASE_URL}/sell/inventory/v1/offer?sku=${sku}`;
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
    listingDescription: 'Test product for migration workflow testing.',
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
  console.log('✅ Offer created:', res.data.offerId);
  return res.data.offerId;
}

async function updateOffer(headers, offerId, sku, policies) {
  const url = `${BASE_URL}/sell/inventory/v1/offer/${offerId}`;
  await axios.put(url, buildOfferBody(sku, policies), { headers });
  console.log('✅ Offer updated:', offerId);
  return offerId;
}

async function getOrCreateOffer(headers, sku, policies) {
  const existing = await findExistingOffer(headers, sku);
  if (existing) {
    console.log('ℹ️ Offer already exists:', existing.offerId, '- status:', existing.status);
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
  console.log('✅ Offer published! Listing ID:', res.data.listingId);
  return res.data.listingId;
}

exports.createTestProduct = async (req, res) => {
  try {
    await createMerchantLocation(headersA);
    await createInventoryItem(headersA, SKU);
    const policies = await ensurePolicies(headersA);
    const { offerId, alreadyPublished } = await getOrCreateOffer(headersA, SKU, policies);

    let listingId = null;
    if (!alreadyPublished) {
      listingId = await publishOffer(headersA, offerId);
    }

    res.json({ success: true, message: 'Test product created and published', offerId, listingId });
  } catch (err) {
    console.log('❌ FINAL ERROR:', JSON.stringify(err.response?.data || err.message));
    res.status(500).json({ error: err.response ? err.response.data : err.message });
  }
};

// ---------- STEP 2: FETCH FROM SELLER A + SAVE TO DATABASE ----------

async function ensureSeller(storeName, role) {
  const [rows] = await db.query('SELECT id FROM sellers WHERE store_name = ?', [storeName]);
  if (rows.length > 0) return rows[0].id;

  const [result] = await db.query(
    'INSERT INTO sellers (store_name, role, environment) VALUES (?, ?, ?)',
    [storeName, role, 'sandbox']
  );
  return result.insertId;
}

exports.fetchAndBackupProduct = async (req, res) => {
  try {
    const sellerAId = await ensureSeller('seller_a_sandbox', 'source');

    // Fetch inventory item + offer from Seller A
    const invUrl = `${BASE_URL}/sell/inventory/v1/inventory_item/${SKU}`;
    const invRes = await axios.get(invUrl, { headers: headersA });
    const inventoryItem = invRes.data;

    const offer = await findExistingOffer(headersA, SKU);
    if (!offer) {
      return res.status(404).json({ error: 'No offer found for this SKU on Seller A' });
    }

    const offerUrl = `${BASE_URL}/sell/inventory/v1/offer/${offer.offerId}`;
    const offerRes = await axios.get(offerUrl, { headers: headersA });
    const offerDetails = offerRes.data;

    // Insert or update products table
    const product = inventoryItem.product;
    const [existingRows] = await db.query('SELECT id FROM products WHERE sku = ?', [SKU]);

    let productId;
    if (existingRows.length > 0) {
      productId = existingRows[0].id;
      await db.query(
        `UPDATE products SET title=?, description=?, price=?, quantity=?, condition_name=?,
         category_id=?, status=?, aspects=?, raw_inventory_json=?, raw_offer_json=? WHERE id=?`,
        [
          product.title,
          product.description,
          offerDetails.pricingSummary?.price?.value || 0,
          inventoryItem.availability?.shipToLocationAvailability?.quantity || 0,
          inventoryItem.condition,
          offerDetails.categoryId,
          'fetched',
          JSON.stringify(product.aspects || {}),
          JSON.stringify(inventoryItem),
          JSON.stringify(offerDetails),
          productId
        ]
      );
      console.log('✅ Product updated in DB, id:', productId);
    } else {
      const [result] = await db.query(
        `INSERT INTO products (source_account_id, ebay_item_id, sku, title, description, price,
         currency, quantity, condition_name, category_id, status, aspects, raw_inventory_json, raw_offer_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sellerAId,
          offer.offerId,
          SKU,
          product.title,
          product.description,
          offerDetails.pricingSummary?.price?.value || 0,
          offerDetails.pricingSummary?.price?.currency || 'USD',
          inventoryItem.availability?.shipToLocationAvailability?.quantity || 0,
          inventoryItem.condition,
          offerDetails.categoryId,
          'fetched',
          JSON.stringify(product.aspects || {}),
          JSON.stringify(inventoryItem),
          JSON.stringify(offerDetails)
        ]
      );
      productId = result.insertId;
      console.log('✅ Product inserted into DB, id:', productId);
    }

    // Save images
    await db.query('DELETE FROM product_images WHERE product_id = ?', [productId]);
    const imageUrls = product.imageUrls || [];
    for (let i = 0; i < imageUrls.length; i++) {
      await db.query(
        'INSERT INTO product_images (product_id, image_url, display_order) VALUES (?, ?, ?)',
        [productId, imageUrls[i], i]
      );
    }
    console.log('✅ Images saved:', imageUrls.length);

    // Create backup snapshot
    await db.query(
      'INSERT INTO product_backups (product_id, sku, backup_json) VALUES (?, ?, ?)',
      [productId, SKU, JSON.stringify({ inventoryItem, offer: offerDetails })]
    );
    await db.query('UPDATE products SET status = ? WHERE id = ?', ['backed_up', productId]);
    console.log('✅ Backup snapshot saved');

    // Log migration attempt start
    await db.query(
      `INSERT INTO migration_log (product_id, sku, source_seller, status)
       VALUES (?, ?, ?, ?)`,
      [productId, SKU, 'seller_a_sandbox', 'backed_up']
    );

    res.json({ success: true, message: 'Product fetched and backed up', productId });
  } catch (err) {
    console.log('❌ FETCH/BACKUP ERROR:', JSON.stringify(err.response?.data || err.message));
    res.status(500).json({ error: err.response ? err.response.data : err.message });
  }
};

// ---------- STEP 3: PUSH FROM DATABASE TO SELLER B ----------

exports.migrateToSellerB = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products WHERE sku = ?', [SKU]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Product not found in database. Fetch it first.' });
    }
    const dbProduct = rows[0];

    const [imageRows] = await db.query(
      'SELECT image_url FROM product_images WHERE product_id = ? ORDER BY display_order',
      [dbProduct.id]
    );
    const imageUrls = imageRows.map(r => r.image_url);

    const sellerBId = await ensureSeller('seller_b_sandbox', 'destination');
    const targetSku = SKU + '-MIGRATED';

    // Create on Seller B
    await createMerchantLocation(headersB);

    const aspects = JSON.parse(dbProduct.aspects || '{}');
    const invUrl = `${BASE_URL}/sell/inventory/v1/inventory_item/${targetSku}`;
    await axios.put(invUrl, {
      availability: { shipToLocationAvailability: { quantity: dbProduct.quantity || 5 } },
      condition: dbProduct.condition_name || 'NEW',
      product: {
        title: dbProduct.title,
        description: dbProduct.description,
        imageUrls: imageUrls.length ? imageUrls : ['https://i.ebayimg.com/images/g/8xkAAOSwiddj6zZW/s-l1600.jpg'],
        aspects
      }
    }, { headers: headersB });
    console.log('✅ Inventory item created on Seller B');

    const policiesB = await ensurePolicies(headersB);
    const { offerId, alreadyPublished } = await getOrCreateOffer(headersB, targetSku, policiesB);

    let listingId = null;
    if (!alreadyPublished) {
      listingId = await publishOffer(headersB, offerId);
    }

    // Update migration log
    await db.query(
      `UPDATE migration_log SET target_seller=?, status=?, target_offer_id=?, target_listing_id=?
       WHERE product_id = ? ORDER BY id DESC LIMIT 1`,
      ['seller_b_sandbox', 'migrated', offerId, listingId, dbProduct.id]
    );
    await db.query('UPDATE products SET status = ? WHERE id = ?', ['migrated', dbProduct.id]);

    res.json({ success: true, message: 'Product migrated to Seller B', offerId, listingId });
  } catch (err) {
    console.log('❌ MIGRATE TO SELLER B ERROR:', JSON.stringify(err.response?.data || err.message));

    await db.query(
      `UPDATE migration_log SET status=?, error_message=? WHERE sku = ? ORDER BY id DESC LIMIT 1`,
      ['failed', JSON.stringify(err.response?.data || err.message), SKU]
    ).catch(() => {});

    res.status(500).json({ error: err.response ? err.response.data : err.message });
  }
};