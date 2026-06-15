/**
 * POST /webhook — Recebe callbacks da Z-API.
 * Não requer autenticação JWT.
 */

const router = require('express').Router();
const { pool } = require('../config/db');
const zapi = require('../services/zapi');
const queueDistribution = require('../services/queueDistribution');

const seenMsgIds = new Set();

router.post('/', async (req, res) => {
  res.json({ ok: true });

  const payload = req.body;
  if (!payload || typeof payload !== 'object') return;

  const mid = payload.messageId || payload.zaapId || payload.id || payload.key?.id || null;

  if (mid) {
    if (seenMsgIds.has(mid) && !payload.status) return;
    seenMsgIds.add(mid);
    if (seenMsgIds.size > 8000) seenMsgIds.delete(seenMsgIds.values().next().value);
  }

  let evtId = null;
  try {
    const { rows: evtRows } = await pool.query(
      'INSERT INTO webhook_events (payload) VALUES ($1) RETURNING id',
      [JSON.stringify(payload)]
    );
    evtId = evtRows[0].id;

    const mappedStatus = zapi.mapStatus(payload.status || payload.messageStatus || payload.ack);
    if (mid && mappedStatus) {
      const { rowCount } = await pool.query(
        `UPDATE chat_messages
         SET status = $1, raw_payload = COALESCE(raw_payload,'{}'::jsonb) || $3::jsonb
         WHERE zapi_message_id = $2`,
        [mappedStatus, mid, JSON.stringify({ lastStatusPayload: payload })]
      );
      if (payload.fromMe === true && rowCount > 0) {
        await markEvent(evtId);
        return;
      }
    }

    // Se for apenas callback de status, pode parar aqui.
    if (payload.fromMe === true && mappedStatus && !payload.text && !payload.image && !payload.audio && !payload.video && !payload.document && !payload.sticker) {
      await markEvent(evtId);
      return;
    }

    const aliases = zapi.getAliases(payload);
    const phone = zapi.resolvePhone(payload);
    const clientName = payload.chatName || payload.senderName || payload.pushName || phone || 'Contato WhatsApp';
    if (!phone && !aliases.length) return;

    const apiInstance = await zapi.findApiInstanceFromPayload(payload);
    const queue = await queueDistribution.getDefaultQueueForInstance(apiInstance?.id || null);
    const assignedByRule = queue ? await queueDistribution.assignUserForQueue(queue.id) : null;

    const conversation = await findOrCreateConversation({
      phone,
      aliases,
      clientName,
      payload,
      apiInstance,
      queue,
      assignedByRule,
    });

    if (!conversation) return;

    const msgType = detectMsgType(payload);
    const textContent = extractText(payload, msgType);
    const mediaUrl = extractMediaUrl(payload, msgType);
    const extraJson = extractExtra(payload, msgType);
    const sentAt = payload.momment || payload.moment || payload.timestamp || payload.messageTimestamp;

    await pool.query(
      `INSERT INTO chat_messages
         (conversation_id, zapi_message_id, from_me, sender_name,
          msg_type, text_content, media_url, file_name, caption, extra_json, status, sent_at, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (zapi_message_id) WHERE zapi_message_id IS NOT NULL
       DO UPDATE SET
         status = EXCLUDED.status,
         raw_payload = EXCLUDED.raw_payload
       RETURNING id`,
      [
        conversation.id,
        mid,
        !!payload.fromMe,
        payload.senderName || clientName,
        msgType,
        textContent,
        mediaUrl,
        payload.document?.fileName || payload.document?.title || null,
        payload.image?.caption || payload.video?.caption || payload.document?.caption || null,
        extraJson ? JSON.stringify(extraJson) : null,
        mappedStatus || (payload.fromMe ? 'SENT' : 'RECEIVED'),
        sentAt ? new Date(Number(sentAt)) : new Date(),
        JSON.stringify(payload),
      ]
    );

    await pool.query(
      `UPDATE conversations SET
         unread_count = CASE WHEN $2 = true THEN unread_count ELSE unread_count + 1 END,
         last_message_at = NOW(),
         client_name = COALESCE(NULLIF($3,''), client_name),
         updated_at = NOW()
       WHERE id = $1`,
      [conversation.id, !!payload.fromMe, clientName !== phone ? clientName : null]
    );

    await markEvent(evtId);
  } catch (err) {
    console.error('[WEBHOOK] Erro ao processar:', err);
    if (evtId) {
      await pool.query('UPDATE webhook_events SET error=$2 WHERE id=$1', [evtId, err.message]).catch(() => {});
    }
  }
});

async function markEvent(id) {
  if (id) await pool.query('UPDATE webhook_events SET processed = true WHERE id = $1', [id]).catch(() => {});
}

