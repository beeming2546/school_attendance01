const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const pool = require('./db/pool');      // นำเข้า pool.js
const indexRoutes = require('./routes/index'); 

const app = express();

// ตั้งค่า session
app.use(session({
  secret: 'my_secret_key',
  resave: false,
  saveUninitialized: false
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json()); // ✅ เพิ่มเพื่อรองรับ JSON จาก fetch
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

// Middleware ให้ user และ showNavbar ใช้งานได้ทุกหน้า
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;   // user ที่ล็อกอินอยู่
  res.locals.showNavbar = true;
  next();
});

// นำเข้า routes อื่น ๆ (ถ้ามี)
app.use('/', indexRoutes);

// Root route - redirect ไปที่หน้า login
app.get('/', (req, res) => {
  res.redirect('/login');
});

// เริ่มเซิร์ฟเวอร์
app.listen(3000, () => {
  console.log('Server is running on port 3000');
});
