const router = require('express').Router();
const { pool } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const zapi = require('../services/zapi');

function digitsOnly(raw) {
  return String(raw || '').split('@')[0].replace(/\D/g, '');
}

function phoneVariants(raw) {
  const d = digitsOnly(raw);
  const out = new Set();
  if (!d) return [];
  out.add(d);

  let local = d;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    local = d.slice(2);
    out.add(local);
  } else if (d.length === 10 || d.length === 11) {
    out.add('55' + d);
  }

  if (local.length === 10) {
    const withNine = local.slice(0, 2) + '9' + local.slice(2);
    out.add(withNine);
    out.add('55' + withNine);
  }

  if (local.length === 11 && local[2] === '9') {
    const withoutNine = local.slice(0, 2) + local.slice(3);
    out.add(withoutNine);
    out.add('55' + withoutNine);
  }

  return [...out].filter(Boolean);
}

function canonicalPhone(raw) {
  const variants = phoneVariants(raw);
  const local11 = variants.find(v => v.length === 11 && !v.startsWith('55'));
  if (local11) return local11;
  const local10 = variants.find(v => v.length === 10 && !v.startsWith('55'));
  if (local10) return local10;
  return variants[0] || digitsOnly(raw);
}

function zapiPhone(raw) {
  const variants = phoneVariants(raw);
  return variants.find(v => v.startsWith('55') && (v.length === 12 || v.length === 13)) ||
    (canonicalPhone(raw) ? '55' + canonicalPhone(raw) : digitsOnly(raw));
}

function isOwner(user, conv) {
  return Number(conv.assigned_user_id) === Number(user.id);
}

async function getOwnedConversation(id, user) {
  const { rows } = await pool.query('SELECT * FROM conversations WHERE id=$1', [id]);
  const conv = rows[0];
  if (!conv) return { error: [404, 'Conversa não encontrada.'] };
  if (!isOwner(user, conv)) return { error: [403, 'Esta conversa pertence a outro atendente.'] };
  return { conv };
}

async function consolidateDuplicateConversations() {
  const { rows } = await pool.query(`SELECT * FROM conversations ORDER BY last_message_at DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC`).catch(() => ({ rows: [] }));
  const groups = new Map();
  for (const conv of rows) {
    const key = canonicalPhone(conv.phone_normalized || conv.phone);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(conv);
  }

  for (const [key, list] of groups.entries()) {
    if (list.length === 1) {
      const only = list[0];
      if (only.phone_normalized !== key) {
        await pool.query('UPDATE conversations SET phone_normalized=$1 WHERE id=$2', [key, only.id]).catch(() => {});
      }
      continue;
    }

    const primary = list[0];
    const duplicateIds = list.slice(1).map(c => c.id);
    const unread = list.reduce((sum, c) => sum + Number(c.unread_count || 0), 0);
    const assigned = primary.assigned_user_id || list.find(c => c.assigned_user_id)?.assigned_user_id || null;

    await pool.query('UPDATE chat_messages SET conversation_id=$1 WHERE conversation_id = ANY($2::int[])', [primary.id, duplicateIds]).catch(() => {});
    await pool.query('UPDATE chat_contact_aliases SET conversation_id=$1 WHERE conversation_id = ANY($2::int[])', [primary.id, duplicateIds]).catch(() => {});
    await pool.query(
      `UPDATE conversations
          SET phone=$2,
              phone_normalized=$3,
              unread_count=$4,
              assigned_user_id=COALESCE(assigned_user_id,$5),
              last_message_at=(SELECT MAX(sent_at) FROM chat_messages WHERE conversation_id=$1),
              updated_at=NOW()
        WHERE id=$1`,
      [primary.id, zapiPhone(primary.phone || key), key, unread, assigned]
    ).catch(() => {});
    await pool.query('DELETE FROM conversations WHERE id = ANY($1::int[])', [duplicateIds]).catch(() => {});
  }
}

