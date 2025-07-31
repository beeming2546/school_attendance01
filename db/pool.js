const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');  // บังคับใช้ IPv4 ก่อน

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // สำคัญสำหรับ Render + Supabase
});

module.exports = pool;