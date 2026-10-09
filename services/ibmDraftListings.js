const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const axios = require('axios');
const { sellerB } = require('../config/ebayAuth');
const { getSellerBRefreshToken, checkMongoStorage } = require('./oauthStorage');

const BASE_URL = 'https://api.ebay.com';
const MARKETPLACE_ID = 'EBAY_US';
const CATEGORY_ID = process.env.IBM_EBAY_CATEGORY_ID || '40004';
const SOURCE_FILE = process.env.IBM_LISTING_XLSX ||
  'C:\\Users\\rupes\\Downloads\\IBM eBay List - 10-5-2026.xlsx';
const STATE_FILE = path.join(__dirname, '..', 'data', 'ibm-draft-listing-state.json');
const MAX_SHIPPING_DELTA = Number(process.env.IBM_MAX_SHIPPING_DELTA || 25);
const REQUEST_DELAY_MS = Number(process.env.IBM_LISTING_DELAY_MS || 350);
const MERCHANT_LOCATION_KEY = process.env.IBM_MERCHANT_LOCATION_KEY?.trim() || 'IBM_PHOENIX_85004';

const jobs = new Map();
let activeJobId = null;

function getSeller() {
  return sellerB;
}

function describeApiError(error) {
  const detail = error.response?.data;
  const messages = detail?.errors?.map((item) => item.longMessage || item.message).filter(Boolean) || [];
  if (messages.length) return `HTTP ${error.response.status}: ${messages.join('; ')}`;
  return error.message || 'Unknown eBay API error';
}

