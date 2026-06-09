const router = require('express').Router();
const multer = require('multer');
const { pool } = require('../config/db');
const { uploadFile, getSignedDownloadUrl, deleteFile } = require('../config/storage');

const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

// Multer com armazenamento em memória (envia direto para R2)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não permitido. Use: JPG, PNG ou PDF.'));
    }
  },
});

// ── POST /api/uploads ───────────────────────────────────────────────────────
// Faz upload de um arquivo e associa a uma análise ou oportunidade
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const { entityType, entityId, docType } = req.body;
    // entityType: 'analysis' | 'opportunity'
    // docType: 'rg', 'selfie', 'aceite', 'comprovante', etc.

    if (!entityType || !entityId) {
      return res.status(400).json({ error: 'entityType e entityId são obrigatórios.' });
    }

    const folder = `${entityType}/${entityId}/${docType || 'misc'}`;
    const { key } = await uploadFile(
      req.file.buffer,
      req.file.originalname,
      folder,
      req.file.mimetype
    );

    // Salva referência no banco
    const { rows } = await pool.query(
      `INSERT INTO attachments
        (entity_type, entity_id, doc_type, file_key, original_name, mime_type, size_bytes, uploaded_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        entityType, entityId, docType || 'misc',
        key, req.file.originalname, req.file.mimetype,
        req.file.size, req.user.id,
      ]
    );

    res.status(201).json({
      id: rows[0].id,
      key,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
    });
  } catch (err) {
    console.error('[UPLOAD] error:', err);
    if (err.message?.includes('Tipo de arquivo')) {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Arquivo muito grande. Limite: 10MB.' });
    }
    res.status(500).json({ error: 'Erro ao fazer upload.' });
  }
});

// ── GET /api/uploads/:id/url ────────────────────────────────────────────────
// Retorna URL assinada temporária para visualização/download
router.get('/:id/url', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM attachments WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Arquivo não encontrado.' });

    const url = await getSignedDownloadUrl(rows[0].file_key, 900); // 15 min
    res.json({ url, expiresIn: 900 });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar URL do arquivo.' });
  }
});

// ── GET /api/uploads?entityType=&entityId= ─────────────────────────────────
// Lista arquivos de uma entidade
router.get('/', async (req, res) => {
  try {
    const { entityType, entityId } = req.query;
    if (!entityType || !entityId) {
      return res.status(400).json({ error: 'entityType e entityId são obrigatórios.' });
    }

    const { rows } = await pool.query(
      `SELECT a.*, u.name AS uploaded_by_name
       FROM attachments a
       LEFT JOIN users u ON u.id = a.uploaded_by_id
       WHERE a.entity_type = $1 AND a.entity_id = $2
       ORDER BY a.created_at DESC`,
      [entityType, entityId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar arquivos.' });
  }
});

// ── DELETE /api/uploads/:id ─────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM attachments WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Arquivo não encontrado.' });

    // Só admin, gerência ou quem fez o upload pode deletar
    const att = rows[0];
    if (!['admin', 'gerencia'].includes(req.user.role) && att.uploaded_by_id !== req.user.id) {
      return res.status(403).json({ error: 'Sem permissão para deletar este arquivo.' });
    }

    await deleteFile(att.file_key);
    await pool.query('DELETE FROM attachments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao deletar arquivo.' });
  }
});

module.exports = router;
