const router = require('express').Router();
const { pool } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const zapi = require('../services/zapi');

router.use(requireRole(['admin', 'gerencia']));

function mask(v) {
  if (!v) return '';
  const s = String(v);
  if (s.length <= 8) return '••••';
  return s.slice(0, 4) + '••••••' + s.slice(-4);
}

async function serializeQueue(row) {
  const { rows: users } = await pool.query(
    `SELECT qu.user_id AS id, u.name, u.username, u.role, qu.role_in_queue, qu.is_active
     FROM queue_users qu
     JOIN users u ON u.id = qu.user_id
     WHERE qu.queue_id = $1
     ORDER BY u.name ASC`,
    [row.id]
  );
  return { ...row, users };
}

// ── USUÁRIOS PARA VINCULAR EM FILAS ───────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, username, role, city, email, active
       FROM users
       WHERE active = true
       ORDER BY name ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar usuários.' });
  }
});

// ── INSTÂNCIAS / APIs ─────────────────────────────────────────────────────
router.get('/api-instances', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, provider, instance_id, phone_number, status, webhook_url,
              is_active, created_at, updated_at
       FROM api_instances
       ORDER BY id DESC`
    );
    res.json(rows.map(r => ({ ...r, instance_id_masked: mask(r.instance_id) })));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar bots/API.' });
  }
});

router.post('/api-instances', async (req, res) => {
  try {
    const d = req.body;
    if (!d.name || !d.instanceId || !d.token) {
      return res.status(400).json({ error: 'Nome, Instance ID e Token são obrigatórios.' });
    }

    let status = 'saved';
    if (d.testConnection === true) {
      try {
        const st = await zapi.checkStatus({
          instance_id: d.instanceId,
          token: d.token,
          client_token: d.clientToken || '',
        });
        status = st.connected || st.smartphoneConnected ? 'connected' : 'disconnected';
      } catch {
        status = 'connection_error';
      }
    }

    if (d.id) {
      const { rows } = await pool.query(
        `UPDATE api_instances SET
          name=$1, provider=$2, instance_id=$3, token=$4, client_token=$5,
          phone_number=$6, status=$7, is_active=$8, updated_at=NOW()
         WHERE id=$9
         RETURNING id, name, provider, instance_id, phone_number, status, webhook_url, is_active, created_at, updated_at`,
        [
          d.name,
          d.provider || 'Z-API',
          d.instanceId,
          d.token,
          d.clientToken || '',
          d.phoneNumber || null,
          status,
          d.isActive !== false,
          d.id,
        ]
      );
      return res.json(rows[0]);
    }

    const { rows } = await pool.query(
      `INSERT INTO api_instances
        (name, provider, instance_id, token, client_token, phone_number, status, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, name, provider, instance_id, phone_number, status, webhook_url, is_active, created_at, updated_at`,
      [
        d.name,
        d.provider || 'Z-API',
        d.instanceId,
        d.token,
        d.clientToken || '',
        d.phoneNumber || null,
        status,
        d.isActive !== false,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Esta bot/API já está cadastrada.' });
    res.status(500).json({ error: 'Erro ao salvar bot/API.' });
  }
});

router.get('/api-instances/:id/status', async (req, res) => {
  try {
    const creds = await zapi.getCreds(req.params.id);
    if (!creds) return res.status(404).json({ error: 'Bot não encontrada.' });

    const st = await zapi.checkStatus(creds);
    const status = st.connected || st.smartphoneConnected ? 'connected' : 'disconnected';

    await pool.query(
      'UPDATE api_instances SET status=$1, updated_at=NOW() WHERE id=$2',
      [status, req.params.id]
    );

    res.json({ ok: true, status, raw: st });
  } catch (err) {
    await pool.query(
      'UPDATE api_instances SET status=$1, updated_at=NOW() WHERE id=$2',
      ['connection_error', req.params.id]
    ).catch(() => {});
    res.status(400).json({ error: 'Erro ao testar conexão: ' + err.message });
  }
});

router.post('/api-instances/:id/webhook', async (req, res) => {
  try {
    const creds = await zapi.getCreds(req.params.id);
    if (!creds) return res.status(404).json({ error: 'Bot não encontrada.' });

    const webhookUrl = `${req.protocol}://${req.get('host')}/webhook`;
    await zapi.registerWebhook(creds, webhookUrl);

    await pool.query(
      'UPDATE api_instances SET webhook_url=$1, status=$2, updated_at=NOW() WHERE id=$3',
      [webhookUrl, 'webhook_registered', req.params.id]
    );

    res.json({ ok: true, webhookUrl });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar webhook: ' + err.message });
  }
});

