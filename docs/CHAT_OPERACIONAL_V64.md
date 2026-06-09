# v64 — Chat Operacional Fullscreen

Correção baseada no vídeo de referência:
- remove título/card de página;
- chat ocupa a área inteira abaixo do menu;
- lista de conversas à esquerda;
- cabeçalho do atendimento no topo;
- toolbar de ações no cabeçalho;
- mensagens no centro;
- composer fixo no rodapé.

Sem dados fictícios.
Usa as rotas reais do chat:
- GET /api/chat/conversations
- GET /api/chat/conversations/:id/messages
- GET /api/chat/conversations/:id/messages/new
- POST /api/chat/conversations/:id/messages
