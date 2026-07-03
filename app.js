const express = require('express');
const path = require('path');
require('dotenv').config();

const indexRouter = require('./routes/index');
const logger = require('./middleware/logger');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(logger);

app.use('/', indexRouter);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`http://localhost:${port}`));

module.exports = app;