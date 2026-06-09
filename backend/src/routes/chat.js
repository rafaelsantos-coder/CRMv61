const router = require('express').Router();
const { pool } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const zapi = require('../services/zapi');
const queueDistribution = require('../services/queueDistribution');

// ── CONFIG LEGADA Z-API ───────────────────────────────────────────────────
router.get('/config', requireRole(['admin', 'gerencia']), async (req, res) => {
  try {
    const creds = await zapi.getCreds();
    if (!creds) return res.json({ configured: false });
    res.json({
      configured: true,
      instanceId: creds.instance_id,
      webhookUrl: creds.webhook_url,
      name: creds.name,
    });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar configuração.' });
  }
});

router.post('/config', requireRole(['admin', 'gerencia']), async (req, res) => {
  try {
    const { instanceId, token, clientToken = '' } = req.body;
    if (!instanceId || !token) {
      return res.status(400).json({ error: 'ID da instância e token são obrigatórios.' });
    }

    const creds = { instance_id: instanceId, token, client_token: clientToken || '' };
    const status = await zapi.checkStatus(creds);

    await pool.query(
      `INSERT INTO zapi_config (instance_id, token, client_token, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (id) DO UPDATE SET
         instance_id=$1, token=$2, client_token=$3, updated_at=NOW()`,
      [instanceId, token, clientToken || '']
    );

    await pool.query(
      `INSERT INTO api_instances (name, provider, instance_id, token, client_token, status, is_active, updated_at)
       VALUES ('Bot Z-API Padrão', 'Z-API', $1, $2, $3, $4, true, NOW())
       ON CONFLICT (provider, instance_id) DO UPDATE SET
         token=$2, client_token=$3, status=$4, is_active=true, updated_at=NOW()`,
      [instanceId, token, clientToken || '', status.connected || status.smartphoneConnected ? 'connected' : 'disconnected']
    );

    res.json({ ok: true, connected: status.connected, smartphoneConnected: status.smartphoneConnected });
  } catch (err) {
    res.status(400).json({ error: 'Erro ao salvar configuração: ' + err.message });
  }
});

router.post('/config/webhook', requireRole(['admin', 'gerencia']), async (req, res) => {
  try {
    const creds = await zapi.getCreds();
    if (!creds) return res.status(400).json({ error: 'Z-API não configurada.' });

    const webhookUrl = `${req.protocol}://${req.get('host')}/webhook`;
    await zapi.registerWebhook(creds, webhookUrl);

    await pool.query('UPDATE zapi_config SET webhook_url=$1, updated_at=NOW()', [webhookUrl]).catch(() => {});
    await pool.query('UPDATE api_instances SET webhook_url=$1, status=$2, updated_at=NOW() WHERE id=$3', [webhookUrl, 'webhook_registered', creds.id]).catch(() => {});

    res.json({ ok: true, webhookUrl });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar webhook: ' + err.message });
  }
});

// ── CONVERSAS ─────────────────────────────────────────────────────────────
router.get('/conversations', async (req, res) => {
  try {
    const user = req.user;
    const canSeeAll = ['admin','gerencia','bko'].includes(user.role);
    const params = [];
    let p = 1;

    let query = `
      SELECT c.*,
             u.name AS assigned_user_name,
             o.client_name AS opp_client_name,
             q.name AS queue_name,
             ai.name AS api_instance_name,
             (
               SELECT COALESCE(
                 NULLIF(cm.text_content,''),
                 CASE cm.msg_type
                   WHEN 'image' THEN 'Imagem'
                   WHEN 'audio' THEN 'Áudio'
                   WHEN 'video' THEN 'Vídeo'
                   WHEN 'document' THEN 'Documento'
                   WHEN 'sticker' THEN 'Figurinha'
                   ELSE cm.msg_type
                 END
               )
               FROM chat_messages cm
               WHERE cm.conversation_id = c.id
               ORDER BY cm.sent_at DESC, cm.id DESC
               LIMIT 1
             ) AS last_preview
      FROM conversations c
      LEFT JOIN users u ON u.id = c.assigned_user_id
      LEFT JOIN opportunities o ON o.id = c.opportunity_id
      LEFT JOIN attendance_queues q ON q.id = c.queue_id
      LEFT JOIN api_instances ai ON ai.id = c.api_instance_id
      WHERE 1=1`;

    if (!canSeeAll) {
      query += ` AND (
        c.assigned_user_id = $${p}
        OR c.assigned_user_id IS NULL
        OR EXISTS (
          SELECT 1 FROM queue_users qu
          WHERE qu.queue_id = c.queue_id
            AND qu.user_id = $${p}
            AND qu.is_active = true
        )
      )`;
      params.push(user.id); p++;
    }

    if (req.query.queueId && req.query.queueId !== 'todos') {
      query += ` AND c.queue_id = $${p++}`;
      params.push(req.query.queueId);
    }

    query += ` ORDER BY c.last_message_at DESC NULLS LAST, c.updated_at DESC LIMIT 200`;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar conversas.' });
  }
});