async function getReadiness() {
  let sellerBRefreshToken = (process.env.SELLER_B_REFRESH_TOKEN || '').trim();
  let mongoStorageReady = false;
  let mongoStorageDetail = process.env.MONGO_URI
    ? 'Connection not checked'
    : 'Set MONGO_URI and EBAY_TOKEN_ENCRYPTION_KEY';
  if (process.env.MONGO_URI) {
    try {
      mongoStorageReady = await checkMongoStorage();
      sellerBRefreshToken = await getSellerBRefreshToken() || sellerBRefreshToken;
      mongoStorageDetail = 'Connected; OAuth tokens are encrypted at rest by the app';
    } catch (error) {
      mongoStorageDetail = error.message || 'MongoDB connection failed';
    }
  }
  const configuredScopes = process.env.EBAY_OAUTH_SCOPES || [
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.account'
  ].join(' ');
  const scopes = new Set(configuredScopes.split(/\s+/).filter(Boolean));
  const appKeyConfigured = Boolean(
    process.env.MIGRATION_TOOL_API_KEY || process.env.API_KEY || process.env.SHARED_SECRET
  );
  const checks = [
    { name: 'App API key', ready: appKeyConfigured, detail: appKeyConfigured ? 'Configured' : 'Set MIGRATION_TOOL_API_KEY, API_KEY, or SHARED_SECRET' },
    { name: 'Seller B eBay client ID', ready: Boolean(process.env.EBAY_CLIENT_ID), detail: process.env.EBAY_CLIENT_ID ? 'Configured' : 'Set EBAY_CLIENT_ID' },
    { name: 'Seller B eBay client secret', ready: Boolean(process.env.EBAY_CLIENT_SECRET), detail: process.env.EBAY_CLIENT_SECRET ? 'Configured' : 'Set EBAY_CLIENT_SECRET' },
    { name: 'MongoDB OAuth storage', ready: mongoStorageReady, detail: mongoStorageDetail },
    { name: 'Seller B OAuth token for REST drafts', ready: Boolean(sellerBRefreshToken || process.env.SELLER_B_ACCESS_TOKEN), detail: sellerBRefreshToken || process.env.SELLER_B_ACCESS_TOKEN ? 'Configured; must refresh successfully for REST Inventory API' : 'Connect Seller B with OAuth or set SELLER_B_REFRESH_TOKEN; Auth’n’Auth tokens do not authorize REST Inventory API calls' },
    { name: 'Seller B Auth’n’Auth token for Trading API view', ready: Boolean(process.env.SELLER_B_AUTH_TOKEN?.trim()), detail: process.env.SELLER_B_AUTH_TOKEN?.trim() ? 'Configured for legacy Trading API product viewing' : 'Set SELLER_B_AUTH_TOKEN to enable product viewing with Auth’n’Auth' },
    { name: 'Production eBay environment', ready: (process.env.EBAY_ENV || 'production').toLowerCase() === 'production', detail: (process.env.EBAY_ENV || 'production').toLowerCase() === 'production' ? 'Configured' : 'Set EBAY_ENV=production for this production listing workflow' },
    { name: 'Inventory API OAuth scope', ready: scopes.has('https://api.ebay.com/oauth/api_scope/sell.inventory'), detail: scopes.has('https://api.ebay.com/oauth/api_scope/sell.inventory') ? 'Configured' : 'Add sell.inventory to EBAY_OAUTH_SCOPES and reauthorize Seller B' },
    { name: 'Account API OAuth scope', ready: scopes.has('https://api.ebay.com/oauth/api_scope/sell.account'), detail: scopes.has('https://api.ebay.com/oauth/api_scope/sell.account') ? 'Configured' : 'Add sell.account to EBAY_OAUTH_SCOPES and reauthorize Seller B' },
    { name: '85004 inventory location key', ready: true, detail: `Configured: ${MERCHANT_LOCATION_KEY}; created on Seller B if not already present` },
    { name: 'eBay category', ready: Boolean(CATEGORY_ID), detail: `Category ${CATEGORY_ID}` }
  ];
  const canCheckSeller = Boolean(
    process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET &&
    (sellerBRefreshToken || process.env.SELLER_B_ACCESS_TOKEN) &&
    scopes.has('https://api.ebay.com/oauth/api_scope/sell.account') &&
    (process.env.EBAY_ENV || 'production').toLowerCase() === 'production'
  );
  if (canCheckSeller) {
    try {
      const token = await getSeller().getToken();
      const client = axios.create({
        baseURL: BASE_URL,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Language': 'en-US',
          'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID
        },
        timeout: 30000
      });
      const fulfillmentPolicies = await getPolicies(client);
      checks.push({ name: 'Seller B eBay API access', ready: true, detail: 'Authenticated; Seller B fulfillment policies are readable' });
      const hasFiveDayShipping = fulfillmentPolicies.some((policy) => policyCostCandidates(policy).length > 0);
      checks.push({
        name: 'Five-business-day shipping policy',
        ready: hasFiveDayShipping,
        detail: hasFiveDayShipping ? 'At least one domestic flat-rate, five-day policy is available' : 'Create or select a domestic flat-rate fulfillment policy with 5 business days handling'
      });
      try {
        const policyIds = await getPolicyIds(client);
        checks.push({ name: 'Seller B payment and return policies', ready: true, detail: `Configured and readable; return policy: ${policyIds.returnPolicyName}` });
      } catch (error) {
        checks.push({ name: 'Seller B payment and return policies', ready: false, detail: error.message || describeApiError(error) });
      }
    } catch (error) {
      checks.push({ name: 'Seller B eBay API access', ready: false, detail: describeApiError(error) });
    }
  } else {
    checks.push({ name: 'Seller B eBay API access', ready: false, detail: 'Resolve the missing client/token/scope/environment checks above first' });
  }
  // Auth'n'Auth is only used by the optional legacy Trading API product-view
  // button. It must not block the REST Inventory API draft workflow.
  const listingChecks = checks.filter((check) => check.name !== 'Seller B Auth’n’Auth token for Trading API view');
  const listingReady = listingChecks.every((check) => check.ready);
  const viewCheck = checks.find((check) => check.name === 'Seller B Auth’n’Auth token for Trading API view');
  return { ready: listingReady, listingReady, viewReady: Boolean(viewCheck?.ready), checks };
}

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function amount(value) {
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[$,]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function makeTitle(row) {
  const full = [row.make, row.model, row.equipmentType].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return full.length <= 80 ? full : `${full.slice(0, 77).trimEnd()}...`;
}

function makeDescription(row) {
  const lines = [
    `Asset #: ${row.assetNumber}`,
    `Make: ${row.make}`,
    `Model: ${row.model}`,
    `Type: ${row.equipmentType}`
  ];
  if (row.configuration) lines.push(`Configuration: ${row.configuration}`);
  return lines.map((line) => `<p>${escapeHtml(line).replace(/\r?\n/g, '<br>')}</p>`).join('\n');
}

function normalizeRows(rawRows) {
  const normalizedKeys = (row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [String(key).trim().toLowerCase().replace(/[\s_]+/g, ' '), value])
  );
  return rawRows.map((original, index) => {
    const raw = normalizedKeys(original);
    const get = (...keys) => {
      for (const key of keys) {
        const value = raw[key.trim().toLowerCase().replace(/[\s_]+/g, ' ')];
        if (value !== undefined) return value;
      }
      return '';
    };
    return {
      rowNumber: index + 2,
      assetNumber: clean(get('Asset #', 'Asset Number', 'Asset')),
      make: clean(get('Make', 'Brand')),
      model: clean(get('Model', 'MPN')),
      equipmentType: clean(get('Equipment_Type', 'Equipment Type', 'Type')),
      configuration: clean(get('Equipment_Configuration', 'Equipment Configuration', 'Configuration', 'Config')),
      askingPrice: amount(get('Asking Price', 'Price')),
      shippingText: clean(get('Shipping Pirce', 'Shipping Price', 'Shipping Amount')),
      shippingAmount: amount(get('Shipping Pirce', 'Shipping Price', 'Shipping Amount')),
      location: clean(get('Location')),
      photoUrls: clean(get('Photo URLs', 'Photo URL(s)', 'Image URLs', 'Picture URLs', 'Photo URL', 'Image URL'))
        .split(/[;\n]+/).map((url) => url.trim()).filter(Boolean)
    };
  });
}

