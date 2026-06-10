# Sulnet V1 — Guia Completo de Deploy em Produção

## Visão Geral da Arquitetura

```
Internet
   │
   ▼
Railway (HTTPS automático)
   │
   ├─ Node.js/Express (API + serve frontend)
   │
   ├─ PostgreSQL (Railway Plugin) ← banco de dados real
   │
   └─ Cloudflare R2 ← uploads de documentos
```

---

## Pré-requisitos

- Conta no [Railway](https://railway.app)
- Conta na [Cloudflare](https://cloudflare.com) (gratuita)
- Git instalado
- Node.js 20+ instalado (para rodar localmente)

---

## PASSO 1 — Estrutura do Projeto

Organize os arquivos assim:

```
sistema-integrado-sulnet-v1-producao/
├── Dockerfile
├── railway.json
├── .gitignore
├── backend/
│   ├── package.json
│   ├── .env.example
│   ├── migrations/
│   │   └── 001_initial_schema.sql
│   └── src/
│       ├── server.js
│       ├── config/
│       │   ├── db.js
│       │   └── storage.js
│       ├── middleware/
│       │   └── auth.js
│       └── routes/
│           ├── auth.js
│           ├── users.js
│           ├── opportunities.js
│           ├── credit.js
│           ├── agenda.js
│           ├── admin.js
│           ├── uploads.js
│           └── dashboard.js
└── public/
    └── index.html   ← copiar do projeto original
```

**Copie o `index.html` original** para a pasta `public/` do novo projeto.

---

## PASSO 2 — Cloudflare R2 (Armazenamento de Arquivos)

### 2.1 Criar bucket

1. Acesse [dash.cloudflare.com](https://dash.cloudflare.com)
2. Menu lateral → **R2 Object Storage**
3. Clique em **Create bucket**
4. Nome: `sistema-integrado-sulnet-v1-docs`
5. Região: escolha a mais próxima (ex: WNAM para América do Sul)
6. Clique em **Create bucket**

### 2.2 Gerar credenciais API

1. Na página do R2 → **Manage R2 API Tokens**
2. **Create API Token**
3. Permissões: **Object Read & Write**
4. Escopo: **Specific bucket** → selecione `sistema-integrado-sulnet-v1-docs`
5. Copie:
   - **Access Key ID**
   - **Secret Access Key**
   - **Account ID** (aparece na URL da página: `dash.cloudflare.com/<account_id>/r2/...`)

---

## PASSO 3 — Railway

### 3.1 Criar projeto

1. Acesse [railway.app](https://railway.app) → **New Project**
2. Escolha **Deploy from GitHub repo** (recomendado) ou **Empty Project**
3. Se usar GitHub: faça push do projeto e conecte o repo

### 3.2 Adicionar PostgreSQL

1. No seu projeto Railway → **+ New** → **Database** → **Add PostgreSQL**
2. Railway cria o banco e gera a variável `DATABASE_URL` automaticamente

### 3.3 Configurar variáveis de ambiente

No Railway → seu serviço → aba **Variables**, adicione:

```
DATABASE_URL          → (gerada automaticamente pelo plugin PostgreSQL)
JWT_SECRET            → gere com o comando abaixo
JWT_EXPIRES           → 12h
R2_ACCOUNT_ID         → seu account ID do Cloudflare
R2_ACCESS_KEY_ID      → access key gerada no passo 2.2
R2_SECRET_ACCESS_KEY  → secret key gerada no passo 2.2
R2_BUCKET_NAME        → sistema-integrado-sulnet-v1-docs
NODE_ENV              → production
ALLOWED_ORIGINS       → https://seu-app.up.railway.app
GOOGLE_CALENDAR_CLIENT_ID → (o mesmo do projeto original)
```

**Gerar JWT_SECRET** (rode no terminal do seu computador):
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3.4 Fazer deploy

```bash
# No terminal, dentro da pasta sistema-integrado-sulnet-v1-producao/
git init
git add .
git commit -m "Sulnet V1 v54 - produção"
git remote add origin https://github.com/seu-usuario/sistema-integrado-sulnet-v1.git
git push -u origin main
```

Railway detecta o push e faz o deploy automaticamente via Dockerfile.

---

## PASSO 4 — Rodar a Migração do Banco

Após o primeiro deploy, execute a migração para criar todas as tabelas.

**Opção A — Via Railway CLI (recomendada):**
```bash
npm install -g @railway/cli
railway login
railway run psql $DATABASE_URL -f backend/migrations/001_initial_schema.sql
```

**Opção B — Via painel Railway:**
1. Clique no serviço PostgreSQL
2. Aba **Query** → cole o conteúdo do arquivo `001_initial_schema.sql` e execute

**Opção C — Via cliente PostgreSQL local:**
```bash
psql "postgresql://..." -f backend/migrations/001_initial_schema.sql
```
(A connection string está nas variáveis do Railway)

---

## PASSO 5 — Primeiro Acesso

Após o deploy e migração:

1. Acesse a URL do Railway (ex: `https://sistema-integrado-sulnet-v1.up.railway.app`)
2. Login com:
   - **Usuário:** `admin`
   - **Senha:** `Admin@2024`
3. O sistema pedirá para **trocar a senha** no primeiro acesso
4. Após trocar, vá em **Administração** e crie os demais usuários

---

## PASSO 6 — Adaptar o Frontend (index.html)

O `index.html` original usa `localStorage` para tudo. É necessário adaptar para consumir a API.

### Estratégia de migração (menor esforço):

Adicione este bloco no `<head>` do `index.html`, **antes** do `<script>` principal:

```html
<script>
// ── Ponte API: substitui localStorage por chamadas ao backend ──
const API_BASE = '';  // mesma origem

// Token JWT em memória (mais seguro que localStorage)
let _token = sessionStorage.getItem('sulnet_jwt') || '';

async function apiCall(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ..._token ? { 'Authorization': 'Bearer ' + _token } : {}
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) {
    _token = '';
    sessionStorage.removeItem('sulnet_jwt');
    location.reload();
    return null;
  }
  return res.json();
}

// Substitui login do sistema original
window.__sulnetApiLogin = async (username, password) => {
  const data = await apiCall('POST', '/api/auth/login', { username, password });
  if (data?.token) {
    _token = data.token;
    sessionStorage.setItem('sulnet_jwt', _token);
    return data.user;
  }
  return null;
};
</script>
```

> **Nota para o desenvolvedor:** A migração completa do frontend requer substituir cada leitura/escrita de `localStorage` por uma chamada `apiCall()` correspondente. As rotas da API espelham exatamente a estrutura de dados que o frontend já conhece.

---

## PASSO 7 — Domínio Personalizado (opcional)

1. No Railway → seu serviço → aba **Settings** → **Domains**
2. **Add Custom Domain** → ex: `crm.suaempresa.com.br`
3. No painel DNS do seu domínio, aponte um registro **CNAME** para o endereço fornecido pelo Railway
4. Railway provê HTTPS automático via Let's Encrypt
5. Atualize `ALLOWED_ORIGINS` nas variáveis do Railway para incluir o novo domínio
6. Adicione o novo domínio nas **Authorized JavaScript origins** do Google Cloud Console (para o Calendar funcionar)

---

## Monitoramento

### Health check
```
GET /health
→ { "ok": true, "db": "connected", "version": "v54-prod" }
```

### Ver logs
```bash
railway logs
```

### Ver uso do banco
No painel Railway → PostgreSQL → aba **Data** ou **Metrics**

---

## Custos Estimados (Railway + Cloudflare R2)

| Serviço | Plano | Custo estimado |
|---------|-------|---------------|
| Railway Hobby | App + PostgreSQL | ~$5/mês |
| Railway Pro | App + PostgreSQL (até 100 usuários) | ~$20/mês |
| Cloudflare R2 | Até 10GB storage + 1M operações | **Gratuito** |
| Cloudflare R2 | Além disso | ~$0,015/GB |

Para 20-100 usuários, o Railway Pro é o recomendado para garantir recursos suficientes.

---

## Segurança — Checklist

- [ ] Senha do admin trocada no primeiro login
- [ ] JWT_SECRET com pelo menos 64 caracteres aleatórios
- [ ] DATABASE_URL não exposta em logs
- [ ] NODE_ENV=production configurado
- [ ] ALLOWED_ORIGINS com apenas os domínios necessários
- [ ] Bucket R2 sem acesso público (só via URL assinada)
- [ ] Backup automático do PostgreSQL habilitado no Railway

---

## Suporte

- Railway Docs: https://docs.railway.app
- Cloudflare R2 Docs: https://developers.cloudflare.com/r2
- Logs de erro: `railway logs --tail`
