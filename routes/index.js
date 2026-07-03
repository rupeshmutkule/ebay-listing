const express = require('express');
const router = express.Router();
const migrationController = require('../controllers/migrationController');

// Page: renders the button UI
router.get('/migration-tool', (req, res) => {
  res.render('index', { title: 'eBay Migration Tool — Seller A → Seller B' });
});

// Button 1: list every product currently live on Seller A
router.get('/api/seller-a/products', migrationController.listSellerAProducts);

// Button 2: back selected SKUs up into MySQL
router.post('/api/move-to-database', migrationController.moveToDatabase);

// Button 3: push selected SKUs to Seller B, then remove them from Seller A
router.post('/api/migrate-to-seller-b', migrationController.migrateToSellerB);

// Button 4: see the current status of every product that has passed through the tool
router.get('/api/migration-status', migrationController.getMigrationStatus);

// Debug/cleanup: see what's live on Seller B, and remove a stale/duplicate SKU from it
router.get('/api/seller-b/products', migrationController.listSellerBProducts);
router.post('/api/seller-b/delete', migrationController.deleteFromSellerB);

module.exports = router;