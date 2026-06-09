-- ============================================================
-- Sistema Integrado Sulnet V1 — Migration 003
-- Atendimento WhatsApp: Instâncias/API, Filas e Usuários por Fila
-- ============================================================

-- ── INSTÂNCIAS / APIs WHATSAPP ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_instances (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(120) NOT NULL,
  provider       VARCHAR(40)  NOT NULL DEFAULT 'Z-API',
  instance_id    TEXT         NOT NULL,
  token          TEXT         NOT NULL,
  client_token   TEXT         NOT NULL,
  phone_number   VARCHAR(30),
  status         VARCHAR(40)  DEFAULT 'unknown',
  webhook_url    TEXT,
  is_active      BOOLEAN      DEFAULT true,
  metadata       JSONB        DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(provider, instance_id)
);

CREATE INDEX IF NOT EXISTS idx_api_instances_active ON api_instances(is_active);
CREATE INDEX IF NOT EXISTS idx_api_instances_provider ON api_instances(provider);

-- ── FILAS DE ATENDIMENTO ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance_queues (
  id                    SERIAL PRIMARY KEY,
  name                  VARCHAR(120) NOT NULL,
  description           TEXT,
  type                  VARCHAR(40)  DEFAULT 'comercial',
  api_instance_id        INT          REFERENCES api_instances(id) ON DELETE SET NULL,
  distribution_type      VARCHAR(40)  DEFAULT 'manual',
  business_hours         JSONB        DEFAULT '{}'::jsonb,
  welcome_message        TEXT,
  after_hours_message    TEXT,
  is_active              BOOLEAN      DEFAULT true,
  last_assigned_user_id  INT          REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ  DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  DEFAULT NOW(),
  CHECK (distribution_type IN ('manual','round_robin','least_open','first_available'))
);

CREATE INDEX IF NOT EXISTS idx_attendance_queues_active ON attendance_queues(is_active);
CREATE INDEX IF NOT EXISTS idx_attendance_queues_api ON attendance_queues(api_instance_id);

-- ── USUÁRIOS POR FILA ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS queue_users (
  id             SERIAL PRIMARY KEY,
  queue_id       INT NOT NULL REFERENCES attendance_queues(id) ON DELETE CASCADE,
  user_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_in_queue  VARCHAR(30) DEFAULT 'atendente',
  is_active      BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(queue_id, user_id),
  CHECK (role_in_queue IN ('atendente','supervisor'))
);

CREATE INDEX IF NOT EXISTS idx_queue_users_queue ON queue_users(queue_id);
CREATE INDEX IF NOT EXISTS idx_queue_users_user ON queue_users(user_id);

-- ── CONVERSAS: ADICIONA VÍNCULOS COM FILA E API ──────────────────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS queue_id INT REFERENCES attendance_queues(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS api_instance_id INT REFERENCES api_instances(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conv_queue ON conversations(queue_id);
CREATE INDEX IF NOT EXISTS idx_conv_api_instance ON conversations(api_instance_id);

-- Expande status de conversas, mantendo compatibilidade com open/closed
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT conname INTO c_name
  FROM pg_constraint
  WHERE conrelid = 'conversations'::regclass
    AND contype = 'c'
    AND conname LIKE '%status%';

  IF c_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE conversations DROP CONSTRAINT ' || quote_ident(c_name);
  END IF;

  ALTER TABLE conversations
    ADD CONSTRAINT conversations_status_check
    CHECK (status IN (
      'new',
      'waiting',
      'open',
      'in_attendance',
      'waiting_customer',
      'transferred',
      'closed',
      'lost',
      'converted'
    ));
END $$;

-- ── TRANSFERÊNCIAS ENTRE FILAS ───────────────────────────────────────────
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

CREATE INDEX IF NOT EXISTS idx_chat_transfers_conv ON chat_transfers(conversation_id);

-- ── MIGRA CONFIGURAÇÃO ANTIGA Z-API PARA NOVO MODELO ─────────────────────
INSERT INTO api_instances (name, provider, instance_id, token, client_token, webhook_url, status, is_active)
SELECT
  'Instância Z-API Padrão',
  'Z-API',
  z.instance_id,
  z.token,
  z.client_token,
  z.webhook_url,
  'unknown',
  true
FROM zapi_config z
WHERE NOT EXISTS (
  SELECT 1 FROM api_instances ai
  WHERE ai.provider = 'Z-API' AND ai.instance_id = z.instance_id
)
ON CONFLICT DO NOTHING;

-- ── CRIA FILA COMERCIAL PADRÃO SE NÃO EXISTIR ────────────────────────────
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

-- Vincula usuários comerciais existentes à fila Comercial, sem duplicar
INSERT INTO queue_users (queue_id, user_id, role_in_queue, is_active)
SELECT
  (SELECT id FROM attendance_queues WHERE LOWER(name) = 'comercial' ORDER BY id LIMIT 1),
  u.id,
  CASE WHEN u.role IN ('admin','gerencia') THEN 'supervisor' ELSE 'atendente' END,
  true
FROM users u
WHERE u.active = true
  AND u.role IN ('admin','gerencia','vendedor')
  AND NOT EXISTS (
    SELECT 1 FROM queue_users qu
    WHERE qu.queue_id = (SELECT id FROM attendance_queues WHERE LOWER(name) = 'comercial' ORDER BY id LIMIT 1)
      AND qu.user_id = u.id
  );
