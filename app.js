require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Redirect root to the app
app.get('/', (req, res) => res.redirect('/ebay-store-migration'));

// Mount all routes under /ebay-store-migration
app.use('/ebay-store-migration', require('./routes/migration'));

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Migration tool running at http://localhost:${PORT}/ebay-store-migration`));