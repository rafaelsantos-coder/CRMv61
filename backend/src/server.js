/**
 * Sulnet V1 - Backend de Producao
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
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas requisicoes. Tente novamente em 15 minutos.' } }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Muitas tentativas de login. Aguarde 15 minutos.' } }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

function requireQueueAdmin(req, res) {
  if (!req.user || !['admin', 'gerencia'].includes(req.user.role)) {
    res.status(403).json({ error: 'Acesso restrito a administradores/gerencia.' });
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
    END $$;`).catch(() => {});
    await pool.query(`UPDATE conversations SET status='open' WHERE status IS NULL OR status=''`).catch(() => {});

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
  res.status(200).json({ ok: true, app: 'Sistema Integrado Sulnet V1', version: 'v68e-chat-visual', db: dbStatus, dbOk, uptime: Math.floor(process.uptime()) });
});

app.get('/api/config', (req, res) => {
  res.json({ app: 'Sistema Integrado Sulnet V1', googleCalendarConfigured: !!process.env.GOOGLE_CALENDAR_CLIENT_ID, googleClientId: process.env.GOOGLE_CALENDAR_CLIENT_ID || '', version: 'v68e-chat-visual', dbConfigured: !!process.env.DATABASE_URL });
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
    const { rows } = await pool.query('UPDATE attendance_queues SET is_active=$1, updated_at=NOW() WHERE id=$2 RETURNING id, is_active, api_instance_id', [nextActive, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Fila nao encontrada.' });
    const apiInstanceId = rows[0].api_instance_id;
    if (apiInstanceId && nextActive) {
      await pool.query(`
        UPDATE api_instances
        SET is_active=true,
            status=CASE WHEN status='disabled' THEN 'pending' ELSE status END,
            updated_at=NOW()
        WHERE id=$1
      `, [apiInstanceId]);
    } else if (apiInstanceId) {
      await pool.query(`
        UPDATE api_instances SET is_active=false, status='disabled', updated_at=NOW()
        WHERE id=$1
          AND NOT EXISTS (
            SELECT 1 FROM attendance_queues
            WHERE api_instance_id=$1 AND is_active=true
          )
      `, [apiInstanceId]);
    }
    res.json({ ok: true, queue: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao alterar status da fila: ' + err.message }); }
});

app.delete('/api/whatsapp/queues/:id/hard', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!requireQueueAdmin(req, res)) return;
    await client.query('BEGIN');
    await client.query('UPDATE conversations SET queue_id=NULL, updated_at=NOW() WHERE queue_id=$1', [req.params.id]).catch(() => {});
    const { rows } = await client.query('DELETE FROM attendance_queues WHERE id=$1 RETURNING id, api_instance_id', [req.params.id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Fila nao encontrada.' }); }
    const apiInstanceId = rows[0].api_instance_id;
    if (apiInstanceId) {
      await client.query(`
        UPDATE api_instances SET is_active=false, status='disabled', updated_at=NOW()
        WHERE id=$1
          AND NOT EXISTS (
            SELECT 1 FROM attendance_queues
            WHERE api_instance_id=$1 AND is_active=true
          )
      `, [apiInstanceId]);
    }
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
  patched = patched.replace("headers: typeof buildAuthHeaders==='function' ? buildAuthHeaders() : {'Content-Type':'application/json'},", `headers: (function(){
      const h = typeof buildAuthHeaders==='function' ? buildAuthHeaders() : {'Content-Type':'application/json'};
      h['Content-Type'] = h['Content-Type'] || 'application/json';
      const u = CS.user || (window._cs68 && window._cs68.user);
      if(u && u.id && !h['x-user-id']) h['x-user-id'] = String(u.id);
      return h;
    })(),`);
  patched = patched.replace("}).catch(e=>{ console.warn('[Chat68]',method,path,e.message); return null; });", "}).catch(e=>{ window.__chat68LastError=e.message; console.warn('[Chat68]',method,path,e.message); return null; });");
  patched = patched.replace('Erro ao carregar conversas. Verifique o banco/migrations e recarregue a tela.', "Erro ao carregar conversas: '+esc(window.__chat68LastError||'falha na API')+'");

  const chatLayout = `
<style id="chat68-layout-v69">
html,body{background:#f4f6fb!important;overflow-x:hidden}
#chat68{height:calc(100vh - 54px)!important;max-width:1440px!important;margin:0 auto!important;background:#0b1018!important;border-left:1px solid #dfe5f0!important;border-right:1px solid #dfe5f0!important;box-shadow:0 18px 50px rgba(15,23,42,.12)!important}
#c68-sidebar{width:360px!important;min-width:360px!important;background:#111722!important;border-right:1px solid #253044!important}
#c68-sidebar-top{padding:16px!important;background:#0f1724!important;border-bottom:1px solid #253044!important}
#c68-sidebar-top h3{font-size:14px!important;margin-bottom:12px!important;color:#f8fafc!important;letter-spacing:0!important}
#c68-search,#c68-newph{height:38px!important;border-radius:8px!important;background:#182235!important;border:1px solid #2b3954!important;color:#e5ecff!important;font-size:13px!important}
#c68-newbar{padding:12px 16px!important;gap:8px!important;background:#111722!important;border-bottom:1px solid #253044!important}
.c68-newbtn{height:38px!important;border-radius:8px!important;background:#16a34a!important;border:0!important;color:white!important;font-weight:700!important;padding:0 14px!important}
.c68-item{min-height:70px!important;padding:12px 16px!important;gap:12px!important;border-bottom:1px solid rgba(148,163,184,.12)!important}
.c68-item:hover{background:#182235!important}.c68-item.sel{background:#1b2a3f!important;border-left:4px solid #ff4f1f!important;padding-left:12px!important}
.c68-av{width:44px!important;height:44px!important;background:#23314a!important;color:#7dd3fc!important;border-color:#334155!important}
.c68-iname{font-size:13px!important;color:#f8fafc!important}.c68-iprev{font-size:12px!important;color:#94a3b8!important;margin-top:4px!important}.c68-itime{color:#94a3b8!important}
.c68-ibadge{background:#ff4f1f!important;color:white!important}.c68-istatus.open,.c68-istatus.in_attendance{background:#22c55e!important}
#c68-mid{background:#0b1018!important;position:relative!important;flex:0 0 50%!important;max-width:50%!important;min-width:0!important}
#c68-empty{background:radial-gradient(circle at center,rgba(34,197,94,.08),transparent 36%),#0b1018!important;color:#94a3b8!important}
#c68-empty span{font-size:58px!important;opacity:.22!important}#c68-empty p{color:#dbeafe!important;font-size:15px!important;font-weight:700!important}
#c68-head{height:64px!important;padding:0 18px!important;background:#111722!important;border-bottom:1px solid #253044!important}
.c68-hav{width:42px!important;height:42px!important;background:#23314a!important;color:#7dd3fc!important}.c68-hname{font-size:15px!important;color:#f8fafc!important}.c68-hsub{font-size:12px!important;color:#94a3b8!important}
.c68-hacts{gap:8px!important}.c68-hbtn{height:34px!important;border-radius:8px!important;background:#182235!important;border:1px solid #334155!important;color:#dbeafe!important}.c68-hbtn.red{color:#fecaca!important;border-color:#7f1d1d!important;background:#2a1518!important}
#c68-msgs{padding:24px 32px!important;background:linear-gradient(180deg,#0b1018 0%,#0d141f 100%)!important;gap:6px!important}.c68-bub{font-size:13px!important;max-width:min(680px,72%)!important;border-radius:14px!important;padding:10px 14px!important}.c68-bub.sent{background:#155e3a!important;border-color:#1f7a4d!important;color:#f0fdf4!important}.c68-bub.recv{background:#182235!important;border-color:#334155!important;color:#e5ecff!important}.c68-meta{font-size:11px!important;color:#94a3b8!important}
#c68-inp{padding:14px 18px!important;background:#111722!important;border-top:1px solid #253044!important}.c68-inprow{gap:10px!important}.c68-attbtn,.c68-micbtn,.c68-sndbtn{width:42px!important;height:42px!important;border-radius:10px!important}.c68-ta{min-height:42px!important;border-radius:10px!important;background:#182235!important;border:1px solid #334155!important;color:#f8fafc!important;font-size:13px!important;padding:10px 12px!important}.c68-sndbtn{background:#16a34a!important;color:white!important}
#c68-panel{width:320px!important;min-width:320px!important;background:#111722!important;border-left:1px solid #253044!important}.c68-psec{padding:16px!important}.c68-oppcard,.c68-note{background:#182235!important;border-color:#334155!important}.c68-pval,.c68-oppval{color:#f8fafc!important}
.c68-error-card{margin:14px!important;padding:14px!important;border:1px solid rgba(248,113,113,.45)!important;background:rgba(127,29,29,.22)!important;border-radius:10px!important;color:#fecaca!important;font-family:inherit!important;line-height:1.45!important}.c68-error-card strong{display:block!important;color:#fff!important;margin-bottom:6px!important}.c68-error-card button{margin-top:10px!important;height:32px!important;border:0!important;border-radius:8px!important;background:#ef4444!important;color:white!important;font-weight:700!important;padding:0 12px!important;cursor:pointer!important}
@media (max-width:900px){#chat68{height:calc(100vh - 48px)!important;border:0!important}#c68-sidebar{width:42vw!important;min-width:280px!important}#c68-mid{flex:1 1 auto!important;max-width:none!important}#c68-panel{display:none!important}.c68-hacts{display:none!important}#c68-msgs{padding:18px!important}.c68-bub{max-width:86%!important}}
</style>
<script id="chat68-layout-v69-js">
(function(){
  window.__chat68Reload=function(){location.reload();};
})();
</script>`;
  if (!patched.includes('chat68-layout-v69')) patched = patched.replace('</body>', `${chatLayout}\n</body>`);
  patched = patched.replace(
    "if(el) el.innerHTML='<div style=\"padding:12px;font-size:11px;color:#fca5a5;font-family:monospace\">Erro ao carregar conversas: '+esc(window.__chat68LastError||'falha na API')+'</div>';",
    "if(el) el.innerHTML='<div class=\"c68-error-card\"><strong>Não foi possível carregar as conversas</strong><div>'+esc(window.__chat68LastError||'Falha na API do chat')+'</div><button onclick=\"window.__chat68Reload&&window.__chat68Reload()\">Recarregar chat</button></div>';"
  );
  patched = patched.replace(
    "    if(!r) return;\n    el.value='';\n    _c68closeNewModal();\n    await _c68loadList(user);\n    _c68openConv(r.id,user);",
    "    if(!r){ alert(window.__chat68LastError||'Não foi possível abrir o atendimento.'); return; }\n    el.value='';\n    _c68closeNewModal();\n    await _c68loadList(user);\n    if(!CS.convs.some(c=>Number(c.id)===Number(r.id))){\n      CS.convs.unshift(r);\n      CS.filtered=CS.convs;\n      _c68renderList(user);\n    }\n    _c68openConv(r.id,user);"
  );
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
    console.log(`Sulnet V1 v68e-chat-visual rodando na porta ${PORT}`);
    console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? 'configurado' : 'NAO configurado'}`);
    console.log(`   JWT_SECRET:   ${process.env.JWT_SECRET !== 'sistema-integrado-sulnet-v1-secret-trocar-nas-variaveis' ? 'configurado' : 'usando padrao (configure nas variaveis)'}`);
    console.log(`   R2:           ${process.env.R2_ACCOUNT_ID ? 'configurado' : 'NAO configurado (uploads desativados)'}`);
  });
}

start();
module.exports = app;
