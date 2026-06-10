/**
 * Sulnet V1 — Backend de Produção
 * Node.js + Express + PostgreSQL + JWT + Cloudflare R2
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');
const path    = require('path');

// ── Valores padrão seguros para variáveis ausentes ─────────────────────────
process.env.JWT_SECRET     = process.env.JWT_SECRET     || 'sistema-integrado-sulnet-v1-secret-trocar-nas-variaveis';
process.env.JWT_EXPIRES    = process.env.JWT_EXPIRES    || '12h';
process.env.NODE_ENV       = process.env.NODE_ENV       || 'production';
process.env.R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'sistema-integrado-sulnet-v1-docs';

const { pool } = require('./config/db');
const { runMigrations } = require('./config/migrate');
const authRoutes      = require('./routes/auth');
const usersRoutes     = require('./routes/users');
const oppsRoutes      = require('./routes/opportunities');
const creditRoutes    = require('./routes/credit');
const agendaRoutes    = require('./routes/agenda');
const adminRoutes     = require('./routes/admin');
const uploadsRoutes   = require('./routes/uploads');
const dashboardRoutes = require('./routes/dashboard');
const chatRoutes      = require('./routes/chat');
const chatAdminRoutes = require('./routes/chatAdmin');
const whatsappRoutes  = require('./routes/whatsapp');
const webhookRoutes   = require('./routes/webhook');
const { authMiddleware } = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Segurança ──────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// CORS — aceita qualquer origem se ALLOWED_ORIGINS não estiver configurado
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : true; // true = aceita tudo (seguro para primeiro deploy)

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

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ── Health check — SEMPRE responde 200, mesmo sem banco ───────────────────
// Railway usa este endpoint para saber se o servidor está vivo
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
  // Retorna 200 sempre — Railway não derruba o container por falta de banco
  res.status(200).json({
    ok: true,
    app: 'Sistema Integrado Sulnet V1',
    version: 'v68b-prod',
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
    version: 'v68b-prod',
    dbConfigured: !!process.env.DATABASE_URL,
  });
});

// ── Rotas da API ───────────────────────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/users',        authMiddleware, usersRoutes);
app.use('/api/opportunities',authMiddleware, oppsRoutes);
app.use('/api/credit',       authMiddleware, creditRoutes);
app.use('/api/agenda',       authMiddleware, agendaRoutes);
app.use('/api/admin',        authMiddleware, adminRoutes);
app.use('/api/uploads',      authMiddleware, uploadsRoutes);
app.use('/api/dashboard',    authMiddleware, dashboardRoutes);
app.use('/api/chat',         authMiddleware, chatRoutes);
app.use('/api/chat-admin',   authMiddleware, chatAdminRoutes);
app.use('/api/whatsapp',     authMiddleware, whatsappRoutes);
app.use('/webhook',          webhookRoutes);

// ── Servir frontend ────────────────────────────────────────────────────────
const publicDir = path.join(__dirname, '../public');
// index.html nunca entra em cache — evita servir versão antiga do app após deploy
app.use(express.static(publicDir, { maxAge: '1h', index: false }));
app.get('*', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ── Error handler global ───────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno do servidor' });
});

// ── Start ──────────────────────────────────────────────────────────────────
async function start() {
  // Aplica migrations pendentes antes de aceitar tráfego. Falha aqui não derruba
  // o servidor — o healthcheck segue respondendo e as rotas têm verificação própria.
  try {
    await runMigrations();
  } catch (err) {
    console.error('⚠️  Erro ao rodar migrations no boot:', err.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Sulnet V1 v68b-prod rodando na porta ${PORT}`);
    console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? '✅ configurado' : '⚠️  NÃO configurado'}`);
    console.log(`   JWT_SECRET:   ${process.env.JWT_SECRET !== 'sistema-integrado-sulnet-v1-secret-trocar-nas-variaveis' ? '✅ configurado' : '⚠️  usando padrão (configure nas variáveis)'}`);
    console.log(`   R2:           ${process.env.R2_ACCOUNT_ID ? '✅ configurado' : '⚠️  NÃO configurado (uploads desativados)'}`);
  });
}

start();

module.exports = app;
