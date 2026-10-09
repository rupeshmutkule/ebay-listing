const draftListings = require('../services/ibmDraftListings');
const authnAuthListings = require('../services/ibmAuthnAuthListing');

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
    let selectedRows;
    if (contentType.includes('application/json')) {
      selectedRows = req.body?.rows;
      if (!Array.isArray(selectedRows) || !selectedRows.length) return res.status(400).json({ error: 'Select at least one product.' });
    } else {
      const rows = contentType.includes('text/csv') || contentType.includes('text/plain')
        ? draftListings.parseCsv(req.body)
        : draftListings.parseWorkbookBuffer(req.body);
      const requested = String(req.query.rowNumbers || '').split(',').map(Number).filter(Number.isInteger);
      const selected = new Set(requested);
      if (!selected.size) return res.status(400).json({ error: 'Select at least one product row.' });
      selectedRows = rows.filter((row) => selected.has(row.rowNumber));
      if (selectedRows.length !== selected.size) return res.status(400).json({ error: 'Some selected product rows were not found in the uploaded workbook.' });
    }
    const results = [];
    for (const row of selectedRows) {
      const result = await authnAuthListings.publishSelected([row]);
      results.push(...result.results);
    }
    res.json({
      success: true,
      results,
      published: results.filter((result) => result.status === 'published').length,
      blocked: results.filter((result) => result.status === 'blocked').length,
      failed: results.filter((result) => result.status === 'failed').length,
      skipped: results.filter((result) => result.status === 'skipped').length
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not publish selected listings.' });
  }
};
