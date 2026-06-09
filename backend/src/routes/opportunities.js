const router = require('express').Router();
const { pool } = require('../config/db');
const { requireRole } = require('../middleware/auth');

// Helper: verifica acesso do usuário ao funil
async function checkFunnelAccess(userId, funnelId, role) {
  if (['admin', 'gerencia'].includes(role)) return true;
  const { rows } = await pool.query(
    'SELECT 1 FROM user_funnel_access WHERE user_id = $1 AND funnel_id = $2',
    [userId, funnelId]
  );
  return rows.length > 0;
}

// ── GET /api/opportunities ──────────────────────────────────────────────────
// Retorna oportunidades visíveis pelo usuário logado
router.get('/', async (req, res) => {
  try {
    const { funnel_id, status, search, range_start, range_end } = req.query;
    const user = req.user;

    let query = `
      SELECT o.*, 
             u.name AS assigned_user_name,
             f.name AS funnel_name,
             s.name AS stage_name,
             COALESCE(
               json_agg(ot.tag_id) FILTER (WHERE ot.tag_id IS NOT NULL), '[]'
             ) AS tag_ids
      FROM opportunities o
      LEFT JOIN users u ON u.id = o.assigned_user_id
      LEFT JOIN funnels f ON f.id = o.funnel_id
      LEFT JOIN stages s ON s.id = o.stage_id
      LEFT JOIN opportunity_tags ot ON ot.opportunity_id = o.id
      WHERE 1=1
    `;
    const params = [];
    let p = 1;

    // Restrição por perfil
    if (!['admin', 'gerencia', 'bko'].includes(user.role)) {
      query += ` AND o.assigned_user_id = $${p++}`;
      params.push(user.id);
    }

    // Filtro de funis acessíveis (exceto admin/gerencia)
    if (!['admin', 'gerencia'].includes(user.role)) {
      query += ` AND o.funnel_id IN (
        SELECT funnel_id FROM user_funnel_access WHERE user_id = $${p++}
      )`;
      params.push(user.id);
    }

    if (funnel_id) { query += ` AND o.funnel_id = $${p++}`; params.push(funnel_id); }
    if (status)    { query += ` AND o.status = $${p++}`;    params.push(status); }
    if (search) {
      query += ` AND (o.client_name ILIKE $${p} OR o.client_cpf ILIKE $${p} OR o.client_phone ILIKE $${p})`;
      params.push(`%${search}%`); p++;
    }
    if (range_start) { query += ` AND o.created_at >= $${p++}`; params.push(range_start); }
    if (range_end)   { query += ` AND o.created_at <= $${p++}`; params.push(range_end); }

    query += ' GROUP BY o.id, u.name, f.name, s.name ORDER BY o.created_at DESC';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('[OPPS] GET error:', err);
    res.status(500).json({ error: 'Erro ao buscar oportunidades.' });
  }
});

