/**
 * Sulnet V1 — Backend de Produção
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'sistema-integrado-sulnet-v1-secret-trocar-nas-variaveis';
process.env.JWT_EXPIRES = process.env.JWT_EXPIRES || '12h';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'sistema-integrado-sulnet-v1-docs';

const { pool } = require('./config/db');
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const oppsRoutes = require('./routes/opportunities');
const creditRoutes = require('./routes/credit');
const agendaRoutes = require('./routes/agenda');
const adminRoutes = require('./routes/admin');
const uploadsRoutes = require('./routes/uploads');
const dashboardRoutes = require('./routes/dashboard');
const chatRoutes = require('./routes/chat');
const chatAdminRoutes = require('./routes/chatAdmin');
const whatsappRoutes = require('./routes/whatsapp');
const webhookRoutes = require('./routes/webhook');
const integrationsRoutes = require('./routes/integrations');
const { authMiddleware } = require('./middleware/auth');
const { runMigrations } = require('./config/migrate');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()) : true, credentials: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas requisições. Tente novamente em 15 minutos.' } }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Muitas tentativas de login. Aguarde 15 minutos.' } }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

function requireQueueAdmin(req, res) {
  if (!req.user || !['admin', 'gerencia'].includes(req.user.role)) {
    res.status(403).json({ error: 'Acesso restrito a administradores/gerência.' });
    return false;
  }
  return true;
}

let chatSchemaReady = false;
async function ensureChatSchema(req, res, next) {
  try {
    if (chatSchemaReady) return next();

    await pool.query(`CREATE TABLE IF NOT EXISTS zapi_config (
      id SERIAL PRIMARY KEY,
      instance_id TEXT NOT NULL,
      token TEXT NOT NULL,
      client_token TEXT NOT NULL DEFAULT '',
      webhook_url TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE zapi_config
      ADD COLUMN IF NOT EXISTS instance_id TEXT,
      ADD COLUMN IF NOT EXISTS token TEXT,
      ADD COLUMN IF NOT EXISTS client_token TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS webhook_url TEXT,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
    `);

    await pool.query(`CREATE TABLE IF NOT EXISTS api_instances (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) DEFAULT 'Z-API',
      provider VARCHAR(40) DEFAULT 'Z-API',
      instance_id TEXT,
      token TEXT,
      client_token TEXT DEFAULT '',
      phone_number VARCHAR(30),
      status VARCHAR(40) DEFAULT 'unknown',
      webhook_url TEXT,
      is_active BOOLEAN DEFAULT true,
      metadata JSONB DEFAULT '{}'::jsonb,
      api_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE api_instances
      ADD COLUMN IF NOT EXISTS name VARCHAR(120) DEFAULT 'Z-API',
      ADD COLUMN IF NOT EXISTS provider VARCHAR(40) DEFAULT 'Z-API',
      ADD COLUMN IF NOT EXISTS instance_id TEXT,
      ADD COLUMN IF NOT EXISTS token TEXT,
      ADD COLUMN IF NOT EXISTS client_token TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30),
      ADD COLUMN IF NOT EXISTS status VARCHAR(40) DEFAULT 'unknown',
      ADD COLUMN IF NOT EXISTS webhook_url TEXT,
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS api_url TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
    `);
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_instances_provider_instance_unique') THEN
        ALTER TABLE api_instances ADD CONSTRAINT api_instances_provider_instance_unique UNIQUE(provider, instance_id);
      END IF;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`).catch(() => {});

    await pool.query(`CREATE TABLE IF NOT EXISTS attendance_queues (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) DEFAULT '',
      description TEXT,
      type VARCHAR(40) DEFAULT 'comercial',
      api_instance_id INT,
      distribution_type VARCHAR(40) DEFAULT 'manual',
      business_hours JSONB DEFAULT '{}'::jsonb,
      welcome_message TEXT,
      after_hours_message TEXT,
      is_active BOOLEAN DEFAULT true,
      last_assigned_user_id INT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE attendance_queues
      ADD COLUMN IF NOT EXISTS name VARCHAR(120) DEFAULT '',
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS type VARCHAR(40) DEFAULT 'comercial',
      ADD COLUMN IF NOT EXISTS api_instance_id INT,
      ADD COLUMN IF NOT EXISTS distribution_type VARCHAR(40) DEFAULT 'manual',
      ADD COLUMN IF NOT EXISTS business_hours JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS welcome_message TEXT,
      ADD COLUMN IF NOT EXISTS after_hours_message TEXT,
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS last_assigned_user_id INT,
      ADD COLUMN IF NOT EXISTS queue_type VARCHAR(40) DEFAULT 'zapi',
      ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30),
      ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS messages_config JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS server_status VARCHAR(40) DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS history_days INT DEFAULT 30,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
    `);

    await pool.query(`CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) UNIQUE,
      client_name VARCHAR(120) DEFAULT '',
      client_photo_url TEXT,
      unread_count INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'open',
      assigned_user_id INT,
      opportunity_id INT,
      queue_id INT,
      api_instance_id INT,
      last_message_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
      ADD COLUMN IF NOT EXISTS client_name VARCHAR(120) DEFAULT '',
      ADD COLUMN IF NOT EXISTS client_photo_url TEXT,
      ADD COLUMN IF NOT EXISTS unread_count INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'open',
      ADD COLUMN IF NOT EXISTS assigned_user_id INT,
      ADD COLUMN IF NOT EXISTS opportunity_id INT,
      ADD COLUMN IF NOT EXISTS queue_id INT,
      ADD COLUMN IF NOT EXISTS api_instance_id INT,
      ADD COLUMN IF NOT EXISTS group_id INT,
      ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(30),
      ADD COLUMN IF NOT EXISTS provider_contact_id TEXT,
      ADD COLUMN IF NOT EXISTS contact_lid TEXT,
      ADD COLUMN IF NOT EXISTS chat_lid TEXT,
      ADD COLUMN IF NOT EXISTS raw_contact JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
    `);
    await pool.query(`DO $$
    DECLARE c_name TEXT;
    BEGIN
      SELECT conname INTO c_name FROM pg_constraint
      WHERE conrelid = 'conversations'::regclass AND contype = 'c' AND conname LIKE '%status%';
      IF c_name IS NOT NULL THEN EXECUTE 'ALTER TABLE conversations DROP CONSTRAINT ' || quote_ident(c_name); END IF;
      ALTER TABLE conversations ADD CONSTRAINT conversations_status_check
      CHECK (status IN ('new','waiting','open','in_attendance','waiting_customer','transferred','closed','lost','converted'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

    await pool.query(`CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      conversation_id INT,
      zapi_message_id VARCHAR(120),
      from_me BOOLEAN DEFAULT false,
      sender_id INT,
      sender_name VARCHAR(120),
      msg_type VARCHAR(20) DEFAULT 'text',
      text_content TEXT,
      media_url TEXT,
      media_key TEXT,
      file_name VARCHAR(200),
      caption TEXT,
      extra_json JSONB,
      status VARCHAR(20) DEFAULT 'RECEIVED',
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE chat_messages
      ADD COLUMN IF NOT EXISTS conversation_id INT,
      ADD COLUMN IF NOT EXISTS zapi_message_id VARCHAR(120),
      ADD COLUMN IF NOT EXISTS from_me BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS sender_id INT,
      ADD COLUMN IF NOT EXISTS sender_name VARCHAR(120),
      ADD COLUMN IF NOT EXISTS msg_type VARCHAR(20) DEFAULT 'text',
      ADD COLUMN IF NOT EXISTS text_content TEXT,
      ADD COLUMN IF NOT EXISTS media_url TEXT,
      ADD COLUMN IF NOT EXISTS media_key TEXT,
      ADD COLUMN IF NOT EXISTS file_name VARCHAR(200),
      ADD COLUMN IF NOT EXISTS caption TEXT,
      ADD COLUMN IF NOT EXISTS extra_json JSONB,
      ADD COLUMN IF NOT EXISTS raw_payload JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'RECEIVED',
      ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
    `);

    await pool.query(`CREATE TABLE IF NOT EXISTS chat_transfers (
      id SERIAL PRIMARY KEY,
      conversation_id INT,
      from_queue_id INT,
      to_queue_id INT,
      from_user_id INT,
      to_user_id INT,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE chat_transfers
      ADD COLUMN IF NOT EXISTS conversation_id INT,
      ADD COLUMN IF NOT EXISTS from_queue_id INT,
      ADD COLUMN IF NOT EXISTS to_queue_id INT,
      ADD COLUMN IF NOT EXISTS from_user_id INT,
      ADD COLUMN IF NOT EXISTS to_user_id INT,
      ADD COLUMN IF NOT EXISTS reason TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
    `);

    await pool.query(`CREATE TABLE IF NOT EXISTS queue_users (
      id SERIAL PRIMARY KEY,
      queue_id INT,
      user_id INT,
      role_in_queue VARCHAR(40) DEFAULT 'atendente',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE queue_users
      ADD COLUMN IF NOT EXISTS queue_id INT,
      ADD COLUMN IF NOT EXISTS user_id INT,
      ADD COLUMN IF NOT EXISTS role_in_queue VARCHAR(40) DEFAULT 'atendente',
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_conv_phone ON conversations(phone)').catch(() => {});
    await pool.query('CREATE INDEX IF NOT EXISTS idx_conv_last_msg ON conversations(last_message_at DESC)').catch(() => {});
    await pool.query('CREATE INDEX IF NOT EXISTS idx_msgs_conv_sent ON chat_messages(conversation_id, sent_at DESC, id DESC)').catch(() => {});

    chatSchemaReady = true;
    next();
  } catch (err) {
    console.error('[CHAT SCHEMA]', err.message);
    res.status(500).json({ error: 'Erro ao preparar Chat: ' + err.message });
  }
}

app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  let dbOk = false;
  try {
    await pool.query('SELECT 1');
    dbStatus = 'connected';
    dbOk = true;
  } catch {
    dbStatus = process.env.DATABASE_URL ? 'error' : 'not_configured';
  }
  res.status(200).json({ ok: true, app: 'Sistema Integrado Sulnet V1', version: 'v68c-final', db: dbStatus, dbOk, uptime: Math.floor(process.uptime()) });
});

app.get('/api/config', (req, res) => {
  res.json({ app: 'Sistema Integrado Sulnet V1', googleCalendarConfigured: !!process.env.GOOGLE_CALENDAR_CLIENT_ID, googleClientId: process.env.GOOGLE_CALENDAR_CLIENT_ID || '', version: 'v68c-final', dbConfigured: !!process.env.DATABASE_URL });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', authMiddleware, usersRoutes);
app.use('/api/opportunities', authMiddleware, oppsRoutes);
app.use('/api/credit', authMiddleware, creditRoutes);
app.use('/api/agenda', authMiddleware, agendaRoutes);
app.use('/api/admin', authMiddleware, adminRoutes);
app.use('/api/uploads', authMiddleware, uploadsRoutes);
app.use('/api/dashboard', authMiddleware, dashboardRoutes);
app.use('/api/chat', authMiddleware, ensureChatSchema, chatRoutes);
app.use('/api/chat-admin', authMiddleware, ensureChatSchema, chatAdminRoutes);

app.patch('/api/whatsapp/queues/:id/active', authMiddleware, async (req, res) => {
  try {
    if (!requireQueueAdmin(req, res)) return;
    const nextActive = req.body?.isActive === true || req.body?.isActive === 'true';
    const { rows } = await pool.query('UPDATE attendance_queues SET is_active=$1, updated_at=NOW() WHERE id=$2 RETURNING id, is_active', [nextActive, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Fila não encontrada.' });
    res.json({ ok: true, queue: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao alterar status da fila: ' + err.message }); }
});

app.delete('/api/whatsapp/queues/:id/hard', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!requireQueueAdmin(req, res)) return;
    await client.query('BEGIN');
    await client.query('UPDATE conversations SET queue_id=NULL, updated_at=NOW() WHERE queue_id=$1', [req.params.id]).catch(() => {});
    const { rows } = await client.query('DELETE FROM attendance_queues WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Fila não encontrada.' }); }
    await client.query('COMMIT');
    res.json({ ok: true, deletedId: rows[0].id });
  } catch (err) { await client.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: 'Erro ao excluir fila: ' + err.message }); }
  finally { client.release(); }
});

app.use('/api/whatsapp', authMiddleware, whatsappRoutes);
app.use('/api/integrations/szchat', integrationsRoutes);
app.use('/webhook', webhookRoutes);

function patchIndexHtml(html) {
  const oldActions = '<td><button class="whats-mini-btn" onclick="deleteWhatsQueue(${q.id})">Desativar</button></td>';
  const queueActions = `<td><div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap"><button class="whats-mini-btn" onclick="editWhatsQueue(\${q.id})">Editar</button><button class="whats-mini-btn" onclick="toggleWhatsQueue(\${q.id}, \${q.is_active ? 'false' : 'true'})">\${q.is_active ? 'Desativar' : 'Ativar'}</button><button class="whats-mini-btn" onclick="hardDeleteWhatsQueue(\${q.id})">Excluir</button></div></td>`;
  let patched = html.replace(oldActions, queueActions);
  if (!patched.includes('window.editWhatsQueue=')) {
    const marker = '  window.deleteWhatsQueue=async function(id){';
    const queueFns = `  window.editWhatsQueue=function(id){
    __whatsV68CState.expanded=id;
    __whatsV68CState.subtab='conexao';
    render();
    setTimeout(()=>document.querySelector('.whats-expand-panel')?.scrollIntoView({behavior:'smooth',block:'start'}),0);
  }

  window.toggleWhatsQueue=async function(id,nextActive){
    if(!confirm((nextActive?'Ativar':'Desativar')+' esta fila?'))return;
    try{ await whatsappApi('PATCH',\`/api/whatsapp/queues/\${id}/active\`,{isActive:nextActive}); toast(nextActive?'Fila ativada.':'Fila desativada.'); await loadWhatsV68C(); }
    catch(e){toast(e.message,'error')}
  }

  window.hardDeleteWhatsQueue=async function(id){
    if(!confirm('Excluir esta fila definitivamente? Conversas vinculadas ficarão sem fila.'))return;
    try{ await whatsappApi('DELETE',\`/api/whatsapp/queues/\${id}/hard\`); if(String(__whatsV68CState.expanded)===String(id))__whatsV68CState.expanded=null; toast('Fila excluída.'); await loadWhatsV68C(); }
    catch(e){toast(e.message,'error')}
  }`;
    patched = patched.replace(marker, `${queueFns}\n\n${marker}`);
  }
  return patched;
}

const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir, { maxAge: '1h', index: false }));
app.get('*', (req, res, next) => {
  fs.readFile(path.join(publicDir, 'index.html'), 'utf8', (err, html) => {
    if (err) return next(err);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(patchIndexHtml(html));
  });
});

app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno do servidor' });
});

async function start() {
  try { await runMigrations(); }
  catch (err) { console.error(`Falha ao preparar banco: ${err.message}`); console.error('O servidor vai iniciar, mas rotas que dependem do schema podem falhar.'); }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Sulnet V1 v68c-final rodando na porta ${PORT}`);
    console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? '✅ configurado' : '⚠️  NÃO configurado'}`);
    console.log(`   JWT_SECRET:   ${process.env.JWT_SECRET !== 'sistema-integrado-sulnet-v1-secret-trocar-nas-variaveis' ? '✅ configurado' : '⚠️  usando padrão (configure nas variáveis)'}`);
    console.log(`   R2:           ${process.env.R2_ACCOUNT_ID ? '✅ configurado' : '⚠️  NÃO configurado (uploads desativados)'}`);
  });
}

start();
module.exports = app;
