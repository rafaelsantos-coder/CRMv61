const { Pool } = require('pg');

// Cria o pool mesmo sem DATABASE_URL — vai falhar nas queries mas não trava o servidor
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/placeholder',
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Erro no pool:', err.message);
});

// Testa conexão de forma NÃO BLOQUEANTE — servidor sobe independente
if (process.env.DATABASE_URL) {
  pool.query('SELECT NOW()').then(() => {
    console.log('✅ PostgreSQL conectado');
  }).catch(err => {
    console.error('⚠️  PostgreSQL não conectado:', err.message);
    console.error('   Configure DATABASE_URL nas variáveis de ambiente.');
    // NÃO faz process.exit — servidor continua respondendo ao healthcheck
  });
} else {
  console.warn('⚠️  DATABASE_URL não configurado. Configure nas variáveis de ambiente do Railway.');
}

module.exports = { pool };
