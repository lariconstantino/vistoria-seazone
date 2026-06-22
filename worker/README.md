# Envio automático do relatório (Cloudflare Worker)

Ao finalizar uma vistoria, o app envia o HTML para este Worker, que:
1. faz **commit do HTML** em `/relatorios/CODIGO-data.html` no repositório (histórico permanente);
2. **posta no Slack** `#vistorias-app-teste`: `✅ Vistoria CODIGO — link`.

O link permanente fica em:
`https://lariconstantino.github.io/vistoria-seazone/relatorios/CODIGO-data.html`

> Os segredos (token do GitHub e webhook do Slack) ficam **só no Worker** (servidor), nunca no site público.

---

## Passo a passo (uma vez)

### 1. Token do GitHub (fine-grained)
1. github.com → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. **Repository access:** Only select repositories → `lariconstantino/vistoria-seazone`
3. **Permissions → Repository permissions → Contents:** `Read and write`
4. Gerar e **copiar o token** (começa com `github_pat_...`).

### 2. Incoming Webhook do Slack (canal #vistorias-app-teste)
1. api.slack.com/apps → o app do workspace Seazone (o mesmo que já tem webhooks) → **Incoming Webhooks** (ativar se preciso)
2. **Add New Webhook to Workspace** → escolher **#vistorias-app-teste** → **Allow**
3. **Copiar a Webhook URL** (`https://hooks.slack.com/services/...`).

### 3. Criar o Worker
1. dash.cloudflare.com → **Workers & Pages → Create → Create Worker** → dar um nome (ex: `vistoria-report`) → **Deploy**.
2. **Edit code** → apagar o conteúdo → colar o `report-worker.js` desta pasta → **Deploy**.
3. **Settings → Variables and Secrets:**
   - **Secret** `GITHUB_TOKEN` = token do passo 1
   - **Secret** `SLACK_WEBHOOK` = URL do passo 2
   - *(opcional)* **Secret** `APP_SECRET` = qualquer string (se usar, colocar a mesma no app)
   - *(opcional, texto)* `GH_OWNER=lariconstantino`, `GH_REPO=vistoria-seazone`, `GH_BRANCH=main`, `PAGES_BASE=https://lariconstantino.github.io/vistoria-seazone` — já são os defaults, só preencher se mudar algo.
4. Copiar a **URL do Worker** (ex: `https://vistoria-report.SEU-SUBDOMINIO.workers.dev`).

### 4. Plugar no app
- Em `index.html`, preencher:
  ```js
  const REPORT_WORKER_URL = 'https://vistoria-report.SEU-SUBDOMINIO.workers.dev';
  ```
- Publicar o app.

### 5. Testar
- Fazer uma vistoria de ponta a ponta no celular. No resumo deve aparecer **"✅ Relatório registrado — abrir link"**, e o canal **#vistorias-app-teste** recebe a mensagem.

---

## ⚠️ Importante para o deploy do app
Os relatórios são commitados na branch **main** (a mesma do GitHub Pages). **Não** publicar o app com `git push --force` (apagaria os relatórios). Usar:
```
git fetch origin
git rebase origin/main
git push origin master:main      # sem --force
```
