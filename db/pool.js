const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // บังคับ IPv4 ก่อน (คงไว้ได้)

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // ดึงมาจากไฟล์ env
  ssl: { rejectUnauthorized: false }, // สำหรับ Render/Supabase
});

// ✅ ตั้ง Time Zone ไทยให้ทุก connection ที่เชื่อมเข้ามา
pool.on('connect', (client) => {
  client.query(`SET TIME ZONE 'Asia/Bangkok'`).catch((e) => {
    console.error('Failed to set timezone:', e);
  });
});

module.exports = pool;