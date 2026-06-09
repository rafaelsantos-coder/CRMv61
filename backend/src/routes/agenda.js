const router = require('express').Router();
const { pool } = require('../config/db');

// ── GET /api/agenda ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { month, year, user_id } = req.query;
    const user = req.user;
    const canSeeAll = ['admin', 'gerencia', 'bko'].includes(user.role);

    let query = `
      SELECT e.*, u.name AS user_name
      FROM calendar_events e
      JOIN users u ON u.id = e.user_id
      WHERE 1=1
    `;
    const params = [];
    let p = 1;

    if (!canSeeAll) {
      query += ` AND e.user_id = $${p++}`;
      params.push(user.id);
    } else if (user_id && user_id !== 'todos') {
      query += ` AND e.user_id = $${p++}`;
      params.push(user_id);
    }

    if (month && year) {
      query += ` AND EXTRACT(MONTH FROM e.start_at) = $${p++} AND EXTRACT(YEAR FROM e.start_at) = $${p++}`;
      params.push(month, year);
    }

    query += ' ORDER BY e.start_at ASC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar eventos.' });
  }
});

// ── POST /api/agenda ────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const d = req.body;
    const { rows } = await pool.query(
      `INSERT INTO calendar_events (user_id, title, description, start_at, end_at, all_day, location, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        req.user.id, d.title, d.description || null,
        d.startAt, d.endAt || null, d.allDay || false,
        d.location || null, d.source || 'internal',
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar evento.' });
  }
});

// ── PATCH /api/agenda/:id ───────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const d = req.body;
    const { rows } = await pool.query(
      `UPDATE calendar_events SET
         title = COALESCE($1, title),
         description = COALESCE($2, description),
         start_at = COALESCE($3, start_at),
         end_at = COALESCE($4, end_at),
         location = COALESCE($5, location),
         updated_at = NOW()
       WHERE id = $6 AND user_id = $7 RETURNING *`,
      [d.title, d.description, d.startAt, d.endAt, d.location, req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Evento não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar evento.' });
  }
});

// ── DELETE /api/agenda/:id ──────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM calendar_events WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao deletar evento.' });
  }
});

module.exports = router;
