# v65 — Correção criação de fila WhatsApp

Correções:
- Backend executa auto-preparo do schema do módulo WhatsApp antes de listar/criar filas.
- Criação de fila não depende mais de migration aplicada manualmente.
- Tela mostra o erro real do backend, não apenas mensagem genérica.
- Depois de criar a fila, abre automaticamente a aba Conexão para preencher Z-API.
- Mantém criação inicial somente com Nome da fila e Tipo da fila.
