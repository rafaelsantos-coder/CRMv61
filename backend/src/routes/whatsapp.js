const router = require('express').Router();
const { pool } = require('../config/db');
const { requireRole } = require('../middleware/auth');
const zapi = require('../services/zapi');

router.use(requireRole(['admin', 'gerencia']));

router.use(async (req, res, next) => {
  try {
    await ensureWhatsappSchema();
    next();
  } catch (err) {
    console.error('[WHATSAPP SCHEMA]', err);
    res.status(500).json({ error: 'Erro ao preparar módulo WhatsApp: ' + err.message });
  }
});

function toBool(v) {
  return v !== false && v !== 'false' && v !== 0 && v !== '0';
}

function mask(value, keepStart = 4, keepEnd = 4) {
  if (!value) return '';
  value = String(value);
  if (value.length <= keepStart + keepEnd) return '••••';
  return value.slice(0, keepStart) + '••••••' + value.slice(-keepEnd);
}

function parseJson(v, fallback = {}) {
  if (!v) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}


// ── Auto-correção de schema do módulo WhatsApp ──────────────────────────────
// Evita travar a criação de fila quando a migration ainda não foi aplicada no Railway.
let _schemaReady = false;
async function ensureWhatsappSchema() {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS api_instances (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    provider VARCHAR(40) DEFAULT 'Z-API',
    instance_id TEXT NOT NULL,
    token TEXT NOT NULL,
    client_token TEXT,
    phone_number VARCHAR(30),
    status VARCHAR(40) DEFAULT 'pending',
    webhook_url TEXT,
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}'::jsonb,
    api_url TEXT,
    bot_type VARCHAR(40) DEFAULT 'whatsapp',
    last_status_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'api_instances_provider_instance_unique'
    ) THEN
      ALTER TABLE api_instances
      ADD CONSTRAINT api_instances_provider_instance_unique UNIQUE(provider, instance_id);
    END IF;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

  await pool.query(`CREATE TABLE IF NOT EXISTS attendance_queues (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    description TEXT,
    type VARCHAR(40) DEFAULT 'comercial',
    api_instance_id INT REFERENCES api_instances(id) ON DELETE SET NULL,
    distribution_type VARCHAR(40) DEFAULT 'round_robin',
    business_hours JSONB DEFAULT '{}'::jsonb,
    welcome_message TEXT,
    after_hours_message TEXT,
    is_active BOOLEAN DEFAULT true,
    last_assigned_user_id INT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`ALTER TABLE attendance_queues
    ADD COLUMN IF NOT EXISTS queue_type VARCHAR(40) DEFAULT 'zapi',
    ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30),
    ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS messages_config JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS server_status VARCHAR(40) DEFAULT 'pending'
  `);

  await pool.query(`CREATE TABLE IF NOT EXISTS whatsapp_groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    queue_id INT NOT NULL REFERENCES attendance_queues(id) ON DELETE CASCADE,
    distribution_type VARCHAR(40) DEFAULT 'round_robin',
    max_per_agent INT DEFAULT 100,
    settings JSONB DEFAULT '{}'::jsonb,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS whatsapp_group_users (
    id SERIAL PRIMARY KEY,
    group_id INT NOT NULL REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_in_group VARCHAR(40) DEFAULT 'atendente',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(group_id, user_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS queue_users (
    id SERIAL PRIMARY KEY,
    queue_id INT NOT NULL REFERENCES attendance_queues(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_in_queue VARCHAR(40) DEFAULT 'atendente',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(queue_id, user_id)
  )`);

  await pool.query(`ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS queue_id INT,
    ADD COLUMN IF NOT EXISTS api_instance_id INT,
    ADD COLUMN IF NOT EXISTS group_id INT,
    ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(30),
    ADD COLUMN IF NOT EXISTS provider_contact_id TEXT,
    ADD COLUMN IF NOT EXISTS contact_lid TEXT,
    ADD COLUMN IF NOT EXISTS chat_lid TEXT,
    ADD COLUMN IF NOT EXISTS raw_contact JSONB DEFAULT '{}'::jsonb
  `).catch(() => {});

  await pool.query(`CREATE TABLE IF NOT EXISTS chat_contact_aliases (
    id SERIAL PRIMARY KEY,
    conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    alias TEXT NOT NULL UNIQUE,
    alias_type VARCHAR(40) DEFAULT 'unknown',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});

  await pool.query(`ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS raw_payload JSONB DEFAULT '{}'::jsonb
  `).catch(() => {});

  _schemaReady = true;
}

async function getQueueFull(id) {
  const { rows } = await pool.query(`
    SELECT
      q.*,
      ai.name AS api_instance_name,
      ai.provider,
      ai.instance_id,
      ai.token,
      ai.client_token,
      ai.webhook_url,
      ai.status AS api_status,
      ai.api_url
    FROM attendance_queues q
    LEFT JOIN api_instances ai ON ai.id = q.api_instance_id
    WHERE q.id = $1
  `, [id]);

  const q = rows[0];
  if (!q) return null;

  q.settings = parseJson(q.settings);
  q.messages_config = parseJson(q.messages_config);
  q.instance_id_masked = mask(q.instance_id);
  q.token_masked = q.token ? '••••••••••••••••' : '';
  q.client_token_masked = q.client_token ? '••••••••••••••••' : '';
  delete q.token;
  delete q.client_token;
  return q;
}

// ── FILAS DE WHATSAPP ──────────────────────────────────────────────────────
router.get('/queues', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        q.*,
        ai.name AS api_instance_name,
        ai.provider,
        ai.instance_id,
        ai.webhook_url,
        ai.status AS api_status,
        COUNT(DISTINCT wg.id)::int AS groups_count
      FROM attendance_queues q
      LEFT JOIN api_instances ai ON ai.id = q.api_instance_id
      LEFT JOIN whatsapp_groups wg ON wg.queue_id = q.id AND wg.is_active = true
      WHERE COALESCE(q.queue_type, 'zapi') IN ('zapi','cloud','wamd')
      GROUP BY q.id, ai.id
      ORDER BY q.id DESC
    `);

    res.json(rows.map(q => ({
      ...q,
      settings: parseJson(q.settings),
      messages_config: parseJson(q.messages_config),
      instance_id_masked: mask(q.instance_id),
    })));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar filas de WhatsApp: ' + err.message });
  }
});

router.get('/queues/:id', async (req, res) => {
  try {
    const q = await getQueueFull(req.params.id);
    if (!q) return res.status(404).json({ error: 'Fila não encontrada.' });
    res.json(q);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar fila: ' + err.message });
  }
});

router.post('/queues', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const d = req.body || {};
    if (!d.name) return res.status(400).json({ error: 'Nome da fila é obrigatório.' });

    const queueType = d.queueType || d.queue_type || 'zapi';
    if (queueType !== 'zapi') {
      return res.status(400).json({ error: 'Neste primeiro momento, somente fila do tipo Z-API está habilitada.' });
    }

    let apiInstanceId = null;
    let apiStatus = 'pending';

    if (d.instanceId && d.token) {
      const creds = {
        instance_id: d.instanceId,
        token: d.token,
        client_token: d.clientToken || '',
      };

      if (d.testConnection) {
        const status = await zapi.checkStatus(creds);
        apiStatus = (status.connected || status.smartphoneConnected) ? 'connected' : 'disconnected';
      }

      const { rows: aiRows } = await client.query(`
        INSERT INTO api_instances
          (name, provider, instance_id, token, client_token, phone_number, status, is_active, api_url, updated_at)
        VALUES ($1,'Z-API',$2,$3,$4,$5,$6,true,$7,NOW())
        ON CONFLICT (provider, instance_id)
        DO UPDATE SET
          name=EXCLUDED.name,
          token=EXCLUDED.token,
          client_token=EXCLUDED.client_token,
          phone_number=EXCLUDED.phone_number,
          status=EXCLUDED.status,
          api_url=EXCLUDED.api_url,
          is_active=true,
          updated_at=NOW()
        RETURNING id
      `, [
        d.name,
        d.instanceId,
        d.token,
        d.clientToken || '',
        d.phoneNumber || '',
        apiStatus,
        d.apiUrl || `https://api.z-api.io/instances/${d.instanceId}/token/${d.token}/send-text`,
      ]);
      apiInstanceId = aiRows[0].id;
    }

    const { rows } = await client.query(`
      INSERT INTO attendance_queues
        (name, description, type, queue_type, phone_number, api_instance_id,
         distribution_type, welcome_message, after_hours_message, settings,
         messages_config, server_status, is_active, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
      RETURNING id
    `, [
      d.name,
      d.description || '',
      d.type || 'comercial',
      queueType,
      d.phoneNumber || '',
      apiInstanceId,
      d.distributionType || 'round_robin',
      d.welcomeMessage || '',
      d.afterHoursMessage || '',
      JSON.stringify(d.settings || {}),
      JSON.stringify(d.messagesConfig || {}),
      apiStatus === 'connected' ? 'Autenticado' : 'Pendente',
      toBool(d.isActive),
    ]);

    await client.query('COMMIT');
    res.status(201).json(await getQueueFull(rows[0].id));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao criar fila: ' + err.message });
  } finally {
    client.release();
  }
});

