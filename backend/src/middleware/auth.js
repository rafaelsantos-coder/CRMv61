const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Middleware de autenticação.
 * Aceita:
 * 1. JWT real no header Authorization: Bearer <token>
 * 2. Compatibilidade do protótipo: Bearer <id numérico do usuário>
 *    usado pelo front local enquanto a migração completa para login JWT não for concluída.
 */
async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token não fornecido.' });
    }

    const token = header.slice(7).trim();
    let userId = null;

    try {
      const payload = jwt.verify(token, JWT_SECRET);
      userId = payload.userId;
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

/**
 * Middleware de autorização por perfil.
 */
function requireRole(roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Acesso negado para este perfil.' });
    }
    next();
  };
}

module.exports = { authMiddleware, requireRole };