function readWorkbook(filePath = SOURCE_FILE) {
  if (!fs.existsSync(filePath)) throw new Error(`Workbook not found: ${filePath}`);
  const workbook = xlsx.readFile(filePath, { cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('The workbook does not contain a worksheet.');
  const rawRows = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: true });
  return normalizeRows(rawRows);
}

function parseCsv(csvText) {
  if (typeof csvText !== 'string' || !csvText.trim()) throw new Error('Upload a non-empty CSV file.');
  const workbook = xlsx.read(csvText, { type: 'string', raw: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('The uploaded CSV could not be read.');
  const rawRows = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: true });
  if (!rawRows.length) throw new Error('The CSV has headers but no product rows.');
  if (rawRows.length > 1000) throw new Error('The CSV exceeds the 1,000-row upload limit.');
  const rows = normalizeRows(rawRows);
  if (rows.every((row) => !row.assetNumber && !row.make && !row.model && !row.equipmentType)) {
    throw new Error('CSV headers must include Asset #, Make, Model, Equipment_Type, Asking Price, and Shipping Price.');
  }
  return rows;
}

function parseWorkbookBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Upload a non-empty Excel workbook.');
  const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('The uploaded workbook does not contain a worksheet.');
  const rawRows = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: true });
  if (!rawRows.length) throw new Error('The workbook has headers but no product rows.');
  if (rawRows.length > 1000) throw new Error('The workbook exceeds the 1,000-row upload limit.');
  const rows = normalizeRows(rawRows);
  if (rows.every((row) => !row.assetNumber && !row.make && !row.model && !row.equipmentType)) {
    throw new Error('Workbook headers must include Asset #, Make, Model, Equipment_Type, Asking Price, and Shipping Price.');
  }
  return rows;
}

function previewRowsLocally(rows) {
  const preview = rows.map((row) => ({
    rowNumber: row.rowNumber,
    assetNumber: row.assetNumber,
    title: makeTitle(row),
    askingPrice: row.askingPrice,
    spreadsheetShipping: row.shippingAmount,
    photoUrls: row.photoUrls || [],
    selectedShipping: null,
    shippingDifference: null,
    offerEnabled: row.askingPrice > 2000,
    issues: validateRow(row),
    policyValidationPending: true
  }));
  return {
    ...previewSummary(preview),
    setupIssues: [],
    merchantLocationKeyConfigured: Boolean(MERCHANT_LOCATION_KEY),
    localOnly: true
  };
}

function validateRow(row) {
  const issues = [];
  if (!row.assetNumber) issues.push('missing Asset #');
  if (!row.make) issues.push('missing Make');
  if (!row.model) issues.push('missing Model');
  if (!row.equipmentType) issues.push('missing Equipment_Type');
  if (!(row.askingPrice > 0)) issues.push('Asking Price must be positive');
  if (row.shippingAmount == null) issues.push(`Shipping Price is not numeric (${row.shippingText || 'blank'}); freight needs a manually approved amount`);
  if (!row.photoUrls?.length) issues.push('add at least one product photo URL before live publishing');
  return issues;
}