router.patch('/queues/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = req.params.id;
    const d = req.body || {};

    const current = await getQueueFull(id);
    if (!current) return res.status(404).json({ error: 'Fila não encontrada.' });

    let apiInstanceId = current.api_instance_id || null;
    let apiStatus = current.api_status || 'pending';

    if (d.instanceId && d.token) {
      const creds = {
        instance_id: d.instanceId,
        token: d.token,
        client_token: d.clientToken || '',
      };

      if (d.testConnection) {
        const status = await zapi.checkStatus(creds);
        apiStatus = (status.connected || status.smartphoneConnected) ? 'connected' : 'disconnected';
      }

      const { rows: aiRows } = await client.query(`
        INSERT INTO api_instances
          (name, provider, instance_id, token, client_token, phone_number, status, is_active, api_url, updated_at)
        VALUES ($1,'Z-API',$2,$3,$4,$5,$6,true,$7,NOW())
        ON CONFLICT (provider, instance_id)
        DO UPDATE SET
          name=EXCLUDED.name,
          token=EXCLUDED.token,
          client_token=EXCLUDED.client_token,
          phone_number=EXCLUDED.phone_number,
          status=EXCLUDED.status,
          api_url=EXCLUDED.api_url,
          is_active=true,
          updated_at=NOW()
        RETURNING id
      `, [
        d.name || current.name,
        d.instanceId,
        d.token,
        d.clientToken || '',
        d.phoneNumber || current.phone_number || '',
        apiStatus,
        d.apiUrl || `https://api.z-api.io/instances/${d.instanceId}/token/${d.token}/send-text`,
      ]);
      apiInstanceId = aiRows[0].id;
    }

    await client.query(`
      UPDATE attendance_queues SET
        name=COALESCE($1,name),
        description=COALESCE($2,description),
        type=COALESCE($3,type),
        queue_type=COALESCE($4,queue_type),
        phone_number=COALESCE($5,phone_number),
        api_instance_id=$6,
        distribution_type=COALESCE($7,distribution_type),
        welcome_message=COALESCE($8,welcome_message),
        after_hours_message=COALESCE($9,after_hours_message),
        settings=COALESCE($10,settings),
        messages_config=COALESCE($11,messages_config),
        server_status=$12,
        is_active=COALESCE($13,is_active),
        updated_at=NOW()
      WHERE id=$14
    `, [
      d.name || null,
      d.description || null,
      d.type || null,
      d.queueType || d.queue_type || null,
      d.phoneNumber || null,
      apiInstanceId,
      d.distributionType || null,
      d.welcomeMessage || null,
      d.afterHoursMessage || null,
      d.settings ? JSON.stringify(d.settings) : null,
      d.messagesConfig ? JSON.stringify(d.messagesConfig) : null,
      apiStatus === 'connected' ? 'Autenticado' : (current.server_status || 'Pendente'),
      d.isActive === undefined ? null : toBool(d.isActive),
      id,
    ]);

    await client.query('COMMIT');
    res.json(await getQueueFull(id));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao atualizar fila: ' + err.message });
  } finally {
    client.release();
  }
});

