const router = require('express').Router();
const bcrypt = require('bcrypt');
const { pool } = require('../config/db');
const { requireRole } = require('../middleware/auth');

// Apenas admin e gerência acessam o módulo admin
router.use(requireRole(['admin', 'gerencia']));

// ── USERS ──────────────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.name, u.username, u.role, u.city, u.email, u.active,
             COALESCE(array_agg(ufa.funnel_id) FILTER (WHERE ufa.funnel_id IS NOT NULL), '{}') AS funnel_access_ids
      FROM users u
      LEFT JOIN user_funnel_access ufa ON ufa.user_id = u.id
      GROUP BY u.id ORDER BY u.name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar usuários.' });
  }
});

router.post('/users', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = req.body;
    const passwordHash = await bcrypt.hash(d.password || 'Mudar@123', 12);

    const { rows } = await client.query(
      `INSERT INTO users (name, username, password_hash, role, city, email, active, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, username, role, city, email, active`,
      [d.name, d.username.toLowerCase().trim(), passwordHash, d.role, d.city || '', d.email || '', d.active !== false, true]
    );
    const user = rows[0];

    if (d.funnelAccessIds?.length) {
      for (const fid of d.funnelAccessIds) {
        await client.query(
          'INSERT INTO user_funnel_access (user_id, funnel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [user.id, fid]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ ...user, funnelAccessIds: d.funnelAccessIds || [] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(400).json({ error: 'Username já existe.' });
    res.status(500).json({ error: 'Erro ao criar usuário.' });
  } finally {
    client.release();
  }
});

router.patch('/users/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = req.body;
    const updates = ['updated_at = NOW()'];
    const params = [];
    let p = 1;

    const fields = { name: d.name, role: d.role, city: d.city, email: d.email, active: d.active };
    for (const [col, val] of Object.entries(fields)) {
      if (val !== undefined) { updates.push(`${col} = $${p++}`); params.push(val); }
    }
    if (d.password) {
      updates.push(`password_hash = $${p++}`);
      params.push(await bcrypt.hash(d.password, 12));
    }
    params.push(req.params.id);
    const { rows } = await client.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${p} RETURNING id, name, username, role, city, email, active`,
      params
    );

    if (d.funnelAccessIds !== undefined) {
      await client.query('DELETE FROM user_funnel_access WHERE user_id = $1', [req.params.id]);
      for (const fid of d.funnelAccessIds) {
        await client.query('INSERT INTO user_funnel_access (user_id, funnel_id) VALUES ($1, $2)', [req.params.id, fid]);
      }
    }

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao atualizar usuário.' });
  } finally {
    client.release();
  }
});

// ── FUNNELS ────────────────────────────────────────────────────────────────
router.get('/funnels', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT f.*, COALESCE(
        json_agg(json_build_object('id', s.id, 'name', s.name, 'color', s.color, 'sortOrder', s.sort_order, 'isWon', s.is_won, 'isLost', s.is_lost)
          ORDER BY s.sort_order) FILTER (WHERE s.id IS NOT NULL), '[]'
      ) AS stages
      FROM funnels f
      LEFT JOIN stages s ON s.funnel_id = f.id
      GROUP BY f.id ORDER BY f.sort_order
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar funis.' });
  }
});

router.post('/funnels', async (req, res) => {
  try {
    const { name, sortOrder } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO funnels (name, sort_order, active) VALUES ($1, $2, true) RETURNING *',
      [name, sortOrder || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar funil.' });
  }
});

router.post('/funnels/:id/stages', async (req, res) => {
  try {
    const d = req.body;
    const { rows } = await pool.query(
      'INSERT INTO stages (funnel_id, name, color, sort_order, is_won, is_lost) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.params.id, d.name, d.color || '#6b7280', d.sortOrder || 0, d.isWon || false, d.isLost || false]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar etapa.' });
  }
});

// ── PRODUCTS ───────────────────────────────────────────────────────────────
router.get('/products', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id AS category_id, c.name AS category_name,
             COALESCE(json_agg(json_build_object('id', p.id, 'name', p.name, 'monthlyValue', p.monthly_value, 'active', p.active)
               ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL), '[]') AS products
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id AND p.active = true
      WHERE c.active = true
      GROUP BY c.id ORDER BY c.name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar produtos.' });
  }
});

router.post('/products/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'INSERT INTO categories (name, active) VALUES ($1, true) RETURNING *', [req.body.name]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar categoria.' });
  }
});

router.post('/products', async (req, res) => {
  try {
    const d = req.body;
    const { rows } = await pool.query(
      'INSERT INTO products (category_id, name, monthly_value, active) VALUES ($1,$2,$3,true) RETURNING *',
      [d.categoryId, d.name, d.monthlyValue || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar produto.' });
  }
});

// ── TAGS ────────────────────────────────────────────────────────────────────
router.get('/tags', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tags ORDER BY name');
  res.json(rows);
});

router.post('/tags', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'INSERT INTO tags (name, color) VALUES ($1, $2) RETURNING *',
      [req.body.name, req.body.color || 'orange']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar tag.' });
  }
});

// ── ORIGINS & OUTCOME REASONS ─────────────────────────────────────────────
router.get('/origins', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM origins ORDER BY name');
  res.json(rows);
});

router.post('/origins', async (req, res) => {
  try {
    const { rows } = await pool.query('INSERT INTO origins (name) VALUES ($1) RETURNING *', [req.body.name]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar origem.' });
  }
});

router.get('/outcome-reasons', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM outcome_reasons ORDER BY type, name');
  res.json(rows);
});

module.exports = router;
