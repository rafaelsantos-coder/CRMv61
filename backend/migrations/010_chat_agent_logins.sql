-- v69: login/logout do atendente na ferramenta de chat.
-- O usuario do sistema nao entra automaticamente no chat: ele precisa "Entrar"
-- na fila pela tela do chat. O estado persiste ate ele clicar em "Sair".
-- Transferencias de conversa so podem apontar para atendentes logados.

CREATE TABLE IF NOT EXISTS chat_agent_logins (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  queue_id INT NOT NULL,
  is_logged_in BOOLEAN DEFAULT false,
  logged_in_at TIMESTAMPTZ,
  logged_out_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, queue_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_logins_queue_on
  ON chat_agent_logins(queue_id)
  WHERE is_logged_in = true;
