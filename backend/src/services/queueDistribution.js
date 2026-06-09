const { pool } = require('../config/db');

async function userCanAccessQueue(user, queueId) {
  if (!queueId) return true;
  if (['admin', 'gerencia', 'bko'].includes(user.role)) return true;

  const { rows } = await pool.query(
    `SELECT 1 FROM queue_users
     WHERE queue_id = $1 AND user_id = $2 AND is_active = true
     LIMIT 1`,
    [queueId, user.id]
  );

  return rows.length > 0;
}

async function getDefaultQueueForUser(user) {
  if (['admin', 'gerencia', 'bko'].includes(user.role)) {
    const { rows } = await pool.query(
      `SELECT * FROM attendance_queues
       WHERE is_active = true
       ORDER BY id ASC
       LIMIT 1`
    );
    return rows[0] || null;
  }

  const { rows } = await pool.query(
    `SELECT q.*
     FROM attendance_queues q
     JOIN queue_users qu ON qu.queue_id = q.id
     WHERE q.is_active = true
       AND qu.is_active = true
       AND qu.user_id = $1
     ORDER BY q.id ASC
     LIMIT 1`,
    [user.id]
  );

  return rows[0] || null;
}

async function getDefaultQueueForInstance(apiInstanceId) {
  const { rows } = await pool.query(
    `SELECT * FROM attendance_queues
     WHERE is_active = true
       AND ($1::int IS NULL OR api_instance_id = $1)
     ORDER BY id ASC
     LIMIT 1`,
    [apiInstanceId || null]
  );
  return rows[0] || null;
}

async function assignUserForQueue(queueId) {
  if (!queueId) return null;

  const { rows: qRows } = await pool.query(
    'SELECT * FROM attendance_queues WHERE id = $1 AND is_active = true',
    [queueId]
  );
  if (!qRows.length) return null;

  const queue = qRows[0];
  if (queue.distribution_type === 'manual') return null;

  const { rows: users } = await pool.query(
    `SELECT u.id, u.name
     FROM queue_users qu
     JOIN users u ON u.id = qu.user_id
     WHERE qu.queue_id = $1
       AND qu.is_active = true
       AND u.active = true
       AND u.role IN ('vendedor','bko','gerencia','admin')
     ORDER BY u.id ASC`,
    [queueId]
  );

  if (!users.length) return null;

  if (queue.distribution_type === 'least_open') {
    const { rows } = await pool.query(
      `SELECT u.id, COUNT(c.id) AS open_count
       FROM queue_users qu
       JOIN users u ON u.id = qu.user_id
       LEFT JOIN conversations c
         ON c.assigned_user_id = u.id
        AND c.queue_id = qu.queue_id
        AND c.status IN ('new','waiting','open','in_attendance','waiting_customer')
       WHERE qu.queue_id = $1
         AND qu.is_active = true
         AND u.active = true
       GROUP BY u.id
       ORDER BY open_count ASC, u.id ASC
       LIMIT 1`,
      [queueId]
    );
    return rows[0]?.id || null;
  }

  if (queue.distribution_type === 'round_robin') {
    const lastId = queue.last_assigned_user_id;
    let next = users[0];

    if (lastId) {
      const idx = users.findIndex(u => Number(u.id) === Number(lastId));
      next = users[(idx + 1) % users.length] || users[0];
    }

    await pool.query(
      'UPDATE attendance_queues SET last_assigned_user_id = $1, updated_at = NOW() WHERE id = $2',
      [next.id, queueId]
    );

    return next.id;
  }

  // first_available: por enquanto pega o primeiro ativo.
  return users[0].id;
}

module.exports = {
  userCanAccessQueue,
  getDefaultQueueForUser,
  getDefaultQueueForInstance,
  assignUserForQueue,
};