async function findConversationByPhone(phone) {
  const variants = phoneVariants(phone);
  if (!variants.length) return null;
  const { rows } = await pool.query(
    `SELECT * FROM conversations
      WHERE phone = ANY($1::text[])
         OR phone_normalized = ANY($1::text[])
      ORDER BY last_message_at DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [variants]
  );
  return rows[0] || null;
}

// ── CONFIG LEGADA Z-API ───────────────────────────────────────────────────
router.get('/config', requireRole(['admin', 'gerencia']), async (req, res) => {
  try {
    const creds = await zapi.getCreds();
    if (!creds) return res.json({ configured: false });
    res.json({ configured: true, instanceId: creds.instance_id, webhookUrl: creds.webhook_url, name: creds.name });
  } catch { res.status(500).json({ error: 'Erro ao buscar configuração.' }); }
});

router.post('/config', requireRole(['admin', 'gerencia']), async (req, res) => {
  try {
    const { instanceId, token, clientToken = '' } = req.body;
    if (!instanceId || !token) return res.status(400).json({ error: 'ID da instância e token são obrigatórios.' });
    const creds = { instance_id: instanceId, token, client_token: clientToken };
    const status = await zapi.checkStatus(creds);
    await pool.query(
      `INSERT INTO zapi_config (instance_id, token, client_token, updated_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (id) DO UPDATE SET instance_id=$1, token=$2, client_token=$3, updated_at=NOW()`,
      [instanceId, token, clientToken]
    );
    await pool.query(
      `INSERT INTO api_instances (name, provider, instance_id, token, client_token, status, is_active, updated_at)
       VALUES ('Bot Z-API Padrão','Z-API',$1,$2,$3,$4,true,NOW())
       ON CONFLICT (provider, instance_id) DO UPDATE SET token=$2, client_token=$3, status=$4, is_active=true, updated_at=NOW()`,
      [instanceId, token, clientToken, status.connected || status.smartphoneConnected ? 'connected' : 'disconnected']
    );
    res.json({ ok: true, connected: status.connected, smartphoneConnected: status.smartphoneConnected });
  } catch (err) { res.status(400).json({ error: 'Erro ao salvar configuração: ' + err.message }); }
});

router.post('/config/webhook', requireRole(['admin', 'gerencia']), async (req, res) => {
  try {
    const creds = await zapi.getCreds();
    if (!creds) return res.status(400).json({ error: 'Z-API não configurada.' });
    const webhookUrl = `${req.protocol}://${req.get('host')}/webhook`;
    await zapi.registerWebhook(creds, webhookUrl);
    await pool.query('UPDATE zapi_config SET webhook_url=$1, updated_at=NOW()', [webhookUrl]).catch(() => {});
    res.json({ ok: true, webhookUrl });
  } catch (err) { res.status(500).json({ error: 'Erro ao registrar webhook: ' + err.message }); }
});