router.delete('/queues/:id', async (req, res) => {
  try {
    await pool.query('UPDATE attendance_queues SET is_active=false, updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao desativar fila: ' + err.message });
  }
});

router.post('/queues/:id/test-status', async (req, res) => {
  try {
    const q = await getQueueFull(req.params.id);
    if (!q || !q.api_instance_id) return res.status(400).json({ error: 'Fila sem instância Z-API configurada.' });

    const creds = await zapi.getCreds(q.api_instance_id);
    const status = await zapi.checkStatus(creds);
    const connected = !!(status.connected || status.smartphoneConnected);

    // Número conectado vem da Z-API automaticamente
    const phoneNumber = status.connectedPhone || status.phone || status.number || status.wid || null;
    const cleanPhone  = phoneNumber ? String(phoneNumber).replace(/[^0-9]/g, '') : null;

    await pool.query(`
      UPDATE api_instances SET
        status=$1, last_status_at=NOW(), updated_at=NOW()
        ${cleanPhone ? ', phone_number=$3' : ''}
      WHERE id=$2
    `, cleanPhone
      ? [connected ? 'connected' : 'disconnected', q.api_instance_id, cleanPhone]
      : [connected ? 'connected' : 'disconnected', q.api_instance_id]
    );

    if (cleanPhone) {
      await pool.query(`
        UPDATE attendance_queues SET phone_number=$1, updated_at=NOW() WHERE id=$2
      `, [cleanPhone, q.id]);
    }

    await pool.query(`
      UPDATE attendance_queues SET server_status=$1, updated_at=NOW() WHERE id=$2
    `, [connected ? 'Autenticado' : 'Desconectado', q.id]);

    res.json({ ok: true, connected, phoneNumber: cleanPhone, raw: status });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao testar Z-API: ' + err.message });
  }
});

