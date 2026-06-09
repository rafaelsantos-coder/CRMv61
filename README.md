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
