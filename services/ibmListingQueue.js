const { getListingQueueCollection } = require('./oauthStorage');
const { publishSelected } = require('./ibmAuthnAuthListing');

const clean = (value) => value == null ? '' : String(value).trim();

function queueKey(row, sourceName = 'workbook') {
  if (row.assetNumber) return `IBM-${clean(row.assetNumber)}`;
  const source = clean(sourceName).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'workbook';
  return `ROW-${source}-${Number(row.rowNumber) || 0}`;
}

function dataIssues(row) {
  const issues = [];
  if (!row.assetNumber) issues.push('Asset # is required');
  if (!row.make || !row.model || !row.equipmentType) issues.push('Make, Model, and Equipment_Type are required');
  if (!(Number(row.askingPrice) > 0)) issues.push('Asking Price must be positive');
  if (row.shippingAmount == null || !(Number(row.shippingAmount) >= 0)) issues.push('Shipping Price must be numeric; Freight rows are excluded');
  return issues;
}

function nextStatus(row, photoUrls = []) {
  if (dataIssues(row).length) return 'needs_data';
  return photoUrls.length ? 'ready' : 'awaiting_photos';
}

async function listQueue() {
  const collection = await getListingQueueCollection();
  return collection.find({}).sort({ excelRow: 1, createdAt: 1 }).limit(1000).toArray();
}

async function importRows(rows, sourceName = 'workbook') {
  if (!Array.isArray(rows) || !rows.length) throw new Error('The workbook has no product rows to queue.');
  const numericRows = rows.filter((row) => row.shippingAmount != null && Number(row.shippingAmount) >= 0);
  const freightExcluded = rows.length - numericRows.length;
  const collection = await getListingQueueCollection();
  const now = new Date();
  let added = 0;
  let updated = 0;
  for (const row of numericRows) {
    const key = queueKey(row, sourceName);
    const previous = await collection.findOne({ queueKey: key });
    if (previous?.status === 'published' || previous?.status === 'publishing') continue;
    const photoUrls = previous?.photoUrls || row.photoUrls || [];
    const status = nextStatus(row, photoUrls);
    await collection.updateOne(
      { queueKey: key, status: { $nin: ['published', 'publishing'] } },
      {
        $set: {
          queueKey: key,
          seller: 'B',
          sourceName: clean(sourceName),
          excelRow: Number(row.rowNumber) || null,
          product: row,
          photoUrls,
          status,
          issues: dataIssues(row),
          updatedAt: now
        },
        $setOnInsert: { createdAt: now }
      },
      { upsert: !previous }
    );
    if (previous) updated += 1;
    else added += 1;
  }
  return { imported: numericRows.length, added, updated, freightExcluded, totalRows: rows.length, queue: await listQueue() };
}

function parsePhotoUrls(input) {
  const urls = (Array.isArray(input) ? input : String(input || '').split(/[\n;]+/))
    .map((value) => clean(value)).filter(Boolean);
  if (!urls.length) throw new Error('Enter at least one HTTPS photo URL.');
  if (urls.length > 12) throw new Error('Use no more than 12 photos per product.');
  for (const value of urls) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error('One or more photo URLs are invalid.'); }
    if (parsed.protocol !== 'https:') throw new Error('Photo URLs must use HTTPS.');
  }
  return [...new Set(urls)];
}

async function savePhotos(key, input) {
  const photoUrls = parsePhotoUrls(input);
  const collection = await getListingQueueCollection();
  const existing = await collection.findOne({ queueKey: key });
  if (!existing) throw new Error('Product was not found in the private queue.');
  if (['published', 'publishing'].includes(existing.status)) throw new Error('Photos cannot be changed while a listing is published or publishing.');
  const status = nextStatus(existing.product, photoUrls);
  await collection.updateOne(
    { queueKey: key, status: { $nin: ['published', 'publishing'] } },
    { $set: { photoUrls, status, issues: dataIssues(existing.product), updatedAt: new Date() } }
  );
  return collection.findOne({ queueKey: key });
}

async function publishQueued(keys) {
  if (!Array.isArray(keys) || !keys.length) throw new Error('Select a queued product to publish.');
  if (keys.length > 1) throw new Error('Publish one product at a time and check its eBay result.');
  const collection = await getListingQueueCollection();
  const key = clean(keys[0]);
  const row = await collection.findOne({ queueKey: key });
  if (!row) throw new Error('Selected product was not found in the private queue.');
  if (row.status !== 'ready') throw new Error('Product must have valid listing data and at least one saved photo before publishing.');
  const service = clean(process.env.IBM_SHIPPING_SERVICE);
  if (/^freight$/i.test(service)) throw new Error('IBM_SHIPPING_SERVICE is set to Freight. Set it to the seller-approved domestic service for these numeric-shipping products before publishing.');

  const claimed = await collection.findOneAndUpdate(
    { queueKey: key, status: 'ready' },
    { $set: { status: 'publishing', updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  const claimedRow = claimed?.value || claimed;
  if (!claimedRow || claimedRow.status !== 'publishing') throw new Error('This product is already being published or its queue status changed. Refresh the queue.');
  try {
    const product = { ...claimedRow.product, photoUrls: claimedRow.photoUrls };
    const outcome = await publishSelected([product]);
    const result = outcome.results?.[0] || { status: 'failed', error: 'eBay returned no result.' };
    const status = result.status === 'published' ? 'published' : result.status === 'skipped' ? 'skipped' : result.status === 'blocked' ? 'ready' : 'failed';
    await collection.updateOne({ queueKey: key }, { $set: {
      status,
      publishResult: result,
      itemId: result.itemId || null,
      itemUrl: result.url || null,
      updatedAt: new Date(),
      publishedAt: result.status === 'published' ? new Date() : null
    } });
    return { result, queueItem: await collection.findOne({ queueKey: key }) };
  } catch (error) {
    await collection.updateOne({ queueKey: key }, { $set: { status: 'failed', publishError: error.message, updatedAt: new Date() } });
    throw error;
  }
}

module.exports = { listQueue, importRows, savePhotos, publishQueued };