function policyCostCandidates(policy) {
  if (!Array.isArray(policy.shippingOptions) || policy.shippingOptions.length !== 1) return [];
  const candidates = [];
  for (const option of policy.shippingOptions) {
    if (option.optionType !== 'DOMESTIC' || option.costType !== 'FLAT_RATE') continue;
    if ((option.shippingServices || []).length !== 1) continue;
    const handling = option.handlingTime || {};
    if (Number(handling.value) !== 5 || !['DAY', 'DAYS'].includes(String(handling.unit || '').toUpperCase())) continue;
    for (const service of option.shippingServices || []) {
      if (service.freeShipping === true || service.freeShipping === 'true') continue;
      const cost = amount(service.shippingCost?.value ?? service.shippingCost);
      if (cost != null) {
        candidates.push({ policy, cost, service: service.shippingServiceCode || '' });
      }
    }
  }
  return candidates;
}

function chooseFulfillmentPolicy(policies, targetAmount) {
  const candidates = policies.flatMap(policyCostCandidates)
    .map((candidate) => ({ ...candidate, delta: Math.abs(candidate.cost - targetAmount) }))
    .filter((candidate) => candidate.delta <= MAX_SHIPPING_DELTA)
    .sort((a, b) => a.delta - b.delta || a.cost - b.cost);
  return candidates[0] || null;
}

async function getJson(client, url, config = {}) {
  const response = await client.get(url, config);
  return response.data;
}

async function getPolicies(client) {
  const url = `${BASE_URL}/sell/account/v1/fulfillment_policy?marketplace_id=${MARKETPLACE_ID}&limit=100`;
  const result = await getJson(client, url);
  return result.fulfillmentPolicies || [];
}

async function ensureMerchantLocation(client) {
  if (!MERCHANT_LOCATION_KEY) throw new Error('Set IBM_MERCHANT_LOCATION_KEY in .env. This location must use ZIP code 85004.');
  const url = `/sell/inventory/v1/location/${encodeURIComponent(MERCHANT_LOCATION_KEY)}`;
  try {
    const existing = await getJson(client, url);
    if (existing.location?.address?.postalCode !== '85004' || existing.location?.address?.country !== 'US') {
      throw new Error(`Merchant location ${MERCHANT_LOCATION_KEY} exists but is not ZIP 85004, US. Choose a new key or correct it manually.`);
    }
  } catch (error) {
    if (error.response?.status !== 404) throw error;
    await client.post(url, {
      location: { address: { postalCode: '85004', country: 'US' } },
      locationTypes: ['WAREHOUSE'],
      name: 'IBM Phoenix AZ 85004'
    });
  }
}

