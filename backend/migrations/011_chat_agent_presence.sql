-- v69b: presenca do atendente no chat.
-- O login do chat vale apenas enquanto a sessao do sistema esta aberta:
-- o navegador renova last_seen_at via heartbeat; sem renovacao por
-- 2 minutos (sistema fechado/deslogado), o login expira automaticamente.

ALTER TABLE chat_agent_logins
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

UPDATE chat_agent_logins
   SET is_logged_in = false,
       logged_out_at = NOW()
 WHERE is_logged_in = true;
