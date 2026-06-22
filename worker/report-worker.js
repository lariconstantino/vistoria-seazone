/**
 * Cloudflare Worker — recebe o relatório de vistoria do PWA, grava o HTML no
 * GitHub (/relatorios) e posta no Slack #vistorias-app-teste.
 *
 * Segredos (configurar em Cloudflare → Worker → Settings → Variables, como "Secret"):
 *   GITHUB_TOKEN   token fine-grained com Contents: Read and write no repo vistoria-seazone
 *   SLACK_WEBHOOK  incoming webhook do canal #vistorias-app-teste
 *   APP_SECRET     (opcional) string compartilhada com o app pra evitar abuso casual
 *
 * Variáveis (texto normal, podem ficar à vista):
 *   GH_OWNER  = lariconstantino
 *   GH_REPO   = vistoria-seazone
 *   GH_BRANCH = main
 *   PAGES_BASE= https://lariconstantino.github.io/vistoria-seazone
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// sanitiza pra nome de arquivo seguro
function slug(s) {
  return String(s || 'imovel')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'imovel';
}

// base64 de string UTF-8 (btoa não lida com acentos direto)
function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

    // proteção opcional contra abuso casual
    if (env.APP_SECRET && req.headers.get('X-App-Secret') !== env.APP_SECRET) {
      return json({ error: 'unauthorized' }, 401);
    }

    let payload;
    try { payload = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }

    const code = slug(payload.code);
    const html = payload.html;
    if (!html || typeof html !== 'string') return json({ error: 'html ausente' }, 400);

    const owner = env.GH_OWNER || 'lariconstantino';
    const repo = env.GH_REPO || 'vistoria-seazone';
    const branch = env.GH_BRANCH || 'main';
    const pagesBase = (env.PAGES_BASE || `https://${owner}.github.io/${repo}`).replace(/\/$/, '');

    // nome único: CODIGO-AAAA-MM-DD-HHMM-rand.html (UTC)
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
    const rand = Math.random().toString(36).slice(2, 6);
    const filename = `${code}-${stamp}-${rand}.html`;
    const path = `relatorios/${filename}`;
    const link = `${pagesBase}/${path}`;

    // 1) commit no GitHub
    const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'vistoria-report-worker',
      },
      body: JSON.stringify({
        message: `relatorio: ${code} (${stamp})`,
        content: toBase64Utf8(html),
        branch,
      }),
    });

    if (!ghRes.ok) {
      const detail = await ghRes.text();
      return json({ error: 'github_failed', status: ghRes.status, detail: detail.slice(0, 300) }, 502);
    }

    // 2) avisa o Slack (não bloqueia o sucesso se falhar)
    let slackOk = false;
    if (env.SLACK_WEBHOOK) {
      try {
        const sr = await fetch(env.SLACK_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `:white_check_mark: Vistoria *${code}* concluída — relatório: ${link}` }),
        });
        slackOk = sr.ok;
      } catch { /* ignora */ }
    }

    return json({ ok: true, url: link, slack: slackOk });
  },
};
