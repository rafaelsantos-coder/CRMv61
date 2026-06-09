-- ============================================================
-- Sistema Integrado Sulnet V1 — Migration 004
-- Atendimento WhatsApp Chatbot: bots, aliases e mensagens únicas
-- ============================================================

-- A Z-API usa Client-Token quando a segurança está ativa.
-- Quando não estiver ativa, o campo pode ficar vazio.
ALTER TABLE IF EXISTS zapi_config
  ALTER COLUMN client_token DROP NOT NULL;

ALTER TABLE IF EXISTS api_instances
  ALTER COLUMN client_token DROP NOT NULL;

ALTER TABLE IF EXISTS api_instances
  ADD COLUMN IF NOT EXISTS api_url TEXT,
  ADD COLUMN IF NOT EXISTS bot_type VARCHAR(40) DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS last_status_at TIMESTAMPTZ;

-- Conversas: manter uma única conversa por número real/canônico.
ALTER TABLE IF EXISTS conversations
  ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(30),
  ADD COLUMN IF NOT EXISTS provider_contact_id TEXT,
  ADD COLUMN IF NOT EXISTS contact_lid TEXT,
  ADD COLUMN IF NOT EXISTS chat_lid TEXT,
  ADD COLUMN IF NOT EXISTS raw_contact JSONB DEFAULT '{}'::jsonb;

UPDATE conversations
SET phone_normalized = regexp_replace(COALESCE(phone,''), '\D', '', 'g')
WHERE phone_normalized IS NULL OR phone_normalized = '';

CREATE INDEX IF NOT EXISTS idx_conv_phone_normalized ON conversations(phone_normalized);
CREATE INDEX IF NOT EXISTS idx_conv_contact_lid ON conversations(contact_lid);
CREATE INDEX IF NOT EXISTS idx_conv_chat_lid ON conversations(chat_lid);

-- Aliases: guarda todos os IDs que a Z-API pode mandar para o mesmo contato.
CREATE TABLE IF NOT EXISTS chat_contact_aliases (
  id              SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  alias           TEXT NOT NULL,
  alias_type      VARCHAR(40) DEFAULT 'unknown',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(alias)
);

CREATE INDEX IF NOT EXISTS idx_chat_alias_conv ON chat_contact_aliases(conversation_id);

-- Mensagens: armazenamento bruto e chave única para deduplicação.
ALTER TABLE IF EXISTS chat_messages
  ADD COLUMN IF NOT EXISTS raw_payload JSONB DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_messages_zapi_message_id
ON chat_messages(zapi_message_id)
WHERE zapi_message_id IS NOT NULL;

-- Garante fila comercial padrão.
INSERT INTO attendance_queues
  (name, description, type, api_instance_id, distribution_type, welcome_message, after_hours_message, is_active)
SELECT
  'Comercial',
  'Fila padrão para atendimento comercial via WhatsApp.',
  'comercial',
  (SELECT id FROM api_instances WHERE is_active = true ORDER BY id LIMIT 1),
  'manual',
  'Olá! Seja bem-vindo ao atendimento comercial.',
  'Olá! No momento estamos fora do horário de atendimento. Retornaremos assim que possível.',
  true
WHERE NOT EXISTS (SELECT 1 FROM attendance_queues WHERE LOWER(name) = 'comercial');
