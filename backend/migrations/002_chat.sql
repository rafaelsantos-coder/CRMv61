-- ============================================================
-- Sulnet V1 — Migration 002: Módulo Chat
-- SOMENTE ADICIONA tabelas novas. Nada existente é alterado.
-- Execute UMA VEZ após o deploy desta versão.
-- ============================================================

-- ── CREDENCIAIS Z-API (configuração global) ────────────────────────────────
CREATE TABLE IF NOT EXISTS zapi_config (
  id            SERIAL PRIMARY KEY,
  instance_id   TEXT NOT NULL,
  token         TEXT NOT NULL,
  client_token  TEXT NOT NULL,
  webhook_url   TEXT,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── CONVERSAS ─────────────────────────────────────────────────────────────
-- Uma por número de telefone do cliente
CREATE TABLE IF NOT EXISTS conversations (
  id               SERIAL PRIMARY KEY,
  phone            VARCHAR(20)  NOT NULL UNIQUE,  -- ex: 5511999999999
  client_name      VARCHAR(120) DEFAULT '',
  client_photo_url TEXT,
  unread_count     INT          DEFAULT 0,
  status           VARCHAR(20)  DEFAULT 'open'    -- open | closed
    CHECK (status IN ('open', 'closed')),
  assigned_user_id INT          REFERENCES users(id) ON DELETE SET NULL,
  opportunity_id   INT          REFERENCES opportunities(id) ON DELETE SET NULL,
  last_message_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conv_phone    ON conversations(phone);
CREATE INDEX IF NOT EXISTS idx_conv_status   ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conv_user     ON conversations(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_conv_last_msg ON conversations(last_message_at DESC);

-- ── MENSAGENS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INT          NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  zapi_message_id VARCHAR(120),                -- ID da mensagem na Z-API (deduplicação)
  from_me         BOOLEAN      DEFAULT false,
  sender_id       INT          REFERENCES users(id) ON DELETE SET NULL,
  sender_name     VARCHAR(120),
  msg_type        VARCHAR(20)  DEFAULT 'text'  -- text | image | audio | video | document | sticker | location | contact | reaction
    CHECK (msg_type IN ('text','image','audio','video','document','sticker','location','contact','reaction','unsupported')),
  text_content    TEXT,
  media_url       TEXT,                        -- URL pública ou do R2
  media_key       TEXT,                        -- chave R2 se for upload local
  file_name       VARCHAR(200),
  caption         TEXT,
  extra_json      JSONB,                       -- dados extras (location coords, contact info, etc.)
  status          VARCHAR(20)  DEFAULT 'RECEIVED'
    CHECK (status IN ('PENDING','SENT','RECEIVED','READ','PLAYED')),
  sent_at         TIMESTAMPTZ  DEFAULT NOW(),
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_msgs_conv      ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_msgs_zapi_id   ON chat_messages(zapi_message_id);
CREATE INDEX IF NOT EXISTS idx_msgs_sent_at   ON chat_messages(sent_at DESC);

-- ── EVENTOS DE WEBHOOK (fila de entrada da Z-API) ─────────────────────────
-- Guarda os webhooks brutos para processamento assíncrono e debug
CREATE TABLE IF NOT EXISTS webhook_events (
  id          SERIAL PRIMARY KEY,
  payload     JSONB        NOT NULL,
  processed   BOOLEAN      DEFAULT false,
  error       TEXT,
  received_at TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_proc ON webhook_events(processed, received_at);
