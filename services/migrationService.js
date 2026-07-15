const { sellerA, sellerB } = require('../config/ebayAuth');
const tradingApi = require('./tradingapi');
const { getSellerPolicies } = require('./accountApi');
const checkpoint = require('./checkpoint');

const jobs = new Map();
const activeBatchKeys = new Map();

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getConfiguredSellerBPolicies() {
  const paymentPolicyId = process.env.SELLER_B_PAYMENT_POLICY_ID?.trim();
  const fulfillmentPolicyId = process.env.SELLER_B_FULFILLMENT_POLICY_ID?.trim();
  const returnPolicyId = process.env.SELLER_B_RETURN_POLICY_ID?.trim();

  const values = [paymentPolicyId, fulfillmentPolicyId, returnPolicyId];
  const hasAny = values.some(Boolean);
  const hasAll = values.every(Boolean);

  if (hasAny && !hasAll) {
    throw new Error(
      'Set all three Semi Equipment policy IDs together: ' +
      'SELLER_B_PAYMENT_POLICY_ID, SELLER_B_FULFILLMENT_POLICY_ID, and SELLER_B_RETURN_POLICY_ID.'
    );
  }

  if (!hasAll) {
    return null;
  }

  return {
    paymentPolicyId,
    fulfillmentPolicyId,
    returnPolicyId,
    source: 'env'
  };
}

async function resolveSellerBPolicies(tokenB) {
  const configured = getConfiguredSellerBPolicies();
  if (configured) {
    console.log('[migration] Using Semi Equipment policy IDs from environment variables.');
    return configured;
  }

  console.log('[migration] Semi Equipment policy IDs not set in env; fetching from eBay Account API.');
  try {
    return await getSellerPolicies(tokenB);
  } catch (err) {
    const status = err.response?.status;
    if (status === 403) {
      console.warn(
        '[migration] Semi Equipment policy lookup returned 403; falling back to legacy Trading API fields ' +
        'cloned from the source listing.'
      );
      return null;
    }
    throw err;
  }
}

function normalizeItemIds(itemIds) {
  const seen = new Set();
  const result = [];

  for (const itemId of itemIds || []) {
    const normalized = String(itemId).trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function makeBatchKey(itemIds) {
  return [...itemIds].sort().join('|');
}

function snapshotJob(job) {
  if (!job) return null;
  return {
    ...job,
    itemIds: [...job.itemIds],
    results: job.results.map(result => ({ ...result }))
  };
}

function jobSummary(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    batchKey: job.batchKey,
    itemIds: [...job.itemIds],
    status: job.status,
    total: job.total,
    completed: job.completed,
    succeeded: job.succeeded,
    failed: job.failed,
    skipped: job.skipped,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error
  };
}

function listJobs() {
  return Array.from(jobs.values()).map(jobSummary);
}

function updateJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  return snapshotJob(job);
}

async function runMigrationBatch(itemIds, policiesB, onResult) {
  const results = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const itemId of itemIds) {
    try {
      const value = await migrateOneItem(itemId, policiesB);
      const entry = { itemId, success: true, ...value };
      if (value?.skipped) {
        skipped += 1;
      } else {
        succeeded += 1;
      }
      results.push(entry);
      if (typeof onResult === 'function') {
        onResult(entry, { total: itemIds.length, succeeded, failed, skipped, completed: results.length, results });
      }
    } catch (err) {
      const entry = { itemId, success: false, error: err.message };
      failed += 1;
      results.push(entry);
      if (typeof onResult === 'function') {
        onResult(entry, { total: itemIds.length, succeeded, failed, skipped, completed: results.length, results });
      }
    }

    // Small pacing delay to stay well under Trading API call limits.
    await sleep(300);
  }

  return {
    total: results.length,
    succeeded,
    failed,
    skipped,
    results
  };
}

