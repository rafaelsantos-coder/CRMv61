/**
 * Integrações externas do Sistema Integrado Sulnet.
 *
 * SZ Chat → CRM
 * Endpoint público para receber webhooks do SZ Chat e criar/atualizar leads.
 * Segurança opcional: configure SZCHAT_WEBHOOK_TOKEN e envie o mesmo token no header
 * x-szchat-token, authorization bearer ou querystring ?token=.
 */

const router = require('express').Router();
const { pool } = require('../config/db');

let _schemaReady = false;

function normalizeUsername(value) {
  if (!value || typeof value !== 'string') return null;
  return value.split('@')[0].trim().toLowerCase() || null;
}

function normalizePhone(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D/g, '');
  return digits || null;
}

function pick(obj, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((acc, key) => {
      if (acc === undefined || acc === null) return undefined;
      return acc[key];
    }, obj);
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function stringifyMessage(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return value.message || value.body || value.text || value.content || value.caption || JSON.stringify(value);
  }
  return String(value);
}

function resolveEventName(payload) {
  return pick(payload, ['event', 'type', 'name', 'action', 'event_name', 'data.event', 'data.type']) || 'szchat_webhook';
}

function resolveAgentEmail(payload) {
  const direct = pick(payload, [
    'agent.email',
    'agent_email',
    'agentEmail',
    'assigned_agent.email',
    'assignedAgent.email',
    'attendance.agent.email',
    'attendance.agent_email',
    'session.agent.email',
    'user.email',
    'operator.email',
    'data.agent.email',
    'data.agent_email',
    'data.user.email',
    'data.operator.email',
  ]);

  if (direct) return String(direct);

  const maybeString = pick(payload, ['agent', 'user', 'operator', 'attendant', 'data.agent', 'data.user']);
  if (maybeString && typeof maybeString === 'string' && maybeString.includes('@')) return maybeString;

  // Para o primeiro teste solicitado: se o evento não trouxer agente, cairá na Gabrieli.
  return process.env.SZCHAT_DEFAULT_CRM_USERNAME || 'gabrieli.padilha';
}

function resolveCustomerName(payload) {
  return pick(payload, [
    'contact.name',
    'contact_name',
    'contactName',
    'customer.name',
    'customerName',
    'chatUserName',
    'client.name',
    'clientName',
    'name',
    'data.contact.name',
    'data.contact_name',
    'data.customer.name',
    'data.chatUserName',
    'data.clientName',
  ]) || 'Cliente SZ Chat';
}

function resolvePhone(payload) {
  return normalizePhone(pick(payload, [
    'contact.phone',
    'contact.number',
    'contact.platform_id',
    'platform_id',
    'platformId',
    'customerId',
    'chatUserId',
    'phone',
    'telephone',
    'mobile',
    'client.phone',
    'data.contact.phone',
    'data.contact.number',
    'data.platform_id',
    'data.customerId',
    'data.chatUserId',
    'data.phone',
  ]));
}

function resolveMessage(payload) {
  const value = pick(payload, [
    'message',
    'text',
    'body',
    'content',
    'last_message',
    'lastMessage',
    'data.message',
    'data.text',
    'data.body',
    'messages.0.text',
    'messages.0.message',
    'messages.0.body',
  ]);
  return stringifyMessage(value);
}

function checkWebhookToken(req) {
  const expected = process.env.SZCHAT_WEBHOOK_TOKEN;
  if (!expected) return true;

  const auth = req.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const provided = req.get('x-szchat-token') || req.query.token || bearer;
  return provided && provided === expected;
}