async function getPolicyIds(client) {
  let paymentPolicyId = process.env.IBM_PAYMENT_POLICY_ID?.trim();
  {
    const result = await getJson(client, `/sell/account/v1/payment_policy?marketplace_id=${MARKETPLACE_ID}&limit=100`);
    const policies = result.paymentPolicies || [];
    if (paymentPolicyId && !policies.some((policy) => String(policy.paymentPolicyId) === paymentPolicyId)) {
      throw new Error('IBM_PAYMENT_POLICY_ID is not a payment policy belonging to Seller B on EBAY_US.');
    }
    if (!paymentPolicyId) {
      const namedMatches = policies.filter((policy) => /managed\s*payments/i.test(policy.name || ''));
      const exactMatches = namedMatches.filter((policy) => String(policy.name).trim().toLowerCase() === 'ebay managed payments');
      const match = exactMatches.length === 1 ? exactMatches[0] : namedMatches.length === 1 ? namedMatches[0] : null;
      if (match) paymentPolicyId = match.paymentPolicyId;
      else {
        const names = policies.map((policy) => policy.name).filter(Boolean).join(', ') || 'none returned';
        throw new Error(`Set IBM_PAYMENT_POLICY_ID to the REST policy ID for eBay Managed Payments. Matching policy was ambiguous or not found. Account policy names: ${names}`);
      }
    }
  }
  const returnResult = await getJson(client, `/sell/account/v1/return_policy?marketplace_id=${MARKETPLACE_ID}&limit=100`);
  const returnPolicies = returnResult.returnPolicies || [];
  const configuredReturnPolicyId = process.env.IBM_RETURN_POLICY_ID?.trim();
  const matchesRequestedTerms = (policy) => {
    const method = String(policy.returnMethod || '').toUpperCase();
    return policy.returnsAccepted === true &&
      Number(policy.returnPeriod?.value) === 30 &&
      ['DAY', 'DAYS'].includes(String(policy.returnPeriod?.unit || '').toUpperCase()) &&
      String(policy.returnShippingCostPayer || '').toUpperCase() === 'BUYER' &&
      ['REPLACEMENT', 'MONEY_BACK_OR_REPLACEMENT'].includes(method);
  };
  let selectedReturnPolicy;
  if (configuredReturnPolicyId) {
    selectedReturnPolicy = returnPolicies.find((policy) => String(policy.returnPolicyId) === configuredReturnPolicyId);
    if (!selectedReturnPolicy) {
      throw new Error('IBM_RETURN_POLICY_ID is not a return policy belonging to Seller B on EBAY_US.');
    }
    if (!matchesRequestedTerms(selectedReturnPolicy)) {
      throw new Error('IBM_RETURN_POLICY_ID does not match the specified 30-day, buyer-paid, money-back-or-replacement terms.');
    }
  } else {
    const matches = returnPolicies.filter(matchesRequestedTerms);
    if (matches.length !== 1) {
      const choices = matches.map((policy) => `${policy.name || '(unnamed)'} [${policy.returnPolicyId}]`).join(', ') || 'no matching policy found';
      throw new Error(`Could not uniquely identify Seller B’s 30-day, buyer-paid, money-back-or-replacement return policy (${choices}). Set IBM_RETURN_POLICY_ID to the approved matching policy ID.`);
    }
    [selectedReturnPolicy] = matches;
  }
  return {
    paymentPolicyId,
    returnPolicyId: selectedReturnPolicy.returnPolicyId,
    returnPolicyName: selectedReturnPolicy.name || selectedReturnPolicy.returnPolicyId
  };
}

function validateRows(rows, policies) {
  return rows.map((row) => {
    const issues = validateRow(row);
    const fulfillment = row.shippingAmount == null ? null : chooseFulfillmentPolicy(policies, row.shippingAmount);
    if (!issues.length && !fulfillment) {
      issues.push(`no domestic flat-rate fulfillment policy has 5 business days and shipping within $${MAX_SHIPPING_DELTA} of $${row.shippingAmount}`);
    }
    return {
      rowNumber: row.rowNumber,
      assetNumber: row.assetNumber,
      title: makeTitle(row),
      askingPrice: row.askingPrice,
      spreadsheetShipping: row.shippingAmount,
      selectedShipping: fulfillment?.cost ?? null,
      shippingDifference: fulfillment?.delta ?? null,
      fulfillmentPolicyId: fulfillment?.policy.fulfillmentPolicyId ?? null,
      offerEnabled: row.askingPrice > 2000,
      issues
    };
  });
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function previewSummary(preview) {
  const eligible = preview.filter((item) => item.issues.length === 0);
  return {
    total: preview.length,
    eligible: eligible.length,
    skipped: preview.length - eligible.length,
    bestOfferEligible: eligible.filter((item) => item.offerEnabled).length,
    rows: preview
  };
}

async function prepare(inputRows) {
  const seller = getSeller();
  const token = await seller.getToken();
  const client = axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Language': 'en-US',
      'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_ID
    },
    timeout: 30000
  });
  const rows = inputRows || readWorkbook();
  const policies = await getPolicies(client);
  return { client, rows, policies };
}

async function previewDrafts(inputRows) {
  const { client, rows, policies } = await prepare(inputRows);
  const preview = validateRows(rows, policies);
  const setupIssues = [];
  try {
    await getPolicyIds(client);
  } catch (error) {
    setupIssues.push(error.response?.data || error.message);
  }
  return {
    ...previewSummary(preview),
    setupIssues,
    merchantLocationKeyConfigured: Boolean(MERCHANT_LOCATION_KEY)
  };
}

function makeJob(inputRows) {
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    jobId,
    status: 'queued',
    total: 0,
    completed: 0,
    drafted: 0,
    skipped: 0,
    failed: 0,
    results: [],
    startedAt: null,
    finishedAt: null
  };
  jobs.set(jobId, job);
  activeJobId = jobId;
  setImmediate(() => { void runJob(jobId, inputRows); });
  return { ...job };
}

