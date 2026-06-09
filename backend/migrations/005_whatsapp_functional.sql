-- ============================================================
-- Sistema Integrado Sulnet V1 — Migration 005
-- Atendimento WhatsApp funcional: filas, grupos e vínculo com chat
-- ============================================================

-- Filas existentes passam a representar também filas/canais de WhatsApp.
ALTER TABLE IF EXISTS attendance_queues
  ADD COLUMN IF NOT EXISTS queue_type VARCHAR(40) DEFAULT 'zapi',
  ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30),
  ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS messages_config JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS server_status VARCHAR(40) DEFAULT 'pending';

ALTER TABLE IF EXISTS api_instances
  ADD COLUMN IF NOT EXISTS api_url TEXT,
  ADD COLUMN IF NOT EXISTS bot_type VARCHAR(40) DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS last_status_at TIMESTAMPTZ;

-- Conversas passam a permitir vínculo ao grupo operacional.
ALTER TABLE IF EXISTS conversations
  ADD COLUMN IF NOT EXISTS group_id INT,
  ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(30),
  ADD COLUMN IF NOT EXISTS provider_contact_id TEXT,
  ADD COLUMN IF NOT EXISTS contact_lid TEXT,
  ADD COLUMN IF NOT EXISTS chat_lid TEXT,
  ADD COLUMN IF NOT EXISTS raw_contact JSONB DEFAULT '{}'::jsonb;

UPDATE conversations
SET phone_normalized = regexp_replace(COALESCE(phone,''), '\D', '', 'g')
WHERE phone_normalized IS NULL OR phone_normalized = '';

CREATE INDEX IF NOT EXISTS idx_conv_phone_normalized ON conversations(phone_normalized);
CREATE INDEX IF NOT EXISTS idx_conv_queue_id ON conversations(queue_id);
CREATE INDEX IF NOT EXISTS idx_conv_group_id ON conversations(group_id);

-- Grupo operacional de atendimento.
CREATE TABLE IF NOT EXISTS whatsapp_groups (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(120) NOT NULL,
  queue_id            INT NOT NULL REFERENCES attendance_queues(id) ON DELETE CASCADE,
  distribution_type   VARCHAR(40) DEFAULT 'round_robin',
  max_per_agent       INT DEFAULT 100,
  settings            JSONB DEFAULT '{}'::jsonb,
  is_active           BOOLEAN DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_queue ON whatsapp_groups(queue_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_active ON whatsapp_groups(is_active);

CREATE TABLE IF NOT EXISTS whatsapp_group_users (
  id                  SERIAL PRIMARY KEY,
  group_id            INT NOT NULL REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
  user_id             INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_in_group       VARCHAR(40) DEFAULT 'atendente',
  is_active           BOOLEAN DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_group_users_group ON whatsapp_group_users(group_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_group_users_user ON whatsapp_group_users(user_id);

-- Aliases para evitar duplicidade quando a Z-API mandar phone, senderLid ou chatLid diferentes.
CREATE TABLE IF NOT EXISTS chat_contact_aliases (
  id              SERIAL PRIMARY KEY,
  conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  alias           TEXT NOT NULL,
  alias_type      VARCHAR(40) DEFAULT 'unknown',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(alias)
);

CREATE INDEX IF NOT EXISTS idx_chat_alias_conv ON chat_contact_aliases(conversation_id);

ALTER TABLE IF EXISTS chat_messages
  ADD COLUMN IF NOT EXISTS raw_payload JSONB DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_messages_zapi_message_id
ON chat_messages(zapi_message_id)
WHERE zapi_message_id IS NOT NULL;
