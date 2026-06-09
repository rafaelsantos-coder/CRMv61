# Atendimento WhatsApp — v61 funcional

A v61 transforma o protótipo visual de filas/grupos em módulo funcional.

## Rotas adicionadas

- GET /api/whatsapp/queues
- POST /api/whatsapp/queues
- PATCH /api/whatsapp/queues/:id
- DELETE /api/whatsapp/queues/:id
- POST /api/whatsapp/queues/:id/test-status
- POST /api/whatsapp/queues/:id/register-webhook
- GET /api/whatsapp/groups
- POST /api/whatsapp/groups
- PATCH /api/whatsapp/groups/:id
- DELETE /api/whatsapp/groups/:id
- GET /api/whatsapp/users

## Integração operacional

Ao criar grupo, os usuários são também refletidos em `queue_users`.
O chat atual já filtra conversas por `queue_users`, então o vendedor só visualiza filas às quais tem acesso.

## Migration

Execute:

```bash
psql "$DATABASE_URL" -f backend/migrations/005_whatsapp_functional.sql
```

No container Railway, se o diretório for /app:

```bash
psql "$DATABASE_URL" -f migrations/005_whatsapp_functional.sql
```