router.post('/conversations', async (req, res) => {
  try {
    const { phone, clientName, queueId } = req.body;
    if (!phone) return res.status(400).json({ error: 'Telefone é obrigatório.' });

    const normalized = zapi.normalizePhone(phone);
    if (normalized.length < 10) return res.status(400).json({ error: 'Telefone inválido.' });

    let queue = null;
    if (queueId) {
      const allowed = await queueDistribution.userCanAccessQueue(req.user, queueId);
      if (!allowed) return res.status(403).json({ error: 'Usuário sem acesso à fila.' });
      const { rows } = await pool.query('SELECT * FROM attendance_queues WHERE id=$1 AND is_active=true', [queueId]);
      queue = rows[0] || null;
    } else {
      queue = await queueDistribution.getDefaultQueueForUser(req.user);
    }

    const assignedByRule = queue ? await queueDistribution.assignUserForQueue(queue.id) : null;

    const { rows: existing } = await pool.query(
      `SELECT * FROM conversations WHERE phone=$1 OR phone_normalized=$1 LIMIT 1`,
      [normalized]
    ).catch(() => ({ rows: [] }));

    if (existing[0]) return res.json(existing[0]);

    const { rows } = await pool.query(
      `INSERT INTO conversations
        (phone, phone_normalized, client_name, status, queue_id, api_instance_id, assigned_user_id, unread_count, last_message_at)
       VALUES ($1,$2,$3,'new',$4,$5,$6,0,NOW())
       RETURNING *`,
      [normalized, normalized, clientName || normalized, queue?.id || null, queue?.api_instance_id || null, assignedByRule]
    );

    await pool.query(
      `INSERT INTO chat_contact_aliases (conversation_id, alias, alias_type)
       VALUES ($1,$2,'phone')
       ON CONFLICT (alias) DO UPDATE SET conversation_id=EXCLUDED.conversation_id`,
      [rows[0].id, normalized]
    ).catch(() => {});

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar conversa: ' + err.message });
  }
});

router.patch('/conversations/:id', async (req, res) => {
  try {
    const { assignedUserId, opportunityId, status, clientName, queueId, apiInstanceId } = req.body;
    const updates = [];
    const params = [];
    let p = 1;

    if (assignedUserId !== undefined) { updates.push(`assigned_user_id=$${p++}`); params.push(assignedUserId || null); }
    if (opportunityId !== undefined) { updates.push(`opportunity_id=$${p++}`); params.push(opportunityId || null); }
    if (status !== undefined) { updates.push(`status=$${p++}`); params.push(status); }
    if (clientName !== undefined) { updates.push(`client_name=$${p++}`); params.push(clientName); }
    if (queueId !== undefined) { updates.push(`queue_id=$${p++}`); params.push(queueId || null); }
    if (apiInstanceId !== undefined) { updates.push(`api_instance_id=$${p++}`); params.push(apiInstanceId || null); }

    if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar.' });
    updates.push('updated_at=NOW()');
    params.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE conversations SET ${updates.join(', ')} WHERE id=$${p} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Conversa não encontrada.' });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar conversa.' });
  }
});

