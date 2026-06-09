const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'sistema-integrado-sulnet-v1-secret-trocar-nas-variaveis';

async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    let token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (!token && req.headers['x-user-id']) {
      token = String(req.headers['x-user-id']).trim();
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
