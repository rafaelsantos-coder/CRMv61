# Integração SZ Chat → CRM

Implementado nesta versão:

- Novo endpoint público: `POST /api/integrations/szchat/webhook`.
- Health check da integração: `GET /api/integrations/szchat/health`.
- Criação automática da origem `SZ Chat` no banco.
- Campo visual `Origem` no modal de Nova Oportunidade.
- Criação automática de lead/oportunidade quando chegar evento do SZ Chat.
- Regra de usuário:
  - SZ Chat: `gabrieli.padilha@bot.sulnet`
  - CRM: `gabrieli.padilha`
  - A integração remove tudo depois do `@`.
- Primeiro teste: se o webhook do SZ Chat não enviar agente, o fallback padrão é `gabrieli.padilha`.
- A lead entra no primeiro funil acessível ao usuário e na etapa inicial do funil (`Lead Inicial`, `INÍCIO` ou primeira etapa disponível).
- Anti-duplicidade por sessão SZ Chat e telefone.
- Log de integração na tabela `szchat_integration_logs`.

## Arquivos alterados/adicionados

- `backend/src/routes/integrations.js` — novo módulo da integração.
- `backend/src/server.js` — registrou a rota `/api/integrations/szchat` sem JWT.
- `backend/migrations/008_szchat_crm_integration.sql` — migration da integração.
- `backend/src/routes/opportunities.js` — correção de SQL duplicado em notas de oportunidade.
- `public/index.html` — origem `SZ Chat` no seed/migração local e campo Origem no formulário.

## Configuração recomendada no Railway

Opcional, mas recomendado:

```env
SZCHAT_WEBHOOK_TOKEN=coloque_um_token_forte_aqui
SZCHAT_DEFAULT_CRM_USERNAME=gabrieli.padilha
```

Se `SZCHAT_WEBHOOK_TOKEN` estiver configurado, o SZ Chat precisa enviar o mesmo token em uma das opções:

- Header `x-szchat-token`
- Header `Authorization: Bearer TOKEN`
- Query string `?token=TOKEN`

## URL para configurar no SZ Chat

```text
https://SEU-DOMINIO-RAILWAY/api/integrations/szchat/webhook
```

Com token via query string, se preferir:

```text
https://SEU-DOMINIO-RAILWAY/api/integrations/szchat/webhook?token=SEU_TOKEN
```

## Payload de teste

```bash
curl -X POST "https://SEU-DOMINIO-RAILWAY/api/integrations/szchat/webhook" \
  -H "Content-Type: application/json" \
  -H "x-szchat-token: SEU_TOKEN" \
  -d '{
    "event": "enter_queue",
    "agent": { "email": "gabrieli.padilha@bot.sulnet" },
    "contact": { "name": "Cliente Teste SZ Chat", "phone": "5599999999999" },
    "platform": "WhatsApp",
    "channel_id": "canal_teste",
    "session_id": "sessao_teste_001",
    "protocol": "SZ-TESTE-001",
    "message": "Olá, quero contratar internet."
  }'
```

Resposta esperada:

```json
{
  "success": true,
  "duplicated": false,
  "message": "Lead criada com sucesso.",
  "lead_id": 123,
  "crm_user": "gabrieli.padilha",
  "origin": "SZ Chat"
}
```

## Observação importante

A migration 008 é idempotente, mas a própria rota também cria as estruturas necessárias ao primeiro uso. Mesmo assim, em produção é recomendado executar a migration `008_szchat_crm_integration.sql` no PostgreSQL do Railway.


## Correção operacional v68c SZCHAT CRM REV2

- A tela administrativa agora prioriza a sessão numérica do CRM em vez de um JWT antigo salvo no navegador, evitando o erro `Token inválido` ao carregar/criar filas.
- A criação da fila não fica mais bloqueada pela validação externa da Z-API. As credenciais são salvas; a validação deve ser feita pelo botão de teste de status.
- Caso a Z-API retorne erro na validação, a fila permanece salva e o sistema mostra o aviso para conferência.
