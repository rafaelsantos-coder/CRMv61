# Sistema Integrado Sulnet V1

Projeto em produção/deploy para Railway.

## Alteração desta versão

- Nome do sistema alterado para **Sistema Integrado Sulnet V1**.
- Removidas referências de marca **CRM ELR/ELR** do pacote atual.
- Mantida a estrutura de produção com front-end, backend, PostgreSQL, JWT, uploads e integrações já existentes.

## Estrutura

```text
public/index.html
backend/src/server.js
backend/src/routes/
backend/src/middleware/
backend/src/services/
backend/src/config/
backend/migrations/
Dockerfile
railway.json
```

## Como rodar localmente

1. Tenha PostgreSQL rodando e crie um banco vazio (ex.: `crm_sulnet`).
2. No diretório `backend/`, crie um arquivo `.env` (use `.env.example` como base):

   ```text
   DATABASE_URL=postgresql://usuario:senha@localhost:5432/crm_sulnet
   JWT_SECRET=<gere com: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
   JWT_EXPIRES=12h
   NODE_ENV=development
   PORT=3000
   ```

3. Instale as dependências e suba o servidor:

   ```bash
   cd backend
   npm install
   npm start
   ```

No primeiro boot, as **migrations são aplicadas automaticamente** (`config/migrate.js`)
em ordem, uma única vez cada — não é preciso rodar `psql` manualmente. Cada migration
aplicada é registrada na tabela `schema_migrations`, então boots seguintes só executam
o que ainda não rodou.

A migration `001` já cria o usuário administrador padrão:

```text
usuário: admin
senha:   Admin@2024   (troque após o primeiro login)
```

A app fica disponível em `http://localhost:3000`.

## Verificação após deploy

Acesse:

```text
/api/config
/health
```

A resposta deve mostrar o app como:

```text
Sistema Integrado Sulnet V1
```


## v56 — Atendimento WhatsApp com múltiplas filas e instâncias

Esta versão adiciona a administração de atendimento WhatsApp:

- Instâncias/API Z-API múltiplas.
- Filas de atendimento.
- Vínculo de usuários por fila.
- Regras de distribuição: manual, rodízio, menor fila e primeiro disponível.
- Conversas vinculadas à fila e à instância/API.
- Transferência de conversas entre filas via backend.
- Migration `003_attendance_queues.sql`.

Depois do deploy, execute a migration 003 no banco.


## v57 — Atendimento WhatsApp Chatbot

Esta versão reorganiza e reforça o módulo de atendimento WhatsApp:

- Administração > Atendimento / WhatsApp com submenus:
  - Criação de Bot
  - Filas de Atendimento
- Bot Z-API com ID da instância, token, Client-Token opcional, teste e webhook.
- Filas vinculadas a um bot/API e a usuários atendentes.
- Webhook com deduplicação por messageId.
- Conversas normalizadas por número e aliases para evitar duplicidade por LID.
- Envio/recebimento de texto, imagem, vídeo, documento, figurinha e áudio.
- Gravação de áudio no navegador e envio direto na conversa.
- Status de mensagem: PENDING, SENT, RECEIVED, READ e PLAYED.
- Migration nova: backend/migrations/004_chatbot_aliases.sql.

## v68b — Chat Operacional + correções de produção

- Módulo Chat operacional reescrito (frontend).
- Histórico de mensagens limitado por `history_days` da fila (padrão 30 dias).
- Migration 007 auto-aplicada no boot: deduplica conversas por telefone,
  cria UNIQUE(phone) e índice de mensagens — sem SQL manual.
- Filas de WhatsApp com botões Editar / Ativar-Desativar / Excluir (exclusão real).
- `getApiToken`/`buildAuthHeaders` expostas globalmente (fix `is not defined`).
- `index.html` servido sem cache do navegador — deploys aparecem na hora.
- Verificação pós-deploy: `/health` deve responder `"version": "v68b-prod"`.
