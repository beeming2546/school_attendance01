const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireRole, requireAnyRole, requireMasterAdmin } = require('../middlewares/auth');
const qr = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const xlsx = require('xlsx');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// ===== Auto clean attendancetoken every 30s =====
const TOKEN_TTL_SECONDS = 10;      // ให้ตรงกับ TTL ใน /qr/:id/token
const CLEAN_INTERVAL_MS  = 900_000; // 1 ชั่วโมง 3_600_000 | 30 นาที 1_800_000 | 15 นาที 900_000

setInterval(() => {
  pool.query(
    `DELETE FROM attendancetoken
      WHERE is_ used = TRUE
         OR created_at < NOW() - ($1 || ' seconds')::interval`,
    [TOKEN_TTL_SECONDS]
  ).catch(e => console.error('token cleanup error:', e));
}, CLEAN_INTERVAL_MS);

// ===== Helpers =====

// รวมค่าชั่วโมง/นาทีจาก body ให้เป็น 'HH:MM'
// ใช้กับคู่ฟิลด์: start_hour/start_minute และ end_hour/end_minute
function resolveTimeFromBody(body, prefix) {
  // prefix = 'start' หรือ 'end'
  // รองรับกรณีมี field เดียวเช่น start_time = '09:30' (ถ้าเผื่อใช้ input type="time")
  if (body[`${prefix}_time`]) {
    const s = String(body[`${prefix}_time`]).slice(0,5);
    return /^\d{2}:\d{2}$/.test(s) ? s : null;
  }

  const hh = String(body[`${prefix}_hour`]   ?? '').padStart(2, '0');
  const mm = String(body[`${prefix}_minute`] ?? '').padStart(2, '0');

  if (!/^\d{2}$/.test(hh) || !/^\d{2}$/.test(mm)) return null;

  const h = Number(hh), m = Number(mm);
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;

  return `${hh}:${mm}`;  // ตัวอย่าง: '09:30'
}

function computeTermDates(academicYearBE, semesterNo) {
  const yearAD = Number(academicYearBE) - 543;
  const s = Number(semesterNo);
// ภาค 1 : 1 มิ.ย. ปีนั้น  – 31 ต.ค. ปีนั้น        
// ภาค 2 : 1 พ.ย. ปีนั้น  – 31 มี.ค. ปีถัดไป      
// ภาค 3 : 1 เม.ย. ปีถัดไป – 31 พ.ค. ปีถัดไป     
  let start_date, end_date;
  if (s === 1) {
    start_date = `${yearAD}-06-01`;
    end_date   = `${yearAD}-10-31`;
  } else if (s === 2) {
    start_date = `${yearAD}-11-01`;
    end_date   = `${yearAD + 1}-03-31`;
  } else if (s === 3) {
    start_date = `${yearAD + 1}-04-01`;
    end_date   = `${yearAD + 1}-05-31`;
  } else {
    throw new Error('Invalid semester number');
  }
  return { start_date, end_date };
}

// หา (หรือสร้าง) term_id จาก ปีการศึกษา (พ.ศ.) และภาค พร้อมกรอก start/end date
async function getOrCreateTermId(academicYearBE, semesterNo) {
  const y = Number(academicYearBE);
  const s = Number(semesterNo);

  // 1) ลองหา term เดิม
  const sel = await pool.query(
    `SELECT term_id, start_date, end_date
       FROM term
      WHERE academic_year = $1 AND semester_no = $2`,
    [y, s]
  );
  if (sel.rows.length) {
    const row = sel.rows[0];
    // กันกรณีข้อมูลเก่ามี NULL ให้เติมให้ครบ
    if (!row.start_date || !row.end_date) {
      const { start_date, end_date } = computeTermDates(y, s);
      await pool.query(
        `UPDATE term SET start_date = $1, end_date = $2 WHERE term_id = $3`,
        [start_date, end_date, row.term_id]
      );
    }
    return row.term_id;
  }

  // 2) ไม่เจอ -> คำนวณช่วงเวลาแล้วสร้างใหม่
  const { start_date, end_date } = computeTermDates(y, s);
  const ins = await pool.query(
    `INSERT INTO term (academic_year, semester_no, start_date, end_date)
     VALUES ($1, $2, $3, $4)
     RETURNING term_id`,
    [y, s, start_date, end_date]
  );
  return ins.rows[0].term_id;
}


// ===== CSV Templates =====
router.get('/templates/csv/:kind', requireAnyRole (['admin' , 'teacher']), (req, res) => {
  const { kind } = req.params;

  const map = {
    admin: {
      header: 'adminid,name,username,password,is_master\n',
      filename: 'admin_template.csv'
    },
    teacher: {
      header: 'teacherid,firstname,surname,username,password,email\n',
      filename: 'teacher_template.csv'
    },
    student: {
      header: 'studentid,firstname,surname,username,password,email\n',
      filename: 'student_template.csv'
    },
    // สำหรับหน้าเพิ่มนักเรียนเข้าชั้นเรียน (คอลัมน์แรก)
    'classroom-students': {
      header: 'studentid\n',
      filename: 'classroom_students_template.csv'
    }
  };

  const item = map[kind];
  if (!item) return res.status(404).send('Template not found');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${item.filename}"`);
  return res.send(item.header);
});
//------------------------------------------------------------------
//--------------------------LOGIN----------------------------------
//------------------------------------------------------------------
router.get('/login', (req, res) => {
  const error = req.session.error || null;
  req.session.error = null;
  res.render('login', { error });
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const adminResult = await pool.query(
      'SELECT * FROM Admin WHERE Username = $1 AND Password = $2',
      [username, password]
    );
    if (adminResult.rows.length > 0) {
      const admin = adminResult.rows[0];

      req.session.user = {
      adminid: admin.adminid,
      username: admin.username,
      name: admin.name,                     // ✅ เพิ่มบรรทัดนี้
      is_master: admin.is_master === true
    };
      req.session.role = 'admin';
      return res.redirect('/admin');
}

    const teacherResult = await pool.query(
      'SELECT * FROM Teacher WHERE Username = $1 AND Password = $2',
      [username, password]
    );
    if (teacherResult.rows.length > 0) {
      req.session.user = teacherResult.rows[0];
      req.session.role = 'teacher';
      return res.redirect('/classroom');
    }

    const studentResult = await pool.query(
      'SELECT * FROM Student WHERE Username = $1 AND Password = $2',
      [username, password]
    );
    if (studentResult.rows.length > 0) {
      req.session.user = studentResult.rows[0];
      req.session.role = 'student';
      return res.redirect('/classroom');
    }

    req.session.error = 'ไม่พบผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
    return res.redirect('/login');
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในระบบ';
    return res.redirect('/login');
  }
});

//------------------------------------------------------------------
//--------------------------SHOW USERLIST--------------------------
//------------------------------------------------------------------
router.get('/admin', requireRole('admin'), (req, res) => {
  res.render('admin', {
    user: req.session.user,          // user ที่ login
    currentUser: req.session.user,   // ส่ง currentUser ด้วย
    currentRole: req.session.role,   // ส่ง currentRole ด้วย
    showNavbar: true
  });
});


// รายชื่อผู้ดูแลระบบ
router.get('/admin/list/admin', requireRole('admin'), async (req, res) => {
  if (!req.session.user.is_master) {
    return res.redirect('/admin');
  }

  try {
    const result = await pool.query('SELECT * FROM Admin ORDER BY AdminId ASC');
    res.render('userlist', {
      title: 'รายชื่อผู้ดูแลระบบ',
      users: result.rows,
      role: 'admin',
      currentUser: req.session.user,
      currentRole: req.session.role,
      showNavbar: true
    });
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการดึงข้อมูลแอดมิน';
    res.redirect('/admin');
  }
});


// รายชื่ออาจารย์
router.get('/admin/list/teacher', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM Teacher ORDER BY TeacherId ASC');
    res.render('userlist', {
      title: 'รายชื่ออาจารย์',
      users: result.rows,
      role: 'teacher',
      currentUser: req.session.user,
      currentRole: req.session.role,
      showNavbar: true
    });
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการดึงข้อมูลอาจารย์';
    res.redirect('/admin');
  }
});

//  รายชื่อนักศีกษา
router.get('/admin/list/student', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM Student ORDER BY StudentId ASC');
    res.render('userlist', {
      title: 'รายชื่อนักศีกษา',
      users: result.rows,
      role: 'student',
      currentUser: req.session.user,
      currentRole: req.session.role,
      showNavbar: true
    });
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการดึงข้อมูลนักศีกษา';
    res.redirect('/admin');
  }
});

//------------------------------------------------------------------
//--------------------------FORM ADD/EDIT USER----------------------
//------------------------------------------------------------------
router.get('/admin/add/:role', requireRole('admin'), (req, res) => {
  const { role } = req.params;

  // ถ้าจะเพิ่ม admin แต่ไม่ใช่ master admin
  if (role === 'admin' && !req.session.user.is_master) {
    return res.redirect('/admin');
  }

  if (!['admin', 'teacher', 'student'].includes(role)) return res.redirect('/admin');

  const error = req.session.error || null;
  req.session.error = null;

  res.render('add_user', {
    role,
    error,
    currentUser: req.session.user,
    currentRole: req.session.role,
    showNavbar: true
  });
});