router.post('/queues/:id/register-webhook', async (req, res) => {
  try {
    const q = await getQueueFull(req.params.id);
    if (!q || !q.api_instance_id) return res.status(400).json({ error: 'Fila sem instância Z-API configurada.' });

    const creds = await zapi.getCreds(q.api_instance_id);
    const webhookUrl = `${req.protocol}://${req.get('host')}/webhook`;

    if (zapi.registerEveryWebhook) {
      await zapi.registerEveryWebhook(creds, webhookUrl);
    } else {
      await zapi.registerWebhook(creds, webhookUrl);
    }

    await pool.query('UPDATE api_instances SET webhook_url=$1, updated_at=NOW() WHERE id=$2', [webhookUrl, q.api_instance_id]);
    await pool.query('UPDATE attendance_queues SET server_status=$1, updated_at=NOW() WHERE id=$2', ['Autenticado', q.id]);

    res.json({ ok: true, webhookUrl });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar webhook: ' + err.message });
  }
});

// ── GRUPOS DE ATENDIMENTO ──────────────────────────────────────────────────
router.get('/groups', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        g.*,
        q.name AS queue_name,
        q.phone_number,
        COALESCE(
          json_agg(
            json_build_object('id', u.id, 'name', u.name, 'role', u.role, 'roleInGroup', gu.role_in_group)
          ) FILTER (WHERE u.id IS NOT NULL),
          '[]'
        ) AS users
      FROM whatsapp_groups g
      JOIN attendance_queues q ON q.id = g.queue_id
      LEFT JOIN whatsapp_group_users gu ON gu.group_id = g.id AND gu.is_active = true
      LEFT JOIN users u ON u.id = gu.user_id
      WHERE g.is_active = true
      GROUP BY g.id, q.id
      ORDER BY g.id DESC
    `);
    res.json(rows.map(r => ({ ...r, settings: parseJson(r.settings) })));
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar grupos: ' + err.message });
  }
});

router.post('/groups', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const d = req.body || {};
    if (!d.name) return res.status(400).json({ error: 'Nome do grupo é obrigatório.' });
    if (!d.queueId) return res.status(400).json({ error: 'Fila vinculada é obrigatória.' });

    const { rows } = await client.query(`
      INSERT INTO whatsapp_groups
        (name, queue_id, distribution_type, max_per_agent, settings, is_active, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      RETURNING id
    `, [
      d.name,
      d.queueId,
      d.distributionType || 'round_robin',
      d.maxPerAgent || 100,
      JSON.stringify(d.settings || {}),
      toBool(d.isActive),
    ]);

    const groupId = rows[0].id;
    const users = d.users || [];
    for (const u of users) {
      const userId = typeof u === 'object' ? u.id : u;
      const role = typeof u === 'object' ? (u.roleInGroup || 'atendente') : 'atendente';

      await client.query(`
        INSERT INTO whatsapp_group_users (group_id, user_id, role_in_group, is_active)
        VALUES ($1,$2,$3,true)
        ON CONFLICT (group_id, user_id)
        DO UPDATE SET role_in_group=EXCLUDED.role_in_group, is_active=true
      `, [groupId, userId, role]);

      // Espelha no vínculo de fila para o chat operacional respeitar acesso por fila.
      await client.query(`
        INSERT INTO queue_users (queue_id, user_id, role_in_queue, is_active)
        VALUES ($1,$2,$3,true)
        ON CONFLICT (queue_id, user_id)
        DO UPDATE SET role_in_queue=EXCLUDED.role_in_queue, is_active=true
      `, [d.queueId, userId, role === 'supervisor' ? 'supervisor' : 'atendente']);
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, id: groupId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao criar grupo: ' + err.message });
  } finally {
    client.release();
  }
});

router.patch('/groups/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const d = req.body || {};
    await client.query(`
      UPDATE whatsapp_groups SET
        name=COALESCE($1,name),
        queue_id=COALESCE($2,queue_id),
        distribution_type=COALESCE($3,distribution_type),
        max_per_agent=COALESCE($4,max_per_agent),
        settings=COALESCE($5,settings),
        is_active=COALESCE($6,is_active),
        updated_at=NOW()
      WHERE id=$7
    `, [
      d.name || null,
      d.queueId || null,
      d.distributionType || null,
      d.maxPerAgent || null,
      d.settings ? JSON.stringify(d.settings) : null,
      d.isActive === undefined ? null : toBool(d.isActive),
      req.params.id,
    ]);

    if (Array.isArray(d.users)) {
      await client.query('UPDATE whatsapp_group_users SET is_active=false WHERE group_id=$1', [req.params.id]);

      const { rows: groupRows } = await client.query('SELECT queue_id FROM whatsapp_groups WHERE id=$1', [req.params.id]);
      const queueId = groupRows[0]?.queue_id;

      for (const u of d.users) {
        const userId = typeof u === 'object' ? u.id : u;
        const role = typeof u === 'object' ? (u.roleInGroup || 'atendente') : 'atendente';

        await client.query(`
          INSERT INTO whatsapp_group_users (group_id, user_id, role_in_group, is_active)
          VALUES ($1,$2,$3,true)
          ON CONFLICT (group_id, user_id)
          DO UPDATE SET role_in_group=EXCLUDED.role_in_group, is_active=true
        `, [req.params.id, userId, role]);

        if (queueId) {
          await client.query(`
            INSERT INTO queue_users (queue_id, user_id, role_in_queue, is_active)
            VALUES ($1,$2,$3,true)
            ON CONFLICT (queue_id, user_id)
            DO UPDATE SET role_in_queue=EXCLUDED.role_in_queue, is_active=true
          `, [queueId, userId, role === 'supervisor' ? 'supervisor' : 'atendente']);
        }
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erro ao atualizar grupo: ' + err.message });
  } finally {
    client.release();
  }
});

router.delete('/groups/:id', async (req, res) => {
  try {
    await pool.query('UPDATE whatsapp_groups SET is_active=false, updated_at=NOW() WHERE id=$1', [req.params.id]);
    await pool.query('UPDATE whatsapp_group_users SET is_active=false WHERE group_id=$1', [req.params.id]).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao desativar grupo: ' + err.message });
  }
});

// Usuários disponíveis para grupos
router.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, username, role, city, active
      FROM users
      WHERE active = true
      ORDER BY name
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar usuários: ' + err.message });
  }
});

module.exports = router;
