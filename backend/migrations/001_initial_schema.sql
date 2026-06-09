-- ============================================================
-- Sulnet V1 — Migração Completa do Banco de Dados
-- Execute em ordem no PostgreSQL do Railway
-- ============================================================

-- Extensões
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── USUÁRIOS ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(120) NOT NULL,
  username            VARCHAR(60)  NOT NULL UNIQUE,
  password_hash       TEXT         NOT NULL,
  role                VARCHAR(20)  NOT NULL CHECK (role IN ('admin','gerencia','bko','vendedor')),
  city                VARCHAR(80)  DEFAULT '',
  email               VARCHAR(120) DEFAULT '',
  active              BOOLEAN      DEFAULT true,
  must_change_password BOOLEAN     DEFAULT true,
  created_at          TIMESTAMPTZ  DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  DEFAULT NOW()
);

-- ── FUNIS ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS funnels (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(80) NOT NULL,
  sort_order INT         DEFAULT 0,
  active     BOOLEAN     DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── ETAPAS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stages (
  id         SERIAL PRIMARY KEY,
  funnel_id  INT         NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  name       VARCHAR(80) NOT NULL,
  color      VARCHAR(20) DEFAULT '#6b7280',
  sort_order INT         DEFAULT 0,
  is_won     BOOLEAN     DEFAULT false,
  is_lost    BOOLEAN     DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── ACESSO DE USUÁRIO A FUNIS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_funnel_access (
  user_id   INT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  funnel_id INT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, funnel_id)
);

-- ── ORIGENS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS origins (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(80) NOT NULL
);

-- ── CATEGORIAS DE PRODUTO ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id     SERIAL PRIMARY KEY,
  name   VARCHAR(80) NOT NULL,
  active BOOLEAN     DEFAULT true
);

-- ── PRODUTOS / PLANOS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id            SERIAL PRIMARY KEY,
  category_id   INT            REFERENCES categories(id) ON DELETE SET NULL,
  name          VARCHAR(120)   NOT NULL,
  monthly_value NUMERIC(10,2)  DEFAULT 0,
  active        BOOLEAN        DEFAULT true,
  created_at    TIMESTAMPTZ    DEFAULT NOW()
);

-- ── TAGS ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tags (
  id    SERIAL PRIMARY KEY,
  name  VARCHAR(60) NOT NULL,
  color VARCHAR(20) DEFAULT 'orange'
);

-- ── MOTIVOS DE GANHO/PERDA ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outcome_reasons (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  type VARCHAR(10) NOT NULL CHECK (type IN ('won','lost'))
);