async function findOrCreateConversation({ phone, aliases, clientName, payload, apiInstance, queue, assignedByRule }) {
  // 1. Procura por aliases.
  for (const a of aliases) {
    const { rows } = await pool.query(
      `SELECT c.* FROM chat_contact_aliases ca
       JOIN conversations c ON c.id = ca.conversation_id
       WHERE ca.alias = $1
       LIMIT 1`,
      [a.alias]
    ).catch(() => ({ rows: [] }));
    if (rows[0]) {
      await registerAliases(rows[0].id, aliases);
      return rows[0];
    }
  }

  // 2. Procura por telefone normalizado.
  const normalized = phone || aliases.find(a => a.type === 'phone')?.alias || null;
  if (normalized) {
    const { rows } = await pool.query(
      `SELECT * FROM conversations
       WHERE phone = $1 OR phone_normalized = $1
       LIMIT 1`,
      [normalized]
    ).catch(() => ({ rows: [] }));
    if (rows[0]) {
      await registerAliases(rows[0].id, aliases);
      return rows[0];
    }
  }

  // 3. Fallback por nome para evitar duplicação LID quando não vem telefone real.
  if (clientName && clientName !== normalized) {
    const { rows } = await pool.query(
      `SELECT * FROM conversations
       WHERE LOWER(client_name) = LOWER($1)
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT 1`,
      [clientName]
    ).catch(() => ({ rows: [] }));
    if (rows[0]) {
      await registerAliases(rows[0].id, aliases);
      return rows[0];
    }
  }

  const phoneToSave = normalized || aliases[0]?.alias || '';
  if (!phoneToSave) return null;

  const contact = apiInstance ? await zapi.fetchContact(apiInstance, phoneToSave).catch(() => null) : null;
  const finalName = contact?.name || clientName || phoneToSave;

  let opportunityId = null;
  let assignedUserId = assignedByRule || null;

  const { rows: existingOpps } = await pool.query(
    `SELECT id, assigned_user_id FROM opportunities
     WHERE client_phone = $1 OR client_cpf = $1
     ORDER BY created_at DESC LIMIT 1`,
    [phoneToSave]
  ).catch(() => ({ rows: [] }));

  if (existingOpps[0]) {
    opportunityId = existingOpps[0].id;
    assignedUserId = existingOpps[0].assigned_user_id || assignedUserId;
  }

  if (!opportunityId) {
    const { rows: funnelRows } = await pool.query(
      `SELECT f.id AS funnel_id, s.id AS stage_id
       FROM funnels f
       JOIN stages s ON s.funnel_id = f.id
       WHERE f.active = true
       ORDER BY f.sort_order ASC, s.sort_order ASC
       LIMIT 1`
    ).catch(() => ({ rows: [] }));

    if (funnelRows[0]) {
      const { rows: newOpp } = await pool.query(
        `INSERT INTO opportunities
           (funnel_id, stage_id, assigned_user_id, client_name, client_phone, status, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'open',$6,NOW(),NOW())
         RETURNING id`,
        [
          funnelRows[0].funnel_id,
          funnelRows[0].stage_id,
          assignedUserId,
          finalName,
          phoneToSave,
          `Oportunidade criada automaticamente via WhatsApp em ${new Date().toLocaleString('pt-BR')}.`,
        ]
      );
      opportunityId = newOpp[0].id;
    }
  }

  const { rows: newConv } = await pool.query(
    `INSERT INTO conversations
       (phone, phone_normalized, client_name, client_photo_url, unread_count, status,
        assigned_user_id, opportunity_id, queue_id, api_instance_id, raw_contact, last_message_at)
     VALUES ($1,$2,$3,$4,0,'new',$5,$6,$7,$8,$9,NOW())
     RETURNING *`,
    [
      phoneToSave,
      zapi.normalizePhone(phoneToSave),
      finalName,
      contact?.photo || null,
      assignedUserId,
      opportunityId,
      queue?.id || null,
      apiInstance?.id || null,
      JSON.stringify(contact?.raw || {}),
    ]
  );

  await registerAliases(newConv[0].id, aliases);
  return newConv[0];
}

async function registerAliases(conversationId, aliases) {
  for (const a of aliases) {
    if (!a.alias) continue;
    await pool.query(
      `INSERT INTO chat_contact_aliases (conversation_id, alias, alias_type)
       VALUES ($1,$2,$3)
       ON CONFLICT (alias) DO UPDATE SET conversation_id = EXCLUDED.conversation_id`,
      [conversationId, a.alias, a.type || 'unknown']
    ).catch(() => {});
  }
}

function detectMsgType(p) {
  if (p.text) return 'text';
  if (p.image) return 'image';
  if (p.audio) return 'audio';
  if (p.video) return 'video';
  if (p.document) return 'document';
  if (p.sticker) return 'sticker';
  if (p.location) return 'location';
  if (p.contact) return 'contact';
  if (p.reaction) return 'reaction';
  if (p.buttonsResponseMessage || p.listResponseMessage) return 'text';
  return 'unsupported';
}

function extractText(p, type) {
  if (type === 'text') {
    return p.text?.message || p.text?.body || (typeof p.text === 'string' ? p.text : null) || p.buttonsResponseMessage?.message || p.listResponseMessage?.message || null;
  }
  if (type === 'reaction') return p.reaction?.value || p.reaction?.emoji || '';
  return null;
}

function extractMediaUrl(p, type) {
  if (type === 'image') return p.image?.imageUrl || p.image?.url || null;
  if (type === 'audio') return p.audio?.audioUrl || p.audio?.url || null;
  if (type === 'video') return p.video?.videoUrl || p.video?.url || null;
  if (type === 'document') return p.document?.documentUrl || p.document?.url || null;
  if (type === 'sticker') return p.sticker?.stickerUrl || p.sticker?.url || null;
  return null;
}

function extractExtra(p, type) {
  if (type === 'location') return p.location;
  if (type === 'contact') return p.contact;
  if (type === 'reaction') return { value: p.reaction?.value || p.reaction?.emoji || p.reaction };
  if (p.notification) return { notification: p.notification };
  return null;
}

module.exports = router;
