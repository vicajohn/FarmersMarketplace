const router = require('express').Router();
const db = require('../db/schema');
const auth = require('../middleware/auth');
const { err } = require('../middleware/error');

// GET /api/analytics/farmer
router.get('/farmer', auth, async (req, res) => {
  if (req.user.role !== 'farmer') return err(res, 403, 'Farmers only', 'forbidden');
  const farmerId = req.user.id;

  const { rows: totalsRows } = await db.query(
    `SELECT COUNT(*) as order_count, COALESCE(SUM(o.total_price), 0) as total_revenue
     FROM orders o JOIN products p ON o.product_id = p.id
     WHERE p.farmer_id = $1 AND o.status = 'paid'`,
    [farmerId]
  );

  const { rows: topProducts } = await db.query(
    `SELECT p.name, COALESCE(SUM(o.total_price), 0) as revenue, COUNT(*) as orders
     FROM orders o JOIN products p ON o.product_id = p.id
     WHERE p.farmer_id = $1 AND o.status = 'paid'
     GROUP BY p.id, p.name ORDER BY revenue DESC LIMIT 5`,
    [farmerId]
  );

  const { rows: monthly } = await db.query(
    `SELECT TO_CHAR(o.created_at, 'YYYY-MM') as month,
            COALESCE(SUM(o.total_price), 0) as revenue, COUNT(*) as orders
     FROM orders o JOIN products p ON o.product_id = p.id
     WHERE p.farmer_id = $1 AND o.status = 'paid'
       AND o.created_at >= NOW() - INTERVAL '6 months'
     GROUP BY month ORDER BY month ASC`,
    [farmerId]
  );

  res.json({
    success: true,
    data: {
      total_revenue: totalsRows[0].total_revenue,
      order_count: totalsRows[0].order_count,
      top_products: topProducts,
      monthly,
    },
  });
});

// GET /api/analytics/farmer/forecast
router.get('/farmer/forecast', auth, async (req, res) => {
  if (req.user.role !== 'farmer') return err(res, 403, 'Farmers only', 'forbidden');

  const farmerId = req.user.id;
  const query = db.isPostgres
    ? `SELECT p.id AS product_id,
              p.name AS product_name,
              DATE_TRUNC('week', o.created_at) AS week_start,
              SUM(o.quantity) AS units_sold
       FROM products p
       LEFT JOIN orders o ON o.product_id = p.id
         AND o.status = 'paid'
         AND o.created_at >= NOW() - INTERVAL '8 weeks'
       WHERE p.farmer_id = $1
       GROUP BY p.id, p.name, week_start
       ORDER BY p.id, week_start ASC`
    : `SELECT p.id AS product_id,
              p.name AS product_name,
              strftime('%Y-%W', o.created_at) AS week_key,
              SUM(o.quantity) AS units_sold
       FROM products p
       LEFT JOIN orders o ON o.product_id = p.id
         AND o.status = 'paid'
         AND o.created_at >= datetime('now', '-56 days')
       WHERE p.farmer_id = ?
       GROUP BY p.id, p.name, week_key
       ORDER BY p.id, week_key ASC`;

  const { rows } = await db.query(query, [farmerId]);

  const byProduct = new Map();
  for (const row of rows) {
    if (!byProduct.has(row.product_id)) {
      byProduct.set(row.product_id, {
        product_id: row.product_id,
        product_name: row.product_name,
        weeks: [],
      });
    }
    if (row.units_sold != null) {
      byProduct.get(row.product_id).weeks.push(Number(row.units_sold));
    }
  }

  const forecast = [];
  for (const [, p] of byProduct.entries()) {
    const weekCount = p.weeks.length;
    if (weekCount < 2) {
      forecast.push({
        product_id: p.product_id,
        product_name: p.product_name,
        avg_weekly_sales: null,
        trend: 'stable',
        note: 'Insufficient data',
      });
      continue;
    }

    const sum = p.weeks.reduce((acc, v) => acc + v, 0);
    const avg = sum / weekCount;

    const half = Math.floor(weekCount / 2);
    const firstHalfAvg = p.weeks.slice(0, half).reduce((a, v) => a + v, 0) / half;
    const secondHalfAvg = p.weeks.slice(half).reduce((a, v) => a + v, 0) / (weekCount - half);
    const delta = secondHalfAvg - firstHalfAvg;
    const threshold = Math.max(1, firstHalfAvg * 0.1);

    let trend = 'stable';
    if (delta > threshold) trend = 'up';
    if (delta < -threshold) trend = 'down';

    forecast.push({
      product_id: p.product_id,
      product_name: p.product_name,
      avg_weekly_sales: Number(avg.toFixed(2)),
      trend,
    });
  }

  res.json({ success: true, data: forecast });
});

module.exports = router;
