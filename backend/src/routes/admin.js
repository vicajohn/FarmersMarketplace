const router = require('express').Router();
const db = require('../db/schema');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');

router.use(auth, adminAuth);

// GET /api/admin/users
router.get('/users', async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page || '1'));
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '20')));
  const offset = (page - 1) * limit;

  const { rows: countRows } = await db.query('SELECT COUNT(*) as count FROM users');
  const total = parseInt(countRows[0].count);

  const { rows: users } = await db.query(
    'SELECT id, name, email, role, stellar_public_key, created_at, active FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  res.json({ success: true, data: users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req, res) => {
  const { rows } = await db.query('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
  if (rows[0].role === 'admin') return res.status(400).json({ success: false, error: 'Cannot deactivate another admin' });
  await db.query('UPDATE users SET active = 0 WHERE id = $1', [req.params.id]);
  res.json({ success: true, message: 'User deactivated' });
});

// GET /api/admin/stats
router.get('/stats', async (_req, res) => {
  const { rows: u } = await db.query('SELECT COUNT(*) as count FROM users');
  const { rows: p } = await db.query('SELECT COUNT(*) as count FROM products');
  const { rows: o } = await db.query('SELECT COUNT(*) as count FROM orders');
  const { rows: r } = await db.query(`SELECT COALESCE(SUM(total_price), 0) as total FROM orders WHERE status = 'paid'`);
  res.json({ success: true, data: { users: parseInt(u[0].count), products: parseInt(p[0].count), orders: parseInt(o[0].count), total_revenue_xlm: r[0].total } });
});

// GET /api/admin/farmers/pending - Get farmers pending verification
router.get('/farmers/pending', async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, name, email, verification_status, verification_docs, created_at
     FROM users
     WHERE role = 'farmer' AND verification_status = 'pending'
     ORDER BY created_at ASC`
  );
  res.json({ success: true, data: rows });
});

// PATCH /api/admin/farmers/:id/verify - Approve or reject verification
router.patch('/farmers/:id/verify', async (req, res) => {
  const { status, reason } = req.body;
  
  if (!['verified', 'rejected'].includes(status)) {
    return res.status(400).json({ success: false, error: 'status must be verified or rejected', code: 'validation_error' });
  }

  const { rows } = await db.query('SELECT id, name, email, role FROM users WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ success: false, error: 'User not found' });
  if (rows[0].role !== 'farmer') return res.status(400).json({ success: false, error: 'User is not a farmer' });

  await db.query('UPDATE users SET verification_status = $1 WHERE id = $2', [status, req.params.id]);

  // Send notification email
  const mailer = require('../utils/mailer');
  const farmer = rows[0];
  const subject = status === 'verified' ? '✅ Farmer Verification Approved' : '❌ Farmer Verification Rejected';
  const message = status === 'verified'
    ? `Hello ${farmer.name},\n\nYour farmer verification has been approved! You now have a verified badge on your profile.\n\nThank you for being part of our trusted community.\n\nBest regards,\nFarmers Marketplace`
    : `Hello ${farmer.name},\n\nYour farmer verification request has been reviewed and could not be approved at this time.\n\n${reason ? `Reason: ${reason}` : ''}\n\nPlease contact support if you have questions.\n\nBest regards,\nFarmers Marketplace`;

  mailer.sendMail({ to: farmer.email, subject, text: message })
    .catch(e => console.error('[Admin] Failed to send verification email:', e.message));

  res.json({ success: true, message: `Farmer ${status}` });
});

module.exports = router;
