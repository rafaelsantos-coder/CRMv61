# Sistema Integrado Sulnet V1 — v68c-final

Versão gerada a partir de `Sistema_Integrado_Sulnet_V1_v68b_FINAL_3.zip`.

## Correções aplicadas

1. Corrigido conflito no frontend do Atendimento / WhatsApp:
   - normalizado `__whatsV62State`, `__whatsV65State` e variações para `__whatsV68CState`;
   - normalizado `loadWhatsV62/loadWhatsV65` para `loadWhatsV68C`.

2. Corrigido fluxo de criação de fila:
   - criação inicial pede apenas Nome da fila e Tipo da fila;
   - depois de criar, abre a aba Conexão para Z-API.

3. Aumentado limite de payload do backend:
   - JSON e URL encoded ajustados para 25mb;
   - necessário para anexos, imagens e áudios base64.

4. Melhor tratamento de erro do módulo WhatsApp:
   - frontend tenta exibir o erro real retornado pelo backend.

5. Preservadas integrações:
   - filas;
   - grupos;
   - usuários;
   - chat operacional;
   - webhook;
   - Z-API.
