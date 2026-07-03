const express = require('express');
const router = express.Router();
const migrationController = require('../controllers/migrationController');

// Page
router.get('/migration-tool', (req, res) => {
  res.render('index', { title: 'eBay Migration Tool — Seller A → Seller B' });
});

// Button 1: Fetch products from Seller A
router.get('/api/seller-a/products', migrationController.listSellerAProducts);

// Button 2: Migrate selected SKUs to Seller B (removes from A)
router.post('/api/migrate', migrationController.migrateProducts);

// Button 3: View products live on Seller B
router.get('/api/seller-b/products', migrationController.listSellerBProducts);

// Cleanup helper (optional, keep for fixing stuck test listings)
router.post('/api/seller-b/delete', migrationController.deleteFromSellerB);

module.exports = router;