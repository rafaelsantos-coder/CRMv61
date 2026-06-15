/**
 * Sulnet V1 - Backend de producao
 * Node.js + Express + PostgreSQL + JWT + Cloudflare R2
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const bcrypt = require('bcrypt');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'sistema-integrado-sulnet-v1-secret-trocar-nas-variaveis';
process.env.JWT_EXPIRES = process.env.JWT_EXPIRES || '12h';
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'sistema-integrado-sulnet-v1-docs';

const { pool } = require('./config/db');
const { runMigrations } = require('./config/migrate');
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
const { authMiddleware } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_VERSION = 'v68i-troca-endereco-admin-bootstrap';

async function ensureAdminLogin() {
  const bootstrapPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!process.env.DATABASE_URL || !bootstrapPassword) return;

  const adminHash = await bcrypt.hash(bootstrapPassword, 12);

  await pool.query(
    `
      INSERT INTO users (
        name, username, password_hash, role, city, email, active, must_change_password, created_at, updated_at
      )
      VALUES ('Administrador Sulnet', 'admin', $1, 'admin', 'Santa Rosa', 'admin@sulnet.com.br', true, false, NOW(), NOW())
      ON CONFLICT (username)
      DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        role = 'admin',
        active = true,
        must_change_password = false,
        updated_at = NOW()
    `,
    [adminHash]
  );
}

app.use(helmet({ contentSecurityPolicy: false }));

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
  : true;

app.use(cors({ origin: allowedOrigins, credentials: true }));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Muitas requisicoes. Tente novamente em 15 minutos.' },
  })
);

app.use(
  '/api/auth/login',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Muitas tentativas de login. Aguarde 15 minutos.' },
  })
);

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

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
    version: APP_VERSION,
    db: dbStatus,
    dbOk,
    uptime: Math.floor(process.uptime()),
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    app: 'Sistema Integrado Sulnet V1',
    googleCalendarConfigured: !!process.env.GOOGLE_CALENDAR_CLIENT_ID,
    googleClientId: process.env.GOOGLE_CALENDAR_CLIENT_ID || '',
    version: APP_VERSION,
    dbConfigured: !!process.env.DATABASE_URL,
  });
});

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
app.use('/api/whatsapp', authMiddleware, whatsappRoutes);
app.use('/webhook', webhookRoutes);

const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir, { maxAge: '1h' }));
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno do servidor' });
});

async function startServer() {
  try {
    await runMigrations();
  } catch (err) {
    console.error('[BOOT] Falha ao aplicar migrations automaticamente:', err.message);
  }

  try {
    await ensureAdminLogin();
    if (process.env.ADMIN_BOOTSTRAP_PASSWORD) {
      console.log('Admin atualizado pela variavel de ambiente.');
    }
  } catch (err) {
    console.error('[BOOT] Nao foi possivel atualizar usuario admin:', err.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sulnet V1 ${APP_VERSION} rodando na porta ${PORT}`);
    console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? 'configurado' : 'nao configurado'}`);
    console.log(
      `   JWT_SECRET:   ${
        process.env.JWT_SECRET !== 'sistema-integrado-sulnet-v1-secret-trocar-nas-variaveis'
          ? 'configurado'
          : 'usando padrao'
      }`
    );
    console.log(`   R2:           ${process.env.R2_ACCOUNT_ID ? 'configurado' : 'nao configurado (uploads desativados)'}`);
  });
}

startServer();

module.exports = app;