// Migrate a single item, resuming from checkpoint if partially done.
async function migrateOneItem(itemId, policiesB) {
  const existing = checkpoint.getItemStatus(itemId);

  // Already fully done in a prior run — skip entirely.
  if (existing?.status === 'removed_from_a') {
    return { skipped: true, reason: 'already completed in a previous run', ...existing };
  }

  let newItemIdOnB = existing?.newItemIdOnB || null;

  try {
    const tokenA = await sellerA.getToken();
    const tokenB = await sellerB.getToken();

    // Step 1: create on Seller B, unless a prior run already got this far.
    if (!newItemIdOnB) {
      const sourceItem = await tradingApi.getItem(itemId, tokenA);
      if (!sourceItem) {
        throw new Error(`Item ${itemId} not found on Bridge Tronic Global (already removed or invalid ID)`);
      }

      const listingStatus = sourceItem.SellingStatus?.ListingStatus;
      if (listingStatus && listingStatus !== 'Active') {
        throw new Error(`Item ${itemId} is not Active on Bridge Tronic Global (status: ${listingStatus}) - skipping`);
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
        `New listing ${newItemIdOnB} on Semi Equipment is not confirmed Active yet ` +
        `(status: ${liveCheck?.SellingStatus?.ListingStatus}) - not removing from Bridge Tronic Global. Retry later.`
      );
    }

    // Step 3: remove from Seller A now that Seller B is confirmed live.
    await tradingApi.endItem(itemId, tokenA, 'NotAvailable');
    checkpoint.updateItem(itemId, { status: 'removed_from_a', newItemIdOnB });

    return { newItemIdOnB, removedFromA: true };
  } catch (err) {
    checkpoint.updateItem(itemId, {
      status: 'failed',
      newItemIdOnB,
      error: err.message
    });
    throw err;
  }
}

async function migrateItems(itemIds) {
  const normalized = normalizeItemIds(itemIds);
  const tokenB = await sellerB.getToken();
  const policiesB = await resolveSellerBPolicies(tokenB);

  const results = await runMigrationBatch(normalized, policiesB);

  return {
    total: results.length,
    succeeded: results.filter(r => r.success && !r.skipped).length,
    failed: results.filter(r => !r.success).length,
    skipped: results.filter(r => r.skipped).length,
    results
  };
}

function startMigrationJob(itemIds) {
  const normalized = normalizeItemIds(itemIds);
  if (!normalized.length) {
    throw new Error('Provide itemIds: string[] (eBay Item Numbers) in the request body');
  }

  const batchKey = makeBatchKey(normalized);
  const activeJobId = activeBatchKeys.get(batchKey);
  if (activeJobId) {
    const activeJob = jobs.get(activeJobId);
    if (activeJob && ['queued', 'running'].includes(activeJob.status)) {
      return { duplicate: true, job: snapshotJob(activeJob) };
    }
    activeBatchKeys.delete(batchKey);
  }

  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const job = {
    jobId,
    batchKey,
    itemIds: normalized,
    status: 'queued',
    total: normalized.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    results: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null
  };

  jobs.set(jobId, job);
  activeBatchKeys.set(batchKey, jobId);

  setImmediate(() => {
    void runMigrationJob(jobId);
  });

  return { duplicate: false, job: snapshotJob(job) };
}

async function runMigrationJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }

  updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() });

  try {
    const tokenB = await sellerB.getToken();
    const policiesB = await resolveSellerBPolicies(tokenB);

    await runMigrationBatch(job.itemIds, policiesB, (entry, progress) => {
      updateJob(jobId, {
        completed: progress.completed,
        succeeded: progress.succeeded,
        failed: progress.failed,
        skipped: progress.skipped,
        results: progress.results
      });
    });

    const current = jobs.get(jobId);
    updateJob(jobId, {
      status: current && current.failed > 0 ? 'completed_with_errors' : 'completed',
      finishedAt: new Date().toISOString()
    });
  } catch (err) {
    updateJob(jobId, {
      status: 'failed',
      error: err.message,
      finishedAt: new Date().toISOString()
    });
  } finally {
    const finishedJob = jobs.get(jobId);
    if (finishedJob) {
      activeBatchKeys.delete(finishedJob.batchKey);
    }
  }
}

function getJobStatus(jobId) {
  return snapshotJob(jobs.get(jobId));
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

// ---------- Link report: Old eBay URL -> New eBay URL + title ----------
async function generateLinkReport() {
  const data = checkpoint.loadCheckpoint();
  const tokenB = await sellerB.getToken();

  const rows = [];

  for (const [oldItemId, entry] of Object.entries(data)) {
    if (entry.status !== 'removed_from_a' || !entry.newItemIdOnB) continue;

    const oldLink = `https://www.ebay.com/itm/${oldItemId}`;
    const newLink = `https://www.ebay.com/itm/${entry.newItemIdOnB}`;

    let title = '';
    try {
      const item = await tradingApi.getItem(entry.newItemIdOnB, tokenB);
      title = item?.Title || '';
    } catch {
      title = '';
    }

    rows.push({ oldLink, newLink, title });
    await sleep(150);
  }

  return rows;
}

module.exports = {
  migrateItems,
  listSellerAItems,
  listSellerBItems,
  migrateOneItem,
  startMigrationJob,
  getJobStatus,
  listJobs,
  generateLinkReport
};