// ── POST /api/opportunities ─────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = req.user;
    const d = req.body;

    const hasAccess = await checkFunnelAccess(user.id, d.funnelId, user.role);
    if (!hasAccess) return res.status(403).json({ error: 'Sem acesso a este funil.' });

    const { rows } = await client.query(
      `INSERT INTO opportunities
        (funnel_id, stage_id, assigned_user_id, client_name, client_cpf, client_phone,
         client_email, client_birth_date, cep, city, state, street, number, neighborhood,
         complement, monthly_value, one_time_value, product_id, product_category,
         product_info, notes, status, is_backoffice_copy, origin_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NOW(),NOW())
       RETURNING *`,
      [
        d.funnelId, d.stageId, d.assignedUserId || user.id,
        d.clientName, d.clientCpf, d.clientPhone, d.clientEmail,
        d.clientBirthDate || null, d.cep, d.city, d.state,
        d.street, d.number, d.neighborhood, d.complement,
        d.monthlyValue || 0, d.oneTimeValue || 0,
        d.productId || null, d.productCategory || null,
        d.productInfo ? JSON.stringify(d.productInfo) : null,
        d.notes || null, d.status || 'open',
        d.isBackofficeCopy || false, d.originId || null,
      ]
    );

    const opp = rows[0];

    // Tags
    if (d.tagIds?.length) {
      for (const tagId of d.tagIds) {
        await client.query(
          'INSERT INTO opportunity_tags (opportunity_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [opp.id, tagId]
        );
      }
    }

    // Prospect notes (anotações de prospecção)
    if (d.prospectNotes?.length) {
      for (const note of d.prospectNotes) {
        await client.query(
          `INSERT INTO prospect_notes
            (opportunity_id, user_id, channel, result, contacted_at, next_follow_up, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [opp.id, user.id, note.channel, note.result, note.contactedAt, note.nextFollowUp || null, note.description]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json(opp);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[OPPS] POST error:', err);
    res.status(500).json({ error: 'Erro ao criar oportunidade.' });
  } finally {
    client.release();
  }
});

// ── PATCH /api/opportunities/:id ────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const user = req.user;
    const d = req.body;

    // Verifica se opp existe e usuário tem acesso
    const { rows: existing } = await client.query(
      'SELECT * FROM opportunities WHERE id = $1', [id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Oportunidade não encontrada.' });

    const opp = existing[0];
    if (!['admin', 'gerencia', 'bko'].includes(user.role) && opp.assigned_user_id !== user.id) {
      return res.status(403).json({ error: 'Sem permissão para editar esta oportunidade.' });
    }

    const updates = [];
    const params = [];
    let p = 1;

    const fields = {
      stage_id: d.stageId, client_name: d.clientName, client_cpf: d.clientCpf,
      client_phone: d.clientPhone, client_email: d.clientEmail,
      client_birth_date: d.clientBirthDate, cep: d.cep, city: d.city,
      state: d.state, street: d.street, number: d.number,
      neighborhood: d.neighborhood, complement: d.complement,
      monthly_value: d.monthlyValue, one_time_value: d.oneTimeValue,
      product_id: d.productId, product_category: d.productCategory,
      product_info: d.productInfo ? JSON.stringify(d.productInfo) : undefined,
      notes: d.notes, status: d.status, assigned_user_id: d.assignedUserId,
      outcome_reason_id: d.outcomeReasonId, closed_at: d.closedAt,
      is_backoffice_copy: d.isBackofficeCopy,
    };

    for (const [col, val] of Object.entries(fields)) {
      if (val !== undefined) {
        updates.push(`${col} = $${p++}`);
        params.push(val);
      }
    }

    updates.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await client.query(
      `UPDATE opportunities SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`,
      params
    );

    // Atualiza tags se fornecidas
    if (d.tagIds !== undefined) {
      await client.query('DELETE FROM opportunity_tags WHERE opportunity_id = $1', [id]);
      for (const tagId of d.tagIds) {
        await client.query(
          'INSERT INTO opportunity_tags (opportunity_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, tagId]
        );
      }
    }

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[OPPS] PATCH error:', err);
    res.status(500).json({ error: 'Erro ao atualizar oportunidade.' });
  } finally {
    client.release();
  }
});

// ── GET /api/opportunities/:id/notes ───────────────────────────────────────
router.get('/:id/notes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pn.*, u.name AS user_name
       FROM prospect_notes pn
       JOIN users u ON u.id = pn.user_id
       WHERE pn.opportunity_id = $1
       ORDER BY pn.contacted_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar anotações.' });
  }
});

// ── POST /api/opportunities/:id/notes ──────────────────────────────────────
router.post('/:id/notes', async (req, res) => {
  try {
    const { channel, result, contactedAt, nextFollowUp, description } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO prospect_notes
        (opportunity_id, user_id, channel, result, contacted_at, next_follow_up, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.params.id, req.user.id, channel, result, contactedAt, nextFollowUp || null, description]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar anotação.' });
  }
});

module.exports = router;