router.patch('/api-instances/:id/toggle', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE api_instances
       SET is_active = NOT is_active, updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, provider, instance_id, phone_number, status, webhook_url, is_active, created_at, updated_at`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bot não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao alterar status da bot.' });
  }
});

// ── FILAS ─────────────────────────────────────────────────────────────────
router.get('/queues', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT q.*,
              ai.name AS api_instance_name,
              ai.provider AS api_provider,
              ai.phone_number AS api_phone_number
       FROM attendance_queues q
       LEFT JOIN api_instances ai ON ai.id = q.api_instance_id
       ORDER BY q.id DESC`
    );

    const result = [];
    for (const row of rows) result.push(await serializeQueue(row));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar filas.' });
  }
});

router.post('/queues', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = req.body;

    if (!d.name) return res.status(400).json({ error: 'Nome da fila é obrigatório.' });

    let queue;
    if (d.id) {
      const { rows } = await client.query(
        `UPDATE attendance_queues SET
          name=$1, description=$2, type=$3, api_instance_id=$4,
          distribution_type=$5, welcome_message=$6, after_hours_message=$7,
          is_active=$8, updated_at=NOW()
         WHERE id=$9
         RETURNING *`,
        [
          d.name,
          d.description || '',
          d.type || 'comercial',
          d.apiInstanceId || null,
          d.distributionType || 'manual',
          d.welcomeMessage || '',
          d.afterHoursMessage || '',
          d.isActive !== false,
          d.id,
        ]
      );
      queue = rows[0];
      await client.query('DELETE FROM queue_users WHERE queue_id=$1', [queue.id]);
    } else {
      const { rows } = await client.query(
        `INSERT INTO attendance_queues
          (name, description, type, api_instance_id, distribution_type, welcome_message, after_hours_message, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          d.name,
          d.description || '',
          d.type || 'comercial',
          d.apiInstanceId || null,
          d.distributionType || 'manual',
          d.welcomeMessage || '',
          d.afterHoursMessage || '',
          d.isActive !== false,
        ]
      );
      queue = rows[0];
    }

    const users = Array.isArray(d.users) ? d.users : [];
    for (const u of users) {
      const userId = Number(u.id || u.userId || u);
      if (!userId) continue;
      await client.query(
        `INSERT INTO queue_users (queue_id, user_id, role_in_queue, is_active)
         VALUES ($1,$2,$3,true)
         ON CONFLICT (queue_id,user_id) DO UPDATE SET
           role_in_queue=EXCLUDED.role_in_queue,
           is_active=true`,
        [queue.id, userId, u.roleInQueue || u.role_in_queue || 'atendente']
      );
    }

    await client.query('COMMIT');

    const { rows: qRows } = await pool.query(
      `SELECT q.*,
              ai.name AS api_instance_name,
              ai.provider AS api_provider,
              ai.phone_number AS api_phone_number
       FROM attendance_queues q
       LEFT JOIN api_instances ai ON ai.id = q.api_instance_id
       WHERE q.id=$1`,
      [queue.id]
    );

    res.status(d.id ? 200 : 201).json(await serializeQueue(qRows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao salvar fila: ' + err.message });
  } finally {
    client.release();
  }
});

router.patch('/queues/:id/toggle', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE attendance_queues
       SET is_active = NOT is_active, updated_at = NOW()
       WHERE id=$1
       RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Fila não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao alterar status da fila.' });
  }
});

router.post('/conversations/:id/transfer', async (req, res) => {
  try {
    const { toQueueId, toUserId, reason } = req.body;
    if (!toQueueId) return res.status(400).json({ error: 'Fila de destino é obrigatória.' });

    const { rows: convRows } = await pool.query('SELECT * FROM conversations WHERE id=$1', [req.params.id]);
    if (!convRows.length) return res.status(404).json({ error: 'Conversa não encontrada.' });
    const conv = convRows[0];

    await pool.query(
      `INSERT INTO chat_transfers
        (conversation_id, from_queue_id, to_queue_id, from_user_id, to_user_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [conv.id, conv.queue_id, toQueueId, req.user.id, toUserId || null, reason || '']
    );

    const { rows } = await pool.query(
      `UPDATE conversations SET
         queue_id=$1,
         assigned_user_id=$2,
         status='transferred',
         updated_at=NOW()
       WHERE id=$3
       RETURNING *`,
      [toQueueId, toUserId || null, conv.id]
    );

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao transferir conversa.' });
  }
});

module.exports = router;
