const tradingApi = require('./tradingapi');
const { sellerBAuthToken } = require('../config/ebayAuth');
const { getListingQueueCollection } = require('./oauthStorage');

const CATEGORY_ID = String(process.env.IBM_EBAY_CATEGORY_ID || '40004');
const MAX_BATCH_SIZE = 1;

function clean(value) { return value == null ? '' : String(value).trim(); }
function money(value) {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[$,]/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}
function xmlHtml(value) {
  return clean(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function plainDescription(row) {
  return [
    `Make: ${clean(row.make)}`,
    `Model: ${clean(row.model)}`,
    `Type: ${clean(row.equipmentType)}`,
    row.configuration ? `Configuration: ${clean(row.configuration)}` : '',
    `Asset #: ${clean(row.assetNumber)}`
  ].filter(Boolean).join('\n').replace(/\]\]>/g, ']]&gt;');
}
function shippingServiceXml(service, amount) {
  return {
    ShippingType: 'Flat',
    ShippingServiceOptions: {
      ShippingService: service,
      ShippingServicePriority: 1,
      ShippingServiceCost: { '#text': amount.toFixed(2), '@_currencyID': 'USD' },
      ShippingServiceAdditionalCost: { '#text': '0.00', '@_currencyID': 'USD' }
    }
  };
}
function validate(row) {
  const issues = [];
  if (!row.assetNumber) issues.push('Asset # is required');
  if (!row.make || !row.model || !row.equipmentType) issues.push('Make, Model, and Equipment_Type are required');
  if (!(money(row.askingPrice) > 0)) issues.push('Asking Price must be positive');
  if (!(money(row.shippingAmount) >= 0)) issues.push('Shipping Price must be numeric; Freight rows need a client-approved numeric amount');
  const photos = Array.isArray(row.photoUrls) ? row.photoUrls : [];
  if (!photos.length) issues.push('At least one product photo URL is required for live publication');
  for (const photo of photos) {
    try { if (new URL(photo).protocol !== 'https:') issues.push('Photo URLs must use HTTPS'); }
    catch { issues.push('A photo URL is invalid'); }
  }
  return [...new Set(issues)];
}
async function findActiveSku(sku) {
  const first = await tradingApi.getSellerList({ type: 'authn-auth', token: sellerBAuthToken }, { pageNumber: 1, entriesPerPage: 200 });
  const all = [...first.items];
  for (let page = 2; page <= first.totalPages; page += 1) {
    const next = await tradingApi.getSellerList({ type: 'authn-auth', token: sellerBAuthToken }, { pageNumber: page, entriesPerPage: 200 });
    all.push(...next.items);
  }
  return all.find((item) => clean(item.SKU) === sku) || null;
}
function toTradingItem(row) {
  const title = [row.make, row.model, row.equipmentType].map(clean).filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 80).trim();
  const amount = money(row.askingPrice);
  const shipping = money(row.shippingAmount);
  const service = clean(process.env.IBM_SHIPPING_SERVICE);
  const zip = '85004';
  const pictures = Array.isArray(row.photoUrls) ? row.photoUrls : [];
  const item = {
    Title: title,
    Description: plainDescription(row),
    PrimaryCategory: { CategoryID: CATEGORY_ID },
    StartPrice: { '#text': amount.toFixed(2), '@_currencyID': 'USD' },
    ConditionID: '3000',
    Country: 'US', Currency: 'USD', DispatchTimeMax: '5', ListingDuration: 'GTC',
    ListingType: 'FixedPriceItem', Location: 'Phoenix, Arizona', PostalCode: zip,
    Quantity: 1,
    SKU: `IBM-${clean(row.assetNumber)}`,
    PictureDetails: { PictureURL: pictures },
    ItemSpecifics: { NameValueList: [
      { Name: 'Brand', Value: clean(row.make) },
      { Name: 'MPN', Value: clean(row.model) },
      { Name: 'Type', Value: clean(row.equipmentType) },
      { Name: 'Asset #', Value: clean(row.assetNumber) },
      ...(row.configuration ? [{ Name: 'Configuration', Value: clean(row.configuration) }] : [])
    ] },
    ShippingDetails: shippingServiceXml(service, shipping),
    ReturnPolicy: {
      ReturnsAcceptedOption: 'ReturnsAccepted',
      RefundOption: 'MoneyBackOrReplacement',
      ReturnsWithinOption: 'Days_30',
      ShippingCostPaidByOption: 'Buyer'
    }
  };
  if (amount > 2000) item.BestOfferDetails = { BestOfferEnabled: true };
  return item;
}
async function getReadiness() {
  const checks = [
    { name: 'MongoDB private queue', ready: false, detail: 'Set MONGO_URI; the queue must be durable before importing client inventory' },
    { name: 'Semi Equipment Auth’n’Auth token', ready: Boolean(sellerBAuthToken), detail: sellerBAuthToken ? 'Configured in server environment' : 'Set SELLER_B_AUTH_TOKEN' },
    { name: 'Private listing access password', ready: Boolean(clean(process.env.IBM_LISTING_ACCESS_PASSWORD)), detail: process.env.IBM_LISTING_ACCESS_PASSWORD ? 'Configured' : 'Set IBM_LISTING_ACCESS_PASSWORD; keep it private and share it only with authorized users' },
    { name: 'Domestic shipping service', ready: Boolean(clean(process.env.IBM_SHIPPING_SERVICE)) && !/^freight$/i.test(clean(process.env.IBM_SHIPPING_SERVICE)), detail: !clean(process.env.IBM_SHIPPING_SERVICE) ? 'Set IBM_SHIPPING_SERVICE to the seller-approved domestic service code' : /^freight$/i.test(clean(process.env.IBM_SHIPPING_SERVICE)) ? 'Current service is Freight; numeric-shipping queue items need the seller-approved domestic service code' : `${clean(process.env.IBM_SHIPPING_SERVICE)}; verify this code is enabled for Seller B and category 40004` },
    { name: 'Payment profile', ready: Boolean(clean(process.env.IBM_PAYMENT_POLICY_ID)), detail: clean(process.env.IBM_PAYMENT_POLICY_ID) ? 'Configured; still must be accepted by eBay for this seller' : 'Set IBM_PAYMENT_POLICY_ID to the seller’s managed-payment profile ID' },
    { name: 'Production category', ready: CATEGORY_ID === '40004', detail: `Category ${CATEGORY_ID}` }
  ];
  if (process.env.MONGO_URI) {
    try {
      await getListingQueueCollection();
      checks[0] = { name: 'MongoDB private queue', ready: true, detail: 'Connected; app-side products are stored in the private listing queue' };
    } catch (error) {
      checks[0] = { name: 'MongoDB private queue', ready: false, detail: error.message || 'Could not access MongoDB queue storage' };
    }
  }
  let activeCount = null;
  if (sellerBAuthToken) {
    try {
      const firstPage = await tradingApi.getSellerList({ type: 'authn-auth', token: sellerBAuthToken }, { pageNumber: 1, entriesPerPage: 1 });
      activeCount = firstPage.totalEntries;
      checks.push({ name: 'Trading API authorization', ready: true, detail: `Auth’n’Auth accepted; ${activeCount} active listings reported` });
    } catch (error) {
      checks.push({ name: 'Trading API authorization', ready: false, detail: error.message || 'Could not verify Auth’n’Auth token' });
    }
  } else {
    checks.push({ name: 'Trading API authorization', ready: false, detail: 'Token is not configured' });
  }
  return { ready: checks.every((check) => check.ready), listingReady: checks.every((check) => check.ready), viewReady: Boolean(sellerBAuthToken), activeCount, checks };
}

