# Atendimento WhatsApp — Sistema Integrado Sulnet V1 v56

## Conceito

O chat agora passa a trabalhar com três níveis:

1. **Instância/API**
   - Conexão técnica com a Z-API.
   - Cada instância pode representar um número WhatsApp.

2. **Fila de Atendimento**
   - Setor de atendimento: Comercial, Suporte, Financeiro, Retenção etc.
   - Cada fila pode ser vinculada a uma instância/API.

3. **Usuários por Fila**
   - Define quais vendedores/atendentes participam da fila.

## Administração

Acesse:

```text
Administração > Atendimento / WhatsApp
```

Nesta tela é possível:

- Criar instância/API.
- Testar conexão.
- Registrar webhook.
- Criar fila de atendimento.
- Vincular usuários à fila.
- Definir tipo de distribuição.

## Tipos de distribuição

- Manual
- Rodízio
- Menor fila
- Primeiro disponível

## Migration

Execute no banco:

```text
backend/migrations/003_attendance_queues.sql
```

## Backend adicionado

```text
backend/src/routes/chatAdmin.js
backend/src/services/queueDistribution.js
backend/migrations/003_attendance_queues.sql
```

## Rotas

```text
GET  /api/chat-admin/api-instances
POST /api/chat-admin/api-instances
GET  /api/chat-admin/api-instances/:id/status
POST /api/chat-admin/api-instances/:id/webhook
PATCH /api/chat-admin/api-instances/:id/toggle

GET  /api/chat-admin/queues
POST /api/chat-admin/queues
PATCH /api/chat-admin/queues/:id/toggle

GET  /api/chat-admin/users
POST /api/chat-admin/conversations/:id/transfer
```
