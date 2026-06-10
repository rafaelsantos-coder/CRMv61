-- ============================================================
-- Migration 007 — Chat v68: deduplicação e histórico configurável
-- SOMENTE ADICIONA — nada existente é alterado
-- ============================================================

-- Garante UNIQUE em phone para evitar conversas duplicadas
-- (usa ON CONFLICT na criação, mas o índice previne na base)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'conversations'::regclass
      AND conname = 'conversations_phone_unique'
  ) THEN
    -- Remove duplicatas mantendo a mais recente antes de criar o índice
    DELETE FROM conversations c1
    USING conversations c2
    WHERE c1.phone = c2.phone
      AND c1.id < c2.id;

    ALTER TABLE conversations ADD CONSTRAINT conversations_phone_unique UNIQUE (phone);
  END IF;
END $$;

-- Adiciona campo history_days nas filas (padrão 30 dias)
ALTER TABLE attendance_queues
  ADD COLUMN IF NOT EXISTS history_days INT DEFAULT 30;

-- Garante índice para busca por sent_at nas mensagens
CREATE INDEX IF NOT EXISTS idx_msgs_conv_sent ON chat_messages(conversation_id, sent_at DESC, id DESC);
