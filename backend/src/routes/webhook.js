/**
 * POST /webhook - Recebe callbacks da Z-API.
 * Nao requer autenticacao JWT.
 */

const router = require('express').Router();
const { pool } = require('../config/db');
const zapi = require('../services/zapi');
const queueDistribution = require('../services/queueDistribution');

const seenMsgIds = new Set();
const CLOSED_STATUSES = new Set(['closed', 'lost', 'converted', 'transferred']);

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

function isClosedConversationStatus(status) {
  return CLOSED_STATUSES.has(String(status || '').toLowerCase());
}

function isMeaningfulText(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return !['unsupported', '[object object]'].includes(text.toLowerCase());
}

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
      const hostedMediaUrl = extractMediaUrl(payload, detectMsgType(payload));
      const { rowCount } = await pool.query(
        `UPDATE chat_messages
         SET status = $1,
             media_url = COALESCE($4, media_url),
             raw_payload = COALESCE(raw_payload,'{}'::jsonb) || $3::jsonb
         WHERE zapi_message_id = $2`,
        [mappedStatus, mid, JSON.stringify({ lastStatusPayload: payload }), hostedMediaUrl]
      );
      if (payload.fromMe === true && rowCount > 0) {
        await markEvent(evtId);
        return;
      }
    }

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

    if (msgType === 'unsupported' && !textContent && !mediaUrl) {
      await markEvent(evtId);
      return;
    }

    await pool.query(
      `INSERT INTO chat_messages
         (conversation_id, zapi_message_id, from_me, sender_name,
          msg_type, text_content, media_url, file_name, caption, extra_json, status, sent_at, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (zapi_message_id) WHERE zapi_message_id IS NOT NULL
       DO UPDATE SET
         conversation_id = EXCLUDED.conversation_id,
         status = EXCLUDED.status,
         media_url = COALESCE(EXCLUDED.media_url, chat_messages.media_url),
         caption = COALESCE(EXCLUDED.caption, chat_messages.caption),
         file_name = COALESCE(EXCLUDED.file_name, chat_messages.file_name),
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

    const assignmentUserId = await resolveAssignmentForIncoming(conversation, queue, assignedByRule);

    await pool.query(
      `UPDATE conversations SET
         phone = COALESCE(NULLIF(phone,''), $4),
         phone_normalized = $5,
         unread_count = CASE WHEN $2 = true THEN unread_count ELSE unread_count + 1 END,
         last_message_at = NOW(),
         client_name = COALESCE(NULLIF($3,''), client_name),
         assigned_user_id = COALESCE($6, assigned_user_id),
         queue_id = COALESCE(queue_id, $7),
         api_instance_id = COALESCE(api_instance_id, $8),
         status = CASE
           WHEN status IN ('closed','lost','converted','transferred') THEN 'new'
           ELSE COALESCE(status, 'new')
         END,
         updated_at = NOW()
       WHERE id = $1`,
      [
        conversation.id,
        !!payload.fromMe,
        clientName !== phone ? clientName : null,
        zapiPhone(phone),
        canonicalPhone(phone),
        assignmentUserId,
        queue?.id || null,
        apiInstance?.id || null,
      ]
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

async function resolveAssignmentForIncoming(conversation, queue, suggestedUserId) {
  const currentUserId = conversation?.assigned_user_id ? Number(conversation.assigned_user_id) : null;
  const nextUserId = suggestedUserId ? Number(suggestedUserId) : null;

  if (!currentUserId) return nextUserId || null;
  if (isClosedConversationStatus(conversation.status)) return nextUserId || currentUserId;
  if (!queue?.id) return null;

  const { rows } = await pool.query(
    `SELECT 1
       FROM queue_users qu
       JOIN users u ON u.id = qu.user_id
      WHERE qu.queue_id=$1
        AND qu.user_id=$2
        AND qu.is_active=true
        AND u.active=true
      LIMIT 1`,
    [queue.id, currentUserId]
  ).catch(() => ({ rows: [] }));

  return rows.length ? null : (nextUserId || null);
}

async function findOrCreateConversation({ phone, aliases, clientName, payload, apiInstance, queue, assignedByRule }) {
  const lookupValues = new Set();
  for (const a of aliases) {
    if (a.alias) {
      lookupValues.add(a.alias);
      phoneVariants(a.alias).forEach(v => lookupValues.add(v));
    }
  }
  phoneVariants(phone).forEach(v => lookupValues.add(v));
  const lookup = [...lookupValues].filter(Boolean);

  if (lookup.length) {
    const { rows } = await pool.query(
      `SELECT c.*
         FROM conversations c
        WHERE c.phone = ANY($1::text[])
           OR c.phone_normalized = ANY($1::text[])
        ORDER BY c.last_message_at DESC NULLS LAST, c.updated_at DESC NULLS LAST, c.id DESC
        LIMIT 1`,
      [lookup]
    ).catch(() => ({ rows: [] }));
    if (rows[0]) {
      await registerAliases(rows[0].id, aliases);
      await mergeConversationDuplicates(rows[0], lookup);
      return rows[0];
    }
  }

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
      await mergeConversationDuplicates(rows[0], lookup);
      return rows[0];
    }
  }

  if (clientName && lookup.length) {
    const { rows } = await pool.query(
      `SELECT * FROM conversations
       WHERE LOWER(client_name) = LOWER($1)
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT 1`,
      [clientName]
    ).catch(() => ({ rows: [] }));
    if (rows[0]) {
      await registerAliases(rows[0].id, aliases);
      await mergeConversationDuplicates(rows[0], lookup);
      return rows[0];
    }
  }

  const phoneToSave = zapiPhone(phone || aliases[0]?.alias || '');
  const normalized = canonicalPhone(phoneToSave);
  if (!phoneToSave) return null;

  const contact = apiInstance ? await zapi.fetchContact(apiInstance, phoneToSave).catch(() => null) : null;
  const finalName = contact?.name || clientName || phoneToSave;

  let opportunityId = null;
  let assignedUserId = assignedByRule || null;
  const variants = phoneVariants(phoneToSave);

  const { rows: existingOpps } = await pool.query(
    `SELECT id, assigned_user_id FROM opportunities
     WHERE client_phone = ANY($1::text[]) OR client_cpf = ANY($1::text[])
     ORDER BY created_at DESC LIMIT 1`,
    [variants]
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
      normalized,
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

async function mergeConversationDuplicates(primary, lookup) {
  if (!primary?.id || !lookup?.length) return;
  const { rows } = await pool.query(
    `SELECT id FROM conversations
      WHERE id <> $1
        AND (phone = ANY($2::text[]) OR phone_normalized = ANY($2::text[]))`,
    [primary.id, lookup]
  ).catch(() => ({ rows: [] }));
  const duplicateIds = rows.map(r => r.id);
  if (!duplicateIds.length) return;
  await pool.query('UPDATE chat_messages SET conversation_id=$1 WHERE conversation_id = ANY($2::int[])', [primary.id, duplicateIds]).catch(() => {});
  await pool.query('UPDATE chat_contact_aliases SET conversation_id=$1 WHERE conversation_id = ANY($2::int[])', [primary.id, duplicateIds]).catch(() => {});
  await pool.query('DELETE FROM conversations WHERE id = ANY($1::int[])', [duplicateIds]).catch(() => {});
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
    for (const v of phoneVariants(a.alias)) {
      await pool.query(
        `INSERT INTO chat_contact_aliases (conversation_id, alias, alias_type)
         VALUES ($1,$2,$3)
         ON CONFLICT (alias) DO UPDATE SET conversation_id = EXCLUDED.conversation_id`,
        [conversationId, v, 'phone_variant']
      ).catch(() => {});
    }
  }
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && isMeaningfulText(value)) return value.trim();
    if (value && typeof value === 'object') {
      const nested = firstText(
        value.message,
        value.body,
        value.text,
        value.content,
        value.caption,
        value.value,
        value.title,
        value.description,
        value.selectedDisplayText,
        value.selectedButtonId,
        value.selectedRowId
      );
      if (nested) return nested;
    }
  }
  return null;
}

function extractPlainText(p) {
  return firstText(
    p.text,
    p.message,
    p.body,
    p.content,
    p.caption,
    p.messageText,
    p.textMessage,
    p.conversation,
    p.extendedTextMessage,
    p.buttonsResponseMessage,
    p.listResponseMessage,
    p.templateButtonReplyMessage
  );
}

function detectMsgType(p) {
  if (extractPlainText(p)) return 'text';
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
    return extractPlainText(p);
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
