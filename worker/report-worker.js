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

// Reconhece quais itens da lista aparecem na foto (Claude vision)
async function handleRecognize(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const image = body.image || '';
  // Provedor flexível: Anthropic (padrão) ou MiniMax (endpoint compatível com Anthropic).
  // Configure no Worker: VISION_API_KEY, VISION_BASE_URL, VISION_MODEL.
  const apiKey = env.VISION_API_KEY || env.ANTHROPIC_API_KEY || env.MINIMAX_API_KEY;
  const baseUrl = (env.VISION_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  const model = env.VISION_MODEL || 'claude-haiku-4-5-20251001';
  if (!apiKey) return json({ recognized: [], disabled: true });
  if (!image || !candidates.length) return json({ recognized: [] });

  // separa media_type + base64 do dataURL
  const mt = (image.match(/^data:(image\/[a-zA-Z]+);base64,/) || [])[1] || 'image/jpeg';
  const b64 = image.replace(/^data:image\/[a-zA-Z]+;base64,/, '');

  const prompt = `Você analisa a foto de um ambiente numa vistoria de imóvel. Quais destes itens aparecem CLARAMENTE na imagem?\n\nItens possíveis:\n${candidates.map(c => '- ' + c).join('\n')}\n\nResponda APENAS com JSON válido: {"itens":["Nome exato da lista", ...]}. Use exatamente os nomes da lista acima. Não inclua itens que não estão visíveis. Se não tiver certeza de um item, não inclua.`;

  try {
    const r = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        // x-api-key (Anthropic) + Bearer (MiniMax e afins) — o provedor usa o que reconhece
        'x-api-key': apiKey,
        'authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mt, data: b64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    if (!r.ok) { const t = await r.text(); return json({ recognized: [], error: 'anthropic_' + r.status, detail: t.slice(0, 200) }); }
    const data = await r.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    const m = text.match(/\{[\s\S]*\}/);
    let itens = [];
    if (m) { try { itens = (JSON.parse(m[0]).itens) || []; } catch {} }
    // só aceita nomes que estão exatamente na lista de candidatos
    const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const set = new Map(candidates.map(c => [norm(c), c]));
    const recognized = [...new Set(itens.map(i => set.get(norm(i))).filter(Boolean))];
    return json({ recognized });
  } catch (e) {
    return json({ recognized: [], error: 'fetch_failed' });
  }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

    // proteção opcional contra abuso casual
    if (env.APP_SECRET && req.headers.get('X-App-Secret') !== env.APP_SECRET) {
      return json({ error: 'unauthorized' }, 401);
    }

    // rota de reconhecimento de itens na foto
    if (new URL(req.url).pathname.replace(/\/$/, '').endsWith('/recognize')) {
      return await handleRecognize(req, env);
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