async function publishSelected(rows) {
  if (!sellerBAuthToken) throw new Error('SELLER_B_AUTH_TOKEN is missing; direct Auth’n’Auth publishing is unavailable.');
  if (!clean(process.env.IBM_SHIPPING_SERVICE)) throw new Error('Set IBM_SHIPPING_SERVICE to a valid domestic eBay Trading API service code before publishing.');
  if (/^freight$/i.test(clean(process.env.IBM_SHIPPING_SERVICE))) throw new Error('IBM_SHIPPING_SERVICE is set to Freight. Set it to the seller-approved domestic service for numeric-shipping products before publishing.');
  if (!clean(process.env.IBM_PAYMENT_POLICY_ID)) throw new Error('Set IBM_PAYMENT_POLICY_ID to the Semi Equipment seller payment profile ID.');
  if (!Array.isArray(rows) || !rows.length) throw new Error('Select at least one product.');
  if (rows.length > MAX_BATCH_SIZE) throw new Error(`Publish at most ${MAX_BATCH_SIZE} items per request; use small batches to review each result.`);
  const results = [];
  for (const row of rows) {
    const rowNumber = Number(row.rowNumber);
    const sku = `IBM-${clean(row.assetNumber)}`;
    const issues = validate(row);
    if (!issues.length && !row.photoUrls?.length) issues.push('At least one photo is required');
    if (!issues.length) {
      try {
        const duplicate = await findActiveSku(sku);
        if (duplicate) {
          results.push({ rowNumber, sku, status: 'skipped', itemId: duplicate.ItemID, reason: 'An active listing already uses this Asset # SKU.' });
          continue;
        }
        const paymentPolicyId = clean(process.env.IBM_PAYMENT_POLICY_ID);
        const result = await tradingApi.addFixedPriceItem(toTradingItem(row), { paymentPolicyId }, { type: 'authn-auth', token: sellerBAuthToken });
        results.push({ rowNumber, sku, status: 'published', itemId: result.itemId, url: result.itemId ? `https://www.ebay.com/itm/${result.itemId}` : null, warnings: result.warnings || null });
      } catch (error) {
        results.push({ rowNumber, sku, status: 'failed', error: error.message || 'eBay listing failed' });
      }
    } else {
      results.push({ rowNumber, sku, status: 'blocked', issues });
    }
  }
  return { results, published: results.filter((r) => r.status === 'published').length, blocked: results.filter((r) => r.status === 'blocked').length, failed: results.filter((r) => r.status === 'failed').length, skipped: results.filter((r) => r.status === 'skipped').length };
}
module.exports = { getReadiness, publishSelected, MAX_BATCH_SIZE };
