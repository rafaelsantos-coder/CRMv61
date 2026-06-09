const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES || '12h';

// ── POST /api/auth/login ────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    }

    const { rows } = await pool.query(
      `SELECT id, name, username, password_hash, role, city, email, active, must_change_password
       FROM users WHERE username = $1`,
      [username.trim().toLowerCase()]
    );

    const user = rows[0];
    if (!user || !user.active) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      // Registra tentativa falha no audit log
      await pool.query(
        `INSERT INTO audit_log (user_id, action, details, ip) VALUES ($1, $2, $3, $4)`,
        [user.id, 'LOGIN_FAILED', JSON.stringify({ username }), req.ip]
      ).catch(() => {}); // silencia erro de log para não bloquear resposta
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    // Audit log de login bem-sucedido
    await pool.query(
      `INSERT INTO audit_log (user_id, action, details, ip) VALUES ($1, $2, $3, $4)`,
      [user.id, 'LOGIN_SUCCESS', JSON.stringify({ username: user.username }), req.ip]
    ).catch(() => {});

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
        city: user.city,
        email: user.email,
        mustChangePassword: user.must_change_password,
      },
    });
  } catch (err) {
    console.error('[AUTH] login error:', err);
    res.status(500).json({ error: 'Erro ao fazer login.' });
  }
});

// ── POST /api/auth/change-password ─────────────────────────────────────────
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Senha atual e nova senha são obrigatórias.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'A nova senha deve ter ao menos 8 caracteres.' });
    }

    const { rows } = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );

    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) {
      return res.status(400).json({ error: 'Senha atual incorreta.' });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = false, updated_at = NOW() WHERE id = $2',
      [newHash, req.user.id]
    );

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao alterar senha.' });
  }
});

// ── GET /api/auth/me ────────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.username, u.role, u.city, u.email,
              COALESCE(array_agg(ufa.funnel_id) FILTER (WHERE ufa.funnel_id IS NOT NULL), '{}') AS funnel_access_ids
       FROM users u
       LEFT JOIN user_funnel_access ufa ON ufa.user_id = u.id
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar dados do usuário.' });
  }
});

module.exports = router;
