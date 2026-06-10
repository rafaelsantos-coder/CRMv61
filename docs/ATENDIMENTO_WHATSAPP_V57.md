# Atendimento WhatsApp Chatbot — v57

## Estrutura

O módulo fica em:

```text
Administração > Atendimento / WhatsApp
```

Submenus:

1. Criação de Bot
2. Filas de Atendimento

## Criação de Bot

O bot representa a integração com uma instância Z-API.

Campos:

- Nome do bot
- Fornecedor: Z-API
- API da instância
- ID da instância
- Token da instância
- Client-Token, se estiver ativo
- Número conectado
- Testar conexão
- Registrar webhook

## Filas de Atendimento

A fila define o grupo operacional de atendimento.

Campos:

- Nome da fila
- Tipo
- Bot/API usado nessa fila
- Usuários vinculados
- Regra de distribuição
- Mensagem de boas-vindas
- Mensagem fora do horário

## Chat

O chat operacional agora suporta:

- Conversa única por número
- Deduplicação por messageId
- Normalização de telefone
- Aliases para LID/chatLid/senderLid
- Envio de texto
- Imagem
- Vídeo
- Documento
- Figurinha
- Áudio gravado na hora
- Status enviado, entregue e lido

## Migration

Execute no banco:

```text
backend/migrations/004_chatbot_aliases.sql
```
