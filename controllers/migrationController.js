const migrationService = require('../services/migrationService');
const checkpoint = require('../services/checkpoint');

exports.listSellerAProducts = async (req, res) => {
  try {
    const items = await migrationService.listSellerAItems();
    res.json({ success: true, count: items.length, products: items });
  } catch (err) {
    res.status(500).json({ error: err.response ? err.response.data : err.message });
  }
};

exports.listSellerBProducts = async (req, res) => {
  try {
    const items = await migrationService.listSellerBItems();
    res.json({ success: true, count: items.length, products: items });
  } catch (err) {
    res.status(500).json({ error: err.response ? err.response.data : err.message });
  }
};

exports.migrateProducts = async (req, res) => {
  const itemIds = req.body.itemIds;
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ error: 'Provide itemIds: string[] (eBay Item Numbers) in the request body' });
  }
  try {
    const result = migrationService.startMigrationJob(itemIds);
    res.status(result.duplicate ? 200 : 202).json({
      success: true,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: err.response ? err.response.data : err.message });
  }
};

exports.getJobStatus = async (req, res) => {
  try {
    const job = migrationService.getJobStatus(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: err.response ? err.response.data : err.message });
  }
};

// Lets you check progress on a long-running 800-item migration without a DB —
// reads straight from the checkpoint file.
exports.getMigrationStatus = async (req, res) => {
  try {
    const data = checkpoint.loadCheckpoint();
    res.json({ success: true, checkpoint: data, jobs: migrationService.listJobs() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
