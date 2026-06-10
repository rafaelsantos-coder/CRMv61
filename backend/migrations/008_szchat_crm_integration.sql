-- ============================================================
-- Sistema Integrado Sulnet V1 — Migration 008
-- Integração SZ Chat → CRM
-- Cria origem SZ Chat, metadados na oportunidade e log de webhooks
-- Idempotente: pode executar mais de uma vez sem duplicar estrutura
-- ============================================================

CREATE TABLE IF NOT EXISTS szchat_integration_logs (
  id SERIAL PRIMARY KEY,
  event_name VARCHAR(120),
  szchat_user VARCHAR(160),
  crm_username VARCHAR(80),
  crm_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  opportunity_id INT REFERENCES opportunities(id) ON DELETE SET NULL,
  status VARCHAR(40) DEFAULT 'received',
  message TEXT,
  payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS szchat_session_id TEXT,
  ADD COLUMN IF NOT EXISTS szchat_protocol TEXT,
  ADD COLUMN IF NOT EXISTS szchat_channel_id TEXT,
  ADD COLUMN IF NOT EXISTS szchat_platform TEXT,
  ADD COLUMN IF NOT EXISTS szchat_contact_id TEXT,
  ADD COLUMN IF NOT EXISTS szchat_first_message TEXT,
  ADD COLUMN IF NOT EXISTS source_channel VARCHAR(80);

CREATE INDEX IF NOT EXISTS idx_opps_szchat_session ON opportunities(szchat_session_id);
CREATE INDEX IF NOT EXISTS idx_opps_phone_digits ON opportunities((regexp_replace(COALESCE(client_phone,''), '\D', '', 'g')));
CREATE INDEX IF NOT EXISTS idx_szchat_logs_created ON szchat_integration_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_szchat_logs_status ON szchat_integration_logs(status);

INSERT INTO origins (name)
SELECT 'SZ Chat'
WHERE NOT EXISTS (SELECT 1 FROM origins WHERE LOWER(name) = LOWER('SZ Chat'));
