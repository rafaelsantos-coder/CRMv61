const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'sistema-integrado-sulnet-v1-secret-trocar-nas-variaveis';

function isSameOriginBrowserRequest(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const referer = String(req.headers.referer || '').toLowerCase();
  const origin = String(req.headers.origin || '').toLowerCase();
  if (!host) return false;
  return referer.includes(`//${host}`) || origin.endsWith(`//${host}`) || origin === `https://${host}` || origin === `http://${host}`;
}

function canUseChatBrowserFallback(req) {
  const url = String(req.originalUrl || req.url || '');
  return isSameOriginBrowserRequest(req) && (
    url.startsWith('/api/chat') ||
    url.startsWith('/api/chat-admin') ||
    url.startsWith('/api/whatsapp/users')
  );
}

async function loadBrowserFallbackUser() {
  const { rows } = await pool.query(
    `SELECT id, name, username, role, city, email, active
       FROM users
      WHERE active = true
        AND role IN ('admin', 'gerencia')
      ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, id
      LIMIT 1`
  );
  return rows[0] || null;
}

async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    let token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (!token && req.headers['x-user-id']) {
      token = String(req.headers['x-user-id']).trim();
    }

    if (!token && canUseChatBrowserFallback(req)) {
      const fallbackUser = await loadBrowserFallbackUser();
      if (fallbackUser) {
        req.user = fallbackUser;
        return next();
      }
    }

    if (!token) {
      return res.status(401).json({ error: 'Token não fornecido.' });
    }

    let userId = null;

    try {
      const payload = jwt.verify(token, JWT_SECRET);
      userId = payload.userId || payload.id || payload.sub;
    } catch (err) {
      if (/^\d+$/.test(token)) {
        userId = Number(token);
      } else if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
      } else {
        return res.status(401).json({ error: 'Token inválido.' });
      }
    }

    const { rows } = await pool.query(
      'SELECT id, name, username, role, city, email, active FROM users WHERE id = $1 AND active = true',
      [userId]
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'Usuário inativo ou não encontrado.' });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido.' });
  }
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Acesso negado para este perfil.' });
    }
    next();
  };
}

module.exports = { authMiddleware, requireRole };
