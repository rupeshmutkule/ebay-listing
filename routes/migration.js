const express = require('express');
const router = express.Router();
const migrationController = require('../controllers/migrationController');

router.get('/migration-tool', (req, res) => {
  res.render('index', { title: 'eBay Migration Tool — Seller A → Seller B (Production)' });
});

router.get('/api/seller-a/products', migrationController.listSellerAProducts);
router.post('/api/migrate', migrationController.migrateProducts);
router.get('/api/seller-b/products', migrationController.listSellerBProducts);
router.get('/api/migration-status', migrationController.getMigrationStatus);

module.exports = router;