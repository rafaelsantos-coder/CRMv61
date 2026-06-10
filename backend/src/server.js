/**
 * Sulnet V1 — Backend de Produção
 * Node.js + Express + PostgreSQL + JWT + Cloudflare R2
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

// ── Valores padrão seguros para variáveis ausentes ─────────────────────────
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

// ── Segurança ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// CORS — aceita qualquer origem se ALLOWED_ORIGINS não estiver configurado
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : true;

app.use(cors({ origin: allowedOrigins, credentials: true }));

// Rate limiting
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em 15 minutos.' },
}));

app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas de login. Aguarde 15 minutos.' },
}));

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

function requireQueueAdmin(req, res) {
  if (!req.user || !['admin', 'gerencia'].includes(req.user.role)) {
    res.status(403).json({ error: 'Acesso restrito a administradores/gerência.' });
    return false;
  }
  return true;
}

// ── Health check — SEMPRE responde 200, mesmo sem banco ────────────────────
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
  res.status(200).json({
    ok: true,
    app: 'Sistema Integrado Sulnet V1',
    version: 'v68c-final',
    db: dbStatus,
    dbOk,
    uptime: Math.floor(process.uptime()),
  });
});

// ── Config pública ─────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    app: 'Sistema Integrado Sulnet V1',
    googleCalendarConfigured: !!process.env.GOOGLE_CALENDAR_CLIENT_ID,
    googleClientId: process.env.GOOGLE_CALENDAR_CLIENT_ID || '',
    version: 'v68c-final',
    dbConfigured: !!process.env.DATABASE_URL,
  });
});

// ── Rotas da API ───────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/users', authMiddleware, usersRoutes);
app.use('/api/opportunities', authMiddleware, oppsRoutes);
app.use('/api/credit', authMiddleware, creditRoutes);
app.use('/api/agenda', authMiddleware, agendaRoutes);
app.use('/api/admin', authMiddleware, adminRoutes);
app.use('/api/uploads', authMiddleware, uploadsRoutes);
app.use('/api/dashboard', authMiddleware, dashboardRoutes);
app.use('/api/chat', authMiddleware, chatRoutes);
app.use('/api/chat-admin', authMiddleware, chatAdminRoutes);

app.patch('/api/whatsapp/queues/:id/active', authMiddleware, async (req, res) => {
  try {
    if (!requireQueueAdmin(req, res)) return;
    const nextActive = req.body?.isActive === true || req.body?.isActive === 'true';
    const { rows } = await pool.query(
      'UPDATE attendance_queues SET is_active=$1, updated_at=NOW() WHERE id=$2 RETURNING id, is_active',
      [nextActive, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Fila não encontrada.' });
    res.json({ ok: true, queue: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao alterar status da fila: ' + err.message });
  }
});

app.delete('/api/whatsapp/queues/:id/hard', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!requireQueueAdmin(req, res)) return;
    await client.query('BEGIN');
    await client.query('UPDATE conversations SET queue_id=NULL, updated_at=NOW() WHERE queue_id=$1', [req.params.id]).catch(() => {});
    const { rows } = await client.query('DELETE FROM attendance_queues WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Fila não encontrada.' });
    }
    await client.query('COMMIT');
    res.json({ ok: true, deletedId: rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Erro ao excluir fila: ' + err.message });
  } finally {
    client.release();
  }
});

app.use('/api/whatsapp', authMiddleware, whatsappRoutes);
// Webhooks externos sem JWT. Use token próprio quando configurado.
app.use('/api/integrations/szchat', integrationsRoutes);
app.use('/webhook', webhookRoutes);

function patchIndexHtml(html) {
  const oldActions = '<td><button class="whats-mini-btn" onclick="deleteWhatsQueue(${q.id})">Desativar</button></td>';
  const queueActions = '<td><div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap"><button class="whats-mini-btn" onclick="editWhatsQueue(${q.id})">Editar</button><button class="whats-mini-btn" onclick="toggleWhatsQueue(${q.id}, ${q.is_active ? \'false\' : \'true\'})">${q.is_active ? \'Desativar\' : \'Ativar\'}</button><button class="whats-mini-btn" onclick="hardDeleteWhatsQueue(${q.id})">Excluir</button></div></td>';
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
    try{
      await whatsappApi('PATCH',\`/api/whatsapp/queues/\${id}/active\`,{isActive:nextActive});
      toast(nextActive?'Fila ativada.':'Fila desativada.');
      await loadWhatsV68C();
    }catch(e){toast(e.message,'error')}
  }

  window.hardDeleteWhatsQueue=async function(id){
    if(!confirm('Excluir esta fila definitivamente? Conversas vinculadas ficarão sem fila.'))return;
    try{
      await whatsappApi('DELETE',\`/api/whatsapp/queues/\${id}/hard\`);
      if(String(__whatsV68CState.expanded)===String(id))__whatsV68CState.expanded=null;
      toast('Fila excluída.');
      await loadWhatsV68C();
    }catch(e){toast(e.message,'error')}
  }`;
    patched = patched.replace(marker, `${queueFns}\n\n${marker}`);
  }

  return patched;
}

// ── Servir frontend ─────────────────────────────────────────────────────────
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir, { maxAge: '1h', index: false }));
app.get('*', (req, res, next) => {
  fs.readFile(path.join(publicDir, 'index.html'), 'utf8', (err, html) => {
    if (err) return next(err);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(patchIndexHtml(html));
  });
});

// ── Error handler global ───────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno do servidor' });
});

// ── Start ──────────────────────────────────────────────────────────────────
async function start() {
  try {
    await runMigrations();
  } catch (err) {
    console.error(`Falha ao preparar banco: ${err.message}`);
    console.error('O servidor vai iniciar, mas rotas que dependem do schema podem falhar.');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Sulnet V1 v68c-final rodando na porta ${PORT}`);
    console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? '✅ configurado' : '⚠️  NÃO configurado'}`);
    console.log(`   JWT_SECRET:   ${process.env.JWT_SECRET !== 'sistema-integrado-sulnet-v1-secret-trocar-nas-variaveis' ? '✅ configurado' : '⚠️  usando padrão (configure nas variáveis)'}`);
    console.log(`   R2:           ${process.env.R2_ACCOUNT_ID ? '✅ configurado' : '⚠️  NÃO configurado (uploads desativados)'}`);
  });
}

start();

module.exports = app;
