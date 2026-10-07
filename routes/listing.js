const express = require('express');
const router = express.Router();
const controller = require('../controllers/listingController');
const requireApiKey = require('../middleware/requireListingApiKey');
const parseCsvBody = express.text({ type: ['text/csv', 'application/csv', 'text/plain'], limit: '5mb' });
const parseWorkbookBody = express.raw({ type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'], limit: '10mb' });

router.get('/readiness', requireApiKey, controller.readiness);
router.get('/preview', requireApiKey, controller.preview);
router.post('/drafts', requireApiKey, controller.createDrafts);
router.post('/preview-csv', requireApiKey, parseCsvBody, controller.previewCsv);
router.post('/drafts-csv', requireApiKey, parseCsvBody, controller.createDraftsFromCsv);
router.post('/preview-workbook', requireApiKey, parseWorkbookBody, controller.previewWorkbook);
router.post('/drafts-workbook', requireApiKey, parseWorkbookBody, controller.createDraftsFromWorkbook);
router.post('/drafts-selected', requireApiKey, parseCsvBody, parseWorkbookBody, controller.createSelectedDrafts);
router.get('/drafts/:jobId', requireApiKey, controller.getJob);

module.exports = router;
