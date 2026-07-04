const { sellerA, sellerB } = require('../config/ebayAuth');
const tradingApi = require('./tradingapi');
const { getSellerPolicies } = require('./accountApi');
const checkpoint = require('./checkpoint');

const CONCURRENCY = 3; // eBay Trading API rate limits are per-app; keep conservative

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- Simple concurrency-limited batch runner ----------
async function runBatch(items, worker, concurrency = CONCURRENCY) {
  const results = [];
  let index = 0;

  async function next() {
    while (index < items.length) {
      const current = items[index++];
      try {
        const value = await worker(current);
        results.push({ itemId: current, success: true, ...value });
      } catch (err) {
        results.push({ itemId: current, success: false, error: err.message });
      }
      // Small pacing delay to stay well under Trading API call limits
      await sleep(300);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, next);
  await Promise.all(workers);
  return results;
}

// ---------- Migrate a single item, resuming from checkpoint if partially done ----------
async function migrateOneItem(itemId, policiesB) {
  const existing = checkpoint.getItemStatus(itemId);

  // Already fully done in a prior run — skip entirely.
  if (existing?.status === 'removed_from_a') {
    return { skipped: true, reason: 'already completed in a previous run', ...existing };
  }

  const tokenA = await sellerA.getToken();
  const tokenB = await sellerB.getToken();

  let newItemIdOnB = existing?.newItemIdOnB || null;

  // Step 1: create on Seller B, unless a prior run already got this far.
  if (!newItemIdOnB) {
    const sourceItem = await tradingApi.getItem(itemId, tokenA);
    if (!sourceItem) {
      throw new Error(`Item ${itemId} not found on Seller A (already removed or invalid ID)`);
    }

    const listingStatus = sourceItem.SellingStatus?.ListingStatus;
    if (listingStatus && listingStatus !== 'Active') {
      throw new Error(`Item ${itemId} is not Active on Seller A (status: ${listingStatus}) — skipping`);
    }

    const created = await tradingApi.addFixedPriceItem(sourceItem, policiesB, tokenB);
    newItemIdOnB = created.itemId;
    checkpoint.updateItem(itemId, { status: 'listed_on_b', newItemIdOnB });
  }

  // Step 2: verify it's actually live on Seller B before touching Seller A.
  const liveCheck = await tradingApi.getItem(newItemIdOnB, tokenB);
  const isActive = liveCheck?.SellingStatus?.ListingStatus === 'Active';
  if (!isActive) {
    throw new Error(
      `New listing ${newItemIdOnB} on Seller B is not confirmed Active yet ` +
      `(status: ${liveCheck?.SellingStatus?.ListingStatus}) — not removing from Seller A. Retry later.`
    );
  }

  // Step 3: remove from Seller A now that Seller B is confirmed live.
  await tradingApi.endItem(itemId, tokenA, 'NotAvailable');
  checkpoint.updateItem(itemId, { status: 'removed_from_a', newItemIdOnB });

  return { newItemIdOnB, removedFromA: true };
}

async function migrateItems(itemIds) {
  const tokenB = await sellerB.getToken();
  const policiesB = await getSellerPolicies(tokenB);

  const results = await runBatch(itemIds, id => migrateOneItem(id, policiesB));

  return {
    total: results.length,
    succeeded: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results
  };
}

// ---------- Fetch active listings from Seller A (all pages) ----------
async function listSellerAItems() {
  const tokenA = await sellerA.getToken();
  const first = await tradingApi.getSellerList(tokenA, { pageNumber: 1 });
  let allItems = first.items;

  for (let page = 2; page <= first.totalPages; page++) {
    const next = await tradingApi.getSellerList(tokenA, { pageNumber: page });
    allItems = allItems.concat(next.items);
  }

  return allItems.map(item => ({
    itemId: item.ItemID,
    title: item.Title,
    sku: item.SKU || null,
    price: item.SellingStatus?.CurrentPrice?.['#text'] ?? item.SellingStatus?.CurrentPrice,
    quantity: item.Quantity,
    image: item.PictureDetails?.GalleryURL || null,
    status: item.SellingStatus?.ListingStatus
  }));
}

async function listSellerBItems() {
  const tokenB = await sellerB.getToken();
  const first = await tradingApi.getSellerList(tokenB, { pageNumber: 1 });
  let allItems = first.items;

  for (let page = 2; page <= first.totalPages; page++) {
    const next = await tradingApi.getSellerList(tokenB, { pageNumber: page });
    allItems = allItems.concat(next.items);
  }

  return allItems.map(item => ({
    itemId: item.ItemID,
    title: item.Title,
    sku: item.SKU || null,
    price: item.SellingStatus?.CurrentPrice?.['#text'] ?? item.SellingStatus?.CurrentPrice,
    quantity: item.Quantity,
    image: item.PictureDetails?.GalleryURL || null,
    status: item.SellingStatus?.ListingStatus
  }));
}

module.exports = { migrateItems, listSellerAItems, listSellerBItems, migrateOneItem };