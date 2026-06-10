-- ============================================================
-- 009 - Correção usuários/funis para Chat, WhatsApp e SZ Chat
-- Pode ser executado manualmente no Railway PostgreSQL.
-- A aplicação também faz esta autocorreção ao carregar o módulo WhatsApp/SZ Chat.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

INSERT INTO funnels (name, sort_order, active)
SELECT v.name, v.sort_order, true
FROM (VALUES
  ('13. RECEPTIVO',13),('2. BACKOFFICE',2),('21. RECEPTIVO PERDAS',21),
  ('14. UPSELL',14),('30. CROSS-Sell',30),('31. PEDIDO DE VENDA',31)
) AS v(name, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM funnels f WHERE LOWER(TRIM(f.name))=LOWER(TRIM(v.name)));

INSERT INTO users (name, username, password_hash, role, city, email, active, must_change_password)
SELECT v.name, v.username, crypt(v.password, gen_salt('bf', 12)), v.role, v.city, v.email, true, false
FROM (VALUES
  ('Backoffice Comercial','bko','bko123','bko','Santa Rosa','bko@sulnet.com.br'),
  ('Gerência Comercial','gerencia','gerencia123','gerencia','Santa Rosa','gerencia@sulnet.com.br'),
  ('Rafael Teste','rafael.teste','comercial123','vendedor','Santa Rosa','rafael@sulnet.com.br'),
  ('Andressa Reus','andressa.reus','comercial123','vendedor','Cerro Largo','andressa@sulnet.com.br'),
  ('Gabrieli Borth Padilha','gabrieli.padilha','comercial123','vendedor','Santo Ângelo','gabrieli@sulnet.com.br'),
  ('Jenifer Garcia Dutra','jenifer.dutra','comercial123','vendedor','Santa Rosa','jenifer@sulnet.com.br'),
  ('Daniel Augusto Strieder Hubner','daniel.hubner','comercial123','vendedor','Entre-Ijuís','daniel@sulnet.com.br')
) AS v(name, username, password, role, city, email)
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(TRIM(u.username))=LOWER(TRIM(v.username)));

DO $$
DECLARE
  fid_receptivo INT;
  fid_backoffice INT;
  uid RECORD;
  fid INT;
BEGIN
  SELECT id INTO fid_receptivo FROM funnels WHERE LOWER(TRIM(name))='13. receptivo' ORDER BY id LIMIT 1;
  SELECT id INTO fid_backoffice FROM funnels WHERE LOWER(TRIM(name))='2. backoffice' ORDER BY id LIMIT 1;

  FOR uid IN SELECT id, username, role FROM users WHERE active=true LOOP
    IF uid.role IN ('admin','gerencia') THEN
      FOR fid IN SELECT id FROM funnels WHERE LOWER(TRIM(name)) IN ('13. receptivo','2. backoffice','21. receptivo perdas','14. upsell','30. cross-sell','31. pedido de venda') LOOP
        INSERT INTO user_funnel_access(user_id,funnel_id) VALUES(uid.id,fid) ON CONFLICT DO NOTHING;
      END LOOP;
    ELSIF uid.role='bko' OR uid.username='bko' THEN
      IF fid_backoffice IS NOT NULL THEN INSERT INTO user_funnel_access(user_id,funnel_id) VALUES(uid.id,fid_backoffice) ON CONFLICT DO NOTHING; END IF;
    ELSE
      IF fid_receptivo IS NOT NULL THEN INSERT INTO user_funnel_access(user_id,funnel_id) VALUES(uid.id,fid_receptivo) ON CONFLICT DO NOTHING; END IF;
    END IF;
  END LOOP;
END $$;