// ── CONVERSAS ─────────────────────────────────────────────────────────────
router.get('/conversations', async (req, res) => {
  try {
    await consolidateDuplicateConversations();
    const user = req.user;
    const params = [user.id];
    let p = 2;

    let query = `
      SELECT c.*,
             u.name  AS assigned_user_name,
             o.client_name AS opp_client_name,
             q.name  AS queue_name,
             ai.name AS api_instance_name,
             (SELECT COALESCE(
                NULLIF(NULLIF(cm.text_content,''),'unsupported'),
                CASE cm.msg_type
                  WHEN 'image'    THEN 'Imagem'
                  WHEN 'audio'    THEN 'Áudio'
                  WHEN 'video'    THEN 'Vídeo'
                  WHEN 'document' THEN 'Documento'
                  WHEN 'sticker'  THEN 'Figurinha'
                  WHEN 'location' THEN 'Localização'
                  WHEN 'contact'  THEN 'Contato'
                  WHEN 'reaction' THEN 'Reação'
                  ELSE 'Mensagem'
                END)
              FROM chat_messages cm
              WHERE cm.conversation_id = c.id
                AND (cm.msg_type <> 'unsupported' OR NULLIF(cm.text_content,'') IS NOT NULL)
              ORDER BY cm.sent_at DESC, cm.id DESC LIMIT 1) AS last_message_preview
      FROM conversations c
      LEFT JOIN users u ON u.id = c.assigned_user_id
      LEFT JOIN opportunities o ON o.id = c.opportunity_id
      LEFT JOIN attendance_queues q ON q.id = c.queue_id
      LEFT JOIN api_instances ai ON ai.id = c.api_instance_id
      WHERE c.assigned_user_id = $1
    `;

    const { status, search, queueId } = req.query;
    if (status && status !== 'todos') { query += ` AND c.status = $${p++}`; params.push(status); }
    if (queueId) { query += ` AND c.queue_id = $${p++}`; params.push(queueId); }
    if (search) {
      query += ` AND (c.phone ILIKE $${p} OR c.phone_normalized ILIKE $${p} OR c.client_name ILIKE $${p})`;
      params.push(`%${search}%`); p++;
    }

    query += ' ORDER BY c.last_message_at DESC NULLS LAST LIMIT 200';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar conversas: ' + err.message }); }
});

router.post('/conversations', async (req, res) => {
  try {
    const { phone, clientName } = req.body;
    if (!phone) return res.status(400).json({ error: 'Número é obrigatório.' });
    const normalized = canonicalPhone(phone);
    const targetPhone = zapiPhone(phone);
    let conv = await findConversationByPhone(phone);

    if (conv) {
      if (conv.assigned_user_id && Number(conv.assigned_user_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: 'Este número já está em atendimento com outro usuário.' });
      }
      const { rows } = await pool.query(
        `UPDATE conversations
            SET assigned_user_id=$1,
                phone=$2,
                phone_normalized=$3,
                client_name=COALESCE(NULLIF(client_name,''),$4),
                updated_at=NOW()
          WHERE id=$5
          RETURNING *`,
        [req.user.id, targetPhone, normalized, clientName || normalized, conv.id]
      );
      return res.json(rows[0]);
    }

    const { rows } = await pool.query(
      `INSERT INTO conversations (phone, phone_normalized, client_name, status, assigned_user_id, last_message_at, created_at, updated_at)
       VALUES ($1,$2,$3,'open',$4,NOW(),NOW(),NOW()) RETURNING *`,
      [targetPhone, normalized, clientName || normalized, req.user.id]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao criar conversa: ' + err.message }); }
});

router.patch('/conversations/:id', async (req, res) => {
  try {
    const owned = await getOwnedConversation(req.params.id, req.user);
    if (owned.error) return res.status(owned.error[0]).json({ error: owned.error[1] });

    const { assignedUserId, opportunityId, status, clientName, queueId, apiInstanceId } = req.body;
    const updates = ['updated_at=NOW()'];
    const params = [];
    let p = 1;
    if (assignedUserId  !== undefined) { updates.push(`assigned_user_id=$${p++}`);  params.push(assignedUserId || null); }
    if (opportunityId   !== undefined) { updates.push(`opportunity_id=$${p++}`);    params.push(opportunityId || null); }
    if (status          !== undefined) { updates.push(`status=$${p++}`);            params.push(status); }
    if (clientName      !== undefined) { updates.push(`client_name=$${p++}`);       params.push(clientName); }
    if (queueId         !== undefined) { updates.push(`queue_id=$${p++}`);          params.push(queueId || null); }
    if (apiInstanceId   !== undefined) { updates.push(`api_instance_id=$${p++}`);   params.push(apiInstanceId || null); }
    if (updates.length === 1) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });
    params.push(req.params.id);
    const { rows } = await pool.query(`UPDATE conversations SET ${updates.join(',')} WHERE id=$${p} RETURNING *`, params);
    if (!rows.length) return res.status(404).json({ error: 'Conversa não encontrada.' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar conversa: ' + err.message }); }
});

// ── TRANSFERÊNCIA ─────────────────────────────────────────────────────────
router.post('/conversations/:id/transfer', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { toUserId, toQueueId, reason } = req.body;
    const convId = req.params.id;
    const { rows: convRows } = await client.query('SELECT * FROM conversations WHERE id=$1', [convId]);
    if (!convRows.length) return res.status(404).json({ error: 'Conversa não encontrada.' });
    const conv = convRows[0];
    if (!isOwner(req.user, conv)) return res.status(403).json({ error: 'Esta conversa pertence a outro atendente.' });

    await client.query(
      `INSERT INTO chat_transfers
         (conversation_id, from_queue_id, to_queue_id, from_user_id, to_user_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [convId, conv.queue_id, toQueueId || conv.queue_id, req.user.id, toUserId || null, reason || null]
    );

    const updates = ['updated_at=NOW()', 'status=\'transferred\''];
    const params = [];
    let p = 1;
    if (toUserId)  { updates.push(`assigned_user_id=$${p++}`); params.push(toUserId); }
    if (toQueueId) { updates.push(`queue_id=$${p++}`);         params.push(toQueueId); }
    params.push(convId);
    await client.query(`UPDATE conversations SET ${updates.join(',')} WHERE id=$${p}`, params);
    await client.query(
      `INSERT INTO chat_messages
         (conversation_id, from_me, sender_name, msg_type, text_content, status, sent_at)
       VALUES ($1, true, 'Sistema', 'text', $2, 'SENT', NOW())`,
      [convId, `Conversa transferida por ${req.user.name}${reason ? ': ' + reason : '.'}`]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Erro ao transferir: ' + err.message });
  } finally { client.release(); }
});

// ── PAINEL LATERAL ────────────────────────────────────────────────────────
router.get('/conversations/:id/panel', async (req, res) => {
  try {
    const owned = await getOwnedConversation(req.params.id, req.user);
    if (owned.error) return res.status(owned.error[0]).json({ error: owned.error[1] });
    const conv = owned.conv;

    let opportunity = null;
    if (conv.opportunity_id) {
      const { rows: oppRows } = await pool.query(
        `SELECT o.*, u.name AS assigned_user_name, f.name AS funnel_name, s.name AS stage_name, p.name AS product_name, c.name AS category_name
         FROM opportunities o
         LEFT JOIN users u ON u.id = o.assigned_user_id
         LEFT JOIN funnels f ON f.id = o.funnel_id
         LEFT JOIN stages s ON s.id = o.stage_id
         LEFT JOIN products p ON p.id = o.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE o.id = $1`,
        [conv.opportunity_id]
      );
      opportunity = oppRows[0] || null;
    } else if (conv.phone) {
      const variants = phoneVariants(conv.phone);
      const { rows: oppRows } = await pool.query(
        `SELECT o.*, u.name AS assigned_user_name, f.name AS funnel_name, s.name AS stage_name
         FROM opportunities o
         LEFT JOIN users u ON u.id = o.assigned_user_id
         LEFT JOIN funnels f ON f.id = o.funnel_id
         LEFT JOIN stages s ON s.id = o.stage_id
         WHERE o.client_phone = ANY($1::text[]) OR o.client_cpf = ANY($1::text[])
         ORDER BY o.created_at DESC LIMIT 1`,
        [variants]
      );
      opportunity = oppRows[0] || null;
    }

    let notes = [];
    if (opportunity?.id) {
      const { rows } = await pool.query(
        `SELECT pn.*, u.name AS user_name
         FROM prospect_notes pn
         LEFT JOIN users u ON u.id = pn.user_id
         WHERE pn.opportunity_id = $1
         ORDER BY pn.contacted_at DESC LIMIT 5`,
        [opportunity.id]
      );
      notes = rows;
    }

    res.json({ conversation: conv, opportunity, notes });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar painel: ' + err.message }); }
});

// ── MENSAGENS ─────────────────────────────────────────────────────────────
router.get('/conversations/:id/messages/new', async (req, res) => {
  try {
    const owned = await getOwnedConversation(req.params.id, req.user);
    if (owned.error) return res.status(owned.error[0]).json({ error: owned.error[1] });
    const since = req.query.since ? Number(req.query.since) : 0;
    const { rows } = await pool.query(
      `SELECT m.*, u.name AS sender_user_name
       FROM chat_messages m
       LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1 AND m.id > $2
         AND (m.msg_type <> 'unsupported' OR NULLIF(m.text_content,'') IS NOT NULL)
       ORDER BY m.sent_at ASC, m.id ASC`,
      [req.params.id, since]
    );
    if (rows.length > 0) await pool.query('UPDATE conversations SET unread_count=0, updated_at=NOW() WHERE id=$1', [req.params.id]).catch(() => {});
    res.json({ messages: rows, lastId: rows.length ? rows[rows.length - 1].id : since });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar novas mensagens.' }); }
});

router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const owned = await getOwnedConversation(req.params.id, req.user);
    if (owned.error) return res.status(owned.error[0]).json({ error: owned.error[1] });
    const { before, limit = 60 } = req.query;
    const conv = owned.conv;
    let historyDays = 30;
    if (conv.queue_id) {
      const { rows: qRows } = await pool.query(`SELECT COALESCE(history_days, 30) AS history_days FROM attendance_queues WHERE id = $1`, [conv.queue_id]);
      if (qRows[0]) historyDays = Number(qRows[0].history_days) || 30;
    }

    let query = `
      SELECT m.*, u.name AS sender_user_name
      FROM chat_messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = $1
        AND m.sent_at >= NOW() - INTERVAL '${historyDays} days'
        AND (m.msg_type <> 'unsupported' OR NULLIF(m.text_content,'') IS NOT NULL)
    `;
    const params = [req.params.id];
    let p = 2;
    if (before) { query += ` AND m.id < $${p++}`; params.push(before); }
    query += ` ORDER BY m.sent_at DESC, m.id DESC LIMIT $${p}`;
    params.push(Math.min(Number(limit), 120));
    const { rows } = await pool.query(query, params);
    res.json(rows.reverse());
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar mensagens.' }); }
});

router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const { type = 'text', text, base64, fileName, caption } = req.body;
    const user = req.user;
    const owned = await getOwnedConversation(req.params.id, user);
    if (owned.error) return res.status(owned.error[0]).json({ error: owned.error[1] });
    const conv = owned.conv;

    let creds = null;
    if (conv.api_instance_id) creds = await zapi.getCreds(conv.api_instance_id).catch(() => null);
    if (!creds) creds = await zapi.getCreds().catch(() => null);
    if (!creds) return res.status(400).json({ error: 'Z-API não configurada para esta conversa.' });

    const targetPhone = zapiPhone(conv.phone || conv.phone_normalized);
    let zapiResult;
    if (type === 'text') {
      if (!text?.trim()) return res.status(400).json({ error: 'Texto é obrigatório.' });
      zapiResult = await zapi.sendText(creds, targetPhone, text.trim());
    } else if (type === 'image') {
      zapiResult = await zapi.sendImage(creds, targetPhone, base64, caption);
    } else if (type === 'audio') {
      zapiResult = await zapi.sendAudio(creds, targetPhone, base64);
    } else if (type === 'document') {
      zapiResult = await zapi.sendDocument(creds, targetPhone, base64, fileName, caption);
    } else {
      return res.status(400).json({ error: `Tipo '${type}' não suportado.` });
    }

    const zapiMessageId = zapiResult?.messageId || zapiResult?.zaapId || null;
    const { rows: msgRows } = await pool.query(
      `INSERT INTO chat_messages
         (conversation_id, zapi_message_id, from_me, sender_id, sender_name,
          msg_type, text_content, media_url, file_name, caption, status, sent_at)
       VALUES ($1,$2,true,$3,$4,$5,$6,$7,$8,$9,'SENT',NOW()) RETURNING *`,
      [conv.id, zapiMessageId, user.id, user.name, type, type === 'text' ? text.trim() : null, null, fileName || null, caption || null]
    );

    await pool.query(
      `UPDATE conversations
          SET phone=$2, phone_normalized=$3, last_message_at=NOW(), status='in_attendance', assigned_user_id=$4, updated_at=NOW()
        WHERE id=$1`,
      [conv.id, targetPhone, canonicalPhone(targetPhone), user.id]
    );

    res.status(201).json(msgRows[0]);
  } catch (err) {
    console.error('[CHAT] Erro ao enviar:', err.message);
    res.status(500).json({ error: 'Erro ao enviar mensagem: ' + err.message });
  }
});

router.get('/unread', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(unread_count),0) AS total
       FROM conversations
       WHERE status NOT IN ('closed','lost','converted') AND assigned_user_id=$1`,
      [req.user.id]
    );
    res.json({ total: Number(rows[0].total) });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar não lidas.' }); }
});

router.get('/queues-available', async (req, res) => {
  try {
    let query = `SELECT q.id, q.name, q.distribution_type FROM attendance_queues q WHERE q.is_active=true`;
    const params = [];
    if (!['admin','gerencia','bko'].includes(req.user.role)) {
      query += ` AND q.id IN (SELECT queue_id FROM queue_users WHERE user_id=$1 AND is_active=true)`;
      params.push(req.user.id);
    }
    query += ' ORDER BY q.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar filas.' }); }
});

module.exports = router;
