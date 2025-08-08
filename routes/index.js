const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireRole, requireAnyRole, requireMasterAdmin } = require('../middlewares/auth');
const qr = require('qrcode');
const { v4: uuidv4 } = require('uuid');

//------------------------------------------------------------------
//--------------------------LOGIN-----------------------------------
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
    // admin
    const adminResult = await pool.query(
      'SELECT * FROM admin WHERE username = $1 AND password = $2',
      [username, password]
    );
    if (adminResult.rows.length > 0) {
      const admin = adminResult.rows[0];
      req.session.user = {
        adminid: admin.adminid,
        username: admin.username,
        name: admin.name,
        is_master: admin.is_master === true
      };
      req.session.role = 'admin';
      return res.redirect('/admin');
    }

    // teacher
    const teacherResult = await pool.query(
      'SELECT * FROM teacher WHERE username = $1 AND password = $2',
      [username, password]
    );
    if (teacherResult.rows.length > 0) {
      req.session.user = teacherResult.rows[0];
      req.session.role = 'teacher';
      return res.redirect('/classroom');
    }

    // student
    const studentResult = await pool.query(
      'SELECT * FROM student WHERE username = $1 AND password = $2',
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
//--------------------------ADMIN PAGES------------------------------
//------------------------------------------------------------------
router.get('/admin', requireRole('admin'), (req, res) => {
  res.render('admin', {
    user: req.session.user,
    currentUser: req.session.user,
    currentRole: req.session.role,
    showNavbar: true
  });
});

// รายชื่อผู้ดูแลระบบ (เฉพาะ master)
router.get('/admin/list/admin', requireRole('admin'), async (req, res) => {
  if (!req.session.user.is_master) {
    return res.status(403).send('คุณไม่มีสิทธิ์เข้าถึงรายชื่อผู้ดูแลระบบ');
  }

  try {
    const result = await pool.query('SELECT * FROM admin ORDER BY adminid ASC');
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

// รายชื่อครู
router.get('/admin/list/teacher', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM teacher ORDER BY teacherid ASC');
    res.render('userlist', {
      title: 'รายชื่อครู',
      users: result.rows,
      role: 'teacher',
      currentUser: req.session.user,
      currentRole: req.session.role,
      showNavbar: true
    });
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการดึงข้อมูลครู';
    res.redirect('/admin');
  }
});

// รายชื่อนักเรียน
router.get('/admin/list/student', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM student ORDER BY studentid ASC');
    res.render('userlist', {
      title: 'รายชื่อนักเรียน',
      users: result.rows,
      role: 'student',
      currentUser: req.session.user,
      currentRole: req.session.role,
      showNavbar: true
    });
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการดึงข้อมูลนักเรียน';
    res.redirect('/admin');
  }
});