-- ── OPORTUNIDADES ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS opportunities (
  id                  SERIAL PRIMARY KEY,
  funnel_id           INT            NOT NULL REFERENCES funnels(id),
  stage_id            INT            REFERENCES stages(id),
  assigned_user_id    INT            REFERENCES users(id),
  origin_id           INT            REFERENCES origins(id),
  product_id          INT            REFERENCES products(id),
  outcome_reason_id   INT            REFERENCES outcome_reasons(id),

  -- Dados do cliente
  client_name         VARCHAR(120),
  client_cpf          VARCHAR(20),
  client_phone        VARCHAR(20),
  client_email        VARCHAR(120),
  client_birth_date   DATE,
  cep                 VARCHAR(10),
  city                VARCHAR(80),
  state               CHAR(2),
  street              VARCHAR(120),
  number              VARCHAR(20),
  neighborhood        VARCHAR(80),
  complement          VARCHAR(80),

  -- Produto
  product_category    VARCHAR(60),
  product_info        JSONB,        -- dados específicos (fibra, móvel, etc.)
  monthly_value       NUMERIC(10,2) DEFAULT 0,
  one_time_value      NUMERIC(10,2) DEFAULT 0,

  -- Status
  status              VARCHAR(20)   DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  is_backoffice_copy  BOOLEAN       DEFAULT false,
  notes               TEXT,
  closed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_opps_funnel    ON opportunities(funnel_id);
CREATE INDEX IF NOT EXISTS idx_opps_stage     ON opportunities(stage_id);
CREATE INDEX IF NOT EXISTS idx_opps_user      ON opportunities(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_opps_status    ON opportunities(status);
CREATE INDEX IF NOT EXISTS idx_opps_created   ON opportunities(created_at);
CREATE INDEX IF NOT EXISTS idx_opps_cpf       ON opportunities(client_cpf);

-- ── TAGS DE OPORTUNIDADE ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS opportunity_tags (
  opportunity_id INT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  tag_id         INT NOT NULL REFERENCES tags(id)          ON DELETE CASCADE,
  PRIMARY KEY (opportunity_id, tag_id)
);

-- ── ANOTAÇÕES DE PROSPECÇÃO ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prospect_notes (
  id              SERIAL PRIMARY KEY,
  opportunity_id  INT         NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  user_id         INT         REFERENCES users(id),
  channel         VARCHAR(40),   -- Ligação, WhatsApp, Visita, etc.
  result          VARCHAR(80),
  contacted_at    TIMESTAMPTZ DEFAULT NOW(),
  next_follow_up  TIMESTAMPTZ,
  description     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notes_opp ON prospect_notes(opportunity_id);

-- ── ANÁLISES DE CRÉDITO ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analysis_requests (
  id                        SERIAL PRIMARY KEY,
  protocol                  VARCHAR(30)  UNIQUE,
  opportunity_id            INT          REFERENCES opportunities(id),
  requested_by_user_id      INT          REFERENCES users(id),
  seller_name               VARCHAR(120),

  -- Dados do cliente
  doc_type                  VARCHAR(10)  DEFAULT 'CPF',
  cpf                       VARCHAR(20),
  client_name               VARCHAR(120),
  client_phone              VARCHAR(20),
  client_birth_date         DATE,
  cep                       VARCHAR(10),
  street                    VARCHAR(120),
  number                    VARCHAR(20),
  neighborhood              VARCHAR(80),
  city                      VARCHAR(80),
  state                     CHAR(2),
  product                   VARCHAR(120),
  seller_note               TEXT,

  -- Status
  status                    VARCHAR(50)  DEFAULT 'Enviado',

  -- Análise BKO
  bko_analyst_id            INT          REFERENCES users(id),
  bko_decision              VARCHAR(50),
  bko_score                 INT,
  bko_risk_level            VARCHAR(20),
  bko_reason                TEXT,
  bko_justification         TEXT,
  bko_source                VARCHAR(80),
  bko_analyzed_at           TIMESTAMPTZ,

  -- Contestação
  contestation_justification TEXT,
  contestation_at            TIMESTAMPTZ,

  -- Decisão gerencial
  management_decision        VARCHAR(50),
  management_justification   TEXT,
  management_at              TIMESTAMPTZ,

  created_at                TIMESTAMPTZ  DEFAULT NOW(),
  updated_at                TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analysis_cpf    ON analysis_requests(cpf);
CREATE INDEX IF NOT EXISTS idx_analysis_status ON analysis_requests(status);
CREATE INDEX IF NOT EXISTS idx_analysis_user   ON analysis_requests(requested_by_user_id);

-- ── HISTÓRICO DE ANÁLISE ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analysis_history (
  id           SERIAL PRIMARY KEY,
  analysis_id  INT         NOT NULL REFERENCES analysis_requests(id) ON DELETE CASCADE,
  actor_id     INT         REFERENCES users(id),
  action       TEXT,
  status       VARCHAR(50),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── REGRAS DE CRÉDITO ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_rules (
  id               SERIAL PRIMARY KEY,
  min_score        INT         DEFAULT 0,
  max_score        INT         DEFAULT 999,
  max_restrictions INT         DEFAULT 99,
  allow_protest    BOOLEAN     DEFAULT true,
  decision         VARCHAR(50),
  risk_level       VARCHAR(20),
  condition_text   TEXT,
  sort_order       INT         DEFAULT 0,
  active           BOOLEAN     DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── AGENDA / EVENTOS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_events (
  id          SERIAL PRIMARY KEY,
  user_id     INT         REFERENCES users(id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL,
  description TEXT,
  start_at    TIMESTAMPTZ NOT NULL,
  end_at      TIMESTAMPTZ,
  all_day     BOOLEAN     DEFAULT false,
  location    VARCHAR(200),
  source      VARCHAR(20) DEFAULT 'internal', -- 'internal' | 'google'
  google_id   VARCHAR(200),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_user  ON calendar_events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_start ON calendar_events(start_at);

-- ── ATTACHMENTS (Cloudflare R2) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachments (
  id               SERIAL PRIMARY KEY,
  entity_type      VARCHAR(30)  NOT NULL, -- 'analysis' | 'opportunity'
  entity_id        INT          NOT NULL,
  doc_type         VARCHAR(60)  DEFAULT 'misc',
  file_key         TEXT         NOT NULL,  -- chave no R2
  original_name    VARCHAR(200),
  mime_type        VARCHAR(80),
  size_bytes       INT,
  uploaded_by_id   INT          REFERENCES users(id),
  created_at       TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attach_entity ON attachments(entity_type, entity_id);

-- ── AUDIT LOG ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  user_id    INT,
  action     VARCHAR(60),
  details    JSONB,
  ip         VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── CONTADORES (protocolo SAC etc.) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS counters (
  name  VARCHAR(60) PRIMARY KEY,
  value INT DEFAULT 0
);

-- ============================================================
-- DADOS INICIAIS
-- ============================================================

-- Usuário administrador padrão (senha: Admin@2024 — TROCAR APÓS PRIMEIRO LOGIN)
INSERT INTO users (name, username, password_hash, role, city, email, active, must_change_password)
VALUES (
  'Administrador Sulnet',
  'admin',
  crypt('Admin@2024', gen_salt('bf', 12)),
  'admin',
  'Santa Rosa',
  'admin@sulnet.com.br',
  true,
  true
) ON CONFLICT (username) DO NOTHING;

-- Funis iniciais
INSERT INTO funnels (name, sort_order) VALUES
  ('Comercial',  1),
  ('Backoffice', 2)
ON CONFLICT DO NOTHING;

-- Etapas do funil Comercial
WITH f AS (SELECT id FROM funnels WHERE name = 'Comercial' LIMIT 1)
INSERT INTO stages (funnel_id, name, color, sort_order) VALUES
  ((SELECT id FROM f), 'Prospecção',     '#6b7280', 1),
  ((SELECT id FROM f), 'Qualificação',   '#2563eb', 2),
  ((SELECT id FROM f), 'Proposta',       '#d97706', 3),
  ((SELECT id FROM f), 'Negociação',     '#7c3aed', 4),
  ((SELECT id FROM f), 'Fechamento',     '#16a34a', 5)
ON CONFLICT DO NOTHING;

-- Etapas do funil Backoffice
WITH f AS (SELECT id FROM funnels WHERE name = 'Backoffice' LIMIT 1)
INSERT INTO stages (funnel_id, name, color, sort_order) VALUES
  ((SELECT id FROM f), 'Documentação',   '#2563eb', 1),
  ((SELECT id FROM f), 'Ativação',       '#d97706', 2),
  ((SELECT id FROM f), 'Concluído',      '#16a34a', 3)
ON CONFLICT DO NOTHING;

-- Acesso do admin a todos os funis
INSERT INTO user_funnel_access (user_id, funnel_id)
SELECT u.id, f.id FROM users u, funnels f WHERE u.username = 'admin'
ON CONFLICT DO NOTHING;

-- Categorias e produtos iniciais
INSERT INTO categories (name) VALUES ('Fibra'), ('Central em Nuvem'), ('Telefonia Móvel'), ('Telefonia Fixa')
ON CONFLICT DO NOTHING;

-- Origens iniciais
INSERT INTO origins (name) VALUES ('Indicação'), ('Portfólio'), ('Instagram'), ('Facebook'), ('Telemarketing'), ('WhatsApp')
ON CONFLICT DO NOTHING;

-- Tags iniciais
INSERT INTO tags (name, color) VALUES
  ('Cliente Quente',       'orange'),
  ('Portabilidade',        'blue'),
  ('Upgrade',              'purple'),
  ('Pendência CRIVO',      'red'),
  ('Cliente Base',         'green')
ON CONFLICT DO NOTHING;

-- Regras de crédito iniciais
INSERT INTO credit_rules (min_score, max_score, max_restrictions, allow_protest, decision, risk_level, condition_text, sort_order, active) VALUES
  (700, 999, 0,  true,  'Aprovado',       'Baixo',   'Aprovado automaticamente. Score excelente.',         1, true),
  (500, 699, 2,  true,  'Pré-aprovado',   'Médio',   'Aprovado com condições. Verificar restrições.',      2, true),
  (300, 499, 5,  false, 'Análise manual', 'Alto',    'Requer avaliação manual do BKO.',                    3, true),
  (0,   299, 99, false, 'Reprovado',      'Crítico', 'Reprovado por score baixo ou protesto.',              4, true)
ON CONFLICT DO NOTHING;

-- Motivos de ganho/perda
INSERT INTO outcome_reasons (name, type) VALUES
  ('Melhor preço',         'won'),
  ('Melhor produto',       'won'),
  ('Indicação de cliente', 'won'),
  ('Atendimento',          'won'),
  ('Preço alto',           'lost'),
  ('Já tem operadora',     'lost'),
  ('Sem interesse',        'lost'),
  ('Sem crédito',          'lost'),
  ('Sem cobertura',        'lost')
ON CONFLICT DO NOTHING;

-- Contador SAC
INSERT INTO counters (name, value) VALUES ('sac_protocol', 0) ON CONFLICT DO NOTHING;