// ── MENSAGENS ─────────────────────────────────────────────────────────────
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.*, u.name AS sender_user_name
       FROM chat_messages m
       LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id=$1
       ORDER BY m.sent_at ASC, m.id ASC
       LIMIT 500`,
      [req.params.id]
    );
    await pool.query('UPDATE conversations SET unread_count=0 WHERE id=$1', [req.params.id]).catch(() => {});
    res.json(rows);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar mensagens.' });
  }
});

router.get('/conversations/:id/messages/new', async (req, res) => {
  try {
    const since = Number(req.query.since || 0);
    const { rows } = await pool.query(
      `SELECT m.*, u.name AS sender_user_name
       FROM chat_messages m
       LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id=$1 AND m.id>$2
       ORDER BY m.sent_at ASC, m.id ASC`,
      [req.params.id, since]
    );
    if (rows.length) await pool.query('UPDATE conversations SET unread_count=0 WHERE id=$1', [req.params.id]).catch(() => {});
    res.json({ messages: rows, lastId: rows.length ? rows[rows.length-1].id : since });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar novas mensagens.' });
  }
});

router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const { type='text', text, base64, fileName, caption } = req.body;
    const user = req.user;

    const { rows: convRows } = await pool.query('SELECT * FROM conversations WHERE id=$1', [req.params.id]);
    if (!convRows.length) return res.status(404).json({ error: 'Conversa não encontrada.' });
    const conv = convRows[0];

    const creds = await zapi.getCreds(conv.api_instance_id);
    if (!creds) return res.status(400).json({ error: 'Nenhum bot/API Z-API vinculado à conversa ou ativo.' });

    let result;
    let mediaUrl = null;

    if (type === 'text') {
      if (!text?.trim()) return res.status(400).json({ error: 'Texto é obrigatório.' });
      result = await zapi.sendText(creds, conv.phone_normalized || conv.phone, text.trim());
    } else if (type === 'image') {
      result = await zapi.sendImage(creds, conv.phone_normalized || conv.phone, base64, caption || '');
      mediaUrl = base64;
    } else if (type === 'video') {
      result = await zapi.sendVideo(creds, conv.phone_normalized || conv.phone, base64, caption || '');
      mediaUrl = base64;
    } else if (type === 'audio') {
      result = await zapi.sendAudio(creds, conv.phone_normalized || conv.phone, base64);
      mediaUrl = base64;
    } else if (type === 'document') {
      result = await zapi.sendDocument(creds, conv.phone_normalized || conv.phone, base64, fileName, caption || '');
      mediaUrl = base64;
    } else if (type === 'sticker') {
      result = await zapi.sendSticker(creds, conv.phone_normalized || conv.phone, base64);
      mediaUrl = base64;
    } else {
      return res.status(400).json({ error: `Tipo '${type}' não suportado.` });
    }

    const zapiMessageId = result?.messageId || result?.zaapId || result?.id || null;

    const { rows } = await pool.query(
      `INSERT INTO chat_messages
        (conversation_id, zapi_message_id, from_me, sender_id, sender_name,
         msg_type, text_content, media_url, file_name, caption, status, sent_at, raw_payload)
       VALUES ($1,$2,true,$3,$4,$5,$6,$7,$8,$9,'SENT',NOW(),$10)
       ON CONFLICT (zapi_message_id) WHERE zapi_message_id IS NOT NULL
       DO UPDATE SET status='SENT'
       RETURNING *`,
      [
        conv.id,
        zapiMessageId,
        user.id,
        user.name,
        type,
        type === 'text' ? text.trim() : null,
        mediaUrl,
        fileName || null,
        caption || null,
        JSON.stringify(result || {}),
      ]
    );

    await pool.query('UPDATE conversations SET last_message_at=NOW(), updated_at=NOW() WHERE id=$1', [conv.id]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[CHAT] Erro ao enviar:', err);
    res.status(500).json({ error: 'Erro ao enviar mensagem: ' + err.message });
  }
});

router.get('/unread', async (req, res) => {
  try {
    const user = req.user;
    const canSeeAll = ['admin','gerencia','bko'].includes(user.role);
    const params = [];
    let query = `SELECT COALESCE(SUM(unread_count),0)::int AS total FROM conversations WHERE status <> 'closed'`;

    if (!canSeeAll) {
      query += ` AND (
        assigned_user_id=$1
        OR assigned_user_id IS NULL
        OR EXISTS (
          SELECT 1 FROM queue_users qu
          WHERE qu.queue_id=conversations.queue_id
            AND qu.user_id=$1
            AND qu.is_active=true
        )
      )`;
      params.push(user.id);
    }

    const { rows } = await pool.query(query, params);
    res.json({ total: rows[0]?.total || 0 });
  } catch {
    res.json({ total: 0 });
  }
});

module.exports = router;