//------------------------------------------------------------------
//-------------------ADMIN: ADD / EDIT / DELETE USER----------------
//------------------------------------------------------------------
router.get('/admin/add/:role', requireRole('admin'), (req, res) => {
  const { role } = req.params;

  if (role === 'admin' && !req.session.user.is_master) {
    return res.status(403).send('คุณไม่มีสิทธิ์เพิ่มผู้ดูแลระบบ');
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

router.post('/admin/add/:role', requireRole('admin'), async (req, res) => {
  const { role } = req.params;
  const { id, firstname, surname, username, password, email } = req.body;

  if (role === 'admin' && !req.session.user.is_master) {
    return res.status(403).send('คุณไม่มีสิทธิ์เพิ่มผู้ดูแลระบบ');
  }

  if (!id || !firstname || !username || !password || (role !== 'admin' && (!surname || !email))) {
    req.session.error = 'กรุณากรอกข้อมูลให้ครบทุกช่อง';
    return res.redirect(`/admin/add/${role}`);
  }

  try {
    let checkQuery = '';
    let checkParams = [];

    if (role === 'admin') {
      checkQuery = 'SELECT 1 FROM admin WHERE adminid = $1 OR username = $2';
      checkParams = [id, username];
    } else if (role === 'teacher') {
      checkQuery = 'SELECT 1 FROM teacher WHERE teacherid = $1 OR username = $2 OR email = $3';
      checkParams = [id, username, email];
    } else if (role === 'student') {
      checkQuery = 'SELECT 1 FROM student WHERE studentid = $1 OR username = $2 OR email = $3';
      checkParams = [id, username, email];
    } else {
      return res.redirect('/admin');
    }

    const checkResult = await pool.query(checkQuery, checkParams);
    if (checkResult.rows.length > 0) {
      req.session.error = 'ID, Username หรือ Email ซ้ำกับในระบบ';
      return res.redirect(`/admin/add/${role}`);
    }

    let insertQuery;
    let insertParams;

    if (role === 'admin') {
      insertQuery = 'INSERT INTO admin (adminid, name, username, password) VALUES ($1, $2, $3, $4)';
      insertParams = [id, firstname, username, password];
    } else if (role === 'teacher') {
      insertQuery = 'INSERT INTO teacher (teacherid, firstname, surname, username, password, email) VALUES ($1, $2, $3, $4, $5, $6)';
      insertParams = [id, firstname, surname, username, password, email];
    } else if (role === 'student') {
      insertQuery = 'INSERT INTO student (studentid, firstname, surname, username, password, email) VALUES ($1, $2, $3, $4, $5, $6)';
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

router.get('/admin/edit/:role/:id', requireRole('admin'), async (req, res) => {
  const { role, id } = req.params;

  if (role === 'admin') {
    if (!req.session.user.is_master) {
      return res.status(403).send('คุณไม่มีสิทธิ์แก้ไขผู้ดูแลระบบ');
    }
    try {
      const result = await pool.query('SELECT * FROM admin WHERE adminid = $1', [id]);
      if (result.rows.length === 0) return res.redirect('/admin');

      const error = req.session.error || null;
      req.session.error = null;

      return res.render('edit_user', {
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
      return res.redirect('/admin');
    }
  }

  try {
    let query = null;
    if (role === 'teacher') query = 'SELECT * FROM teacher WHERE teacherid = $1';
    else if (role === 'student') query = 'SELECT * FROM student WHERE studentid = $1';
    else return res.redirect('/admin');

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

router.post('/admin/edit/:role/:id', requireRole('admin'), async (req, res) => {
  const { role, id } = req.params;
  const { firstname, surname, username, password, email } = req.body;

  if (role === 'admin' && !req.session.user.is_master) {
    return res.status(403).send('คุณไม่มีสิทธิ์แก้ไขข้อมูลผู้ดูแลระบบ');
  }

  try {
    let query;
    let params;
    const hasPassword = password && password.trim() !== '';

    if (role === 'admin') {
      if (hasPassword) {
        query = 'UPDATE admin SET name = $1, username = $2, password = $3 WHERE adminid = $4';
        params = [firstname, username, password, id];
      } else {
        query = 'UPDATE admin SET name = $1, username = $2 WHERE adminid = $3';
        params = [firstname, username, id];
      }
    } else if (role === 'teacher') {
      if (hasPassword) {
        query = 'UPDATE teacher SET firstname = $1, surname = $2, username = $3, password = $4, email = $5 WHERE teacherid = $6';
        params = [firstname, surname, username, password, email, id];
      } else {
        query = 'UPDATE teacher SET firstname = $1, surname = $2, username = $3, email = $4 WHERE teacherid = $5';
        params = [firstname, surname, username, email, id];
      }
    } else if (role === 'student') {
      if (hasPassword) {
        query = 'UPDATE student SET firstname = $1, surname = $2, username = $3, password = $4, email = $5 WHERE studentid = $6';
        params = [firstname, surname, username, password, email, id];
      } else {
        query = 'UPDATE student SET firstname = $1, surname = $2, username = $3, email = $4 WHERE studentid = $5';
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
    if (!req.session.user.is_master) {
      return res.status(403).send('คุณไม่มีสิทธิ์ลบผู้ดูแลระบบ');
    }
    if (String(req.session.user.adminid) === String(id)) {
      req.session.error = 'คุณไม่สามารถลบบัญชีของตนเองได้';
      return res.redirect('/admin/list/admin');
    }
  }

  try {
    let query;
    if (role === 'admin') query = 'DELETE FROM admin WHERE adminid = $1';
    else if (role === 'teacher') query = 'DELETE FROM teacher WHERE teacherid = $1';
    else if (role === 'student') query = 'DELETE FROM student WHERE studentid = $1';
    else return res.redirect('/admin');

    await pool.query(query, [id]);
    res.redirect(`/admin/list/${role}`);
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการลบข้อมูล';
    res.redirect(`/admin/list/${role}`);
  }
});

//------------------------------------------------------------------
//--------------------------CLASSROOM LIST---------------------------
//------------------------------------------------------------------
router.get('/classroom', requireAnyRole(['teacher', 'student']), async (req, res) => {
  try {
    const role = req.session.role;
    let classrooms = [];

    if (role === 'teacher') {
      const teacherId = req.session.user.teacherid;
      const result = await pool.query(
        `SELECT c.*, (t.firstname || ' ' || t.surname) AS teacher_fullname
         FROM classroom c
         JOIN teacher t ON c.teacherid = t.teacherid
         WHERE c.teacherid = $1`,
        [teacherId]
      );
      classrooms = result.rows;

    } else if (role === 'student') {
      const studentId = req.session.user.studentid;
      const result = await pool.query(
        `SELECT DISTINCT c.*, (t.firstname || ' ' || t.surname) AS teacher_fullname
         FROM classroom c
         JOIN teacher t ON c.teacherid = t.teacherid
         JOIN classroom_student cs ON c.classroomid = cs.classroomid
         WHERE cs.studentid = $1`,
        [studentId]
      );
      classrooms = result.rows;

    } else {
      return res.redirect('/login');
    }

    res.render('classroom', {
      classrooms,
      role,
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: role
    });

  } catch (err) {
    console.error(err);
    res.render('classroom', {
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
//--------------------------CLASSROOM ADD/EDIT----------------------
//------------------------------------------------------------------
router.get('/classroom/add', requireRole('teacher'), (req, res) => {
  const error = req.session.error || null;
  req.session.error = null;

  res.render('addclassroom', {
    error,
    showNavbar: true,
    currentUser: req.session.user,
    currentRole: req.session.role
  });
});

router.post('/classroom/add', requireRole('teacher'), async (req, res) => {
  const { classroomname, RoomNumber, Description, MinAttendancePercent } = req.body;

  if (!classroomname || !RoomNumber || !Description || !MinAttendancePercent) {
    req.session.error = 'กรุณากรอกข้อมูลให้ครบทุกช่อง';
    return res.redirect('/classroom/add');
  }

  try {
    await pool.query(
      'INSERT INTO classroom (classroomname, roomnumber, description, minattendancepercent, teacherid) VALUES ($1, $2, $3, $4, $5)',
      [classroomname, RoomNumber, Description, MinAttendancePercent, req.session.user.teacherid]
    );
    res.redirect('/classroom');
  } catch (err) {
    console.error(err);
    res.render('addclassroom', {
      error: 'เกิดข้อผิดพลาดในการสร้างห้องเรียน',
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role
    });
  }
});

router.get('/classroom/view/:id', requireAnyRole(['teacher', 'student']), async (req, res) => {
  const classroomId = req.params.id;
  try {
    const result = await pool.query(`
      SELECT c.*, (t.firstname || ' ' || t.surname) AS teacher_fullname
      FROM classroom c
      JOIN teacher t ON c.teacherid = t.teacherid
      WHERE c.classroomid = $1
    `, [classroomId]);

    if (result.rows.length === 0) return res.redirect('/classroom');

    res.render('viewclassroom', {
      classroom: result.rows[0],
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role
    });
  } catch (err) {
    console.error(err);
    res.redirect('/classroom');
  }
});

router.get('/classroom/edit/:id', requireRole('teacher'), async (req, res) => {
  const classroomId = req.params.id;

  try {
    const result = await pool.query('SELECT * FROM classroom WHERE classroomid = $1', [classroomId]);
    if (result.rows.length === 0) {
      req.session.error = 'ไม่พบห้องเรียน';
      return res.redirect('/classroom');
    }

    res.render('editclassroom', {
      classroom: result.rows[0],
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role,
      error: req.session.error || null
    });

    req.session.error = null;
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการโหลดข้อมูลห้องเรียน';
    res.redirect('/classroom');
  }
});

router.post('/classroom/edit/:id', requireRole('teacher'), async (req, res) => {
  const { classroomname, RoomNumber, Description, MinAttendancePercent } = req.body;
  const id = req.params.id;

  if (!classroomname || !RoomNumber || !Description || !MinAttendancePercent) {
    req.session.error = 'กรุณากรอกข้อมูลให้ครบทุกช่อง';
    return res.redirect(`/classroom/edit/${id}`);
  }

  try {
    await pool.query(
      'UPDATE classroom SET classroomname=$1, roomnumber=$2, description=$3, minattendancepercent=$4 WHERE classroomid=$5',
      [classroomname, RoomNumber, Description, MinAttendancePercent, id]
    );
    res.redirect('/classroom');
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการแก้ไข';
    res.redirect(`/classroom/edit/${id}`);
  }
});

router.post('/classroom/delete/:id', requireRole('teacher'), async (req, res) => {
  const classroomId = req.params.id;
  const teacherId = req.session.user.teacherid;

  try {
    await pool.query('DELETE FROM classroom WHERE classroomid = $1 AND teacherid = $2', [classroomId, teacherId]);
    res.redirect('/classroom');
  } catch (err) {
    console.error(err);
    res.redirect('/classroom');
  }
});

//------------------------------------------------------------------
//-------------------ADD STUDENTS TO CLASSROOM----------------------
//------------------------------------------------------------------
router.get('/classroom/add-students', requireRole('teacher'), async (req, res) => {
  try {
    const teacherId = req.session.user.teacherid;
    const classroomId = req.query.classroomId;
    if (!classroomId) return res.status(400).send('กรุณาระบุรหัสชั้นเรียน');

    const classroomRes = await pool.query(
      'SELECT classroomname FROM classroom WHERE classroomid = $1 AND teacherid = $2',
      [classroomId, teacherId]
    );
    if (classroomRes.rows.length === 0) return res.status(403).send('คุณไม่มีสิทธิ์เข้าถึงชั้นเรียนนี้');

    res.render('add_student_to_classroom', {
      classroomId,
      classroomName: classroomRes.rows[0].classroomname,
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role,
      error: null
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('เกิดข้อผิดพลาดในการโหลดข้อมูล');
  }
});

router.post('/classroom/add-students', requireRole('teacher'), async (req, res) => {
  const { studentIds, classroomid } = req.body;

  try {
    const teacherId = req.session.user.teacherid;

    const classroomRes = await pool.query(
      'SELECT classroomid FROM classroom WHERE classroomid = $1 AND teacherid = $2',
      [classroomid, teacherId]
    );
    if (classroomRes.rows.length === 0) {
      const classroomNameResult = await pool.query(
        'SELECT classroomname FROM classroom WHERE classroomid = $1',
        [classroomid]
      );
      const classroomName = classroomNameResult.rows.length > 0 ? classroomNameResult.rows[0].classroomname : '';

      return res.render('add_student_to_classroom', {
        classroomId: classroomid,
        classroomName,
        error: 'คุณไม่มีสิทธิ์แก้ไขชั้นเรียนนี้',
        showNavbar: true,
        currentUser: req.session.user,
        currentRole: req.session.role
      });
    }

    const classroomId = classroomRes.rows[0].classroomid;
    const ids = (studentIds || '')
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0);

    const existing = await pool.query(
      'SELECT studentid FROM classroom_student WHERE classroomid = $1',
      [classroomId]
    );
    const existingIds = existing.rows.map(r => String(r.studentid));
    const newIds = ids.filter(id => !existingIds.includes(id));

    if (newIds.length === 0) {
      const classroomNameResult = await pool.query(
        'SELECT classroomname FROM classroom WHERE classroomid = $1',
        [classroomid]
      );
      const classroomName = classroomNameResult.rows.length > 0 ? classroomNameResult.rows[0].classroomname : '';
      return res.render('add_student_to_classroom', {
        classroomId: classroomid,
        classroomName,
        error: 'รหัสนักเรียนมีอยู่ในชั้นเรียนแล้ว',
        showNavbar: true,
        currentUser: req.session.user,
        currentRole: req.session.role
      });
    }

    for (let sid of newIds) {
      await pool.query(
        'INSERT INTO classroom_student (classroomid, studentid) VALUES ($1, $2)',
        [classroomId, sid]
      );
    }

    return res.redirect(`/classroom/${classroomId}/students`);
  } catch (err) {
    console.error('เกิด error:', err);

    const classroomNameResult = await pool.query(
      'SELECT classroomname FROM classroom WHERE classroomid = $1',
      [classroomid]
    );
    const classroomName = classroomNameResult.rows.length > 0 ? classroomNameResult.rows[0].classroomname : '';

    return res.render('add_student_to_classroom', {
      classroomId: classroomid,
      classroomName,
      error: 'รหัสนักเรียนไม่ถูกต้อง หรือไม่มีรหัสนักเรียนที่มีในระบบ',
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role
    });
  }
});

//------------------------------------------------------------------
//---------------------LIST STUDENTS IN CLASS-----------------------
//------------------------------------------------------------------
router.get('/classroom/:id/students', requireAnyRole(['teacher', 'student']), async (req, res) => {
  const classroomId = req.params.id;

  try {
    const classRes = await pool.query(
      'SELECT * FROM classroom WHERE classroomid = $1', [classroomId]
    );
    if (classRes.rows.length === 0) return res.redirect('/classroom');

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
    const classroomCheck = await pool.query(
      'SELECT 1 FROM classroom WHERE classroomid = $1 AND teacherid = $2',
      [classroomId, teacherId]
    );
    if (classroomCheck.rows.length === 0) {
      return res.status(403).send('คุณไม่มีสิทธิ์ลบนักเรียนในห้องเรียนนี้');
    }

    await pool.query(
      'DELETE FROM classroom_student WHERE classroomid = $1 AND studentid = $2',
      [classroomId, studentId]
    );

    res.redirect(`/classroom/${classroomId}/students`);
  } catch (err) {
    console.error('เกิดข้อผิดพลาดในการลบนักเรียน:', err);
    res.status(500).send('เกิดข้อผิดพลาดในการลบนักเรียน');
  }
});

//------------------------------------------------------------------
//--------------------------QR TOKEN SYSTEM-------------------------
//------------------------------------------------------------------

// ครูเปิดหน้าดู QR View
router.get('/attendance/qr-view/:classroomId', requireRole('teacher'), (req, res) => {
  res.render('qr', {
    classroomId: req.params.classroomId,
    currentUser: req.session.user,
    currentRole: req.session.role,
    showNavbar: true
  });
});

// สร้าง QR token (ครูเรียกจากหน้าดู QR ทุก 20 วิ)
router.get('/api/qr/:classroomId', requireRole('teacher'), async (req, res) => {
  const classroomId = parseInt(req.params.classroomId, 10);
  try {
    await pool.query(
      `DELETE FROM attendancetoken
       WHERE classroomid = $1
         AND (is_used = TRUE OR created_at < NOW() - INTERVAL '20 seconds')`,
      [classroomId]
    );

    const token = uuidv4();
    await pool.query(
      'INSERT INTO attendancetoken (token, classroomid) VALUES ($1, $2)',
      [token, classroomId]
    );

    res.json({ token });
  } catch (err) {
    console.error('Error generating QR token:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการสร้าง token' });
  }
});

// นักเรียนสแกน token เพื่อเช็กชื่อ
router.post('/api/scan', requireRole('student'), async (req, res) => {
  const { token } = req.body;
  const studentId = req.session.user.studentid;

  try {
    const result = await pool.query(
      `SELECT * FROM attendancetoken
       WHERE token = $1 
         AND is_used = FALSE 
         AND created_at > NOW() - INTERVAL '20 seconds'`,
      [token]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Token หมดอายุหรือถูกใช้ไปแล้ว' });
    }

    const classroomId = result.rows[0].classroomid;

    await pool.query('UPDATE attendancetoken SET is_used = TRUE WHERE token = $1', [token]);

    // บันทึกการเช็กชื่อ (upsert)
    await pool.query(
      `INSERT INTO attendance (studentid, classroomid, date, "time", status)
       VALUES ($1, $2, CURRENT_DATE, NOW()::time, 'Present')
       ON CONFLICT (studentid, classroomid, date)
       DO UPDATE SET
        "time" = EXCLUDED."time",
         status = 'Present'`,
      [studentId, classroomId, token]
    );

    res.json({ message: 'เช็กชื่อสำเร็จ', classroomId });
  } catch (err) {
    console.error('Error scanning QR token:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการสแกน token' });
  }
});

// หน้ารวม QR + รายชื่อนักเรียนของห้อง ณ วันที่เลือก
router.get('/qr/:id', requireRole('teacher'), async (req, res) => {
  const classroomId = req.params.id;
  const selectedDate = req.query.date || new Date().toISOString().split('T')[0];

  try {
    const studentQuery = await pool.query(`
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

    res.render('qr', {
      classroomId,
      students: studentQuery.rows,
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: 'teacher',
      selectedDate
    });
  } catch (err) {
    console.error('Error loading QR page:', err);
    res.status(500).send('ไม่สามารถโหลดหน้า QR ได้');
  }
});

// หน้าสแกน (นักเรียน)
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

router.post('/attendance/checkin', async (req, res) => {
  const { studentid, classroomid, token } = req.body;

  try {
    // ตรวจสอบ token ว่าใช้งานได้หรือยัง
    const result = await pool.query(
      'SELECT * FROM attendancetoken WHERE token = $1 AND classroomid = $2 AND is_used = false',
      [token, classroomid]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ message: 'Token ไม่ถูกต้อง หรือถูกใช้ไปแล้ว' });
    }

    // เพิ่มหรืออัปเดตข้อมูลการเข้าเรียน
    
await pool.query(
  `INSERT INTO attendance (studentid, classroomid, date, "time", status)
  VALUES ($1, $2, CURRENT_DATE, NOW()::time, 'Present')
  ON CONFLICT (studentid, classroomid, date)
  DO UPDATE SET
    "time" = EXCLUDED."time",
    status = 'Present'`,
  [studentid, classroomid, token]
);

    // อัปเดต token เป็นใช้งานแล้ว
    await pool.query(
      'UPDATE attendancetoken SET is_used = true WHERE token = $1',
      [token]
    );

    return res.json({ message: 'เช็กชื่อสำเร็จแล้ว' });

  } catch (err) {
    console.error('เกิดข้อผิดพลาด:', err);
    return res.status(500).json({ message: 'เกิดข้อผิดพลาดในการเช็กชื่อ' });
  }
});

// รายงานสถานะเข้าชั้น (ของครู) ตามวัน
router.get('/classroom/:id/attendance', requireRole('teacher'), async (req, res) => {
  const classroomId = req.params.id;
  const selectedDate = req.query.date || new Date().toISOString().split('T')[0];

  try {
    const result = await pool.query(
      `SELECT
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
      ORDER BY s.firstname`,
      [classroomId, selectedDate]
    );

    res.render('teacher/attendance_list', {
      students: result.rows,
      classroomId
    });

  } catch (err) {
    console.error(err);
    res.status(500).send('เกิดข้อผิดพลาดในการโหลดข้อมูล');
  }
});

// เลือกวันที่ไปหน้า QR
router.get('/classroom/:id/select-date', async (req, res) => {
  const { id } = req.params;
  res.render('select_date', {
    classroomId: id,
    currentUser: req.session.user,
    currentRole: req.session.role
  });
});

router.post('/classroom/:id/generate-token', async (req, res) => {
  const classroomId = req.params.id;
  const selectedDate = req.body.date || new Date().toISOString().split('T')[0];
  return res.redirect(`/qr/${classroomId}?date=${selectedDate}`);
});

// (ทางเลือก) สร้าง QR สำหรับลิงก์ยืนยัน token แบบ URL เต็ม
router.get('/generate-qr/:classroomId', requireRole('teacher'), async (req, res) => {
  try {
    const classroomId = parseInt(req.params.classroomId, 10);
    const token = uuidv4();
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = `${baseUrl}/attendance/confirm/${token}`;
    const qrCode = await qr.toDataURL(url);

    await pool.query(
      'INSERT INTO attendance (token, classroomid, created_at) VALUES ($1, $2, NOW())',
      [token, classroomId]
    );

    res.render('qr', {
      qrCode,
      qrUrl: url,
      classroomId,
      currentUser: req.session.user,
      currentRole: req.session.role,
      showNavbar: true
    });

  } catch (err) {
    console.error('❌ Error generating QR:', err);
    res.status(500).send('เกิดข้อผิดพลาดในการสร้าง QR');
  }
});

// (ถ้า flow นี้ไม่ใช้ ให้ลบบล็อกนี้ได้)
// ยืนยันการเช็กชื่อผ่านลิงก์ token (ตัวอย่าง mapping ให้ตรงสคีมา)
router.get('/attendance/confirm/:token', async (req, res) => {
  const token = req.params.token;
  const student = req.session.user;
  if (!student) return res.redirect('/login');

  const result = await pool.query(
    `SELECT a.attendanceid, c.classroomid, c.classroomname
       FROM attendance a
       JOIN classroom c ON a.classroomid = c.classroomid
      WHERE a.token = $1`,
    [token]
  );
  if (result.rowCount === 0) return res.status(404).send('ไม่พบข้อมูลการเช็คชื่อ');

  const { attendanceid, classroomid, classroomname } = result.rows[0];

  const check = await pool.query(
    `SELECT 1 FROM classroom_student
      WHERE classroomid = $1 AND studentid = $2`,
    [classroomid, student.studentid]
  );
  if (check.rowCount === 0) {
    return res.render('not_enrolled', {
      classroomName: classroomname,
      studentName: (student.firstname || '') + ' ' + (student.surname || '')
    });
  }

  const now = new Date();
  const date = now.toLocaleDateString('th-TH');
  const time = now.toLocaleTimeString('th-TH');

  res.render('attendance_confirm', {
    attendanceId: attendanceid,
    classroom: { name: classroomname },
    date,
    time,
    student
  });
});

module.exports = router;
