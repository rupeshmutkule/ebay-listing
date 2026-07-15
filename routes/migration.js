const express = require('express');
const router = express.Router();
const migrationController = require('../controllers/migrationController');
const requireApiKey = require('../middleware/requireApiKey');

router.get('/', (req, res) => {
  res.render('index', {
    title: 'eBay Migration Tool - Bridge Tronic Global -> Semi Equipment',
    apiKey: process.env.MIGRATION_TOOL_API_KEY || process.env.API_KEY || process.env.SHARED_SECRET || ''
  });
});

router.get('/api/seller-a/products', requireApiKey, migrationController.listSellerAProducts);
router.post('/api/migrate', requireApiKey, migrationController.migrateProducts);
router.get('/api/migrate/jobs/:jobId', requireApiKey, migrationController.getJobStatus);
router.get('/api/seller-b/products', requireApiKey, migrationController.listSellerBProducts);
router.get('/api/migration-status', requireApiKey, migrationController.getMigrationStatus);
router.get('/api/migration-report/csv', requireApiKey, migrationController.downloadMigrationReport);

module.exports = router;