// เพิ่มผู้ใช้ (รองรับ bulk สำหรับ admin)
// เพิ่มผู้ใช้ (รองรับ bulk สำหรับ admin/teacher/student)
router.post('/admin/add/:role', requireRole('admin'), upload.single('file'), async (req, res) => {
  const { role } = req.params;

  // ---------- กิ่งพิเศษ: BULK สำหรับ ADMIN ----------
  if (role === 'admin' && (req.body.mode === 'text' || req.body.mode === 'file')) {
    if (!req.session.user.is_master) {
      req.session.error = 'คุณไม่มีสิทธิ์เพิ่มผู้ดูแลระบบ (ต้องเป็น Master Admin)';
      return res.redirect('/admin');
    }
    try {
      let rows = [];
      if (req.body.mode === 'text') {
        const raw = (req.body.bulk_text || '').trim();
        if (!raw) { req.session.error = 'กรุณากรอกข้อมูลในโหมดพิมพ์รายการ'; return res.redirect(`/admin/add/${role}`); }
        raw.split(/\r?\n/).forEach(line => {
          const parts = line.split(',').map(s => s.trim());
          if (parts.length >= 4) {
            const [adminid, name, username, password, is_master] = parts;
            rows.push({ adminid, name, username, password, is_master });
          }
        });
      } else if (req.body.mode === 'file') {
        if (!req.file) { req.session.error = 'กรุณาเลือกไฟล์ CSV'; return res.redirect(`/admin/add/${role}`); }
        const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sh = wb.Sheets[wb.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(sh, { header: 1, defval: '' });
        const startRow = (String((data[0]||[])[0]).toLowerCase().includes('adminid')) ? 1 : 0;
        for (let i = startRow; i < data.length; i++) {
          const r = data[i];
          if (!r || r.length < 4) continue;
          rows.push({
            adminid: String(r[0]).trim(),
            name: String(r[1]).trim(),
            username: String(r[2]).trim(),
            password: String(r[3]).trim(),
            is_master: String(r[4]||'0').trim()
          });
        }
      }
      if (rows.length === 0) { req.session.error = 'ไม่พบข้อมูลสำหรับเพิ่ม'; return res.redirect(`/admin/add/${role}`); }

      const idRe = /^\d+$/;
      const cleaned = rows
        .filter(r => r.adminid && idRe.test(r.adminid) && r.name && r.username && r.password)
        .map(r => ({ ...r, is_master: (String(r.is_master || '0').trim() === '1') }));
      if (cleaned.length === 0) { req.session.error = 'ข้อมูลไม่ถูกต้อง (adminid,name,username,password[,is_master])'; return res.redirect(`/admin/add/${role}`); }

      await pool.query('BEGIN');
      let inserted = 0, duplicates = 0;
      for (const r of cleaned) {
        const dup = await pool.query('SELECT 1 FROM Admin WHERE AdminId = $1 OR Username = $2',[r.adminid, r.username]);
        if (dup.rows.length > 0) { duplicates++; continue; }
        await pool.query('INSERT INTO Admin (AdminId, Name, Username, Password, is_master) VALUES ($1,$2,$3,$4,$5)',
          [r.adminid, r.name, r.username, r.password, r.is_master]);
        inserted++;
      }
      await pool.query('COMMIT');
      req.session.success = `เพิ่มสำเร็จ ${inserted} รายการ, ซ้ำ ${duplicates} รายการ`;
      return res.redirect('/admin/list/admin');
    } catch (err) {
      console.error('Bulk add admin error:', err);
      await pool.query('ROLLBACK');
      req.session.error = 'เกิดข้อผิดพลาดในการเพิ่มแบบกลุ่ม';
      return res.redirect(`/admin/add/${role}`);
    }
  }
  // ---------- END BULK ADMIN ----------


  // ---------- กิ่งพิเศษ: BULK สำหรับ TEACHER (CSV) ----------
  if (role === 'teacher' && req.body.mode === 'file') {
    try {
      if (!req.file) { req.session.error = 'กรุณาเลือกไฟล์ CSV'; return res.redirect(`/admin/add/${role}`); }
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sh = wb.Sheets[wb.SheetNames[0]];
      const data = xlsx.utils.sheet_to_json(sh, { header: 1, defval: '' });

      let startRow = 0;
      const h0 = (data[0]||[]).map(v => String(v).toLowerCase());
      if (h0.includes('teacherid') || h0.includes('firstname') || h0.includes('surname')) startRow = 1;

      const rows = [];
      for (let i = startRow; i < data.length; i++) {
        const r = data[i]; if (!r || r.length < 6) continue;
        rows.push({
          teacherid: String(r[0]).trim(),
          firstname: String(r[1]).trim(),
          surname:   String(r[2]).trim(),
          username:  String(r[3]).trim(),
          password:  String(r[4]).trim(),
          email:     String(r[5]).trim()
        });
      }
      if (rows.length === 0) { req.session.error = 'ไม่พบข้อมูลสำหรับเพิ่ม'; return res.redirect(`/admin/add/${role}`); }

      const idRe = /^\d+$/;
      const cleaned = rows.filter(r =>
        r.teacherid && idRe.test(r.teacherid) && r.firstname && r.surname && r.username && r.password && r.email
      );
      if (cleaned.length === 0) { req.session.error = 'ข้อมูลไม่ถูกต้อง (teacherid,firstname,surname,username,password,email)'; return res.redirect(`/admin/add/${role}`); }

      await pool.query('BEGIN');
      let inserted = 0, duplicates = 0;
      for (const r of cleaned) {
        const dup = await pool.query('SELECT 1 FROM Teacher WHERE TeacherId=$1 OR Username=$2 OR Email=$3',
          [r.teacherid, r.username, r.email]);
        if (dup.rows.length > 0) { duplicates++; continue; }
        await pool.query('INSERT INTO Teacher (TeacherId, firstname, surname, Username, Password, Email) VALUES ($1,$2,$3,$4,$5,$6)',
          [r.teacherid, r.firstname, r.surname, r.username, r.password, r.email]);
        inserted++;
      }
      await pool.query('COMMIT');
      req.session.success = `เพิ่มอาจารย์สำเร็จ ${inserted} รายการ, ซ้ำ ${duplicates} รายการ`;
      return res.redirect('/admin/list/teacher');
    } catch (err) {
      console.error('Bulk add teacher error:', err);
      await pool.query('ROLLBACK');
      req.session.error = 'เกิดข้อผิดพลาดในการเพิ่มอาจารย์แบบกลุ่ม';
      return res.redirect(`/admin/add/${role}`);
    }
  }
  // ---------- END BULK TEACHER ----------


  // ---------- กิ่งพิเศษ: BULK สำหรับ STUDENT (CSV) ----------
  if (role === 'student' && req.body.mode === 'file') {
    try {
      if (!req.file) { req.session.error = 'กรุณาเลือกไฟล์ CSV'; return res.redirect(`/admin/add/${role}`); }

      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sh = wb.Sheets[wb.SheetNames[0]];
      const data = xlsx.utils.sheet_to_json(sh, { header: 1, defval: '' });

      // ข้าม header ถ้าเจอคำบ่งชี้
      let startRow = 0;
      const h0 = (data[0]||[]).map(v => String(v).toLowerCase());
      if (h0.includes('studentid') || h0.includes('firstname') || h0.includes('surname')) startRow = 1;

      const rows = [];
      for (let i = startRow; i < data.length; i++) {
        const r = data[i]; if (!r || r.length < 6) continue;
        rows.push({
          studentid: String(r[0]).trim(),
          firstname: String(r[1]).trim(),
          surname:   String(r[2]).trim(),
          username:  String(r[3]).trim(),
          password:  String(r[4]).trim(),
          email:     String(r[5]).trim()
        });
      }
      if (rows.length === 0) { req.session.error = 'ไม่พบข้อมูลสำหรับเพิ่ม'; return res.redirect(`/admin/add/${role}`); }

      // ตรวจความถูกต้อง
      const idRe = /^\d+$/;
      const cleaned = rows.filter(r =>
        r.studentid && idRe.test(r.studentid) && r.firstname && r.surname && r.username && r.password && r.email
      );
      if (cleaned.length === 0) { req.session.error = 'ข้อมูลไม่ถูกต้อง (studentid,firstname,surname,username,password,email)'; return res.redirect(`/admin/add/${role}`); }

      // บันทึก
      await pool.query('BEGIN');
      let inserted = 0, duplicates = 0;
      for (const r of cleaned) {
        const dup = await pool.query('SELECT 1 FROM Student WHERE StudentId=$1 OR Username=$2 OR Email=$3',
          [r.studentid, r.username, r.email]);
        if (dup.rows.length > 0) { duplicates++; continue; }
        await pool.query('INSERT INTO Student (StudentId, firstname, surname, Username, Password, Email) VALUES ($1,$2,$3,$4,$5,$6)',
          [r.studentid, r.firstname, r.surname, r.username, r.password, r.email]);
        inserted++;
      }
      await pool.query('COMMIT');
      req.session.success = `เพิ่มนักศึกษาสำเร็จ ${inserted} รายการ, ซ้ำ ${duplicates} รายการ`;
      return res.redirect('/admin/list/student');
    } catch (err) {
      console.error('Bulk add student error:', err);
      await pool.query('ROLLBACK');
      req.session.error = 'เกิดข้อผิดพลาดในการเพิ่มนักศึกษาแบบกลุ่ม';
      return res.redirect(`/admin/add/${role}`);
    }
  }
  // ---------- END BULK STUDENT ----------


  // ---------- โหมดเดิม: เพิ่มทีละคน ----------
  const { id, firstname, surname, username, password, email, is_master } = req.body;

  if (role === 'admin' && !req.session.user.is_master) {
    req.session.error = 'คุณไม่มีสิทธิ์เพิ่มผู้ดูแลระบบ (ต้องเป็น Master Admin)';
    return res.redirect('/admin');
  }

  if (!id || !firstname || !username || !password || (role !== 'admin' && (!surname || !email))) {
    req.session.error = 'กรุณากรอกข้อมูลให้ครบทุกช่อง';
    return res.redirect(`/admin/add/${role}`);
  }

  try {
    let checkQuery = '', checkParams = [];
    if (role === 'admin') {
      checkQuery = 'SELECT 1 FROM Admin WHERE AdminId=$1 OR Username=$2';
      checkParams = [id, username];
    } else if (role === 'teacher') {
      checkQuery = 'SELECT 1 FROM Teacher WHERE TeacherId=$1 OR Username=$2 OR Email=$3';
      checkParams = [id, username, email];
    } else if (role === 'student') {
      checkQuery = 'SELECT 1 FROM Student WHERE StudentId=$1 OR Username=$2 OR Email=$3';
      checkParams = [id, username, email];
    } else {
      return res.redirect('/admin');
    }

    const existed = await pool.query(checkQuery, checkParams);
    if (existed.rows.length > 0) {
      req.session.error = 'พบข้อมูลซ้ำ (รหัส/ชื่อผู้ใช้/อีเมล)';
      return res.redirect(`/admin/add/${role}`);
    }

    let insertQuery = '', insertParams = [];
    if (role === 'admin') {
      insertQuery = 'INSERT INTO Admin (AdminId, Name, Username, Password, is_master) VALUES ($1,$2,$3,$4,$5)';
      insertParams = [id, firstname, username, password, (is_master === '1')];
    } else if (role === 'teacher') {
      insertQuery = 'INSERT INTO Teacher (TeacherId, firstname, surname, Username, Password, Email) VALUES ($1,$2,$3,$4,$5,$6)';
      insertParams = [id, firstname, surname, username, password, email];
    } else if (role === 'student') {
      insertQuery = 'INSERT INTO Student (StudentId, firstname, surname, Username, Password, Email) VALUES ($1,$2,$3,$4,$5,$6)';
      insertParams = [id, firstname, surname, username, password, email];
    }

    await pool.query(insertQuery, insertParams);
    res.redirect(`/admin/list/${role}`);
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการเพิ่มข้อมูล';
    res.redirect(`/admin/add/${role}`);
  }
});


router.get('/admin/edit/:role/:id', requireRole('admin'), async (req, res, next) => {
  const { role, id } = req.params;

  if (role === 'admin') {
    // admin ต้องเป็น master เท่านั้น
    return requireMasterAdmin(req, res, async () => {
      // โค้ดโหลดข้อมูล admin และ render
      let query = 'SELECT * FROM Admin WHERE AdminId = $1';

      try {
        const result = await pool.query(query, [id]);
        if (result.rows.length === 0) return res.redirect('/admin');

        const error = req.session.error || null;
        req.session.error = null;

        res.render('edit_user', {
          user: result.rows[0],
          role,
          error,
          currentUser: req.session.user,
          currentRole: req.session.role,
          showNavbar: true
        });
      } catch (err) {
        console.error(err);
        req.session.error = 'เกิดข้อผิดพลาดในการโหลดข้อมูล';
        res.redirect('/admin');
      }
    });
  } else {
    // สำหรับ teacher/student ตามปกติ
    let query;
    if (role === 'teacher') {
      query = 'SELECT * FROM Teacher WHERE TeacherId = $1';
    } else if (role === 'student') {
      query = 'SELECT * FROM Student WHERE StudentId = $1';
    } else {
      return res.redirect('/admin');
    }

    try {
      const result = await pool.query(query, [id]);
      if (result.rows.length === 0) return res.redirect('/admin');

      const error = req.session.error || null;
      req.session.error = null;

      res.render('edit_user', {
        user: result.rows[0],
        role,
        error,
        currentUser: req.session.user,
        currentRole: req.session.role,
        showNavbar: true
      });
    } catch (err) {
      console.error(err);
      req.session.error = 'เกิดข้อผิดพลาดในการโหลดข้อมูล';
      res.redirect('/admin');
    }
  }
});

router.post('/admin/edit/:role/:id', requireRole('admin'), async (req, res) => {
  const { role, id } = req.params;
  const { firstname, surname, username, password, email } = req.body;

  try {
    let query;
    let params;
    const hasPassword = password && password.trim() !== '';

    if (role === 'admin') {
      if (hasPassword) {
        query = 'UPDATE Admin SET Name = $1, Username = $2, Password = $3 WHERE AdminId = $4';
        params = [firstname, username, password, id];
      } else {
        query = 'UPDATE Admin SET Name = $1, Username = $2 WHERE AdminId = $3';
        params = [firstname, username, id];
      }
    } else if (role === 'teacher') {
      if (hasPassword) {
        query = 'UPDATE Teacher SET firstname = $1, surname = $2, username = $3, password = $4, email = $5 WHERE TeacherId = $6';
        params = [firstname, surname, username, password, email, id];
      } else {
        query = 'UPDATE Teacher SET firstname = $1, surname = $2, username = $3, email = $4 WHERE TeacherId = $5';
        params = [firstname, surname, username, email, id];
      }
    } else if (role === 'student') {
      if (hasPassword) {
        query = 'UPDATE Student SET firstname = $1, surname = $2, username = $3, password = $4, email = $5 WHERE StudentId = $6';
        params = [firstname, surname, username, password, email, id];
      } else {
        query = 'UPDATE Student SET firstname = $1, surname = $2, username = $3, email = $4 WHERE StudentId = $5';
        params = [firstname, surname, username, email, id];
      }
    } else {
      return res.redirect('/admin');
    }

    await pool.query(query, params);
    res.redirect(`/admin/list/${role}`);
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการบันทึกข้อมูล';
    res.redirect(`/admin/edit/${role}/${id}`);
  }
});


router.post('/admin/delete/:role/:id', requireRole('admin'), async (req, res) => {
  const { role, id } = req.params;

  if (role === 'admin') {
    // ไม่ใช่ master admin ห้ามลบ admin ใด ๆ
    if (!req.session.user.is_master) {
      return res.status(403).send('คุณไม่มีสิทธิ์ลบผู้ดูแลระบบ');
    }

    // ห้าม master ลบตัวเอง
    if (String(req.session.user.adminid) === String(id)) {
      req.session.error = 'คุณไม่สามารถลบบัญชีของตนเองได้';
      return res.redirect('/admin/list/admin');
    }
  }

  let query;
  if (role === 'admin') {
    query = 'DELETE FROM Admin WHERE AdminId = $1';
  } else if (role === 'teacher') {
    query = 'DELETE FROM Teacher WHERE TeacherId = $1';
  } else if (role === 'student') {
    query = 'DELETE FROM Student WHERE StudentId = $1';
  } else {
    return res.redirect('/admin');
  }

  try {
    await pool.query(query, [id]);
    res.redirect(`/admin/list/${role}`);
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการลบข้อมูล';
    res.redirect(`/admin/list/${role}`);
  }
});

//------------------------------------------------------------------
//--------------------------SHOW CLASSROOM--------------------------
//------------------------------------------------------------------

router.get('/classroom', requireAnyRole(['teacher', 'student']), async (req, res) => {
  try {
    const role = req.session.role;

    // 1) หา "เทอมปัจจุบัน" เป็น default (ถ้าไม่มีให้ใช้เทอมล่าสุดใน term)
    const { rows: curRows } = await pool.query(`
      SELECT academic_year, semester_no
      FROM term
      WHERE (start_date IS NOT NULL AND end_date IS NOT NULL
             AND CURRENT_DATE BETWEEN start_date AND end_date)
      ORDER BY academic_year DESC, semester_no DESC
      LIMIT 1
    `);
    const { rows: lastRows } = await pool.query(`
      SELECT academic_year, semester_no
      FROM term
      ORDER BY academic_year DESC, semester_no DESC
      LIMIT 1
    `);
    const cur = curRows[0] || lastRows[0] || { academic_year: null, semester_no: null };

    // helpers
    const toNumOrNull = (v) => {
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const hasYearQ = Object.prototype.hasOwnProperty.call(req.query, 'year');
    const hasSemQ  = Object.prototype.hasOwnProperty.call(req.query, 'semester');

    // 2) รับค่าฟิลเตอร์จาก query
    let selectedYear = hasYearQ ? toNumOrNull(req.query.year) : toNumOrNull(cur.academic_year);
    let selectedSem  = hasSemQ  ? toNumOrNull(req.query.semester)
                                : (hasYearQ ? null : toNumOrNull(cur.semester_no));

    // 3) “ตัวเลือกปี/ภาค” ต้องมาจากห้องที่ผู้ใช้เข้าถึงได้จริง
    let yearOptions = [];
    let semesterOptions = [];
    if (role === 'teacher') {
      const teacherId = req.session.user.teacherid;

      // ปีทั้งหมดที่อาจารย์คนนี้มีห้อง
      const { rows: yrows } = await pool.query(`
        SELECT DISTINCT tm.academic_year
        FROM classroom c
        LEFT JOIN term tm ON tm.term_id = c.term_id
        WHERE c.teacherid = $1
          AND tm.academic_year IS NOT NULL
        ORDER BY tm.academic_year DESC
      `, [teacherId]);
      yearOptions = yrows.map(r => r.academic_year);

      // ถ้าปีที่เลือกไม่อยู่ในรายการของผู้ใช้ -> ล้างปี/ภาค
      if (selectedYear != null && !yearOptions.includes(selectedYear)) {
        selectedYear = null;
        selectedSem = null;
      }

      // ภาคในปีที่เลือก
      if (selectedYear != null) {
        const { rows: srows } = await pool.query(`
          SELECT DISTINCT tm.semester_no
          FROM classroom c
          LEFT JOIN term tm ON tm.term_id = c.term_id
          WHERE c.teacherid = $1
            AND tm.academic_year = $2
          ORDER BY tm.semester_no
        `, [teacherId, selectedYear]);
        semesterOptions = srows.map(r => r.semester_no);

        if (selectedSem != null && !semesterOptions.includes(selectedSem)) {
          selectedSem = null;
        }
      } else {
        // ยังไม่เลือกปี -> ยังไม่โชว์ภาค (ปล่อยว่าง)
        semesterOptions = [];
      }

      // ถ้าไม่ได้ส่ง query ใด ๆ และเทอมปัจจุบันไม่มีห้อง ให้ default เป็นปี/ภาคล่าสุดของผู้ใช้
      if (!hasYearQ && !hasSemQ && (selectedYear == null) && yearOptions.length) {
        selectedYear = yearOptions[0]; // มากสุด (DESC)
        const { rows: srows } = await pool.query(`
          SELECT DISTINCT tm.semester_no
          FROM classroom c
          LEFT JOIN term tm ON tm.term_id = c.term_id
          WHERE c.teacherid = $1
            AND tm.academic_year = $2
          ORDER BY tm.semester_no
        `, [teacherId, selectedYear]);
        semesterOptions = srows.map(r => r.semester_no);
        selectedSem = semesterOptions[semesterOptions.length - 1] ?? null; // เทอมมากสุดในปีนั้น
      }

    } else {
      // student
      const studentId = req.session.user.studentid;

      const { rows: yrows } = await pool.query(`
        SELECT DISTINCT tm.academic_year
        FROM classroom c
        JOIN classroom_student cs ON cs.classroomid = c.classroomid
        LEFT JOIN term tm ON tm.term_id = c.term_id
        WHERE cs.studentid = $1
          AND tm.academic_year IS NOT NULL
        ORDER BY tm.academic_year DESC
      `, [studentId]);
      yearOptions = yrows.map(r => r.academic_year);

      if (selectedYear != null && !yearOptions.includes(selectedYear)) {
        selectedYear = null;
        selectedSem = null;
      }

      if (selectedYear != null) {
        const { rows: srows } = await pool.query(`
          SELECT DISTINCT tm.semester_no
          FROM classroom c
          JOIN classroom_student cs ON cs.classroomid = c.classroomid
          LEFT JOIN term tm ON tm.term_id = c.term_id
          WHERE cs.studentid = $1
            AND tm.academic_year = $2
          ORDER BY tm.semester_no
        `, [studentId, selectedYear]);
        semesterOptions = srows.map(r => r.semester_no);

        if (selectedSem != null && !semesterOptions.includes(selectedSem)) {
          selectedSem = null;
        }
      } else {
        semesterOptions = [];
      }

      if (!hasYearQ && !hasSemQ && (selectedYear == null) && yearOptions.length) {
        selectedYear = yearOptions[0];
        const { rows: srows } = await pool.query(`
          SELECT DISTINCT tm.semester_no
          FROM classroom c
          JOIN classroom_student cs ON cs.classroomid = c.classroomid
          LEFT JOIN term tm ON tm.term_id = c.term_id
          WHERE cs.studentid = $1
            AND tm.academic_year = $2
          ORDER BY tm.semester_no
        `, [studentId, selectedYear]);
        semesterOptions = srows.map(r => r.semester_no);
        selectedSem = semesterOptions[semesterOptions.length - 1] ?? null;
      }
    }

    // 4) ดึงรายการห้องตามบทบาท + ฟิลเตอร์
    let classrooms = [];
    if (role === 'teacher') {
      const teacherId = req.session.user.teacherid;
      const where = ['c.teacherid = $1'];
      const params = [teacherId];

      if (selectedYear != null) {
        params.push(selectedYear);
        where.push(`tm.academic_year = $${params.length}`);
      }
      if (selectedSem != null) {
        params.push(selectedSem);
        where.push(`tm.semester_no = $${params.length}`);
      }

      const sql = `
        SELECT c.*,
               CONCAT(t.firstname, ' ', t.surname) AS teacher_fullname,
               tm.semester_no AS semester,
               tm.academic_year,
               tm.start_date, tm.end_date
        FROM classroom c
        JOIN teacher t ON c.teacherid = t.teacherid
        LEFT JOIN term tm ON tm.term_id = c.term_id
        WHERE ${where.join(' AND ')}
        ORDER BY tm.academic_year DESC NULLS LAST,
                 tm.semester_no  DESC NULLS LAST,
                 c.classroomname ASC
      `;
      classrooms = (await pool.query(sql, params)).rows;

    } else if (role === 'student') {
      const studentId = req.session.user.studentid;
      const where = ['cs.studentid = $1'];
      const params = [studentId];

      if (selectedYear != null) {
        params.push(selectedYear);
        where.push(`tm.academic_year = $${params.length}`);
      }
      if (selectedSem != null) {
        params.push(selectedSem);
        where.push(`tm.semester_no = $${params.length}`);
      }

      const sql = `
        SELECT DISTINCT
               c.*,
               CONCAT(t.firstname, ' ', t.surname) AS teacher_fullname,
               tm.semester_no AS semester,
               tm.academic_year,
               tm.start_date, tm.end_date
        FROM classroom c
        JOIN teacher t ON c.teacherid = t.teacherid
        JOIN classroom_student cs ON c.classroomid = cs.classroomid
        LEFT JOIN term tm ON tm.term_id = c.term_id
        WHERE ${where.join(' AND ')}
        ORDER BY tm.academic_year DESC NULLS LAST,
                 tm.semester_no  DESC NULLS LAST,
                 c.classroomname ASC
      `;
      classrooms = (await pool.query(sql, params)).rows;
    } else {
      return res.redirect('/login');
    }

    // 5) render
    return res.render('classroom', {
      classrooms,
      role,
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: role,
      yearOptions,
      semesterOptions,
      selectedYear,
      selectedSem
    });

  } catch (err) {
    console.error(err);
    return res.render('classroom', {
      classrooms: [],
      role: req.session.role,
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role,
      error: 'เกิดข้อผิดพลาดในการโหลดข้อมูลห้องเรียน'
    });
  }
});



//------------------------------------------------------------------
//--------------------------ADD CLASSROOM---------------------------
//------------------------------------------------------------------
// GET: แสดงฟอร์มสร้างห้องเรียน (เฉพาะอาจารย์)
// แทนทั้ง handler GET /classroom/add
// เพิ่มห้องเรียน
router.get('/classroom/add', requireRole('teacher'), async (req, res) => {
  try {
    // ปีการศึกษา: 2568..2578 (รวม 11 ปี)
    const yearOptions = Array.from({ length: 11 }, (_, i) => 2568 + i);

    const err = req.session.error || null;
    req.session.error = null;

    return res.render('addclassroom', {
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role,
      error: err,
      yearOptions,           // ✅ ส่งช่วงปี 2568–2578
      semesters: [1, 2, 3],  // ✅ ภาค 1–3
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) return res.redirect('/classroom');
  }
});






// POST: บันทึก classroom ใหม่ (เฉพาะอาจารย์)
router.post('/classroom/add', requireRole('teacher'), async (req, res) => {
  try {
    const teacherId = req.session.user.teacherid;

    const {
      ClassroomName, RoomNumber, Description,
      MinAttendancePercent, day_of_week,
      academic_year,          // ✅ ปี พ.ศ. จากฟอร์ม
      semester_no             // ✅ ภาค 1-3 จากฟอร์ม
    } = req.body;

    const start_time = resolveTimeFromBody(req.body, 'start');
    const end_time   = resolveTimeFromBody(req.body, 'end');

    if (!ClassroomName || !RoomNumber || !Description || !MinAttendancePercent ||
        !day_of_week || !start_time || !end_time || !academic_year || !semester_no) {
      req.session.error = 'กรุณากรอกข้อมูลให้ครบถ้วน';
      return res.redirect('/classroom/add');
    }

    // ✅ หา/สร้าง term_id จาก ปี (พ.ศ.) และ ภาค
    const term_id = await getOrCreateTermId(Number(academic_year), Number(semester_no));

    await pool.query(
      `INSERT INTO classroom
       (classroomname, roomnumber, description, minattendancepercent, teacherid,
        day_of_week, start_time, end_time, term_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        ClassroomName,
        RoomNumber,
        Description,
        parseInt(MinAttendancePercent, 10),
        teacherId,
        day_of_week,
        start_time,
        end_time,
        term_id
      ]
    );

    return res.redirect('/classroom');
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการบันทึกห้องเรียน';
    return res.redirect('/classroom/add');
  }
});



//------------------------------------------------------------------
//--------------------------VIEW CLASSROOM---------------------------
//------------------------------------------------------------------
router.get('/classroom/view/:id', requireAnyRole(['teacher', 'student']), async (req, res) => {
  const classroomId = req.params.id;
  try {
    const result = await pool.query(`
      SELECT c.*,
             t.firstname || ' ' || t.surname AS teacher_fullname,
             tm.semester_no AS semester,
             tm.academic_year,
             tm.start_date,
             tm.end_date
      FROM classroom c
      JOIN teacher t ON c.teacherid = t.teacherid
      LEFT JOIN term tm ON tm.term_id = c.term_id
      WHERE c.classroomid = $1
    `, [classroomId]);

    if (result.rows.length === 0) {
      req.session.error = 'ไม่พบห้องเรียน';
      return res.redirect('/classroom');
    }

    return res.render('viewclassroom', {
      classroom: result.rows[0],
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) return res.redirect('/classroom');
  }
});


//------------------------------------------------------------------
//--------------------------EDIT CLASSROOM---------------------------
//------------------------------------------------------------------

// GET: แก้ไขห้องเรียน
// แก้ไขห้องเรียน
router.get('/classroom/edit/:id', requireRole('teacher'), async (req, res) => {
  const classroomId = req.params.id;
  try {
    const { rows: clsRows } = await pool.query(`
      SELECT c.*,
             tm.academic_year,
             tm.semester_no AS semester,   -- alias เป็น semester เพื่อใช้ใน EJS
             tm.term_id
      FROM classroom c
      LEFT JOIN term tm ON tm.term_id = c.term_id
      WHERE c.classroomid = $1
    `, [classroomId]);

    if (!clsRows.length) {
      req.session.error = 'ไม่พบห้องเรียน';
      return res.redirect('/classroom');
    }

    // ปีการศึกษา: 2568..2578 (รวม 11 ปี)
    const yearOptions = Array.from({ length: 11 }, (_, i) => 2568 + i);

    const err = req.session.error || null;
    req.session.error = null;

    return res.render('editclassroom', {
      classroom: clsRows[0],
      yearOptions,           // ✅ ส่งช่วงปี 2568–2578
      semesters: [1, 2, 3],  // ✅ ภาค 1–3
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role,
      error: err,
    });
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการโหลดข้อมูลห้องเรียน';
    return res.redirect('/classroom');
  }
});



// POST: แก้ไขห้องเรียน
router.post('/classroom/edit/:id', requireRole('teacher'), async (req, res) => {
  const id = req.params.id;
  try {
    const {
      ClassroomName, RoomNumber, Description,
      MinAttendancePercent, day_of_week,
      academic_year, semester_no
    } = req.body;

    const start_time = resolveTimeFromBody(req.body, 'start');
    const end_time   = resolveTimeFromBody(req.body, 'end');

    if (!ClassroomName || !RoomNumber || !Description || !MinAttendancePercent ||
        !day_of_week || !start_time || !end_time || !academic_year || !semester_no) {
      req.session.error = 'กรุณากรอกข้อมูลให้ครบถ้วน';
      return res.redirect(`/classroom/edit/${id}`);
    }

    const term_id = await getOrCreateTermId(Number(academic_year), Number(semester_no));

    await pool.query(
      `UPDATE classroom
       SET classroomname=$1, roomnumber=$2, description=$3,
           minattendancepercent=$4, day_of_week=$5, start_time=$6, end_time=$7,
           term_id=$8
       WHERE classroomid=$9`,
      [
        ClassroomName, RoomNumber, Description,
        parseInt(MinAttendancePercent, 10),
        day_of_week, start_time, end_time,
        term_id, id
      ]
    );

    return res.redirect('/classroom');
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการแก้ไขห้องเรียน';
    return res.redirect(`/classroom/edit/${id}`);
  }
});



// Route ลบห้องเรียน
router.post('/classroom/delete/:id', requireRole('teacher'), async (req, res) => {
  const classroomId = req.params.id;
  const teacherId = req.session.user.teacherid;

  try {
    await pool.query('DELETE FROM Classroom WHERE ClassroomId = $1 AND TeacherId = $2', [classroomId, teacherId]);
    res.redirect('/classroom');
  } catch (err) {
    console.error(err);
    res.redirect('/classroom');
  }
});

//------------------------------------------------------------------
//--------------------------FORM ADD student to classroom----------------------
//------------------------------------------------------------------


router.get('/classroom/add-students', requireRole('teacher'), async (req, res) => {
  try {
    const teacherId   = req.session.user.teacherid;
    const classroomId = req.query.classroomId;

    if (!classroomId) {
      req.session.error = 'กรุณาระบุรหัสชั้นเรียน';
      return res.redirect('/classroom');
    }

    // ตรวจสิทธิ์ว่าห้องนี้เป็นของอาจารย์ที่ล็อกอิน
    const classroomRes = await pool.query(
      'SELECT classroomid, classroomname FROM classroom WHERE classroomid = $1 AND teacherid = $2',
      [classroomId, teacherId]
    );
    if (classroomRes.rows.length === 0) {
      req.session.error = 'คุณไม่มีสิทธิ์เข้าถึงชั้นเรียนนี้';
      return res.redirect('/classroom');
    }

    const classroom = classroomRes.rows[0];

    return res.render('add_student_to_classroom', {
      classroomId: classroom.classroomid,
      classroomName: classroom.classroomname,
      error: req.session.error || null,
      success: null,
      summary: null,
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role
    });
  } catch (err) {
    console.error(err);
    return res.status(500).send('เกิดข้อผิดพลาดในการโหลดข้อมูล');
  } finally {
    req.session.error = null;
  }
});



router.post('/classroom/add-students',
  requireRole('teacher'),
  upload.single('file'),
  async (req, res) => {
    const { ClassroomId } = req.body;

    // helper render กลับหน้าเดิม
    const renderBack = async (opts) => {
      try {
        const c = await pool.query('SELECT classroomid, classroomname FROM classroom WHERE classroomid = $1', [ClassroomId]);
        return res.render('add_student_to_classroom', {
          classroomId: ClassroomId,
          classroomName: c.rows[0]?.classroomname || '',
          showNavbar: true,
          currentUser: req.session.user,
          currentRole: req.session.role,
          ...opts
        });
      } catch (e) {
        console.error('renderBack error:', e);
        return res.status(500).send('Server error');
      }
    };

    try {
      const teacherId = req.session.user.teacherid;

      // ตรวจสิทธิ์ห้อง
      const classroomRes = await pool.query(
        'SELECT classroomid FROM classroom WHERE classroomid = $1 AND teacherid = $2',
        [ClassroomId, teacherId]
      );
      if (classroomRes.rows.length === 0) {
        return renderBack({ error: 'คุณไม่มีสิทธิ์แก้ไขชั้นเรียนนี้', success: null, summary: null });
      }
      const classroomId = classroomRes.rows[0].classroomid;

      // --- รวบรวมรหัสจาก "ข้อความ" ---
      const fromText = (() => {
        const raw = (req.body.studentIds || '').toString();
        if (!raw.trim()) return [];
        // แยกด้วย comma, เว้นบรรทัด หรือช่องว่างยาว ๆ
        return raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
      })();

      // --- รวบรวมรหัสจาก "ไฟล์" (Excel/CSV) ---
      const fromFile = (() => {
        if (!req.file) return [];
        const name = (req.file.originalname || '').toLowerCase();
        const buf  = req.file.buffer;

        try {
          if (name.endsWith('.csv')) {
            const text  = buf.toString('utf8');
            const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const first = (lines[0] || '').toLowerCase();
            const start = (first.includes('student') && first.includes('id')) ? 1 : 0;
            return lines.slice(start).map(line => line.split(',')[0].trim()).filter(Boolean);
          } else {
            const wb = xlsx.read(buf, { type: 'buffer', cellText: false, cellDates: true });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' }); // array of arrays
            let col0 = rows.map(r => (r && r.length ? String(r[0]).trim() : '')).filter(Boolean);
            const head = (col0[0] || '').toLowerCase();
            if (head.includes('student') && head.includes('id')) col0 = col0.slice(1);
            return col0;
          }
        } catch (e) {
          console.error('read file error:', e);
          return [];
        }
      })();

      // รวม + ทำความสะอาด + unique
      const clean = s => String(s).trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
      let candidateIds = Array.from(new Set([...fromText, ...fromFile].map(clean).filter(Boolean)));

      const summary = {
        total: fromText.length + fromFile.length,
        readable: candidateIds.length,
        found: 0,
        notfound: 0,
        inserted: 0,
        duplicates: 0
      };

      if (candidateIds.length === 0) {
        return renderBack({ error: 'กรุณากรอกรหัสนักศึกษา หรืออัปโหลดไฟล์ที่มีรหัสในคอลัมน์แรก', success: null, summary });
      }

      // ตรวจว่ามีในตาราง student จริงกี่คน
      const validRes = await pool.query(
        'SELECT studentid FROM student WHERE studentid = ANY($1)',
        [candidateIds]
      );
      const validIds = validRes.rows.map(r => r.studentid.toString());
      summary.found = validIds.length;
      summary.notfound = summary.readable - summary.found;

      if (validIds.length === 0) {
        return renderBack({ error: 'ไม่พบรหัสที่ตรงกับข้อมูลในระบบ (ตาราง Student)', success: null, summary });
      }

      // แทรกทีเดียว กันซ้ำด้วย NOT EXISTS (ถ้า DB มี UNIQUE(classroomid, studentid) ก็จะกันซ้ำซ้อน)
      const insertRes = await pool.query(
        `
        INSERT INTO classroom_student (classroomid, studentid)
        SELECT $1, s.studentid
          FROM student s
         WHERE s.studentid = ANY($2)
           AND NOT EXISTS (
             SELECT 1 FROM classroom_student cs
              WHERE cs.classroomid = $1 AND cs.studentid = s.studentid
           )
        RETURNING studentid
        `,
        [classroomId, validIds]
      );

      summary.inserted  = insertRes.rowCount;
      summary.duplicates = summary.found - summary.inserted;

      // ส่งกลับหน้าเดิมให้เห็นสรุป
      return renderBack({ success: 'อัปโหลด/บันทึกเสร็จแล้ว', error: null, summary });

    } catch (err) {
      console.error('add-students error:', err);
      return renderBack({ error: 'เกิดข้อผิดพลาดระหว่างบันทึก กรุณาลองอีกครั้ง', success: null, summary: null });
    }
  }
);


//------------------------------------------------------------------
//--------------------------list student in class----------------------
//------------------------------------------------------------------
router.get('/classroom/:id/students', requireAnyRole(['teacher', 'student']), async (req, res) => {
  const classroomId = req.params.id;

  try {
    // ดึงข้อมูลห้องเรียน
    const classRes = await pool.query(
      `SELECT * FROM Classroom WHERE ClassroomId = $1`, [classroomId]
    );
    if (classRes.rows.length === 0) return res.redirect('/classroom');

    // ดึงรายชื่อนักศีกษาในห้อง
    const studentRes = await pool.query(`
      SELECT s.studentid, s.firstname, s.surname
      FROM classroom_student cs
      JOIN student s ON cs.studentid = s.studentid
      WHERE cs.classroomid = $1
      ORDER BY s.studentid ASC
    `, [classroomId]);

    res.render('liststudentinclass', {
      classroom: classRes.rows[0],
      students: studentRes.rows,
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role
    });
  } catch (err) {
    console.error(err);
    res.redirect('/classroom');
  }
});


router.post('/classroom/:classroomId/students/:studentId/remove', requireRole('teacher'), async (req, res) => {
  const { classroomId, studentId } = req.params;
  const teacherId = req.session.user.teacherid;

  try {
    // ตรวจสอบสิทธิ์ว่าเป็นเจ้าของห้องเรียน
    const classroomCheck = await pool.query(
      'SELECT * FROM classroom WHERE classroomid = $1 AND teacherid = $2',
      [classroomId, teacherId]
    );

    if (classroomCheck.rows.length === 0) {
      return res.status(403).send('คุณไม่มีสิทธิ์ลบนักศีกษาในห้องเรียนนี้');
    }

    // ลบนักศีกษาจากห้องเรียน
    await pool.query(
      'DELETE FROM classroom_student WHERE classroomid = $1 AND studentid = $2',
      [classroomId, studentId]
    );

    res.redirect(`/classroom/${classroomId}/students`);
  } catch (err) {
    console.error('เกิดข้อผิดพลาดในการลบนักศีกษา:', err);
    res.status(500).send('เกิดข้อผิดพลาดในการลบนักศีกษา');
  }
});

//------------------------------------------------------------------
//--------------------------QR TOKEN SYSTEM-------------------------
//------------------------------------------------------------------

// คืนโทเคนที่ยังใช้ได้ภายใน 10 วิ ถ้าไม่มีให้สร้างใหม่
// คืนโทเคนที่ยังใช้ได้ภายใน 10 วิ ถ้าไม่มีให้สร้างใหม่
router.get('/qr/:id/token', requireRole('teacher'), async (req, res) => {
  const classroomId = parseInt(req.params.id, 10);
  const force = String(req.query.force || '').trim() === '1';
  const parent = (req.query.parent || '').toString().trim();   // ← โทเคนหลักของคาบ

  try {
    // 1) หา meta ของคาบจาก parent token (ถ้าไม่ได้ส่งมา จะ fallback เป็นแถวล่าสุดของห้องที่มี meta)
    let meta = null;
    if (parent) {
      const m = await pool.query(`
        SELECT term_id, grace_minutes, late_cutoff_at
        FROM attendancetoken
        WHERE token = $1
      `, [parent]);
      meta = m.rows[0] || null;
    }
    if (!meta) {
      const m2 = await pool.query(`
        SELECT term_id, grace_minutes, late_cutoff_at
        FROM attendancetoken
        WHERE classroomid = $1
          AND grace_minutes IS NOT NULL
          AND late_cutoff_at IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1
      `, [classroomId]);
      meta = m2.rows[0] || null; // ถ้าไม่มีจริง ๆ ก็จะเป็น null (ถือว่าไม่ตั้งตัดสาย)
    }

    // 2) ถ้าไม่ force ลองใช้โทเคนที่ยังไม่หมดอายุที่ "สร้างด้วย meta แล้ว"
    if (!force) {
      const q = await pool.query(`
        SELECT token, created_at
        FROM attendancetoken
        WHERE classroomid = $1
          AND is_used = FALSE
          AND created_at > NOW() - ($2 || ' seconds')::interval
        ORDER BY created_at DESC
        LIMIT 1
      `, [classroomId, TOKEN_TTL_SECONDS]);
      if (q.rowCount > 0) {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const url = `${baseUrl}/attendance/confirm/${q.rows[0].token}`;
        return res.json({ token: q.rows[0].token, url, ttl: TOKEN_TTL_SECONDS });
      }
    }

    // 3) สร้างโทเคนใหม่ พร้อมคัดลอก meta ลงไปด้วย
    const token = uuidv4();
    const ins = await pool.query(`
      INSERT INTO attendancetoken
        (token, classroomid, created_at, is_used,
         term_id, grace_minutes, late_cutoff_at)
      VALUES
        ($1, $2, NOW(), FALSE,
         $3, $4, $5)
      RETURNING token
    `, [
      token, classroomId,
      meta?.term_id ?? null,
      meta?.grace_minutes ?? null,
      meta?.late_cutoff_at ?? null
    ]);

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = `${baseUrl}/attendance/confirm/${ins.rows[0].token}`;
    return res.json({ token: ins.rows[0].token, url, ttl: TOKEN_TTL_SECONDS });
  } catch (e) {
    console.error('qr token error:', e);
    return res.status(500).json({ error: 'cannot create token' });
  }
});

// สร้าง QR token (อาจารย์เรียกจากหน้าดู QR ทุก 10 วิ)
// อาจารย์เท่านั้นที่ดูสถานะได้
router.get('/api/qr-status/:classroomId', requireRole('teacher'), async (req, res) => {
  const classroomId = parseInt(req.params.classroomId, 10);
  const token = (req.query.token || '').toString().trim();

  try {
    const r = await pool.query(`
      SELECT is_used
      FROM attendancetoken
      WHERE classroomid = $1
        AND token = $2
        AND created_at > NOW() - ($3 || ' seconds')::interval
    `, [classroomId, token, TOKEN_TTL_SECONDS]);

    if (r.rowCount === 0) {
      // ไม่พบ/หมดอายุ → ปฏิบัติเหมือนถูกใช้ไป
      return res.json({ exists: false, is_used: true });
    }
    return res.json({ exists: true, is_used: r.rows[0].is_used === true });
  } catch (e) {
    console.error('qr-status error:', e);
    return res.status(500).json({ error: 'error' });
  }
});

// หน้ารวม QR + รายชื่อนักศีกษาของห้อง ณ วันที่เลือก
router.get('/qr/:id', requireRole('teacher'), async (req, res) => {
  const classroomId = req.params.id;

  // ตรวจสอบรูปแบบ YYYY-MM-DD
  const isISODate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  // วันที่วันนี้ตามโซนเวลาไทย เป็นรูปแบบ YYYY-MM-DD
  const todayISOInBangkok = () => {
    const now = new Date();
    const th = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const y = th.getFullYear();
    const m = String(th.getMonth() + 1).padStart(2, '0');
    const d = String(th.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const selectedDate = isISODate(req.query.date) ? req.query.date : todayISOInBangkok();

  // ฟอร์แมต YYYY-MM-DD -> DD/MM/YYYY เพื่อแสดงผล
  const displayDate = (() => {
    const [y, m, d] = selectedDate.split('-');
    return `${d}/${m}/${y}`;
  })();

  try {
    // 🔻 เพิ่มฟีเจอร์ตัดสาย: อ่าน token จาก query แล้วดึง grace_minutes/late_cutoff_at
    const token = (req.query.token || '').toString().trim();
    let metaLate = null;
    if (token) {
      const q = await pool.query(
        `SELECT grace_minutes, late_cutoff_at
         FROM public.attendancetoken
         WHERE token = $1`,
        [token]
      );
      metaLate = q.rows[0] || null;
    }

    // 1) ดึงรายชื่อนักศึกษากับสถานะเช็กชื่อของวันนั้น
    const studentQuery = await pool.query(
      `
      SELECT
        s.studentid,
        s.firstname || ' ' || s.surname AS fullname,
        COALESCE(a.status, 'Absent') AS status,
        TO_CHAR(a."time", 'HH24:MI') AS checkin_time
      FROM classroom_student cs
      JOIN student s ON cs.studentid = s.studentid
      LEFT JOIN attendance a
        ON a.studentid = s.studentid
       AND a.classroomid = cs.classroomid
       AND a.date = $2
      WHERE cs.classroomid = $1
      ORDER BY s.firstname
      `,
      [classroomId, selectedDate]
    );

    // 2) ดึงชื่อชั้นเรียน
    const classQuery = await pool.query(
      `SELECT classroomname FROM classroom WHERE classroomid = $1`,
      [classroomId]
    );

    const rows = studentQuery.rows;
    const classroomName = classQuery.rows[0]?.classroomname || '-';

    // ผู้สอน (เอาจาก session ของอาจารย์ที่ล็อกอิน)
    const teacherName = [
      req.session?.user?.firstname || '',
      req.session?.user?.surname || ''
    ].filter(Boolean).join(' ') || '-';

    // ✅ นับจำนวนแบบแยกและรวม
    const onTimeCount  = rows.reduce((n, r) => n + (r.status === 'Present' ? 1 : 0), 0);
    const lateCount    = rows.reduce((n, r) => n + (r.status === 'Late'    ? 1 : 0), 0);
    const presentCount = onTimeCount + lateCount;     // มาเรียน = ตรงเวลา + มาสาย
    const absentCount  = rows.length - presentCount;

    return res.render('qr', {
      classroomId,
      classroomName,     // ส่งให้ qr.ejs
      teacherName,       // ส่งให้ qr.ejs
      displayDate,       // DD/MM/YYYY
      selectedDate,      // YYYY-MM-DD

      students: rows,

      // ✅ ส่งค่าที่นับมาให้หน้า EJS ใช้
      onTimeCount,
      lateCount,
      presentCount,
      absentCount,

      // ✅ ส่งเพิ่มสำหรับแสดง “ตัดสาย”
      token,
      metaLate,

      showNavbar: true,
      currentUser: req.session.user,
      currentRole: 'teacher',
    });
  } catch (err) {
    console.error('Error loading QR page:', err);
    req.session.error = 'ไม่สามารถโหลดหน้า QR ได้';
    return res.redirect('/classroom');
  }
});




// นักศีกษาสแกน token เพื่อเช็กชื่อ
// นักศีกษาสแกน → ตรวจ token แล้วบอกให้ไปหน้า confirm
router.post('/api/scan', requireRole('student'), async (req, res) => {
  try {
    const raw = (req.body.token || '').toString().trim();
    const m = raw.match(/\/attendance\/confirm\/([A-Za-z0-9-]{10,})/i);
    const token = m ? m[1] : raw;

    const q = await pool.query(`
      SELECT classroomid
      FROM attendancetoken
      WHERE token = $1
        AND is_used = FALSE
        AND created_at > NOW() - ($2 || ' seconds')::interval
    `, [token, TOKEN_TTL_SECONDS]);

    if (q.rowCount === 0) {
      return res.status(400).json({ error: 'Token หมดอายุหรือถูกใช้ไปแล้ว' });
    }
    return res.json({ redirect: `/attendance/confirm/${token}` });
  } catch (e) {
    console.error('api/scan redirect error:', e);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// หน้าสแกน (นักศีกษา)
router.get('/scan', requireRole('student'), (req, res) => {
  res.render('scan', {
    currentUser: req.session.user,
    currentRole: req.session.role,
    showNavbar: true
  });
});
router.get('/attendance/scan', requireRole('student'), (req, res) => {
  res.render('scan', {
    currentUser: req.session.user,
    currentRole: req.session.role,
    showNavbar: true
  });
});
router.get('/api/classroom/:id/attendance', requireRole('teacher'), async (req, res) => {
  const classroomId = req.params.id;
  const selectedDate = req.query.date || new Date().toISOString().split('T')[0];

  try {
    const result = await pool.query(`
      SELECT
        s.studentid,
        s.firstname || ' ' || s.surname AS fullname,
        COALESCE(a.status, 'Absent') AS status,
        TO_CHAR(a."time", 'HH24:MI') AS checkin_time
      FROM classroom_student cs
      JOIN student s ON cs.studentid = s.studentid
      LEFT JOIN attendance a
        ON a.studentid = s.studentid
       AND a.classroomid = cs.classroomid
       AND a.date = $2
      WHERE cs.classroomid = $1
      ORDER BY s.firstname
    `, [classroomId, selectedDate]);

    res.set('Cache-Control', 'no-store');
    return res.json({ students: result.rows });
  } catch (err) {
    console.error('api/classroom attendance error:', err);
    return res.status(500).json({ error: 'failed' });
  }
});

// ✅ เลือกวันที่ไปหน้า QR (เหลือครั้งเดียวพอ)

router.get('/classroom/:id/select-date', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT classroomid, classroomname 
       FROM classroom 
       WHERE classroomid = $1`, 
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("ไม่พบบันทึกชั้นเรียน");
    }

    const classroom = result.rows[0];

    res.render('select_date', {
      classroomId: classroom.classroomid,
      classroomName: classroom.classroomname,  // ส่งค่าไป ejs
      currentUser: req.session.user,
      currentRole: req.session.role,
      showNavbar: true
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// ✅ ใช้ middleware ตัวเดิมของโปรเจกต์ และใช้ uuidv4() ที่ประกาศไว้แล้วด้านบน
router.post('/classroom/:id/select-date', requireRole('teacher'), async (req, res) => {
  const classroomId = Number(req.params.id);
  const { date, grace_minutes } = req.body;   // date = 'YYYY-MM-DD', grace_minutes เช่น '20'
  const gm = Math.max(0, parseInt(grace_minutes || '0', 10));

  try {
    const token = uuidv4(); // ✅ ใช้ uuidv4() (อย่าประกาศซ้ำ)

    // คำนวณ late_cutoff_at ที่ฝั่ง Postgres: (date + start_time ของห้อง) + gm นาที
    const sql = `
      WITH cls AS (
        SELECT term_id, start_time
        FROM public.classroom
        WHERE classroomid = $2
      )
      INSERT INTO public.attendancetoken
        (token, classroomid, term_id, created_at, is_used, grace_minutes, late_cutoff_at)
      SELECT
        $1,                             -- token
        $2,                             -- classroomid
        cls.term_id,                    -- term ปัจจุบันของห้อง
        NOW(),                          -- created_at
        FALSE,                          -- is_used
        $4::int,                        -- grace_minutes
        ($3::date + cls.start_time) + make_interval(mins => $4::int)  -- late_cutoff_at
      FROM cls
      RETURNING token
    `;
    await pool.query(sql, [token, classroomId, date, gm]);

    // ไปหน้า QR พร้อม token และ date (เพื่อให้ qr.ejs แสดงตัดสายได้)
    return res.redirect(`/qr/${classroomId}?date=${encodeURIComponent(date)}&token=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error('select-date error:', err);
    req.session.error = 'สร้างโทเคนไม่สำเร็จ';
    return res.redirect(`/classroom/view/${classroomId}`);
  }
});


// ===== สร้างโทเคนของคาบ พร้อมกำหนดเวลาตัดสาย =====


router.post('/classroom/:id/generate-token', requireRole('teacher'), async (req, res) => {
  const classroomId = Number(req.params.id);
  const { date, grace_minutes } = req.body;              // มาจากฟอร์ม select_date.ejs
  const gm = Math.max(0, parseInt(grace_minutes || '0', 10));

  try {
    // สร้าง token หนึ่งอันสำหรับคาบนี้
    const token = uuidv4();

    // คำนวณ late_cutoff_at ที่ฝั่ง Postgres: (วันที่เลือก + start_time ของห้อง) + gm นาที
    // พร้อมบันทึก term_id ของห้องไปกับ token ด้วย
    const sql = `
      WITH cls AS (
        SELECT term_id, start_time
        FROM public.classroom
        WHERE classroomid = $2
      )
      INSERT INTO public.attendancetoken
        (token, classroomid, term_id, created_at, is_used, grace_minutes, late_cutoff_at)
      SELECT
        $1,                             -- token
        $2,                             -- classroomid
        cls.term_id,                    -- term ปัจจุบันของห้อง
        NOW(),                          -- created_at
        FALSE,                          -- is_used
        $4::int,                        -- grace_minutes
        ($3::date + cls.start_time) + make_interval(mins => $4::int)  -- late_cutoff_at
      FROM cls
      RETURNING token
    `;
    await pool.query(sql, [token, classroomId, date, gm]);

    // ไปหน้า QR พร้อมทั้งส่ง date/token ให้หน้าแสดงผล (ถ้าต้องการใช้โชว์)
    return res.redirect(`/qr/${classroomId}?date=${date}&token=${token}`);
  } catch (err) {
    console.error('generate-token error:', err);
    req.session.error = 'สร้างโทเคนไม่สำเร็จ';
    return res.redirect(`/classroom/view/${classroomId}`);
  }
});



// ========== หน้ายืนยันการเช็คชื่อ (นักศีกษากดจากลิงก์ใน QR) ==========
// GET /attendance/confirm/:token — แสดงหน้ายืนยันหลังสแกน (ยังไม่บันทึก)
router.get('/attendance/confirm/:token', requireRole('student'), async (req, res) => {
  const { token } = req.params;
  const student = req.session.user;
  if (!student || !student.studentid) return res.redirect('/login');

  try {
    const tok = await pool.query(`
      SELECT t.classroomid, c.classroomname
      FROM attendancetoken t
      JOIN classroom c ON c.classroomid = t.classroomid
      WHERE t.token = $1
        AND t.is_used = FALSE
        AND t.created_at > NOW() - ($2 || ' seconds')::interval
    `, [token, TOKEN_TTL_SECONDS]);

    // ❌ token ใช้ไม่ได้/หมดอายุ → alert แล้วเด้งกลับหน้า scan
    if (tok.rowCount === 0) {
      return res
        .status(400)
        .type('html')
        .send(`<!doctype html><html lang="th"><head><meta charset="utf-8"></head>
<body>
<script>
  alert(${JSON.stringify('Token ไม่ถูกต้องหรือหมดอายุ')});
  window.location.replace(${JSON.stringify('/attendance/scan')});
</script>
<noscript>
  <p>Token ไม่ถูกต้องหรือหมดอายุ</p>
  <a href="/attendance/scan">กลับไปหน้าเช็คชื่อ</a>
</noscript>
</body></html>`);
    }

    const { classroomid, classroomname } = tok.rows[0];

    const belong = await pool.query(
      `SELECT 1 FROM classroom_student WHERE classroomid = $1 AND studentid = $2`,
      [classroomid, student.studentid]
    );

    // เคสยกเว้น: ยัง render not_enrolled ตามเดิม
    if (belong.rowCount === 0) {
      return res.status(403).render('not_enrolled', {
        classroomName: classroomname,
        studentName: student.firstname
          ? `${student.firstname} ${student.surname || ''}`.trim()
          : (student.name || ''),
        showNavbar: true,
        currentUser: req.session.user,
        currentRole: req.session.role
      });
    }

    const now = new Date();
const dateTH = now.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' });
const timeTH = now.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });

    // ✅ ปกติ: แสดงหน้า confirm
    return res.render('attendance_confirm', {
      classroomName: classroomname,
      date: dateTH,
      time: timeTH,
      studentId: student.studentid,
      token,
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role
    });
  } catch (err) {
    console.error('confirm error:', err);
    // ⚠️ error อื่นๆ → alert แล้วเด้งกลับหน้า scan
    return res
      .status(500)
      .type('html')
      .send(`<!doctype html><html lang="th"><head><meta charset="utf-8"></head>
<body>
<script>
  alert(${JSON.stringify('เกิดข้อผิดพลาดในการโหลดหน้ายืนยัน')});
  window.location.replace(${JSON.stringify('/attendance/scan')});
</script>
<noscript>
  <p>เกิดข้อผิดพลาดในการโหลดหน้ายืนยัน</p>
  <a href="/attendance/scan">กลับไปหน้าเช็คชื่อ</a>
</noscript>
</body></html>`);
  }
});


// ========== กดปุ่ม "ยืนยันการเช็คชื่อ" ==========
// ป้องกันเช็คซ้ำในวันเดียวกัน + ไม่กิน token ถ้าเด็กคนนั้นเช็คไปแล้ว
// ========== กดปุ่ม "ยืนยันการเช็คชื่อ" พร้อมตัดสิน Present/Late ==========
router.post('/attendance/confirm', requireRole('student'), async (req, res) => {
  const tokenRaw = (req.body.token || '').toString().trim();
  const student  = req.session.user;

  const alertAndRedirect = (status, message, redirect = '/attendance/scan') => {
    return res
      .status(status)
      .type('html')
      .send(`<!doctype html><html lang="th"><head><meta charset="utf-8"></head>
<body>
<script>
  alert(${JSON.stringify(message)});
  window.location.replace(${JSON.stringify(redirect)});
</script>
<noscript><p>${message}</p><a href="${redirect}">กลับไปหน้าเช็คชื่อ</a></noscript>
</body></html>`);
  };

  try {
    // 1) อ่านข้อมูล token + เวลา "ตัดสาย" + term_id (และเช็คอายุโทเคน)
    const tq = await pool.query(`
      SELECT classroomid, term_id, late_cutoff_at
      FROM public.attendancetoken
      WHERE token=$1 AND is_used=FALSE
        AND created_at > NOW() - ($2 || ' seconds')::interval
    `, [tokenRaw, TOKEN_TTL_SECONDS]);

    if (tq.rowCount === 0) {
      return alertAndRedirect(400, 'Token ไม่ถูกต้องหรือหมดอายุ');
    }
    const { classroomid, term_id } = tq.rows[0];

    // 2) ต้องเป็นนักศึกษาที่อยู่ในห้องนี้
    const belong = await pool.query(
      `SELECT 1 FROM classroom_student WHERE classroomid=$1 AND studentid=$2`,
      [classroomid, student.studentid]
    );
    if (belong.rowCount === 0) {
      return res.status(403).render('not_enrolled', {
        classroomName: '',
        studentName: `${student.firstname} ${student.surname}`,
        showNavbar: true,
        currentUser: req.session.user,
        currentRole: req.session.role,
      });
    }

    // 3) เคยเช็คชื่อวันนี้ไปแล้วหรือไม่ (กันซ้ำ)
    const exist = await pool.query(
      `SELECT 1 FROM attendance
       WHERE classroomid=$1 AND studentid=$2 AND date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date`,
      [classroomid, student.studentid]
    );
    if (exist.rowCount > 0) {
      return alertAndRedirect(409, 'คุณได้เช็คชื่อไปแล้วในวันนี้');
    }

    // 4) ล็อก token (กันใช้ซ้ำ)
    const lock = await pool.query(
      `UPDATE attendancetoken SET is_used=TRUE
        WHERE token=$1 AND is_used=FALSE
          AND created_at > NOW() - ($2 || ' seconds')::interval
        RETURNING token`,
      [tokenRaw, TOKEN_TTL_SECONDS]
    );
    if (lock.rowCount === 0) {
      return alertAndRedirect(400, 'Token ถูกใช้ไปแล้วหรือหมดอายุ');
    }

    // 5) ✅ ตัดสิน Present/Late ด้วย SQL (อิงเวลาไทย) เพื่อกันปัญหา timezone/parse
    const { rows: [st] } = await pool.query(`
  SELECT CASE
           WHEN late_cutoff_at IS NULL
                OR (NOW() AT TIME ZONE 'Asia/Bangkok') <= late_cutoff_at
             THEN 'Present'::varchar(10)
           ELSE 'Late'::varchar(10)
         END AS status
  FROM public.attendancetoken
  WHERE token = $1
`, [tokenRaw]);
const status = st?.status || 'Present';


    // 6) บันทึก (ใส่ term_id ด้วย)
    await pool.query(
      `INSERT INTO attendance (studentid, classroomid, term_id, date, "time", status)
       VALUES ($1, $2, $3,
         (NOW() AT TIME ZONE 'Asia/Bangkok')::date,
         (NOW() AT TIME ZONE 'Asia/Bangkok')::time,
         $4)
       ON CONFLICT (studentid, classroomid, term_id, date)
       DO UPDATE SET time=EXCLUDED.time, status=EXCLUDED.status`,
      [student.studentid, classroomid, term_id, status]
    );

    return alertAndRedirect(200, status === 'Present'
      ? '✅ เช็คชื่อสำเร็จ'
      : '⏰ เช็คชื่อสำเร็จ (มาสาย)');
  } catch (err) {
    console.error('submit confirm error:', err);
    return alertAndRedirect(500, 'เกิดข้อผิดพลาดในการบันทึกการเช็คชื่อ');
  }
});


//------------------------------------------------------------------
//--------------------------คะแนน/ประวัติ CLASSROOM---------------------------
//------------------------------------------------------------------
// รายงานประวัติการเช็คชื่อรายวัน (ผู้สอน)
router.get('/classroom/:id/history', requireRole('teacher'), async (req, res) => {
  const classroomId = Number(req.params.id);
  const teacherId   = req.session.user.teacherid;

  // ตรวจรูปแบบ YYYY-MM-DD
  const isISODate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  // วันที่วันนี้ (โซนไทย) -> YYYY-MM-DD
  const todayISOInBangkok = () => {
    const now = new Date();
    const th  = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const y = th.getFullYear();
    const m = String(th.getMonth() + 1).padStart(2, '0');
    const d = String(th.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const selectedDate = isISODate(req.query.date) ? req.query.date : todayISOInBangkok();
  const [y, m, d] = selectedDate.split('-');
  const displayDate = `${d}/${m}/${y}`;

  try {
    // 1) ตรวจสิทธิ์ห้องเรียน
    const classRes = await pool.query(
      `SELECT classroomid, classroomname
         FROM classroom
        WHERE classroomid = $1 AND teacherid = $2`,
      [classroomId, teacherId]
    );
    if (classRes.rows.length === 0) {
      return res.status(403).send('คุณไม่มีสิทธิ์เข้าถึงชั้นเรียนนี้');
    }

    // 2) ดึงรายการนักเรียน + สถานะของวันนั้น
    const { rows } = await pool.query(
      `
      SELECT
        s.studentid,
        s.firstname,
        s.surname,
        COALESCE(a.status, 'Absent') AS status,
        TO_CHAR(a."time", 'HH24:MI') AS checkin_time
      FROM classroom_student cs
      JOIN student s ON cs.studentid = s.studentid
      LEFT JOIN attendance a
        ON a.studentid  = s.studentid
       AND a.classroomid = cs.classroomid
       AND a.date = $2
      WHERE cs.classroomid = $1
      ORDER BY s.studentid ASC
      `,
      [classroomId, selectedDate]
    );

    // 3) นับจำนวนแบบแยกและรวม (มาเรียน = ตรงเวลา + มาสาย)
    const onTimeCount  = rows.filter(r => r.status === 'Present').length;
    const lateCount    = rows.filter(r => r.status === 'Late').length;
    const presentCount = onTimeCount + lateCount;      // มาเรียน (รวมสาย)
    const absentCount  = rows.length - presentCount;
    const hasAnyAttendance = presentCount > 0;

    // 4) render
    return res.render('teacher_history_by_date', {
      classroom: classRes.rows[0],
      selectedDate,
      displayDate,
      students: rows,

      // ส่งตัวเลขสำหรับ badge 4 ตัว
      onTimeCount,
      lateCount,
      presentCount,
      absentCount,
      hasAnyAttendance,

      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role
    });

  } catch (err) {
    console.error('history error:', err);
    return res.status(500).send('เกิดข้อผิดพลาดในการโหลดรายงาน');
  }
});
;

// คะแนนการเช็คชื่อ "ทั้งห้อง" (ฝั่งอาจารย์)

// คะแนนการเช็กชื่อรวมทั้งห้อง + กติกา 3 สาย = ขาด 1, ขาดรวม ≥ 3 = ไม่ผ่าน
router.get('/classroom/:id/attendance-scores', requireRole('teacher'), async (req, res) => {
  const classroomId = Number(req.params.id);
  const teacherId   = req.session.user.teacherid;

  try {
    // 1) ตรวจสิทธิ์ห้องเรียน + ดึงเกณฑ์เปอร์เซ็นต์ขั้นต่ำ
    const c = await pool.query(
      `SELECT classroomid, classroomname, minattendancepercent
         FROM classroom
        WHERE classroomid = $1 AND teacherid = $2`,
      [classroomId, teacherId]
    );
    if (c.rows.length === 0) return res.status(403).send('คุณไม่มีสิทธิ์เข้าถึงชั้นเรียนนี้');

    const classroom  = c.rows[0];
    const minPercent = classroom.minattendancepercent || 0;

    // 2) จำนวนคาบทั้งหมดที่ห้องนี้มีการเช็กชื่อ (อิงข้อมูลจริงใน attendance)
    const totalRes = await pool.query(
      `SELECT COUNT(DISTINCT date)::int AS total_sessions
         FROM attendance
        WHERE classroomid = $1`,
      [classroomId]
    );
    const totalSessions = totalRes.rows[0].total_sessions;

    // 3) ดึงสถิติต่อคน: ontime_count = Present, late_count = Late
    const statsRes = await pool.query(`
      SELECT
        s.studentid,
        s.firstname,
        s.surname,
        COUNT(a.*) FILTER (WHERE a.status = 'Present')::int AS ontime_count,
        COUNT(a.*) FILTER (WHERE a.status = 'Late')::int    AS late_count
      FROM classroom_student cs
      JOIN student s ON s.studentid = cs.studentid
      LEFT JOIN attendance a
        ON a.classroomid = cs.classroomid
       AND a.studentid   = s.studentid
      WHERE cs.classroomid = $1
      GROUP BY s.studentid, s.firstname, s.surname
      ORDER BY s.studentid
    `, [classroomId]);

    // 4) คิดเกณฑ์: 3 มาสาย = ขาด 1, ขาดรวม ≥ 3 ⇒ ไม่ผ่าน
    const rows = statsRes.rows.map(r => {
      const ontime = Number(r.ontime_count) || 0;   // มาตรงเวลา (Present)
      const late   = Number(r.late_count)   || 0;   // มาสาย (Late)

      // มาเรียน "ดิบ" = ตรงเวลา + สาย
      const presentRaw = ontime + late;
      // ขาด "ดิบ" (ยังไม่คิดโทษจากสาย)
      const absentRaw  = Math.max(0, totalSessions - presentRaw);

      // ✅ โทษจากสาย: 3 สาย = ขาด 1
      const latePenalty = Math.floor(late / 3);

      // ✅ ขาด "หลังคิดโทษ"
      const absentEffective  = absentRaw + latePenalty;
      // ✅ มาเรียน "หลังคิดโทษ"
      const presentEffective = Math.max(0, totalSessions - absentEffective);

      // เปอร์เซ็นต์คิดจากค่าหลังคิดโทษ
      const percent = totalSessions
        ? Math.round((presentEffective / totalSessions) * 100)
        : 0;

      // ✅ ผ่านเมื่อ: เปอร์เซ็นต์ ≥ minPercent และ ขาดหลังคิดโทษ < 3
      const isPass = percent >= minPercent && absentEffective < 3;

      return {
        studentid: r.studentid,
        firstname: r.firstname,
        surname:   r.surname,

        // ค่าไว้แสดงผล
        ontime,                   // จำนวนมาตรงเวลา
        late,                     // จำนวนมาสาย
        present: presentRaw,      // จำนวนเข้าเรียน (รวม = ontime + late)
        absent:  absentEffective, // จำนวนขาดเรียน (หลังคิดโทษ)
        percent,
        isPass,

        // (ออปชัน) tooltip อธิบายที่มาของ "ขาด"
        _absent_raw: absentRaw,       // ขาดจริงก่อนคิดโทษ
        _late_penalty: latePenalty,   // โทษจากสายที่แปลงเป็นขาด
      };
    });

    res.render('teacher_classroom_scores', {
      classroom,
      minPercent,
      totalSessions,
      scores: rows,
      hasAnySession: totalSessions > 0,
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role
    });
  } catch (err) {
    console.error('scores error:', err);
    res.status(500).send('เกิดข้อผิดพลาดในการโหลดคะแนนการเช็คชื่อ');
  }
});





// ประวัติการเช็คชื่อของ "นักศีกษาที่ล็อกอินอยู่" ในห้องนี้
router.get('/student/classroom/:id/attendance-history', requireRole('student'), async (req, res) => {
  const classroomId = req.params.id;
  const studentId   = req.session.user.studentid;

  try {
    // ต้องเป็นนักศีกษาในห้องนี้
    const belong = await pool.query(
      `SELECT 1 FROM classroom_student WHERE classroomid = $1 AND studentid = $2`,
      [classroomId, studentId]
    );
    if (belong.rowCount === 0) return res.status(403).send('คุณไม่ได้อยู่ในชั้นเรียนนี้');

    // ข้อมูลห้อง
    const cls = await pool.query(
      `SELECT classroomid, classroomname FROM classroom WHERE classroomid = $1`,
      [classroomId]
    );
    if (cls.rowCount === 0) return res.redirect('/classroom');
    const classroom = cls.rows[0];

    // ดึงรายการเช็คชื่อเรียงใหม่ล่าสุดก่อน
    const rec = await pool.query(
      `SELECT 
         TO_CHAR(date, 'DD/MM/YYYY') AS display_date,
         TO_CHAR(time, 'HH24:MI')    AS display_time,
         status
       FROM attendance
       WHERE classroomid = $1 AND studentid = $2
       ORDER BY date DESC, time DESC`,
      [classroomId, studentId]
    );

    res.render('student_attendance_history', {
      classroom,                // ใช้ classroom.classroomname แสดงใต้หัวรายงาน
      records: rec.rows,        // [{display_date, display_time, status}, ...]
      hasRecords: rec.rowCount > 0,
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role
    });
  } catch (err) {
    console.error('student history error:', err);
    res.status(500).send('เกิดข้อผิดพลาดในการโหลดประวัติการเช็คชื่อ');
  }
});

// คะแนนการเช็คชื่อของ "นักศีกษาที่ล็อกอินอยู่" ในห้องนี้
// ✅ สรุปคะแนนของนักเรียน 1 คน ในห้องเรียน
router.get('/student/classroom/:id/attendance-score', requireRole('student'), async (req, res) => {
  const classroomId = Number(req.params.id);
  const studentId   = req.session.user.studentid;

  try {
    // 1) ตรวจว่าลงทะเบียนในห้องนี้จริง
    const belong = await pool.query(
      `SELECT 1 FROM classroom_student WHERE classroomid=$1 AND studentid=$2`,
      [classroomId, studentId]
    );
    if (belong.rowCount === 0) return res.status(403).send('คุณไม่ได้สังกัดชั้นเรียนนี้');

    // 2) ดึงชื่อห้อง + เกณฑ์ขั้นต่ำ
    const { rows: [room] } = await pool.query(
      `SELECT classroomid, classroomname, minattendancepercent
       FROM classroom WHERE classroomid=$1`,
      [classroomId]
    );
    const minPercent = room?.minattendancepercent || 0;

    // 3) จำนวนคาบทั้งหมดของห้องนี้ (นับเฉพาะคาบที่มีการเช็กชื่อเกิดขึ้นจริง)
    const { rows: [tot] } = await pool.query(
      `SELECT COUNT(DISTINCT date)::int AS total_sessions
       FROM attendance WHERE classroomid=$1`,
      [classroomId]
    );
    const totalSessions = tot?.total_sessions || 0;

    // 4) นับของ "นักเรียนคนนี้" แยกตรงเวลา/สาย
    const { rows: [st] } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='Present')::int AS ontime_count,
         COUNT(*) FILTER (WHERE status='Late')::int    AS late_count
       FROM attendance
       WHERE classroomid=$1 AND studentid=$2`,
      [classroomId, studentId]
    );
    const ontime = st?.ontime_count || 0;
    const late   = st?.late_count   || 0;

    // 5) คิดกติกา: 3 สาย = ขาด 1, ขาดรวม ≥ 3 ⇒ ไม่ผ่าน
    const presentRaw = ontime + late;                         // มาเรียน(ดิบ)
    const absentRaw  = Math.max(0, totalSessions - presentRaw);
    const latePenalty      = Math.floor(late / 3);            // ✅ 3 สาย = ขาด 1
    const absentEffective  = absentRaw + latePenalty;         // ขาดหลังคิดโทษ
    const presentEffective = Math.max(0, totalSessions - absentEffective);

    const percent = totalSessions
      ? Math.round((presentEffective / totalSessions) * 100)
      : 0;

    const isPass = percent >= minPercent && absentEffective < 3;

    return res.render('student_attendance_score', {
  classroom: room,
  totalSessions,
  ontime,
  late,
  present: presentRaw,
  absent:  absentEffective,
  percent,
  minPercent,
  isPass,

  // (ออปชัน) อธิบายที่มาของ "ขาด"
  _absent_raw: absentRaw,
  _late_penalty: latePenalty,

  // ✅ เพิ่มบรรทัดนี้
  hasAnySession: totalSessions > 0,

  showNavbar: true,
  currentUser: req.session.user,
  currentRole: req.session.role
});

  } catch (err) {
    console.error('student score error:', err);
    res.status(500).send('เกิดข้อผิดพลาดในการโหลดคะแนนของคุณ');
  }
});



module.exports = router;
