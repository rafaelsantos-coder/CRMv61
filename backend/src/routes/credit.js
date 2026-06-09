const router = require('express').Router();
const { pool } = require('../config/db');
const { requireRole } = require('../middleware/auth');

// ── GET /api/credit ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, search } = req.query;
    const user = req.user;
    const canSeeAll = ['admin', 'gerencia', 'bko'].includes(user.role);

    let query = `
      SELECT ar.*,
             u.name AS requested_by_name,
             bu.name AS analyst_name
      FROM analysis_requests ar
      LEFT JOIN users u ON u.id = ar.requested_by_user_id
      LEFT JOIN users bu ON bu.id = ar.bko_analyst_id
      WHERE 1=1
    `;
    const params = [];
    let p = 1;

    if (!canSeeAll) {
      query += ` AND ar.requested_by_user_id = $${p++}`;
      params.push(user.id);
    }
    if (status && status !== 'todos') {
      query += ` AND ar.status = $${p++}`;
      params.push(status);
    }
    if (search) {
      query += ` AND (ar.client_name ILIKE $${p} OR ar.cpf ILIKE $${p} OR ar.protocol ILIKE $${p})`;
      params.push(`%${search}%`); p++;
    }

    query += ' ORDER BY ar.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar análises.' });
  }
});

// ── POST /api/credit ────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const d = req.body;
    const user = req.user;

    // Gera protocolo
    const year = new Date().getFullYear();
    const { rows: counter } = await pool.query(
      `INSERT INTO counters (name, value) VALUES ('sac_protocol', 1)
       ON CONFLICT (name) DO UPDATE SET value = counters.value + 1 RETURNING value`
    );
    const protocol = `SAC-${year}-${String(counter[0].value).padStart(4, '0')}`;

    const { rows } = await pool.query(
      `INSERT INTO analysis_requests
        (protocol, opportunity_id, requested_by_user_id, seller_name,
         doc_type, cpf, client_name, client_phone, client_birth_date,
         cep, street, number, neighborhood, city, state,
         product, seller_note, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW())
       RETURNING *`,
      [
        protocol, d.opportunityId || null, user.id, user.name,
        d.docType, d.cpf, d.clientName, d.clientPhone,
        d.clientBirthDate || null, d.cep, d.street, d.number,
        d.neighborhood, d.city, d.state, d.product, d.sellerNote,
        'Enviado',
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[CREDIT] POST error:', err);
    res.status(500).json({ error: 'Erro ao criar análise.' });
  }
});

// ── PATCH /api/credit/:id — BKO registra análise ───────────────────────────
router.patch('/:id/analyze', requireRole(['admin', 'gerencia', 'bko']), async (req, res) => {
  try {
    const d = req.body;
    const { rows } = await pool.query(
      `UPDATE analysis_requests SET
         status = $1, bko_analyst_id = $2, bko_decision = $3,
         bko_score = $4, bko_risk_level = $5, bko_reason = $6,
         bko_justification = $7, bko_source = $8, bko_analyzed_at = NOW(),
         updated_at = NOW()
       WHERE id = $9 RETURNING *`,
      [
        d.status, req.user.id, d.decision, d.score,
        d.riskLevel, d.reason, d.justification, d.source,
        req.params.id,
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Análise não encontrada.' });

    // Registra no histórico
    await pool.query(
      `INSERT INTO analysis_history (analysis_id, actor_id, action, status)
       VALUES ($1, $2, $3, $4)`,
      [rows[0].id, req.user.id, `Análise BKO registrada: ${d.decision}.`, d.status]
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar análise.' });
  }
});

// ── PATCH /api/credit/:id/contest — Vendedor contesta ─────────────────────
router.patch('/:id/contest', async (req, res) => {
  try {
    const { justification } = req.body;
    const { rows } = await pool.query(
      `UPDATE analysis_requests SET
         status = 'Contestação enviada', contestation_justification = $1,
         contestation_at = NOW(), updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [justification, req.params.id]
    );
    await pool.query(
      `INSERT INTO analysis_history (analysis_id, actor_id, action, status) VALUES ($1,$2,$3,$4)`,
      [rows[0].id, req.user.id, 'Contestação enviada pelo vendedor.', 'Contestação enviada']
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao contestar análise.' });
  }
});

// ── PATCH /api/credit/:id/manage — Gerência decide ────────────────────────
router.patch('/:id/manage', requireRole(['admin', 'gerencia']), async (req, res) => {
  try {
    const d = req.body;
    const { rows } = await pool.query(
      `UPDATE analysis_requests SET
         status = $1, management_decision = $2,
         management_justification = $3, management_at = NOW(), updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [d.status, d.decision, d.justification, req.params.id]
    );
    await pool.query(
      `INSERT INTO analysis_history (analysis_id, actor_id, action, status) VALUES ($1,$2,$3,$4)`,
      [rows[0].id, req.user.id, `Decisão gerencial: ${d.decision}.`, d.status]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar decisão gerencial.' });
  }
});

// ── GET /api/credit/:id/history ────────────────────────────────────────────
router.get('/:id/history', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ah.*, u.name AS actor_name
       FROM analysis_history ah
       LEFT JOIN users u ON u.id = ah.actor_id
       WHERE ah.analysis_id = $1
       ORDER BY ah.created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar histórico.' });
  }
});

// ── GET /api/credit/rules ──────────────────────────────────────────────────
router.get('/rules', requireRole(['admin', 'gerencia', 'bko']), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM credit_rules ORDER BY sort_order ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar regras.' });
  }
});

// ── POST /api/credit/rules ─────────────────────────────────────────────────
router.post('/rules', requireRole(['admin', 'gerencia']), async (req, res) => {
  try {
    const d = req.body;
    const { rows } = await pool.query(
      `INSERT INTO credit_rules
        (min_score, max_score, max_restrictions, allow_protest, decision, risk_level, condition_text, sort_order, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [d.minScore, d.maxScore, d.maxRestrictions, d.allowProtest, d.decision, d.riskLevel, d.condition, d.sortOrder || 0, d.active !== false]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar regra.' });
  }
});

module.exports = router;
