# Sistema Integrado Sulnet V1 — v68d-chat-operacional

Versão focada no chat operacional real.

## Ajustes principais

1. Conversas por fila/grupo/usuário
   - Vendedores visualizam conversas atribuídas a eles ou pertencentes às filas em `queue_users`.
   - Admin/gerência/BKO continuam visualizando tudo.

2. Novo atendimento por fila
   - Modal "Novo atendimento".
   - Seleção obrigatória da fila de atendimento.
   - Número com DDD.
   - Conversa nasce com `queue_id` e `api_instance_id` da fila.

3. Distribuição de atendimento
   - Usa `assignUserForQueue(queueId)`.
   - Se a fila for manual ou não houver atendente automático, o atendimento fica com o usuário que abriu.

4. Mídias enviadas no histórico
   - Imagem, áudio e documento enviados são salvos como referência em `media_url`, permitindo exibição imediata no histórico do chat.

5. Base preservada
   - Z-API, webhook, filas, grupos e usuários permanecem no mesmo modelo da v68c.
