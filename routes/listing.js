const express = require('express');
const router = express.Router();
const controller = require('../controllers/listingController');
const requireApiKey = require('../middleware/requireListingApiKey');
const requireListingPassword = require('../middleware/requireListingAccessPassword');
const parseCsvBody = express.text({ type: ['text/csv', 'application/csv', 'text/plain'], limit: '5mb' });
const parseWorkbookBody = express.raw({ type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'], limit: '10mb' });

router.get('/readiness', requireApiKey, controller.readiness);
// The Mongo-backed queue contains private client inventory; every queue
// operation requires both the app API key and the private listing password.
router.get('/queue', requireApiKey, requireListingPassword, controller.getPrivateQueue);
router.post('/queue/import', requireApiKey, requireListingPassword, parseCsvBody, parseWorkbookBody, controller.importPrivateQueue);
router.put('/queue/:queueKey/photos', requireApiKey, requireListingPassword, controller.savePrivateQueuePhotos);
router.post('/queue/publish', requireApiKey, requireListingPassword, controller.publishPrivateQueueItems);

module.exports = router;
