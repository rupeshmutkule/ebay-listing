const draftListings = require('../services/ibmDraftListings');
const authnAuthListings = require('../services/ibmAuthnAuthListing');
const XLSX = require('xlsx');

function withAlreadyListedSummary(preview, alreadyListedCount) {
  return {
    ...preview,
    alreadyListed: alreadyListedCount,
    eligible: Math.max(0, preview.eligible - alreadyListedCount),
    skipped: preview.skipped + alreadyListedCount
  };
}

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
    const listingCheck = await authnAuthListings.markAlreadyListed(rows);
    const preview = draftListings.previewRowsLocally(listingCheck.rows);
    res.json({ success: true, preview: withAlreadyListedSummary(preview, listingCheck.alreadyListed.length) });
  } catch (error) {
    res.status(400).json({ error: error.response?.data || error.message });
  }
};

exports.previewWorkbook = async (req, res) => {
  try {
    const rows = draftListings.parseWorkbookBuffer(req.body);
    const listingCheck = await authnAuthListings.markAlreadyListed(rows);
    const preview = draftListings.previewRowsLocally(listingCheck.rows);
    res.json({ success: true, preview: withAlreadyListedSummary(preview, listingCheck.alreadyListed.length) });
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

exports.downloadListedReport = (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'No listed products are available for the report.' });

    const reportRows = rows.map((row, index) => ({
      'Sr. No.': index + 1,
      'Product Name': String(row.productName || '').trim(),
      'Listed URL': String(row.listedUrl || '').trim()
    })).filter(row => row['Product Name'] || row['Listed URL']);

    if (!reportRows.length) return res.status(400).json({ error: 'No product names or listed URLs are available for the report.' });

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(reportRows);
    worksheet['!cols'] = [{ wch: 10 }, { wch: 70 }, { wch: 55 }];
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Listed Products');

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="listed-products-report-${stamp}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not create the listed products report.' });
  }
};
