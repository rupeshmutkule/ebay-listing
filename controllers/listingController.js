const draftListings = require('../services/ibmDraftListings');
const authnAuthListings = require('../services/ibmAuthnAuthListing');
const listingQueue = require('../services/ibmListingQueue');

exports.readiness = async (req, res) => {
  try {
    res.json({ success: true, readiness: await authnAuthListings.getReadiness() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.preview = async (req, res) => {
  try {
    res.json({ success: true, preview: await draftListings.previewDrafts() });
  } catch (error) {
    res.status(400).json({ error: error.response?.data || error.message });
  }
};

exports.previewCsv = async (req, res) => {
  try {
    const rows = draftListings.parseCsv(req.body);
    res.json({ success: true, preview: draftListings.previewRowsLocally(rows) });
  } catch (error) {
    res.status(400).json({ error: error.response?.data || error.message });
  }
};

exports.previewWorkbook = async (req, res) => {
  try {
    const rows = draftListings.parseWorkbookBuffer(req.body);
    res.json({ success: true, preview: draftListings.previewRowsLocally(rows) });
  } catch (error) {
    res.status(400).json({ error: error.response?.data || error.message });
  }
};

exports.createDrafts = async (req, res) => {
  try {
    const result = await draftListings.startDraftJob();
    res.status(result.duplicate ? 200 : 202).json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.createDraftsFromCsv = async (req, res) => {
  try {
    const rows = draftListings.parseCsv(req.body);
    const result = await draftListings.startDraftJob(rows);
    res.status(result.duplicate ? 200 : 202).json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.createDraftsFromWorkbook = async (req, res) => {
  try {
    const rows = draftListings.parseWorkbookBuffer(req.body);
    const result = await draftListings.startDraftJob(rows);
    res.status(result.duplicate ? 200 : 202).json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.response?.data || error.message });
  }
};

exports.createSelectedDrafts = async (req, res) => {
  try {
    const contentType = req.get('content-type') || '';
    const rows = contentType.includes('text/csv') || contentType.includes('text/plain')
      ? draftListings.parseCsv(req.body)
      : draftListings.parseWorkbookBuffer(req.body);
    const requested = String(req.query.rowNumbers || '')
      .split(',').map((value) => Number(value)).filter((value) => Number.isInteger(value));
    const selected = new Set(requested);
    if (!selected.size) return res.status(400).json({ error: 'Select at least one product row.' });
    const selectedRows = rows.filter((row) => selected.has(row.rowNumber));
    if (selectedRows.length !== selected.size) {
      return res.status(400).json({ error: 'Some selected product rows were not found in the uploaded file.' });
    }
    const result = await draftListings.startDraftJob(selectedRows);
    res.status(result.duplicate ? 200 : 202).json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.response?.data || error.message });
  }
};

exports.getJob = (req, res) => {
  const job = draftListings.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Draft job not found' });
  res.json({ success: true, job });
};


exports.publishSelectedAuthnAuth = async (req, res) => {
  try {
    const contentType = req.get('content-type') || '';
    const rows = contentType.includes('text/csv') || contentType.includes('text/plain')
      ? draftListings.parseCsv(req.body)
      : draftListings.parseWorkbookBuffer(req.body);
    const requested = String(req.query.rowNumbers || '').split(',').map(Number).filter(Number.isInteger);
    const selected = new Set(requested);
    if (!selected.size) return res.status(400).json({ error: 'Select at least one product row.' });
    const selectedRows = rows.filter((row) => selected.has(row.rowNumber));
    if (selectedRows.length !== selected.size) return res.status(400).json({ error: 'Some selected product rows were not found in the uploaded workbook.' });
    res.json({ success: true, ...await authnAuthListings.publishSelected(selectedRows) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not publish selected listings.' });
  }
};

exports.getPrivateQueue = async (req, res) => {
  try {
    res.json({ success: true, queue: await listingQueue.listQueue() });
  } catch (error) {
    res.status(503).json({ error: error.message || 'Could not load the private product queue.' });
  }
};

exports.importPrivateQueue = async (req, res) => {
  try {
    const contentType = req.get('content-type') || '';
    const rows = contentType.includes('text/csv') || contentType.includes('text/plain')
      ? draftListings.parseCsv(req.body)
      : draftListings.parseWorkbookBuffer(req.body);
    const sourceName = req.get('x-source-name') || 'product workbook';
    res.json({ success: true, ...await listingQueue.importRows(rows, sourceName) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not import products into the private queue.' });
  }
};

exports.savePrivateQueuePhotos = async (req, res) => {
  try {
    const item = await listingQueue.savePhotos(req.params.queueKey, req.body.photoUrls);
    res.json({ success: true, item });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not save product photos.' });
  }
};

exports.publishPrivateQueueItems = async (req, res) => {
  try {
    const result = await listingQueue.publishQueued(req.body.queueKeys);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not publish the queued product.' });
  }
};