async function runJob(jobId, inputRows) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  try {
    const { client, rows, policies } = await prepare(inputRows);
    const policyIds = await getPolicyIds(client);
    const preview = validateRows(rows, policies);
    job.total = preview.length;
    saveState({ jobId, status: 'running', startedAt: job.startedAt, results: [] });

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const check = preview[i];
      if (check.issues.length) {
        job.skipped += 1;
        job.completed += 1;
        job.results.push({ ...check, status: 'skipped' });
        saveState(job);
        continue;
      }

      const sku = `IBM-${row.assetNumber}`;
      const fulfillmentPolicyId = check.fulfillmentPolicyId;
      const itemUrl = `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
      try {
        const existingOffers = await getJson(client, `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${MARKETPLACE_ID}`);
        if ((existingOffers.offers || []).length) {
          job.skipped += 1;
          job.completed += 1;
          job.results.push({ ...check, status: 'skipped', sku, reason: 'SKU already has an eBay offer; left unchanged.' });
          saveState(job);
          continue;
        }
        try {
          await getJson(client, itemUrl);
          job.skipped += 1;
          job.completed += 1;
          job.results.push({ ...check, status: 'skipped', sku, reason: 'SKU already exists in eBay inventory; left unchanged.' });
          saveState(job);
          continue;
        } catch (error) {
          if (error.response?.status !== 404) throw error;
        }

        await ensureMerchantLocation(client);
        await client.put(itemUrl, {
          availability: { shipToLocationAvailability: { quantity: 1 } },
          condition: 'USED',
          product: {
            title: check.title,
            description: makeDescription(row),
            aspects: { Brand: [row.make], MPN: [row.model] }
          }
        });

        const offer = {
          sku,
          marketplaceId: MARKETPLACE_ID,
          format: 'FIXED_PRICE',
          availableQuantity: 1,
          categoryId: CATEGORY_ID,
          merchantLocationKey: MERCHANT_LOCATION_KEY,
          listingDuration: 'GTC',
          listingDescription: makeDescription(row),
          listingPolicies: {
            paymentPolicyId: policyIds.paymentPolicyId,
            returnPolicyId: policyIds.returnPolicyId,
            fulfillmentPolicyId
          },
          pricingSummary: { price: { value: row.askingPrice.toFixed(2), currency: 'USD' } }
        };
        if (row.askingPrice > 2000) offer.listingPolicies.bestOfferTerms = { bestOfferEnabled: true };

        const response = await client.post('/sell/inventory/v1/offer', offer);
        const result = {
          ...check,
          status: 'draft',
          sku,
          offerId: response.data.offerId,
          published: false
        };
        job.drafted += 1;
        job.results.push(result);
      } catch (error) {
        const result = {
          ...check,
          status: 'failed',
          sku,
          error: error.response?.data || error.message
        };
        job.failed += 1;
        job.results.push(result);
      }
      job.completed += 1;
      saveState(job);
      if (REQUEST_DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
    }
    job.status = job.failed ? 'completed_with_errors' : 'completed';
  } catch (error) {
    job.status = 'failed';
    job.error = error.response?.data || error.message;
  } finally {
    job.finishedAt = new Date().toISOString();
    saveState(job);
    activeJobId = null;
  }
}

async function startDraftJob(inputRows) {
  getSeller();
  if (!MERCHANT_LOCATION_KEY) throw new Error('Set IBM_MERCHANT_LOCATION_KEY in .env before creating drafts.');
  const rows = inputRows || readWorkbook();
  if (!rows.length) throw new Error('No product rows were supplied.');
  const readiness = await getReadiness();
  if (!readiness.listingReady) {
    const missing = readiness.checks.filter((check) => !check.ready && check.name !== 'Seller B Auth’n’Auth token for Trading API view');
    throw new Error(`Seller B listing setup is not ready: ${missing.map((check) => `${check.name} — ${check.detail}`).join('; ')}`);
  }
  if (activeJobId) return { duplicate: true, job: { ...jobs.get(activeJobId) } };
  return { duplicate: false, job: makeJob(rows) };
}

function getJob(jobId) {
  const job = jobs.get(jobId);
  if (job) return { ...job };
  if (fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved.jobId === jobId) return saved;
  }
  return null;
}

module.exports = { getReadiness, parseCsv, parseWorkbookBuffer, previewRowsLocally, previewDrafts, startDraftJob, getJob };
