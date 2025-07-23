const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();           // ✅ โหลดค่า .env ก่อนใช้ pool
const pool = require('./db/pool');    // ต้องใช้ process.env แล้ว
const indexRoutes = require('./routes/index'); 

const app = express();

// ตั้งค่า session
app.use(session({
  secret: 'my_secret_key',
  resave: false,
  saveUninitialized: false
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

// Middleware ให้ user และ showNavbar ใช้งานได้ทุกหน้า
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.showNavbar = true;
  next();
});

// Routes
app.use('/', indexRoutes);

app.get('/', (req, res) => {
  res.redirect('/login');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server is running on port 3000');
});