async function ensureSzChatSchema() {
  if (_schemaReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS szchat_integration_logs (
      id SERIAL PRIMARY KEY,
      event_name VARCHAR(120),
      szchat_user VARCHAR(160),
      crm_username VARCHAR(80),
      crm_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      opportunity_id INT REFERENCES opportunities(id) ON DELETE SET NULL,
      status VARCHAR(40) DEFAULT 'received',
      message TEXT,
      payload JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE opportunities
      ADD COLUMN IF NOT EXISTS szchat_session_id TEXT,
      ADD COLUMN IF NOT EXISTS szchat_protocol TEXT,
      ADD COLUMN IF NOT EXISTS szchat_channel_id TEXT,
      ADD COLUMN IF NOT EXISTS szchat_platform TEXT,
      ADD COLUMN IF NOT EXISTS szchat_contact_id TEXT,
      ADD COLUMN IF NOT EXISTS szchat_first_message TEXT,
      ADD COLUMN IF NOT EXISTS source_channel VARCHAR(80)
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_opps_szchat_session ON opportunities(szchat_session_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_opps_phone_digits ON opportunities((regexp_replace(COALESCE(client_phone,''), '\\D', '', 'g')))`);

  await pool.query(`INSERT INTO origins (name)
    SELECT 'SZ Chat'
    WHERE NOT EXISTS (SELECT 1 FROM origins WHERE LOWER(name) = LOWER('SZ Chat'))`);

  _schemaReady = true;
}

async function createLog({ eventName, szchatUser, crmUsername, crmUserId, opportunityId, status, message, payload }) {
  await pool.query(
    `INSERT INTO szchat_integration_logs
      (event_name, szchat_user, crm_username, crm_user_id, opportunity_id, status, message, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [eventName, szchatUser, crmUsername, crmUserId || null, opportunityId || null, status, message || null, JSON.stringify(payload || {})]
  ).catch(err => console.error('[SZCHAT LOG] erro:', err.message));
}

async function findCrmUser(crmUsername) {
  const { rows } = await pool.query(
    `SELECT * FROM users
     WHERE active = true
       AND (
        LOWER(username) = LOWER($1)
        OR LOWER(email) = LOWER($1)
        OR LOWER(split_part(email, '@', 1)) = LOWER($1)
       )
     LIMIT 1`,
    [crmUsername]
  );
  return rows[0] || null;
}

async function findUserFunnelAndStage(userId) {
  const { rows } = await pool.query(
    `SELECT f.id AS funnel_id,
            COALESCE(
              (SELECT s1.id FROM stages s1 WHERE s1.funnel_id = f.id AND LOWER(s1.name) IN ('lead inicial','início','inicio') ORDER BY s1.sort_order ASC, s1.id ASC LIMIT 1),
              (SELECT s2.id FROM stages s2 WHERE s2.funnel_id = f.id ORDER BY s2.sort_order ASC, s2.id ASC LIMIT 1)
            ) AS stage_id
     FROM user_funnel_access ufa
     JOIN funnels f ON f.id = ufa.funnel_id
     WHERE ufa.user_id = $1 AND COALESCE(f.active, true) = true
     ORDER BY f.sort_order ASC, f.id ASC
     LIMIT 1`,
    [userId]
  );

  if (rows[0]) return rows[0];

  const fallback = await pool.query(
    `SELECT f.id AS funnel_id, s.id AS stage_id
     FROM funnels f
     JOIN stages s ON s.funnel_id = f.id
     WHERE COALESCE(f.active, true) = true
     ORDER BY f.sort_order ASC, f.id ASC, s.sort_order ASC, s.id ASC
     LIMIT 1`
  );
  return fallback.rows[0] || null;
}

async function findSzChatOriginId() {
  const { rows } = await pool.query(`SELECT id FROM origins WHERE LOWER(name) = LOWER('SZ Chat') ORDER BY id LIMIT 1`);
  return rows[0]?.id || null;
}

async function findExistingOpenOpportunity({ phone, sessionId }) {
  if (sessionId) {
    const bySession = await pool.query(
      `SELECT * FROM opportunities WHERE status = 'open' AND szchat_session_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [sessionId]
    );
    if (bySession.rows[0]) return bySession.rows[0];
  }

  if (phone) {
    const byPhone = await pool.query(
      `SELECT * FROM opportunities
       WHERE status = 'open'
         AND regexp_replace(COALESCE(client_phone,''), '\\D', '', 'g') = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [phone]
    );
    if (byPhone.rows[0]) return byPhone.rows[0];
  }

  return null;
}

router.get('/health', async (_req, res) => {
  try {
    await ensureSzChatSchema();
    res.json({ ok: true, integration: 'SZ Chat', endpoint: '/api/integrations/szchat/webhook' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/webhook', async (req, res) => {
  const payload = req.body || {};
  const eventName = resolveEventName(payload);
  const szchatUser = resolveAgentEmail(payload);
  const crmUsername = normalizeUsername(szchatUser);

  try {
    if (!checkWebhookToken(req)) {
      await createLog({ eventName, szchatUser, crmUsername, status: 'unauthorized', message: 'Token inválido', payload });
      return res.status(401).json({ success: false, error: 'Token inválido.' });
    }

    await ensureSzChatSchema();

    if (!crmUsername) {
      await createLog({ eventName, szchatUser, status: 'error', message: 'Usuário SZ Chat não informado', payload });
      return res.status(400).json({ success: false, error: 'Usuário SZ Chat não informado.' });
    }

    const crmUser = await findCrmUser(crmUsername);
    if (!crmUser) {
      await createLog({ eventName, szchatUser, crmUsername, status: 'error', message: `Usuário CRM não encontrado: ${crmUsername}`, payload });
      return res.status(404).json({ success: false, error: `Usuário CRM não encontrado: ${crmUsername}` });
    }

    const funnelStage = await findUserFunnelAndStage(crmUser.id);
    if (!funnelStage?.funnel_id || !funnelStage?.stage_id) {
      await createLog({ eventName, szchatUser, crmUsername, crmUserId: crmUser.id, status: 'error', message: 'Funil/etapa inicial não encontrado para o usuário', payload });
      return res.status(422).json({ success: false, error: 'Funil/etapa inicial não encontrado para o usuário.' });
    }

    const originId = await findSzChatOriginId();
    const phone = resolvePhone(payload);
    const customerName = String(resolveCustomerName(payload)).trim() || 'Cliente SZ Chat';
    const firstMessage = resolveMessage(payload);
    const sessionId = pick(payload, ['session_id', 'sessionId', '_id', 'attendance_id', 'attendanceId', 'data.session_id', 'data._id']) || null;
    const protocol = pick(payload, ['protocol', 'protocolo', 'attendance.protocol', 'data.protocol']) || null;
    const channelId = pick(payload, ['channel_id', 'channelId', 'channel.id', 'data.channel_id']) || null;
    const platform = pick(payload, ['platform', 'platform_name', 'channel.platform', 'data.platform']) || 'SZ Chat';
    const contactId = pick(payload, ['contact_id', 'contactId', 'contact.id', 'data.contact_id', 'data.contact.id']) || null;

    if (!phone && !sessionId && !contactId) {
      await createLog({ eventName, szchatUser, crmUsername, crmUserId: crmUser.id, status: 'error', message: 'Sem telefone, sessão ou contato para identificar a lead', payload });
      return res.status(400).json({ success: false, error: 'Sem telefone, sessão ou contato para identificar a lead.' });
    }

    const existing = await findExistingOpenOpportunity({ phone, sessionId });
    if (existing) {
      await pool.query(
        `INSERT INTO prospect_notes
          (opportunity_id, user_id, channel, result, contacted_at, description)
         VALUES ($1,$2,'SZ Chat','Cliente chamou novamente',NOW(),$3)`,
        [
          existing.id,
          crmUser.id,
          firstMessage
            ? `Novo contato recebido via SZ Chat. Mensagem: ${firstMessage}`
            : 'Novo contato recebido via SZ Chat.',
        ]
      ).catch(() => {});

      await createLog({ eventName, szchatUser, crmUsername, crmUserId: crmUser.id, opportunityId: existing.id, status: 'duplicated', message: 'Lead aberta já existente. Histórico atualizado.', payload });
      return res.json({ success: true, duplicated: true, message: 'Lead já existente. Histórico atualizado.', lead_id: existing.id });
    }

    const notes = [
      'Lead criada automaticamente via integração SZ Chat.',
      protocol ? `Protocolo SZ Chat: ${protocol}.` : '',
      platform ? `Canal/plataforma: ${platform}.` : '',
      firstMessage ? `Primeira mensagem: ${firstMessage}` : '',
    ].filter(Boolean).join('\n');

    const { rows } = await pool.query(
      `INSERT INTO opportunities
        (funnel_id, stage_id, assigned_user_id, origin_id,
         client_name, client_phone, status, notes,
         szchat_session_id, szchat_protocol, szchat_channel_id,
         szchat_platform, szchat_contact_id, szchat_first_message, source_channel,
         created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,$12,$13,'SZ Chat',NOW(),NOW())
       RETURNING *`,
      [
        funnelStage.funnel_id,
        funnelStage.stage_id,
        crmUser.id,
        originId,
        customerName,
        phone,
        notes,
        sessionId,
        protocol,
        channelId,
        platform,
        contactId,
        firstMessage,
      ]
    );

    const lead = rows[0];

    await pool.query(
      `INSERT INTO prospect_notes
        (opportunity_id, user_id, channel, result, contacted_at, description)
       VALUES ($1,$2,'SZ Chat','Lead inicial',NOW(),$3)`,
      [lead.id, crmUser.id, firstMessage || 'Lead criada automaticamente pelo SZ Chat.']
    ).catch(() => {});

    await createLog({ eventName, szchatUser, crmUsername, crmUserId: crmUser.id, opportunityId: lead.id, status: 'created', message: 'Lead criada com sucesso.', payload });

    res.status(201).json({
      success: true,
      duplicated: false,
      message: 'Lead criada com sucesso.',
      lead_id: lead.id,
      crm_user: crmUsername,
      funnel_id: lead.funnel_id,
      stage_id: lead.stage_id,
      origin: 'SZ Chat',
    });
  } catch (err) {
    console.error('[SZCHAT WEBHOOK] erro:', err);
    await createLog({ eventName, szchatUser, crmUsername, status: 'error', message: err.message, payload });
    res.status(500).json({ success: false, error: 'Erro ao processar webhook SZ Chat.', detail: err.message });
  }
});

module.exports = router;
