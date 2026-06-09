-- ============================================================
-- Sistema Integrado Sulnet V1 — Migration 006
-- Chat v67: índices de transferência e coluna last_message_preview
-- SOMENTE ADICIONA — nada existente é alterado
-- ============================================================

-- Garante tabela de transferências (idempotente)
CREATE TABLE IF NOT EXISTS chat_transfers (
  id               SERIAL PRIMARY KEY,
  conversation_id  INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_queue_id    INT REFERENCES attendance_queues(id) ON DELETE SET NULL,
  to_queue_id      INT REFERENCES attendance_queues(id) ON DELETE SET NULL,
  from_user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  to_user_id       INT REFERENCES users(id) ON DELETE SET NULL,
  reason           TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_transfers_conv     ON chat_transfers(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_transfers_from_user ON chat_transfers(from_user_id);
CREATE INDEX IF NOT EXISTS idx_chat_transfers_to_user   ON chat_transfers(to_user_id);

-- Status 'transferred' para conversas
DO $$
BEGIN
  -- Remove constraint de status existente e recria com 'transferred' incluído
  ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_status_check;
  ALTER TABLE conversations
    ADD CONSTRAINT conversations_status_check
    CHECK (status IN (
      'new','waiting','open','in_attendance',
      'waiting_customer','transferred','closed','lost','converted'
    ));
EXCEPTION WHEN others THEN NULL;
END $$;
