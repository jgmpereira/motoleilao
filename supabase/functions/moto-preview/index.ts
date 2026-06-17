// Edge Function: moto-preview
// Página pública de uma moto para compartilhar (ex: WhatsApp).
// - Bots de redes sociais (WhatsApp, Facebook, Telegram...) recebem HTML com meta tags og: (preview).
// - Pessoas recebem uma página simples com foto + modelo + botão "Assinar".
// Mostra apenas foto + modelo (sem preço), conforme definido.

const SUPA_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SITE = 'https://motoleiloes.com.br';

function esc(s: string): string {
  return (s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (!id || !/^\d+$/.test(id)) {
    return Response.redirect(SITE, 302);
  }

  // Busca a moto (apenas campos públicos da prévia)
  let moto: { id: number; marca: string; modelo: string; ano: string; foto: string | null } | null = null;
  try {
    const res = await fetch(
      `${SUPA_URL}/rest/v1/motos?id=eq.${id}&select=id,marca,modelo,ano,foto&limit=1`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } },
    );
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length) moto = rows[0];
  } catch (_) { /* ignora — cai no fallback */ }

  // Moto não encontrada → manda pro site
  if (!moto) {
    return new Response('', { status: 302, headers: { 'Location': SITE } });
  }

  const titulo = `${moto.marca} ${moto.modelo}`.trim();
  const anoTxt = moto.ano ? ` ${moto.ano}` : '';
  const ogTitle = `${titulo}${anoTxt} — veja na MotoLeilão`;
  const ogDesc = 'Encontre motos em leilão abaixo da FIPE. Veja esta e centenas de outras no MotoLeilão.';
  const foto = moto.foto || `${SITE}/og-default.png`;
  const linkSite = `${SITE}/#moto-${moto.id}`;
  const ogUrl = `${SUPA_URL}/functions/v1/moto-preview?id=${moto.id}`;

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(ogTitle)}</title>
<meta name="description" content="${esc(ogDesc)}">

<!-- Open Graph (WhatsApp, Facebook, Telegram) -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="MotoLeilão">
<meta property="og:title" content="${esc(ogTitle)}">
<meta property="og:description" content="${esc(ogDesc)}">
<meta property="og:image" content="${esc(foto)}">
<meta property="og:url" content="${esc(ogUrl)}">
<meta property="og:locale" content="pt_BR">

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(ogTitle)}">
<meta name="twitter:description" content="${esc(ogDesc)}">
<meta name="twitter:image" content="${esc(foto)}">

<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'DM Sans',sans-serif;background:#111318;color:#e8eaed;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px;}
  .nav{display:flex;align-items:center;gap:8px;margin-bottom:28px;}
  .nav-icon{width:32px;height:32px;background:#ff4d00;clip-path:polygon(20% 0%,80% 0%,100% 20%,100% 80%,80% 100%,20% 100%,0% 80%,0% 20%);display:flex;align-items:center;justify-content:center;font-size:15px;}
  .nav-text{font-family:'Bebas Neue',sans-serif;font-size:24px;letter-spacing:3px;}
  .nav-text span{color:#ff4d00;}
  .card{background:#1c1f27;border:1px solid rgba(255,255,255,.08);border-radius:18px;overflow:hidden;max-width:420px;width:100%;box-shadow:0 16px 48px rgba(0,0,0,.4);}
  .card-img{width:100%;aspect-ratio:4/3;object-fit:cover;background:#0e1015;display:block;}
  .card-img-fallback{width:100%;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;font-size:64px;background:#0e1015;}
  .card-body{padding:24px;}
  .card-tag{display:inline-block;background:rgba(255,77,0,.12);border:1px solid rgba(255,77,0,.25);color:#ff4d00;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:4px 12px;border-radius:20px;margin-bottom:14px;}
  .card-title{font-size:22px;font-weight:700;line-height:1.25;margin-bottom:8px;}
  .card-sub{font-size:14px;color:#8a93a8;margin-bottom:24px;line-height:1.5;}
  .btn{display:block;text-align:center;background:#ff4d00;color:#fff;text-decoration:none;font-size:15px;font-weight:700;padding:15px;border-radius:10px;transition:background .2s;}
  .btn:hover{background:#e04000;}
  .btn-ghost{display:block;text-align:center;color:#8a93a8;text-decoration:none;font-size:13px;padding:12px;margin-top:6px;}
  .foot{margin-top:24px;font-size:12px;color:#3a4050;text-align:center;}
</style>
</head>
<body>
  <div class="nav">
    <div class="nav-icon">🏍</div>
    <div class="nav-text">MOTO<span>LEILÃO</span></div>
  </div>
  <div class="card">
    ${moto.foto
      ? `<img class="card-img" src="${esc(moto.foto)}" alt="${esc(titulo)}" onerror="this.outerHTML='<div class=\\'card-img-fallback\\'>🏍️</div>'">`
      : `<div class="card-img-fallback">🏍️</div>`}
    <div class="card-body">
      <span class="card-tag">Moto em leilão</span>
      <div class="card-title">${esc(titulo)}${esc(anoTxt)}</div>
      <div class="card-sub">Veja esta moto e centenas de outras em leilão — compare com a tabela FIPE e ache o melhor negócio.</div>
      <a class="btn" href="${SITE}">Ver na MotoLeilão →</a>
      <a class="btn-ghost" href="${esc(linkSite)}">Já sou assinante</a>
    </div>
  </div>
  <div class="foot">© MotoLeilão — Monitor de leilões de motos</div>
</body>
</html>`;

  return new Response(new TextEncoder().encode(html), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
});
