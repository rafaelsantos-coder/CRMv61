# v63 — Chat do Vendedor

Tela operacional do chat redesenhada para:
- lista de conversas à esquerda;
- cabeçalho com cliente, fila, bot e status;
- mensagens reais ao centro;
- barra inferior com texto, anexo, áudio e envio.

Não há dados fictícios na tela do chat.
A tela usa:
- GET /api/chat/conversations
- GET /api/chat/conversations/:id/messages
- GET /api/chat/conversations/:id/messages/new
- POST /api/chat/conversations/:id/messages

O acesso segue filas/grupos/usuários porque o backend filtra por queue_users.
