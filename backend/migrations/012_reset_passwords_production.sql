-- ============================================================
-- 012 - Preparacao do login para producao
-- Reseta a senha de TODOS os usuarios para a padrao comercial123
-- e exige a troca de senha no primeiro acesso.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

UPDATE users
   SET password_hash = crypt('comercial123', gen_salt('bf', 12)),
       must_change_password = true,
       updated_at = NOW();
