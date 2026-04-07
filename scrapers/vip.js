#!/usr/bin/env node
'use strict';

/**
 * Scraper automático — VIP Leilões
 *
 * Estratégia:
 *  1. GET /canal → obtém cookie __CBCanal (sem Playwright)
 *  2. POST /pesquisa?handler=pesquisar&pageNumber=N → HTML com 12 cards por página
 *  3. Parseia os cards via regex
 *  4. Agrupa por data de início → um leilão por dia (id: vip_YYYY-MM-DD)
 *  5. Upsert no Supabase
 *
 * Secrets necessários no GitHub:
 *   SUPABASE_KEY  — service_role key (ou anon key se RLS permitir)
 */

const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPA_URL   = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY   = process.env.SUPABASE_KEY;
const VIP_HOST   = 'www.vipleiloes.com.br';
const CANAL_PATH = '/canal?returnUrl=%2Fpesquisa%3Fclassificacao%3DMotos';
const SEARCH_PATH = '/pesquisa?handler=pesquisar&pageNumber=';

if (!SUPA_KEY) {
  console.error('❌  SUPABASE_KEY não definido');
  process.exit(1);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpRequest(opts, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      // Collect Set-Cookie headers
      const cookies = res.headers['set-cookie'] || [];
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, cookies, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// Extrai o valor de um cookie por nome
function getCookieValue(cookieHeaders, name) {
  for (const h of cookieHeaders) {
    const m = h.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

// Parseia "Set-Cookie" bruto para string "name=value"
function parseCookies(cookieHeaders) {
  return cookieHeaders
    .map(h => h.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

// ── Supabase REST helper ──────────────────────────────────────────────────────
async function supaFetch(path, opts = {}) {
  const { method = 'GET', body, prefer = 'return=minimal' } = opts;
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey':        SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        prefer,
    },
    body,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Supabase ${method} /${path} → ${res.status}: ${txt}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text || !text.trim()) return null;
  return JSON.parse(text);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function toTitle(str) {
  return (str || '').toLowerCase().replace(/(?:^|\s)\w/g, c => c.toUpperCase()).trim();
}

const MARCA_NORM = {
  'honda': 'Honda', 'yamaha': 'Yamaha', 'kawasaki': 'Kawasaki', 'suzuki': 'Suzuki',
  'bmw': 'BMW', 'ktm': 'KTM', 'ducati': 'Ducati', 'triumph': 'Triumph',
  'harley-davidson': 'Harley-Davidson', 'harley davidson': 'Harley-Davidson',
  'royal enfield': 'Royal Enfield', 'aprilia': 'Aprilia', 'benelli': 'Benelli',
  'cfmoto': 'CFMoto', 'dafra': 'Dafra', 'shineray': 'Shineray', 'bajaj': 'Bajaj',
  'haojue': 'Haojue', 'jtz': 'JTZ', 'mv agusta': 'MV Agusta', 'indian': 'Indian',
  'zero': 'Zero',
};

function normalizarMarca(raw) {
  if (!raw) return null;
  const low = raw.toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(MARCA_NORM, low)) return MARCA_NORM[low];
  return toTitle(raw);
}

// "R$ 3.500,00" → 3500
function parseLance(vlr) {
  if (!vlr) return null;
  const num = parseFloat(vlr.replace(/[R$\s.]/g, '').replace(',', '.'));
  return isNaN(num) || num <= 0 ? null : num;
}

// "DD/MM/YYYY" → "YYYY-MM-DD"
function parseDateBR(str) {
  const m = (str || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

const MESES = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];

function nomeDoMes(dataISO) {
  const dt = new Date(dataISO + 'T00:00:00');
  return `${dt.getDate()}/${MESES[dt.getMonth()]}`;
}

// ── Parse dos cards VIP ───────────────────────────────────────────────────────
// Cada card tem:
//   <h1 class="mb-0">MODELO - YYYY/YYYY</h1>
//   <div class="anc-info"><span>marca</span>...</div>
//   <span class="anc-start">Início:  DD/MM/YYYY</span>
//   <span class="anc-hour">HH:MM</span>
//   Valor inicial: <b>R$ X.XXX,XX</b>
//   <strong>Lote:</strong> N ... <strong>Local:</strong> UF
//   <img src="..." class="card-img-top">
//   href="/evento/anuncio/{slug}"
function parseCards(html) {
  const blocks = html.split('<div class="card card-lel card-anuncio').slice(1);
  const lots = [];

  for (const block of blocks) {
    const g = re => (block.match(re) || [])[1];

    const slug     = g(/href="\/evento\/anuncio\/([^"]+)"/);
    const titleRaw = g(/<h1 class="mb-0">([^<]+)<\/h1>/);
    const brandRaw = g(/<div class="anc-info">\s*<span>([^<]*)<\/span>/);
    const dateStr  = g(/<span class="anc-start">[^0-9]*(\d{2}\/\d{2}\/\d{4})<\/span>/);
    const hora     = g(/<span class="anc-hour">(\d{2}:\d{2})<\/span>/) || '';
    const lanceStr = g(/Valor inicial:\s*<b>([^<]+)<\/b>/);
    const loteStr  = g(/<strong>Lote:<\/strong>\s*(\w+)/);
    const local    = g(/<strong>Local:<\/strong>\s*(\w+)/);
    const foto     = g(/<img[^>]+src="(https:\/\/armazupvipleiloesprd[^"]+)"/) ||
                     g(/<img[^>]*class="card-img-top[^"]*"[^>]*src="([^"]+)"/) ||
                     g(/src="([^"]+\.(?:jpg|jpeg|png|webp))"/i);
    const statusRaw = g(/<span class="situacao[^"]*">([^<]+)<\/span>/);

    if (!slug || !titleRaw || !dateStr) continue;

    const dataISO = parseDateBR(dateStr);
    if (!dataISO) continue;

    // "CB250F TWISTER CBS - 2022/2022" → modelo="CB250F TWISTER CBS", ano="22/22"
    const titleClean = titleRaw.trim();
    const anoMatch   = titleClean.match(/[-\s]+(\d{4}\/\d{4})\s*$/);
    let modelo = titleClean;
    let ano    = null;
    if (anoMatch) {
      modelo = titleClean.slice(0, titleClean.length - anoMatch[0].length).trim();
      const [a, b] = anoMatch[1].split('/');
      ano = `${a.slice(-2)}/${b.slice(-2)}`;
    }
    modelo = toTitle(modelo);

    const marca = normalizarMarca(brandRaw || '');
    const lance = parseLance(lanceStr);

    const encerrado = (statusRaw || '').toLowerCase().includes('encerrado') ||
                      (statusRaw || '').toLowerCase().includes('arrematado');

    lots.push({
      slug, dataISO, hora, modelo, marca, ano, lance,
      lote: loteStr || null, local: local || 'Online', foto,
      url: `https://www.vipleiloes.com.br/evento/anuncio/${slug}`,
      encerrado,
    });
  }

  return lots;
}

// ── Extrai cilindrada (portada do freitas.js) ─────────────────────────────────
function extractCilindrada(marca, modelo) {
  const texto = ((marca || '') + ' ' + (modelo || '')).toUpperCase();
  const FIXOS = {
    'AFRICA TWIN': 1084, 'PAN AMERICA': 1252, 'MULTISTRADA V4': 1158, 'MULTISTRADA': 1103,
    'HIMALAYAN': 411, 'HIMALAYA': 411, 'METEOR 350': 349, 'STREET TRIPLE': 765,
    'BONNEVILLE': 1200, 'TIGER 900': 888, 'TIGER 800': 800, 'SCRAMBLER 1200': 1200,
    'SCRAMBLER 400': 400, 'SPEED 400': 400, 'NINJA ZX-10R': 998, 'NINJA ZX-6R': 636,
    'VERSYS-X 300': 296, 'VERSYS 300': 296, 'VERSYS 650': 649, 'NINJA 1000': 1043,
    'NINJA 650': 649, 'NINJA 400': 399, 'ELIMINATOR 500': 500,
    'V-STROM 650': 645, 'GSX-R1000': 999, 'GSR750': 749, 'GSX-8': 776,
    'INTRUDER 125': 125, 'BURGMAN 650': 638, 'BURGMAN 400': 400,
    'FAZER 250': 249, 'FAZER 150': 150, 'FAZER SED': 150,
    'FACTOR 150': 150, 'LANDER 250': 249, 'XTZ 250': 249,
    'CROSSER 150': 150, 'XTZ 150': 150, 'TENERE 700': 689, 'TENERE 250': 249,
    'XT660': 660, 'XT 660': 660, 'YZF-R15': 155, 'YZF-R3': 321, 'YZF-R6': 599,
    'YZF-R7': 689, 'YZF-R1': 998, 'MT-03': 321, 'MT-07': 689, 'MT-09': 890,
    'NMAX': 155, 'XMAX': 292, 'TMAX': 560, 'YBR 150': 150, 'YBR 125': 125,
    'YS150': 150, 'FZ25': 249, 'FZ15': 150, 'FLUO 125': 125, 'CRYPTON': 115,
    'NEO AT': 113, 'Z400': 399, 'Z650': 649, 'Z900': 948, 'Z1000': 1043,
    'CBR 600': 599, 'CBR 1000': 999, 'CBR 250': 249,
    'CB 500': 471, 'CB 650': 649, 'CB300': 300, 'CB 300': 300,
    'XRE 300': 292, 'XRE 190': 184, 'NC 750': 745, 'SH 300': 279,
    'HORNET': 599, 'TWISTER': 250, 'TORNADO': 230, 'PCX': 160,
    'NXR160': 160, 'BROS 160': 160, 'NXR150': 150, 'BROS 150': 150, 'BROS': 160,
    'CG FAN': 150, 'FAN 150': 150, 'FAN 125': 125,
    'CG TITAN': 160, 'TITAN 160': 160, 'TITAN 150': 150,
    'CG125': 125, 'CG 125': 125, 'CG150': 150, 'CG 150': 150,
    'CG160': 160, 'CG 160': 160,
    'BIZ 125': 125, 'BIZ 110': 110, 'POP 110': 110, 'POP 100': 100,
    'LEAD 110': 110, 'ELITE 125': 125,
    'S1000RR': 999, 'R1300GS': 1300, 'R1250GS': 1254, 'R1200GS': 1170,
    'F850GS': 853, 'F750GS': 853, 'F800': 798, 'G650GS': 652,
    'G310GS': 310, 'G310R': 310, 'G310': 310,
    'DUKE 390': 373, 'DUKE 250': 248, 'ADVENTURE 390': 373,
    'MONSTER 937': 937, 'MONSTER 821': 821,
    'SPORTSTER': 883, 'FAT BOY': 1868, 'ROAD KING': 1745, 'STREET BOB': 1745,
    'XL 1200': 1202, 'XL1200': 1202, 'XL883': 883,
    'SCRAM 411': 411, 'HUNTER 350': 349, 'CLASSIC 350': 349,
    'CARGO': 160,   // CG 160 CARGO
    'START': 160,   // CG 160 START
    'BROS ESD': 160,
  };
  const chaves = Object.keys(FIXOS).sort((a, b) => b.length - a.length);
  for (const key of chaves) {
    const re = new RegExp('(^|[\\s\\-/])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s\\-/0-9]|$)');
    if (re.test(texto)) return FIXOS[key];
  }
  const nums = [...texto.matchAll(/\b(\d{2,4})\b(?!\/)/g)].map(m => +m[1]);
  for (const n of nums) {
    if (n >= 50 && n <= 2500) return n;
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🏍  VIP Leilões — scraper iniciando');
  console.log(`    Supabase: ${SUPA_URL}`);

  // ── 1. Obtém cookie __CBCanal ─────────────────────────────────────────────
  console.log('\n🌐 Obtendo cookie do VIP...');
  const canalRes = await httpRequest({
    hostname: VIP_HOST,
    path: CANAL_PATH,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
  });
  if (canalRes.status !== 200) {
    throw new Error(`Canal retornou HTTP ${canalRes.status}`);
  }
  const cookieStr = parseCookies(canalRes.cookies);
  console.log(`   Cookie: ${cookieStr.slice(0, 60)}...`);

  // ── 2. Busca total de resultados (página 1) ───────────────────────────────
  const POST_BODY = 'Filtro.Classificacao=1&Filtro.OrdenarPor=DataInicio' +
    '&Filtro.SomenteDestaques=False&Filtro.Texto=&Filtro.SelecaoVeiculos=false' +
    '&Filtro.SelecaoOutros=false&Filtro.Financiavel=false';

  const COMMON_HEADERS = {
    'Host': VIP_HOST,
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://www.vipleiloes.com.br/pesquisa?classificacao=Motos',
    'Cookie': cookieStr,
    'Accept': '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'Content-Length': String(Buffer.byteLength(POST_BODY)),
  };

  async function fetchPage(pageNum) {
    const res = await httpRequest({
      hostname: VIP_HOST,
      path: `${SEARCH_PATH}${pageNum}`,
      method: 'POST',
      headers: COMMON_HEADERS,
    }, POST_BODY);
    if (res.status !== 200) throw new Error(`Página ${pageNum} retornou HTTP ${res.status}`);
    return res.body;
  }

  console.log('\n🌐 Buscando página 1 para contar resultados...');
  const page1Html = await fetchPage(1);

  const totalMatch = page1Html.match(/(\d+)\s*resultados?\s*encontrados?/i);
  const total = totalMatch ? parseInt(totalMatch[1]) : 0;
  const totalPages = Math.max(1, Math.ceil(total / 12));
  console.log(`   ${total} lotes encontrados → ${totalPages} páginas`);

  // ── 3. Busca todas as páginas ─────────────────────────────────────────────
  const allLots = [];
  let page1Lots = parseCards(page1Html);
  allLots.push(...page1Lots);
  console.log(`   Página 1: ${page1Lots.length} lotes`);

  for (let pn = 2; pn <= totalPages; pn++) {
    const html = await fetchPage(pn);
    const lots = parseCards(html);
    allLots.push(...lots);
    console.log(`   Página ${pn}: ${lots.length} lotes`);
    // Pequena pausa para não sobrecarregar o servidor
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n   Total parseado: ${allLots.length} lotes`);

  if (allLots.length === 0) {
    console.log('ℹ️  Nenhum lote encontrado. Encerrando.');
    return;
  }

  // ── 4. Debug: imprime primeiro lote ──────────────────────────────────────
  console.log('\n🔍 Primeiro lote (verificação):');
  console.log(JSON.stringify(allLots[0], null, 2));

  // ── 5. Agrupa por data de início ──────────────────────────────────────────
  const hoje = new Date().toISOString().slice(0, 10);
  const leiloesPorData   = {};
  const motosPorLeilao   = {};

  for (const lot of allLots) {
    // Descarta lotes com data muito passada (>3 dias)
    if (lot.dataISO < hoje) {
      const diffDias = (Date.now() - new Date(lot.dataISO + 'T12:00:00').getTime()) / 86_400_000;
      if (diffDias > 3) continue;
    }

    const lid = `vip_${lot.dataISO.replace(/-/g, '')}`;

    if (!leiloesPorData[lid]) {
      leiloesPorData[lid] = {
        id:         lid,
        nome:       `VIP Leilões — ${nomeDoMes(lot.dataISO)}`,
        plataforma: 'VIP Leilões',
        data:       lot.dataISO,
        hora:       lot.hora || '',
        local:      'Online',
        link:       'https://www.vipleiloes.com.br/pesquisa?classificacao=Motos',
        encerrado:  false,
      };
      motosPorLeilao[lid] = [];
    }

    const { marca, modelo, ano, lance, lote, local, foto, url } = lot;
    const cilindrada = extractCilindrada(marca, modelo);
    const monta = cilindrada == null ? null
      : cilindrada <= 150 ? 'pequena'
      : cilindrada <= 500 ? 'media'
      : 'grande';

    motosPorLeilao[lid].push({
      leilao_id:    lid,
      lote,
      marca,
      modelo,
      ano,
      cor:          null,
      condicao:     'financiada',
      lance_inicial: lance,
      financeira:   'Financeira',
      cilindrada,
      monta,
      foto:         foto || null,
      url,
      fipe_csv:     null,
      patio:        local || null,
    });
  }

  const leilaoIds  = Object.keys(leiloesPorData);
  const totalMotos = Object.values(motosPorLeilao).reduce((s, a) => s + a.length, 0);

  console.log(`\n📋 Resumo:`);
  console.log(`   ${leilaoIds.length} leilão(ões)`);
  console.log(`   ${totalMotos} motos válidas`);
  leilaoIds.forEach(lid => {
    const l = leiloesPorData[lid];
    console.log(`   → ${lid}: ${l.nome} (${l.data}) — ${motosPorLeilao[lid].length} motos`);
  });

  if (leilaoIds.length === 0) {
    console.log('ℹ️  Nenhum leilão futuro. Encerrando.');
    return;
  }

  // ── 6. Upsert no Supabase ─────────────────────────────────────────────────
  console.log('\n💾 Salvando no Supabase...');

  for (const lid of leilaoIds) {
    const l = leiloesPorData[lid];
    console.log(`\n  Leilão: ${lid}  (${l.data} ${l.hora})`);

    await supaFetch('leiloes?on_conflict=id', {
      method: 'POST',
      body:   JSON.stringify(l),
      prefer: 'resolution=merge-duplicates,return=minimal',
    });

    const motosExist = await supaFetch(`motos?select=id&leilao_id=eq.${lid}`);
    const idsExist   = (motosExist ?? []).map(m => m.id);

    if (idsExist.length > 0) {
      const comArr    = await supaFetch(`arrematados?select=moto_id&moto_id=in.(${idsExist.join(',')})`);
      const idsComArr = new Set((comArr ?? []).map(a => a.moto_id));
      const deletar   = idsExist.filter(id => !idsComArr.has(id));
      if (deletar.length > 0) {
        const DBATCH = 100;
        for (let i = 0; i < deletar.length; i += DBATCH) {
          await supaFetch(`motos?id=in.(${deletar.slice(i, i + DBATCH).join(',')})`, { method: 'DELETE', prefer: '' });
        }
        console.log(`  → Removeu ${deletar.length} motos antigas`);
      }
    }

    const novas = motosPorLeilao[lid];
    const BATCH = 50;
    for (let i = 0; i < novas.length; i += BATCH) {
      await supaFetch('motos', { method: 'POST', body: JSON.stringify(novas.slice(i, i + BATCH)), prefer: 'return=minimal' });
    }
    console.log(`  → Inseriu ${novas.length} moto(s)`);
  }

  // ── 7. Marca leilões VIP passados como encerrados ─────────────────────────
  const leiloesPast = await supaFetch(
    `leiloes?id=like.vip_*&encerrado=eq.false&data=lt.${hoje}&select=id,data`
  );
  if (leiloesPast && leiloesPast.length > 0) {
    console.log(`\n🔒 Encerrando ${leiloesPast.length} leilão(ões) com data passada...`);
    for (const l of leiloesPast) {
      await supaFetch(`leiloes?id=eq.${l.id}`, {
        method: 'PATCH',
        body:   JSON.stringify({ encerrado: true }),
        prefer: 'return=minimal',
      });
      console.log(`  → ${l.id} (${l.data}) marcado como encerrado`);
    }
  }

  console.log('\n✅ Scraper VIP concluído com sucesso!');
}

main().catch(err => {
  console.error('\n❌ Erro fatal:', err.message);
  process.exit(1);
});
