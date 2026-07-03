const express = require('express');
const router = express.Router();
const migrationController = require('../controllers/migrationController');

router.get('/create-test-product', migrationController.createTestProduct);
router.get('/fetch-and-backup', migrationController.fetchAndBackupProduct);
router.get('/migrate-to-seller-b', migrationController.migrateToSellerB);

module.exports = router;