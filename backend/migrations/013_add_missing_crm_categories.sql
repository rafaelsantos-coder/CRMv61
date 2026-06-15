INSERT INTO categories (name)
VALUES
  ('VPN'),
  ('Wifi Adicional'),
  ('Troca de Titular'),
  ('Troca de Endereco')
ON CONFLICT DO NOTHING;
