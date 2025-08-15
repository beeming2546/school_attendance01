const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { requireRole, requireAnyRole, requireMasterAdmin } = require('../middlewares/auth');
const qr = require('qrcode');
const { v4: uuidv4 } = require('uuid');

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
    return res.status(403).send('คุณไม่มีสิทธิ์เข้าถึงรายชื่อผู้ดูแลระบบ');
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


// รายชื่อครู
router.get('/admin/list/teacher', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM Teacher ORDER BY TeacherId ASC');
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

//  รายชื่อนักเรียน
router.get('/admin/list/student', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM Student ORDER BY StudentId ASC');
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
//--------------------------FORM ADD/EDIT USER----------------------
//------------------------------------------------------------------
router.get('/admin/add/:role', requireRole('admin'), (req, res) => {
  const { role } = req.params;

  // ถ้าจะเพิ่ม admin แต่ไม่ใช่ master admin
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

  // ถ้าจะเพิ่ม admin แต่ไม่ใช่ master admin
  if (role === 'admin' && !req.session.user.is_master) {
    return res.status(403).send('คุณไม่มีสิทธิ์เพิ่มผู้ดูแลระบบ');
  }

  // เช็คช่องว่างเบื้องต้น
  if (!id || !firstname || !username || !password || (role !== 'admin' && (!surname || !email))) {
    req.session.error = 'กรุณากรอกข้อมูลให้ครบทุกช่อง';
    return res.redirect(`/admin/add/${role}`);
  }

  try {
    let checkQuery = '';
    let checkParams = [];

    if (role === 'admin') {
      checkQuery = 'SELECT 1 FROM Admin WHERE AdminId = $1 OR Username = $2';
      checkParams = [id, username];
    } else if (role === 'teacher') {
      checkQuery = 'SELECT 1 FROM Teacher WHERE TeacherId = $1 OR Username = $2 OR Email = $3';
      checkParams = [id, username, email];
    } else if (role === 'student') {
      checkQuery = 'SELECT 1 FROM Student WHERE StudentId = $1 OR Username = $2 OR Email = $3';
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
      insertQuery = 'INSERT INTO Admin (AdminId, Name, Username, Password) VALUES ($1, $2, $3, $4)';
      insertParams = [id, firstname, username, password];
    } else if (role === 'teacher') {
      insertQuery = 'INSERT INTO Teacher (TeacherId, firstname, Surname, Username, Password, Email) VALUES ($1, $2, $3, $4, $5, $6)';
      insertParams = [id, firstname, surname, username, password, email];
    } else if (role === 'student') {
      insertQuery = 'INSERT INTO Student (StudentId, firstname, Surname, Username, Password, Email) VALUES ($1, $2, $3, $4, $5, $6)';
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

  // ถ้าแก้ไข admin แต่ user ไม่ใช่ master admin ห้ามบันทึก
  if (role === 'admin' && !req.session.user.is_master) {
    return res.status(403).send('คุณไม่มีสิทธิ์แก้ไขข้อมูลผู้ดูแลระบบ');
  }

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
    let classrooms = [];

    if (role === 'teacher') {
      const teacherId = req.session.user.teacherid;
      const result = await pool.query(
        `SELECT c.*, CONCAT(t.firstname, ' ', t.surname) AS teacher_fullname
         FROM Classroom c
         JOIN Teacher t ON c.teacherid = t.teacherid
         WHERE c.teacherid = $1`,
        [teacherId]
      );
      classrooms = result.rows;

    } else if (role === 'student') {
      const studentId = req.session.user.studentid;

      const result = await pool.query(
        `SELECT DISTINCT c.*, CONCAT(t.firstname, ' ', t.surname) AS teacher_fullname
         FROM Classroom c
         JOIN Teacher t ON c.teacherid = t.teacherid
         JOIN Classroom_Student cs ON c.classroomid = cs.classroomid
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
//--------------------------ADD CLASSROOM---------------------------
//------------------------------------------------------------------
// GET: แสดงฟอร์มสร้างห้องเรียน (เฉพาะครู)
router.get('/classroom/add', requireRole('teacher'), (req, res) => {
  const error = req.session.error || null;
  req.session.error = null;

  res.render('addclassroom', {
    error,
    showNavbar: true,
    currentUser: req.session.user,   // เปลี่ยนจาก user เป็น currentUser
    currentRole: req.session.role    // เปลี่ยนจาก role เป็น currentRole
  });
});


// POST: บันทึก classroom ใหม่ (เฉพาะครู)
router.post('/classroom/add', requireRole('teacher'), async (req, res) => {
  const { ClassroomName, RoomNumber, Description, MinAttendancePercent } = req.body;

  if (!ClassroomName || !RoomNumber || !Description || !MinAttendancePercent) {
    req.session.error = 'กรุณากรอกข้อมูลให้ครบทุกช่อง';
    return res.redirect('/classroom/add');
  }

  try {
    await pool.query(
      'INSERT INTO Classroom (ClassroomName, RoomNumber, Description, MinAttendancePercent, TeacherId) VALUES ($1, $2, $3, $4, $5)',
      [ClassroomName, RoomNumber, Description, MinAttendancePercent, req.session.user.teacherid]
    );
    res.redirect('/classroom');
  } catch (err) {
    console.error(err);
    // ถ้าเกิด error ตอน insert แล้วอยากให้แสดง error พร้อม navbar:
    res.render('addclassroom', {
      error: 'เกิดข้อผิดพลาดในการสร้างห้องเรียน',
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role
    });
  }
});

//------------------------------------------------------------------
//--------------------------VIEW CLASSROOM---------------------------
//------------------------------------------------------------------
router.get('/classroom/view/:id', requireAnyRole(['teacher', 'student']), async (req, res) => {
  const classroomId = req.params.id;
  try {
    const result = await pool.query(`
      SELECT c.*, t.firstname || ' ' || t.surname AS teacher_fullname
      FROM Classroom c
      JOIN Teacher t ON c.teacherid = t.teacherid
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

//------------------------------------------------------------------
//--------------------------EDIT CLASSROOM---------------------------
//------------------------------------------------------------------

router.get('/classroom/edit/:id', requireRole('teacher'), async (req, res) => {
  const classroomId = req.params.id;

  try {
    const result = await pool.query('SELECT * FROM Classroom WHERE ClassroomId = $1', [classroomId]);
    if (result.rows.length === 0) {
      req.session.error = 'ไม่พบห้องเรียน';
      return res.redirect('/classroom');
    }

    res.render('editclassroom', {
      classroom: result.rows[0],
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role,
      error: req.session.error || null   // ✅ เพิ่มบรรทัดนี้
    });

    req.session.error = null; // ✅ ล้างหลังแสดงแล้ว
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการโหลดข้อมูลห้องเรียน';
    res.redirect('/classroom');
  }
});
// POST: แก้ไขห้องเรียน
router.post('/classroom/edit/:id', requireRole('teacher'), async (req, res) => {
  const { ClassroomName, RoomNumber, Description, MinAttendancePercent } = req.body;
  const id = req.params.id;

  if (!ClassroomName || !RoomNumber || !Description || !MinAttendancePercent) {
    req.session.error = 'กรุณากรอกข้อมูลให้ครบทุกช่อง';
    return res.redirect(`/classroom/edit/${id}`);
  }

  try {
    await pool.query(
      'UPDATE Classroom SET ClassroomName=$1, RoomNumber=$2, Description=$3, MinAttendancePercent=$4 WHERE ClassroomId=$5',
      [ClassroomName, RoomNumber, Description, MinAttendancePercent, id]
    );
    res.redirect('/classroom');
  } catch (err) {
    console.error(err);
    req.session.error = 'เกิดข้อผิดพลาดในการแก้ไข';
    res.redirect(`/classroom/edit/${id}`);
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
    const teacherId = req.session.user.teacherid;
    const classroomId = req.query.classroomId;

    if (!classroomId) {
      return res.status(400).send('กรุณาระบุรหัสชั้นเรียน');
    }

    // Query ชื่อห้องเรียน จากตาราง Classroom ตาม TeacherId และ ClassroomId
    const classroomRes = await pool.query(
      'SELECT ClassroomName FROM Classroom WHERE ClassroomId = $1 AND TeacherId = $2',
      [classroomId, teacherId]
    );

    if (classroomRes.rows.length === 0) {
      return res.status(403).send('คุณไม่มีสิทธิ์เข้าถึงชั้นเรียนนี้');
    }

    res.render('add_student_to_classroom', {
  classroomId,
  classroomName: classroomRes.rows[0].classroomname, // ✅ ใช้ lowercase
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
  const { studentIds, ClassroomId } = req.body;

  try {
    const teacherId = req.session.user.teacherid;

    const classroomRes = await pool.query(
      'SELECT classroomid FROM classroom WHERE classroomid = $1 AND teacherid = $2',
      [ClassroomId, teacherId]
    );

    if (classroomRes.rows.length === 0) {
      // render หน้าเดิม
      const classroomNameResult = await pool.query(
        'SELECT classroomname FROM classroom WHERE classroomid = $1',
        [ClassroomId]
      );
      const classroomName = classroomNameResult.rows.length > 0 ? classroomNameResult.rows[0].classroomname : '';

      return res.render('add_student_to_classroom', {
        classroomId: ClassroomId,
        classroomName,
        error: 'คุณไม่มีสิทธิ์แก้ไขชั้นเรียนนี้',
        showNavbar: true,
        currentUser: req.session.user,
        currentRole: req.session.role,
      });
    }

    const classroomId = classroomRes.rows[0].classroomid;

    const ids = studentIds
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0);

    const existing = await pool.query(
      'SELECT studentid FROM classroom_student WHERE classroomid = $1',
      [classroomId]
    );

    const existingIds = existing.rows.map(row => row.studentid.toString());

    const newIds = ids.filter(id => !existingIds.includes(id));

    if (newIds.length === 0) {
      const classroomNameResult = await pool.query(
        'SELECT classroomname FROM classroom WHERE classroomid = $1',
        [ClassroomId]
      );
      const classroomName = classroomNameResult.rows.length > 0 ? classroomNameResult.rows[0].classroomname : '';

      return res.render('add_student_to_classroom', {
        classroomId: ClassroomId,
        classroomName,
        error: 'รหัสนักเรียนมีอยู่ในชั้นเรียนแล้ว',
        showNavbar: true,
        currentUser: req.session.user,
        currentRole: req.session.role,
      });
    }

    for (let studentId of newIds) {
      await pool.query(
        'INSERT INTO classroom_student (classroomid, studentid) VALUES ($1, $2)',
        [classroomId, studentId]
      );
    }

    return res.redirect(`/classroom/${classroomId}/students`);
  } catch (err) {
    console.error('เกิด error:', err);

    const classroomNameResult = await pool.query(
      'SELECT classroomname FROM classroom WHERE classroomid = $1',
      [ClassroomId]
    );
    const classroomName = classroomNameResult.rows.length > 0 ? classroomNameResult.rows[0].classroomname : '';

    return res.render('add_student_to_classroom', {
      classroomId: ClassroomId,
      classroomName,
      error: 'รหัสนักเรียนไม่ถูกต้อง หรือไม่มีรหัสนักเรียนที่มีในระบบ',
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role,
    });
  }
});

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

    // ดึงรายชื่อนักเรียนในห้อง
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
      return res.status(403).send('คุณไม่มีสิทธิ์ลบนักเรียนในห้องเรียนนี้');
    }

    // ลบนักเรียนจากห้องเรียน
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
// นักเรียนสแกน → ตรวจ token แล้วบอกให้ไปหน้า confirm
router.post('/api/scan', requireRole('student'), async (req, res) => {
  try {
    // 1) รับค่าที่สแกนได้
    const raw = (req.body.token || '').toString().trim();

    // 2) รองรับทั้งกรณีส่งมาเป็น URL หรือเป็น token เปล่า
    const m = raw.match(/\/attendance\/confirm\/([A-Za-z0-9-]{10,})/i);
    const token = m ? m[1] : raw;

    // 3) ตรวจ token ยังใช้ได้ (ยังไม่ถูกใช้ + ยังไม่หมดอายุ)
    const q = await pool.query(
      `SELECT classroomid
         FROM attendancetoken
        WHERE token = $1
          AND is_used = FALSE
          AND created_at > NOW() - INTERVAL '90 seconds'`,
      [token]
    );

    if (q.rowCount === 0) {
      return res.status(400).json({ error: 'Token หมดอายุหรือถูกใช้ไปแล้ว' });
    }

    // ✅ ไม่บันทึก attendance ตรงนี้
    // ✅ ไม่ mark is_used ตรงนี้
    // แค่ส่ง URL ให้ฝั่ง client ไปหน้า confirm
    return res.json({ redirect: `/attendance/confirm/${token}` });
  } catch (e) {
    console.error('api/scan redirect error:', e);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
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

// ✅ เลือกวันที่ไปหน้า QR (เหลือครั้งเดียวพอ)
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

// (ถ้า flow นี้ไม่ใช้ ให้ลบบล็อกนี้ได้)
// ยืนยันการเช็กชื่อผ่านลิงก์ token (ตัวอย่าง mapping ให้ตรงสคีมา)
// ========== หน้ายืนยันการเช็คชื่อ (นักเรียนกดจากลิงก์ใน QR) ==========
// GET /attendance/confirm/:token — แสดงหน้ายืนยันหลังสแกน (ยังไม่บันทึก)
router.get('/attendance/confirm/:token', requireRole('student'), async (req, res) => {
  const { token } = req.params;
  const student = req.session.user; // ต้องมี studentid ใน session

  // กันเคส session หลุด
  if (!student || !student.studentid) {
    return res.redirect('/login');
  }

  try {
    console.log('CONFIRM token =', token, ' studentid =', student.studentid);

    // 1) หา token -> classroom (ขยายหน้าต่างเวลาได้ตามต้องการ: 20/60/90 วินาที)
    const tok = await pool.query(
      `
      SELECT t.classroomid, c.classroomname
      FROM attendancetoken t
      JOIN classroom c ON c.classroomid = t.classroomid
      WHERE t.token = $1
        AND t.is_used = FALSE
        AND t.created_at > NOW() - INTERVAL '20 seconds'
      `,
      [token]
    );

    if (tok.rowCount === 0) {
      return res.status(400).send('Token ไม่ถูกต้องหรือหมดอายุ');
    }

    const { classroomid, classroomname } = tok.rows[0];

    // 2) นักเรียนต้องอยู่ในห้องนี้
    const belong = await pool.query(
      `SELECT 1 FROM classroom_student WHERE classroomid = $1 AND studentid = $2`,
      [classroomid, student.studentid]
    );

    if (belong.rowCount === 0) {
      // ส่งตัวแปร navbar ให้ EJS ด้วย กัน error currentUser/currentRole
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

    // 3) เตรียมข้อมูลแสดงตามภาพ 3.10
    const now = new Date();
    const dateTH = now.toLocaleDateString('th-TH');
    const timeTH = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

    // ✅ render หน้ายืนยัน (EJS ควรอ่านตัวแปรเหล่านี้)
    return res.render('attendance_confirm', {
      classroomName: classroomname,
      date: dateTH,
      time: timeTH,
      studentId: student.studentid,
      token, // ส่ง token ไว้ให้ฟอร์ม POST /attendance/confirm ใช้ตอนบันทึกจริง
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role
    });
  } catch (err) {
    console.error('confirm error:', err);
    return res.status(500).send('เกิดข้อผิดพลาดในการโหลดหน้ายืนยัน');
  }
});


// ========== กดปุ่ม "ยืนยันการเช็คชื่อ" ==========
router.post('/attendance/confirm', requireRole('student'), async (req, res) => {
  const token = req.body.token;
  const student = req.session.user;

  try {
    // 1) ตรวจ token อีกรอบ (กันเปลี่ยนฟอร์ม)
    const tok = await pool.query(`
      SELECT classroomid
      FROM attendancetoken
      WHERE token = $1 AND is_used = FALSE
        AND created_at > NOW() - INTERVAL '20 seconds'
    `, [token]);
    if (tok.rowCount === 0) {
      return res.status(400).send('Token ไม่ถูกต้องหรือหมดอายุ');
    }
    const classroomId = tok.rows[0].classroomid;

    // 2) กันเช็คชื่อซ้ำในวันเดียวกัน
    const exist = await pool.query(
      `SELECT 1 FROM attendance
        WHERE classroomid = $1 AND studentid = $2 AND date = CURRENT_DATE`,
      [classroomId, student.studentid]
    );
    if (exist.rowCount > 0) {
      // ไม่ต้อง mark used เพื่อให้คนอื่นยังใช้ได้ภายในเวลา
      return res.send('คุณได้เช็คชื่อไปแล้วในวันนี้');
    }

    // 3) บันทึกเช็คชื่อ
    await pool.query(
  `INSERT INTO attendance (studentid, classroomid, date, time, status)
   VALUES ($1, $2, CURRENT_DATE, NOW(), 'Present')`,
  [student.studentid, classroomId]
);

    // 4) ทำให้ token นี้ใช้แล้ว (กันยิงซ้ำ)
    await pool.query(`UPDATE attendancetoken SET is_used = TRUE WHERE token = $1`, [token]);

    return res.send('✅ เช็คชื่อสำเร็จ');
  } catch (err) {
    console.error('submit confirm error:', err);
    return res.status(500).send('เกิดข้อผิดพลาดในการบันทึกการเช็คชื่อ');
  }
});


// รายงานประวัติการเช็คชื่อรายวัน (ผู้สอน)
router.get('/classroom/:id/history', requireRole('teacher'), async (req, res) => {
  const classroomId = req.params.id;
  const teacherId   = req.session.user.teacherid;
  const selectedDate = (req.query.date || new Date().toISOString().slice(0,10)); // YYYY-MM-DD

  // แปลง YYYY-MM-DD -> DD/MM/YYYY (ให้เหมือนในเอกสาร)
  const [y, m, d] = selectedDate.split('-');
  const displayDate = `${d}/${m}/${y}`;

  try {
    const classRes = await pool.query(
      `SELECT classroomid, classroomname
       FROM classroom
       WHERE classroomid = $1 AND teacherid = $2`,
      [classroomId, teacherId]
    );
    if (classRes.rows.length === 0) return res.status(403).send('คุณไม่มีสิทธิ์เข้าถึงชั้นเรียนนี้');

    // ✅ เลือก firstname, surname แยกคอลัมน์ และใช้ a.time เป็นเวลาเช็คชื่อ
    const detailsRes = await pool.query(`
      SELECT
        s.studentid,
        s.firstname,
        s.surname,
        COALESCE(a.status, 'Absent') AS status,
        TO_CHAR(a.time, 'HH24:MI')   AS checkin_time
      FROM classroom_student cs
      JOIN student s ON cs.studentid = s.studentid
      LEFT JOIN attendance a
        ON a.studentid = s.studentid
       AND a.classroomid = cs.classroomid
       AND a.date = $2
      WHERE cs.classroomid = $1
      ORDER BY s.studentid ASC
    `, [classroomId, selectedDate]);

    const totalStudents = detailsRes.rows.length;
const presentCount  = detailsRes.rows.filter(r => r.status === 'Present').length;
const absentCount   = totalStudents - presentCount;

// 👉 ถ้าไม่มีใครมาเรียนเลย
const hasAnyAttendance = presentCount > 0;

res.render('teacher_history_by_date', {
  classroom: classRes.rows[0],
  selectedDate,
  displayDate,
  totalStudents,
  presentCount,
  absentCount,
  students: detailsRes.rows,
  hasAnyAttendance,       // << ส่งไปที่ EJS
  showNavbar: true,
  currentUser: req.session.user,
  currentRole: req.session.role
});

  } catch (err) {
    console.error('history error:', err);
    res.status(500).send('เกิดข้อผิดพลาดในการโหลดรายงาน');
  }
});

// คะแนนการเช็คชื่อ "ทั้งห้อง" (ฝั่งอาจารย์)
router.get('/classroom/:id/attendance-scores', requireRole('teacher'), async (req, res) => {
  const classroomId = req.params.id;
  const teacherId   = req.session.user.teacherid;

  try {
    // 1) ตรวจสิทธิ์ห้องเรียน
    const c = await pool.query(
      `SELECT classroomid, classroomname, minattendancepercent
         FROM classroom
        WHERE classroomid = $1 AND teacherid = $2`,
      [classroomId, teacherId]
    );
    if (c.rows.length === 0) return res.status(403).send('คุณไม่มีสิทธิ์เข้าถึงชั้นเรียนนี้');
    const classroom = c.rows[0];
    const minPercent = classroom.minattendancepercent || 0;

    // 2) นับจำนวนคาบ/วัน ที่มีการเช็คชื่อในห้องนี้ทั้งหมด
    const totalRes = await pool.query(
      `SELECT COUNT(DISTINCT date)::int AS total_sessions
         FROM attendance
        WHERE classroomid = $1`,
      [classroomId]
    );
    const totalSessions = totalRes.rows[0].total_sessions;

    // 3) รวมสถิติของนักเรียนทุกคนในห้อง
    //   - present_count / late_count / leave_count ต่อคน
    const statsRes = await pool.query(`
      SELECT
        s.studentid,
        s.firstname,
        s.surname,
        COUNT(a.*) FILTER (WHERE a.status = 'Present')::int AS present_count,
        COUNT(a.*) FILTER (WHERE a.status = 'Late')::int    AS late_count,
        COUNT(a.*) FILTER (WHERE a.status = 'Leave')::int   AS leave_count
      FROM classroom_student cs
      JOIN student s ON s.studentid = cs.studentid
      LEFT JOIN attendance a
        ON a.classroomid = cs.classroomid
       AND a.studentid   = s.studentid
      WHERE cs.classroomid = $1
      GROUP BY s.studentid, s.firstname, s.surname
      ORDER BY s.studentid
    `, [classroomId]);

    // 4) คำนวณ absent + เปอร์เซ็นต์ + ผลผ่าน/ไม่ผ่าน ต่อคน
    const rows = statsRes.rows.map(r => {
      const present = r.present_count || 0;
      const late    = r.late_count    || 0;
      const leave   = r.leave_count   || 0;
      const absent  = Math.max(0, totalSessions - (present + late + leave));
      const percent = totalSessions > 0 ? Math.round((present / totalSessions) * 100) : 0; // นับเฉพาะ Present
      const isPass  = percent >= minPercent;

      return {
        studentid: r.studentid,
        firstname: r.firstname,
        surname:   r.surname,
        present, absent, percent, isPass
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

// คะแนนการเช็คชื่อของ "นักเรียนที่ล็อกอินอยู่" ในห้องนี้
router.get('/student/classroom/:id/attendance-score', requireRole('student'), async (req, res) => {
  const classroomId = req.params.id;
  const studentId   = req.session.user.studentid;

  try {
    // นักเรียนต้องอยู่ในห้องนี้
    const belong = await pool.query(
      `SELECT 1 FROM classroom_student WHERE classroomid = $1 AND studentid = $2`,
      [classroomId, studentId]
    );
    if (belong.rowCount === 0) return res.status(403).send('คุณไม่ได้อยู่ในชั้นเรียนนี้');

    // ข้อมูลห้อง
    const cls = await pool.query(
      `SELECT classroomid, classroomname, minattendancepercent
         FROM classroom
        WHERE classroomid = $1`,
      [classroomId]
    );
    if (cls.rowCount === 0) return res.redirect('/classroom');
    const classroom  = cls.rows[0];
    const minPercent = classroom.minattendancepercent || 0;

    // จำนวนคาบที่มีการเช็คชื่อทั้งหมดของห้องนี้
    const totalRes = await pool.query(
      `SELECT COUNT(DISTINCT date)::int AS total_sessions
         FROM attendance
        WHERE classroomid = $1`,
      [classroomId]
    );
    const totalSessions = totalRes.rows[0].total_sessions;

    // นับสถิติของนักเรียนคนนี้
    const presentRes = await pool.query(
      `SELECT COUNT(*)::int AS c
         FROM attendance
        WHERE classroomid = $1 AND studentid = $2 AND status = 'Present'`,
      [classroomId, studentId]
    );
    const lateRes = await pool.query(
      `SELECT COUNT(*)::int AS c
         FROM attendance
        WHERE classroomid = $1 AND studentid = $2 AND status = 'Late'`,
      [classroomId, studentId]
    );
    const leaveRes = await pool.query(
      `SELECT COUNT(*)::int AS c
         FROM attendance
        WHERE classroomid = $1 AND studentid = $2 AND status = 'Leave'`,
      [classroomId, studentId]
    );

    const present = presentRes.rows[0].c;
    const late    = lateRes.rows[0].c;
    const leave   = leaveRes.rows[0].c;

    const absent  = Math.max(0, totalSessions - (present + late + leave));

    // % เข้าเรียน (นับเฉพาะ Present; ถ้าจะนับสาย/ลาเป็นมาให้เปลี่ยนเป็น present+late+leave)
    const percent = totalSessions > 0 ? Math.round((present / totalSessions) * 100) : 0;
    const isPass  = percent >= minPercent;

    res.render('student_attendance_score', {
      classroom,
      totalSessions,
      present,
      absent,
      percent,
      minPercent,
      isPass,
      hasAnySession: totalSessions > 0,
      showNavbar: true,
      currentUser: req.session.user,
      currentRole: req.session.role
    });
  } catch (err) {
    console.error('student self-score error:', err);
    res.status(500).send('เกิดข้อผิดพลาดในการโหลดข้อมูลคะแนน');
  }
});

// ประวัติการเช็คชื่อของ "นักเรียนที่ล็อกอินอยู่" ในห้องนี้
router.get('/student/classroom/:id/attendance-history', requireRole('student'), async (req, res) => {
  const classroomId = req.params.id;
  const studentId   = req.session.user.studentid;

  try {
    // ต้องเป็นนักเรียนในห้องนี้
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

module.exports = router;
