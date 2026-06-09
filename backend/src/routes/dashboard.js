// dashboard.js
const router = require('express').Router();
const { pool } = require('../config/db');
const { requireRole } = require('../middleware/auth');

router.get('/', async (req, res) => {
  try {
    const { funnel_id, user_id, product_id, status, range_start, range_end } = req.query;
    const user = req.user;
    const canSeeAll = ['admin', 'gerencia', 'bko'].includes(user.role);

    const params = [];
    let p = 1;
    const conditions = ['1=1'];

    if (!canSeeAll) { conditions.push(`o.assigned_user_id = $${p++}`); params.push(user.id); }
    if (funnel_id && funnel_id !== 'todos') { conditions.push(`o.funnel_id = $${p++}`); params.push(funnel_id); }
    if (user_id && user_id !== 'todos') { conditions.push(`o.assigned_user_id = $${p++}`); params.push(user_id); }
    if (status && status !== 'todos') { conditions.push(`o.status = $${p++}`); params.push(status); }
    if (range_start) { conditions.push(`o.created_at >= $${p++}`); params.push(range_start); }
    if (range_end) { conditions.push(`o.created_at <= $${p++}`); params.push(range_end); }

    const where = conditions.join(' AND ');

    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE o.status = 'open') AS opportunities,
        COUNT(*) AS total_leads,
        SUM(o.monthly_value) FILTER (WHERE o.status = 'won') AS revenue,
        SUM(o.monthly_value) FILTER (WHERE o.status = 'open') AS expected_value,
        COUNT(*) FILTER (WHERE o.status = 'won') AS won_count,
        COUNT(*) FILTER (WHERE o.status = 'lost') AS lost_count,
        ROUND(
          COUNT(*) FILTER (WHERE o.status = 'won')::numeric /
          NULLIF(COUNT(*) FILTER (WHERE o.status IN ('won','lost')), 0) * 100, 1
        ) AS conversion_rate
      FROM opportunities o WHERE ${where}
    `, params);

    // Top produto
    const { rows: topProduct } = await pool.query(`
      SELECT p.name, COUNT(*) AS qty
      FROM opportunities o
      LEFT JOIN products p ON p.id = o.product_id
      WHERE ${where} AND o.status = 'won' AND p.name IS NOT NULL
      GROUP BY p.name ORDER BY qty DESC LIMIT 1
    `, params);

    // Top vendedor
    const { rows: topUser } = await pool.query(`
      SELECT u.name, COUNT(*) AS qty
      FROM opportunities o
      JOIN users u ON u.id = o.assigned_user_id
      WHERE ${where} AND o.status = 'won'
      GROUP BY u.name ORDER BY qty DESC LIMIT 1
    `, params);

    // Métricas de crédito
    const { rows: credit } = await pool.query(`
      SELECT
        COUNT(*) AS total_consulted,
        COUNT(*) FILTER (WHERE status ILIKE '%aprovado%') AS approved,
        COUNT(*) FILTER (WHERE status ILIKE '%reprovado%') AS rejected,
        COUNT(*) FILTER (WHERE status ILIKE '%análise%' OR status = 'Enviado') AS pending
      FROM analysis_requests
      ${canSeeAll ? '' : `WHERE requested_by_user_id = ${user.id}`}
    `);

    res.json({
      ...rows[0],
      topProduct: topProduct[0]?.name || '-',
      topUser: topUser[0]?.name || '-',
      credit: credit[0],
    });
  } catch (err) {
    console.error('[DASHBOARD] error:', err);
    res.status(500).json({ error: 'Erro ao buscar dados do dashboard.' });
  }
});

module.exports = router;
