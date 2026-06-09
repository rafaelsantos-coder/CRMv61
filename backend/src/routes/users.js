const router = require('express').Router();
const { pool } = require('../config/db');

// Listagem básica de usuários (para selects no frontend)
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, username, role, city, active FROM users WHERE active = true ORDER BY name'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar usuários.' });
  }
});

module.exports = router;
