/**
 * Runner de migrations — aplica os arquivos SQL de backend/migrations em ordem,
 * uma única vez cada, no boot do servidor.
 *
 * Filosofia do projeto: o sistema se auto-prepara. Após configurar DATABASE_URL,
 * basta subir o servidor — o schema é criado/atualizado automaticamente, sem
 * precisar rodar `psql` manualmente.
 *
 * Cada arquivo é registrado em schema_migrations após aplicado com sucesso, então
 * boots seguintes só executam o que ainda não rodou.
 */

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠️  Migrations ignoradas: DATABASE_URL não configurado.');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`✅ Migration aplicada: ${file}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`⚠️  Falha ao aplicar migration ${file}: ${err.message}`);
      // Não derruba o servidor — segue o boot. As rotas que dependem do schema
      // têm verificação própria (ensureWhatsappSchema) como rede de segurança.
      throw err;
    } finally {
      client.release();
    }
  }

  if (count === 0) {
    console.log('✅ Banco já está atualizado (nenhuma migration pendente).');
  } else {
    console.log(`✅ ${count} migration(s) aplicada(s) com sucesso.`);
  }
}

module.exports = { runMigrations };
