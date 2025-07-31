function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.role !== role) {
      return res.redirect('/login');
    }
    next();
  };
}

function requireAnyRole(roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.role)) {
      return res.redirect('/login');
    }
    next();
  };
}

// เพิ่ม middleware ตรวจสอบ admin ที่เป็น master เท่านั้น
function requireMasterAdmin(req, res, next) {
  if (!req.session.user || req.session.role !== 'admin' || !req.session.user.is_master) {
    return res.status(403).send('คุณไม่มีสิทธิ์เข้าถึงหน้านี้');
  }
  next();
}

module.exports = { requireRole, requireAnyRole, requireMasterAdmin };
