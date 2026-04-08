#!/usr/bin/env node
'use strict';

/**
 * Scraper automático — Sodré Santoro
 *
 * Estratégia:
 *  1. Abre a listagem de motos com Playwright (Chrome headless)
 *  2. Intercepta as chamadas JSON que o Vue.js faz ao backend
 *  3. Parseia os lotes e agrupa por leilão
 *  4. Upsert no Supabase (mesmo esquema do index.html)
 *
 * Secrets necessários no GitHub:
 *   SUPABASE_URL  — ex: https://xxx.supabase.co
 *   SUPABASE_KEY  — service_role key (ou anon key se RLS permitir)
 */

const { chromium } = require('playwright');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPA_URL = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY  = process.env.SUPABASE_KEY;
// Diagnóstico — imprime antes de qualquer coisa para ver o valor real
console.log(`🔧 SUPABASE_URL env raw : "${process.env.SUPABASE_URL ?? '(não definido)'}"`);
console.log(`🔧 SUPA_URL final       : "${SUPA_URL}"`);
const SODRE_URL = 'https://www.sodresantoro.com.br/veiculos/lotes?lot_category=motos&sort=auction_date_init_asc';
// Quantos lotes esperar no máximo; aumentar se o site tiver paginação com load-more
const MAX_SCROLL_ROUNDS = 50;

if (!SUPA_KEY) {
  console.error('❌  SUPABASE_KEY não definido');
  process.exit(1);
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

// ── Utilities (portadas do index.html) ───────────────────────────────────────
function toTitle(str) {
  return (str || '').toLowerCase().replace(/(?:^|\s)\w/g, c => c.toUpperCase()).trim();
}

const MARCA_NORM = {
  'honda/cg': 'Honda', 'honda/cg150': 'Honda', 'honda/cb': 'Honda',
  'honda/pcx': 'Honda', 'honda/nxr': 'Honda', 'honda/xre': 'Honda',
  'honda/biz': 'Honda', 'honda/pop': 'Honda', 'honda/lead': 'Honda',
  'yamaha/factor': 'Yamaha', 'yamaha/ybr': 'Yamaha', 'yamaha/fazer': 'Yamaha',
  'yamaha/yzf': 'Yamaha', 'yamaha/mt': 'Yamaha', 'yamaha/xtz': 'Yamaha',
  'shineray/xy': 'Shineray', 'shineray': 'Shineray',
  'suzuki/en125': 'Suzuki', 'suzuki/en': 'Suzuki',
  'i/kawasaki': 'Kawasaki', 'i/bmw': 'BMW', 'i/ducati': 'Ducati',
  'i/triumph': 'Triumph', 'i/harley-davidson': 'Harley-Davidson',
  'i/royal enfield': 'Royal Enfield', 'i/yamaha': 'Yamaha', 'i/honda': 'Honda',
  'i/suzuki': 'Suzuki', 'i/ktm': 'KTM', 'i/aprilia': 'Aprilia',
  'i/benelli': 'Benelli', 'i/cfmoto': 'CFMoto', 'i': null,
  'bmw': 'BMW', 'ktm': 'KTM', 'harley-davidson': 'Harley-Davidson',
  'harley davidson': 'Harley-Davidson', 'royal enfield': 'Royal Enfield',
  'jtz': 'JTZ', 'veiculo': null, 'veículo': null, 'moto': null,
  'motocicleta': null, 'sucata': null, '—': null, '-': null, '': null,
};

function normalizarMarca(marca) {
  if (!marca) return null;
  const low = marca.toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(MARCA_NORM, low)) return MARCA_NORM[low];
  if (low.includes('/')) {
    const [prefix] = low.split('/');
    if (Object.prototype.hasOwnProperty.call(MARCA_NORM, prefix)) return MARCA_NORM[prefix];
    if (prefix === 'i') return null;
    return prefix.charAt(0).toUpperCase() + prefix.slice(1);
  }
  if (['veiculo', 'veículo', 'moto', 'motocicleta', '-', '—'].includes(low)) return null;
  return marca.trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Whitelist de marcas de moto — rejeita carros que escapem do filtro da busca
const MARCAS_MOTO = new Set([
  'Honda','Yamaha','Kawasaki','Suzuki','BMW','KTM','Ducati','Triumph',
  'Harley-Davidson','Royal Enfield','Aprilia','Benelli','CFMoto','Dafra',
  'Shineray','Bajaj','Haojue','JTZ','MV Agusta','Indian','Zero',
  'Sundown','Hero','Moto Guzzi','Norton','Husqvarna','Gas Gas','Traxx',
  'Kasinski','Kymco','Sym','Lifan','Loncin','Zongshen','Buell','Can-Am',
  'Star','Vmoto','Super Soco','Energica',
]);
function isMoto(marca) { return !!marca && MARCAS_MOTO.has(marca); }

function extractCilindrada(marca, modelo) {
  const texto = ((marca || '') + ' ' + (modelo || '')).toUpperCase();
  // Mapa portado do index.html — keys maiores primeiro para evitar match parcial
  const FIXOS = {
    'AFRICA TWIN': 1084, 'AFRICA-TWIN': 1084, 'PAN AMERICA': 1252,
    'MULTISTRADA V4': 1158, 'MTS V4': 1158, 'MULTISTRADA': 1103,
    'ROYAL ENFIELD HIMALAYAN': 411, 'HIMALAYAN': 411, 'METEOR 350': 349,
    'STREET TRIPLE': 765, 'TIGER EXPLORER': 1215, 'BONNEVILLE': 1200,
    'TIGER 900': 888, 'TIGER 800': 800,
    'NINJA ZX-10R': 998, 'NINJA ZX-6R': 636,
    'VERSYS-X 300': 296, 'VERSYS X 300': 296, 'VERSYS 300': 296,
    'VERSYS 650': 649, 'NINJA 1000': 1043, 'NINJA 650': 649, 'NINJA 400': 399,
    'ELIMINATOR 500': 500,
    'V-STROM 650': 645, 'V-STROM650': 645,
    'GSX-R1000': 999, 'GSR750': 749,
    'INTRUDER 125': 125, 'INTRUDER125': 125,
    'BURGMAN 650': 638, 'BURGMAN 400': 400,
    'FAZER 250': 249, 'FAZER250': 249, 'FAZER 150': 150, 'FAZER150': 150,
    'FACTOR 150': 150, 'FACTOR150': 150,
    'LANDER 250': 249, 'XTZ 250': 249, 'XTZ250': 249,
    'CROSSER 150': 150, 'CROSSER150': 150, 'XTZ 150': 150, 'XTZ150': 150,
    'YZF-R15': 155, 'YZF R15': 155,
    'YZF-R3': 321, 'YZF R3': 321,
    'YZF-R6': 599, 'YZF R6': 599,
    'YZF-R7': 689, 'YZF R7': 689,
    'YZF-R1': 998, 'YZF R1': 998,
    'MT-03': 321, 'MT03': 321, 'MT 03': 321,
    'MT-07': 689, 'MT07': 689,
    'MT-09': 890, 'MT09': 890,
    'Z400': 399, 'Z650': 649, 'Z 650': 649,
    'Z900': 948, 'Z 900': 948, 'Z1000': 1043, 'Z 1000': 1043,
    'CBR 600': 599, 'CBR600': 599,
    'CBR 1000': 999, 'CBR1000': 999,
    'CBR 250': 249, 'CBR250': 249,
    'CB 500': 471, 'CB500': 471,
    'CB 650': 649, 'CB650': 649,
    'XRE 300': 292, 'XRE300': 292,
    'XRE 190': 184, 'XRE190': 184,
    'NC 750': 745, 'NC750': 745,
    'SH 300': 279, 'SH300': 279,
    'HORNET': 599,
    'PCX': 160, 'NMAX': 155, 'N-MAX': 155, 'XMAX': 292, 'X-MAX': 292,
    'TMAX': 560, 'T-MAX': 560,
    'BIZ 125': 125, 'BIZ125': 125, 'BIZ 110': 110, 'BIZ110': 110,
    'POP 110': 110, 'POP110': 110, 'POP 100': 100, 'POP100': 100,
    'LEAD 110': 110, 'LEAD110': 110,
    'S1000RR': 999, 'S1000 RR': 999, 'S1000XR': 999,
    'R1300GS': 1300, 'R1250GS': 1254, 'R1200GS': 1170,
    'F850': 853, 'F 850': 853, 'F750GS': 853, 'F750': 853, 'F 750': 853,
    'F800': 798, 'F 800': 798,
    'G650GS': 652, 'G 650': 652,
    'DUKE 990': 999, 'DUKE 390': 373, 'DUKE 250': 248,
    '990 SUPER DUKE': 999,
    'MONSTER 937': 937, 'MONSTER 821': 821, 'SCRAMBLER': 803,
    'SPORTSTER': 883, 'FAT BOY': 1868, 'FATBOY': 1868,
    'ROAD KING': 1745, 'STREET BOB': 1745, 'VRSC': 1131,
    'XL 1200': 1202, 'XL1200': 1202, 'XL883': 883,
    'YBR 150': 150, 'YBR150': 150, 'YBR 125': 125, 'YBR125': 125,
    'FZ25': 249, 'FZ 25': 249, 'FZ15': 150, 'FZ 15': 150,
    'CRYPTON': 115, 'XJ6': 600, 'R15': 155, 'R3': 321,
    'R6': 599, 'R7': 689,
  };
  const chaves = Object.keys(FIXOS).sort((a, b) => b.length - a.length);
  for (const key of chaves) {
    const re = new RegExp('(^|[\\s\\-/])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s\\-/0-9]|$)');
    if (re.test(texto)) return FIXOS[key];
  }
  // Fallback numérico (50–2500, não seguido de "/" que indicaria ano)
  const nums = [...texto.matchAll(/\b(\d{2,4})\b(?!\/)/g)].map(m => +m[1]);
  for (const n of nums) {
    if (n >= 50 && n <= 2500) return n;
  }
  return null;
}

// ── Leilão helpers ────────────────────────────────────────────────────────────
const MESES = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];

function gerarLeilaoId(dataISO) {
  return 'sodre_' + dataISO.replace(/-/g, '_');
}

function gerarLeilaoObj(dataISO, hora, link) {
  const dt  = new Date(dataISO + 'T00:00:00');
  const dia = dt.getDate();
  const mes = MESES[dt.getMonth()];
  return {
    id:         gerarLeilaoId(dataISO),
    nome:       `Sodré Santoro — ${dia}/${mes}`,
    plataforma: 'Sodré Santoro',
    data:       dataISO,
    hora:       hora || '',
    local:      'Online',
    link:       link || '',
    encerrado:  false,
  };
}

// ── Parsear descrição do lote ─────────────────────────────────────────────────
// Input:  "Honda Cg 160 Fan 22/22", "Sucata - Yamaha Fazer 250 20/21"
// Output: { marca, modelo, ano, cor, condicaoExtra }
function parseLoteDescricao(desc) {
  let texto = (desc || '').trim();
  if (!texto) return null;

  // Extrai prefixo de condição
  let condicaoExtra = null;
  const prefM = texto.match(/^(sucata|sinistro|financiado|financiada)\s*[-–]\s*/i);
  if (prefM) { condicaoExtra = prefM[1].toLowerCase(); texto = texto.slice(prefM[0].length).trim(); }

  // Extrai ano (XX/XX ou XXXX/XXXX)
  const anoM = texto.match(/(\d{2,4}\/\d{2,4})\s*$/);
  if (!anoM) return null;
  const ano = anoM[1].replace(/\d{4}/g, m => m.slice(2));   // normaliza para AA/AA
  let semAno = texto.slice(0, texto.lastIndexOf(anoM[0])).trim();

  // Extrai cor
  const COR_RE = /\b(preta|branca|vermelha|azul|cinza|prata|amarela|verde|rosa|laranja|roxa|marrom|grafite|titanio|titânio|bege|dourada|vinho|lilás)\b/i;
  const corM = semAno.match(COR_RE);
  const cor = corM ? toTitle(corM[1]) : null;
  if (corM) semAno = semAno.replace(corM[0], '').replace(/\s+/g, ' ').trim();

  const palavras = semAno.split(/\s+/).filter(Boolean);
  if (palavras.length < 2) return null;

  const marcaRaw = toTitle(palavras[0]);
  const marca    = normalizarMarca(marcaRaw) || marcaRaw;
  const modelo   = toTitle(palavras.slice(1).join(' '));
  if (!marca || !modelo) return null;

  return { marca, modelo, ano, cor, condicaoExtra };
}

// ── Mapear condição ───────────────────────────────────────────────────────────
function mapCondicao(condicaoTexto, condicaoExtra) {
  const t = (condicaoTexto || '').toLowerCase();
  if (t.includes('sucata') || condicaoExtra === 'sucata') return 'sucata';
  if (t.includes('sinistro') || t.includes('colisão') || t.includes('roubo') ||
      t.includes('furto') || t.includes('incêndio') || t.includes('granizo') ||
      t.includes('alagamento') || condicaoExtra === 'sinistro') return 'sinistro';
  return 'financiada';
}

// ── Extrai dados estruturados de um objeto de lote cru ────────────────────────
// Campos confirmados pela API real do Sodré Santoro:
//   lot_title, lot_brand, lot_model, lot_year_model, auction_date_init,
//   lot_category, lot_sinister, lot_location, bid_initial,
//   lot_number, auction_id, auction_name, lot_id
function extractLotData(lot) {
  // Data do leilão — "2026-03-30 09:30:00" (horário de SP, sem fuso)
  const dateRaw = String(lot.auction_date_init ?? lot.auction_date ?? lot.start_date ?? '').trim();
  let dataISO = null, hora = '';
  if (dateRaw) {
    dataISO = dateRaw.slice(0, 10);   // "2026-03-30"
    hora    = dateRaw.slice(11, 16);  // "09:30"
    if (isNaN(new Date(dataISO))) dataISO = null;
  }

  // Número do lote — "0015" → "15"
  const loteNum = String(lot.lot_number ?? lot.numero_lote ?? lot.lote ?? '').replace(/^0+/, '') || null;

  // Marca e modelo — campos separados confirmados
  const marcaRaw  = String(lot.lot_brand  ?? lot.brand  ?? '').trim();
  const modeloRaw = String(lot.lot_model  ?? lot.model  ?? '').trim().replace(/ipva\d{4}/gi, '').trim();
  const marca  = marcaRaw  ? (normalizarMarca(marcaRaw)  || toTitle(marcaRaw))  : null;
  const modelo = modeloRaw ? toTitle(modeloRaw) : null;

  // Ano — lot_year_model: 2024 → "24/24"
  const anoNum = lot.lot_year_model ?? lot.year_model ?? null;
  let ano = null;
  if (anoNum) {
    const y = String(anoNum).slice(-2);
    ano = `${y}/${y}`;
  }

  // Lance inicial — bid_initial: "0.00"
  const lanceRaw = parseFloat(lot.bid_initial ?? lot.start_value ?? lot.lance_inicial ?? lot.initial_bid ?? 0);
  const lance = lanceRaw > 0 ? lanceRaw : null;

  // Monta — lot_sinister: "média monta" (classificação por porte)
  let monta = null;
  const sinisterRaw = String(lot.lot_sinister ?? '').toLowerCase();
  if      (sinisterRaw.includes('pequena'))                          monta = 'pequena';
  else if (sinisterRaw.includes('média') || sinisterRaw.includes('media')) monta = 'media';
  else if (sinisterRaw.includes('grande'))                           monta = 'grande';

  // Condição — inferida do título e outros campos
  const titleLow = String(lot.lot_title ?? lot.lot_brand ?? '').toLowerCase();
  let condicao = 'financiada';
  if (titleLow.includes('sucata')) condicao = 'sucata';
  else if (titleLow.includes('sinistro') || titleLow.includes('colisão') ||
           titleLow.includes('roubo')    || titleLow.includes('furto'))   condicao = 'sinistro';

  // Financeira — auction_name: "BANCO, SEGURADORAS, ETC"
  const auctionName = String(lot.auction_name ?? '').toLowerCase();
  let financeira = 'Particular/Empresa';
  if (auctionName.includes('segur'))                       financeira = 'Seguradora';
  else if (auctionName.includes('banco') || auctionName.includes('financ') ||
           auctionName.includes('bv ')   || auctionName.includes('itau')   ||
           auctionName.includes('bradesco') || auctionName.includes('santander') ||
           auctionName.includes('porto'))                  financeira = 'Financeira';

  // Pátio — lot_location: "guarulhos iii/sp"
  const patio = String(lot.lot_location ?? lot.location ?? '').trim() || null;

  // Link do leilão — auction_id: 28242
  const leilaoLink = (lot.auction_id && lot.lot_id)
    ? `https://leilao.sodresantoro.com.br/leilao/${lot.auction_id}/lote/${lot.lot_id}/`
    : '';
  return { dataISO, hora, leilaoLink, loteNum, marca, modelo, ano, monta, lance, condicao, financeira, patio };
}

// ── Detecta se resposta API contém array de lotes ─────────────────────────────
// Campos que só existem em lotes reais (não em categorias/segmentos)
const LOT_FIELDS = ['lot_number','lot_brand','lot_id','bid_initial','lot_year_model',
  'auction_date_init','auction_date','start_date','start_value','lance_inicial',
  'initial_bid','vehicle_name','vehicle_description','slug'];

function pareceArrayDeLotes(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const sample = arr[0];
  // Rejeita explicitamente objetos de categoria/segmento
  if (sample.categories || sample.segments || sample.subcategories) return false;
  // Aceita se o primeiro item tiver pelo menos um campo típico de lote
  return LOT_FIELDS.some(f => sample[f] != null);
}

function extrairLotesDeResposta(json) {
  if (pareceArrayDeLotes(json)) return json;
  for (const key of ['data', 'lots', 'lotes', 'items', 'results', 'vehicles', 'veiculos']) {
    if (pareceArrayDeLotes(json[key])) return json[key];
  }
  return null;
}

// ── Detecta se um lote é de moto ─────────────────────────────────────────────
const MARCAS_MOTO = new Set(['honda','yamaha','kawasaki','suzuki','bmw','harley','ducati',
  'triumph','ktm','royal enfield','dafra','shineray','bajaj','haojue','jtz','cfmoto',
  'benelli','aprilia','mv agusta','indian','zero']);

function isMoto(lot) {
  // lot_category é o campo confirmado da API do Sodré
  const cat = String(lot.lot_category ?? lot.category ?? lot.categoria ?? '').toLowerCase();
  if (cat === 'motos' || cat === 'moto' || cat.includes('moto')) return true;
  if (cat && cat !== 'veiculo' && cat !== 'vehicle') return false;
  // Fallback para lotes vindos do DOM scraping
  const desc = String(lot.lot_title ?? lot.title ?? lot.description ?? lot.name ?? '').toLowerCase();
  if (MARCAS_MOTO.has(desc.split(' ')[0])) return true;
  return true; // já filtramos lot_category=motos na URL
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🏍  Sodré Santoro — scraper iniciando');
  console.log(`    URL: ${SODRE_URL}`);
  console.log(`    Supabase: ${SUPA_URL}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    userAgent:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport:   { width: 1280, height: 900 },
    locale:     'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
  });

  // Remove flag webdriver
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  // Intercepta todas as respostas JSON
  const capturedLots = [];
  context.on('response', async (response) => {
    const url = response.url();
    const ct  = response.headers()['content-type'] ?? '';
    if (!ct.includes('application/json')) return;
    // Loga TODAS as chamadas JSON do domínio para descobrir a URL correta dos lotes
    if (!url.includes('sodresantoro')) return;
    if (/\.(js|css|woff|png|jpg)/.test(url)) return;

    try {
      const json = await response.json();
      const lots = extrairLotesDeResposta(json);
      if (lots && lots.length > 0) {
        console.log(`  📡 LOTES [${response.status()}] ${url} → ${lots.length} itens`);
        capturedLots.push(...lots);
      } else {
        // Log de todas as outras chamadas para descobrir onde ficam os lotes
        console.log(`  📡 JSON  [${response.status()}] ${url} — não são lotes: ${JSON.stringify(json).slice(0, 200)}`);
      }
    } catch {
      // body não é JSON puro — ignora
    }
  });

  const page = await context.newPage();

  try {
    // ── 1. Navega até a listagem ──────────────────────────────────────────────
    console.log('\n🌐 Navegando para a listagem...');
    const navResp = await page.goto(SODRE_URL, {
      waitUntil: 'domcontentloaded',
      timeout:   90_000,
    });
    console.log(`   Status HTTP: ${navResp?.status()}`);

    if (navResp?.status() === 403) {
      console.error('❌  Bloqueado pelo CDN (403). O site pode estar com proteção extra.');
    }

    // Aguarda a SPA renderizar (networkidle às vezes trava em SPAs com polling)
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(3_000);

    // — 2. Navega pelas páginas para carregar todos os lotes
  let pageNum = 1;
  while (true) {
    if (pageNum > 1) {
      const pageUrl = SODRE_URL + '&page=' + pageNum;
      console.log(`  Navegando para página ${pageNum}: ${pageUrl}`);
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
      await page.waitForTimeout(3_000);
    }
    const beforeCount = capturedLots.length;
    await page.waitForTimeout(2_000);
    console.log(`  Página ${pageNum}: ${capturedLots.length} lotes acumulados`);
    if (capturedLots.length === beforeCount && pageNum > 1) {
      console.log(`  Página ${pageNum}: sem novos lotes, encerrando.`);
      break;
    }
    const nextBtn = page.locator('a[aria-label="Next"], [class*="next"]:not([disabled])').first();
    const hasNext = await nextBtn.isVisible({ timeout: 2_000 }).catch(() => false);
    if (!hasNext) { console.log('  Sem próxima página, encerrando.'); break; }
    pageNum++;
  }

    console.log(`\n📊 Total lotes via API: ${capturedLots.length}`);
    if (capturedLots.length > 0) {
      console.log('\n🔍 JSON do primeiro lote (para debug de campos):');
      console.log(JSON.stringify(capturedLots[0], null, 2));
      console.log('─────────────────────────────────────────────\n');
    }

    // ── 3. Fallback: DOM scraping ─────────────────────────────────────────────
    if (capturedLots.length === 0) {
      console.log('⚠️  Nenhum dado via API. Tentando extrair texto da página...');

      // Salva screenshot para diagnóstico
      await page.screenshot({ path: 'sodre-debug.png', fullPage: false });
      console.log('   📸 Screenshot: sodre-debug.png');

      // Coleta todo texto visível da página
      const pageText = await page.evaluate(() => {
        // Remove scripts/styles do clone para limpar o texto
        const clone = document.body.cloneNode(true);
        clone.querySelectorAll('script,style,noscript').forEach(el => el.remove());
        return clone.innerText;
      });

      console.log('\n── Texto da página (primeiros 2000 chars) ──');
      console.log(pageText.slice(0, 2_000));
      console.log('────────────────────────────────────────────\n');

      // Tenta extrair lotes da estrutura DOM
      const domLots = await extractLotsFromDOM(page);
      if (domLots.length > 0) {
        console.log(`   DOM scraping encontrou ${domLots.length} lotes`);
        capturedLots.push(...domLots);
      }
    }

    if (capturedLots.length === 0) {
      console.log('ℹ️  Nenhum lote encontrado. Encerrando sem salvar.');
      return;
    }

    // ── 4. Processa e agrupa por leilão ───────────────────────────────────────
    console.log('\n🔧 Processando lotes...');
    const leiloesPorId  = {};
    const motosPorLeilao = {};
    let skipped = 0;

    // Deduplica por lote (a API pode retornar o mesmo lote em múltiplas páginas)
    const lotesSeen = new Set();

    for (const lot of capturedLots) {
      if (!isMoto(lot)) continue;

      const { dataISO, hora, leilaoLink, loteNum, marca, modelo, ano, monta: montaAPI,
              lance, condicao, financeira, patio } = extractLotData(lot);

      if (!dataISO || !marca || !modelo) {
        console.log(`   ⚠️  Incompleto: marca="${marca}" modelo="${modelo}" data="${dataISO}"`);
        skipped++;
        continue;
      }

      // Filtra datas passadas (leilões já encerrados)
      const hoje = new Date().toISOString().slice(0, 10);
      if (dataISO < hoje) {
        const diffDias = (Date.now() - new Date(dataISO + 'T12:00:00').getTime()) / 86_400_000;
        if (diffDias > 3) continue;
      }

      const dedupeKey = `${dataISO}|${loteNum}|${lot.lot_id ?? marca + modelo}`;
      if (lotesSeen.has(dedupeKey)) continue;
      lotesSeen.add(dedupeKey);

      const lid = gerarLeilaoId(dataISO);
      if (!leiloesPorId[lid]) {
        leiloesPorId[lid]   = gerarLeilaoObj(dataISO, hora, leilaoLink);
        motosPorLeilao[lid] = [];
      }

      if (!isMoto(marca)) { console.log(`  ⚠️  ignorado (não é moto): ${marca} ${modelo}`); continue; }
      const cilindrada = extractCilindrada(marca, modelo);
      // Usa monta da API se disponível; senão deriva da cilindrada
      const monta = montaAPI ?? (cilindrada == null ? null : cilindrada <= 200 ? 'pequena' : cilindrada <= 500 ? 'media' : 'grande');

      motosPorLeilao[lid].push({
        leilao_id:    lid,
        lote:         loteNum,
        marca,
        modelo,
        ano,
        cor:          null,  // Sodré não fornece cor na API
        condicao,
        lance_inicial: lance,
        financeira,
        patio:        patio || null,
        cilindrada,
        monta,
        fipe_csv:     null,
       url:           (lot.auction_id && lot.lot_id) ? `https://leilao.sodresantoro.com.br/leilao/${lot.auction_id}/lote/${lot.lot_id}/` : null,
      foto:          (lot.lot_pictures && lot.lot_pictures[0]) ? lot.lot_pictures[0] : null,
      });
    }

    const leilaoIds = Object.keys(leiloesPorId);
    const totalMotos = Object.values(motosPorLeilao).reduce((s, a) => s + a.length, 0);

    console.log(`\n📋 Resumo:`);
    console.log(`   ${leilaoIds.length} leilão(ões)`);
    console.log(`   ${totalMotos} motos válidas`);
    console.log(`   ${skipped} lotes ignorados (sem data/parse)`);

    if (leilaoIds.length === 0) {
      console.log('ℹ️  Nenhum leilão futuro encontrado. Encerrando.');
      return;
    }

    // ── 5. Upsert no Supabase ─────────────────────────────────────────────────
    console.log('\n💾 Salvando no Supabase...');

    for (const lid of leilaoIds) {
      const l = leiloesPorId[lid];
      console.log(`\n  Leilão: ${lid}  (${l.data} ${l.hora})`);

      // Upsert leilão (cria se não existir, atualiza se existir — exceto encerrado)
      await supaFetch('leiloes?on_conflict=id', {
        method: 'POST',
        body:   JSON.stringify(l),
        prefer: 'resolution=merge-duplicates,return=minimal',
      });

      // Busca motos existentes
      const motosExist = await supaFetch(`motos?select=id&leilao_id=eq.${lid}`);
      const idsExist   = (motosExist ?? []).map(m => m.id);

      if (idsExist.length > 0) {
        // Preserva motos que já têm arrematado
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

      // Insere novas motos
      const novas = motosPorLeilao[lid];
      const BATCH = 50;
      for (let i = 0; i < novas.length; i += BATCH) {
        await supaFetch('motos', { method: 'POST', body: JSON.stringify(novas.slice(i, i + BATCH)), prefer: 'return=minimal' });
      }
      console.log(`  → Inseriu ${novas.length} moto(s)`);
    }

    console.log('\n✅ Scraper concluído com sucesso!');

  } catch (err) {
    console.error('\n❌ Erro fatal:', err.message);
    try { await page.screenshot({ path: 'sodre-error.png' }); } catch {}
    throw err;
  } finally {
    await browser.close();
  }
}

// ── Fallback DOM: tenta extrair lotes de cards HTML ──────────────────────────
async function extractLotsFromDOM(page) {
  // Tenta vários seletores comuns de cards de lote em sites de leilão Vue.js
  const CARD_SELECTORS = [
    '[class*="lot-card"]', '[class*="lote-card"]', '[class*="lot_card"]',
    '[class*="vehicle-card"]', '[class*="veiculo"]', '[class*="auction-lot"]',
    'article[data-id]', 'div[data-lot]', 'li[data-lot]',
  ];

  for (const sel of CARD_SELECTORS) {
    const count = await page.locator(sel).count();
    if (count < 2) continue;

    console.log(`   Seletor "${sel}" encontrou ${count} cards`);
    const cards = await page.locator(sel).all();
    const lots = [];

    for (const card of cards) {
      try {
        const text = (await card.innerText()).trim();
        // Extrai data no formato DD/MM/AA HH:MM ou DD/MM/AAAA HH:MM
        const dateM = text.match(/(\d{2})\/(\d{2})\/(\d{2,4})\s+(\d{2}:\d{2})/);
        // Extrai lote ex: "Lote 0071" ou "0071"
        const loteM = text.match(/[Ll]ote\s*[:\-]?\s*(\d+)/) || text.match(/^(\d{3,5})\b/m);
        // Extrai valor
        const valM  = text.match(/R\$\s*([\d.]+(?:,\d{2})?)/);
        // Primeira linha como descrição
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

        if (!dateM && !lines.some(l => /\d{2}\/\d{2}/.test(l))) continue;

        lots.push({
          title:      lines[0] ?? '',
          lot_number: loteM ? loteM[1] : null,
          start_value: valM ? parseFloat(valM[1].replace(/\./g, '').replace(',', '.')) : null,
          auction_date_init: dateM
            ? `${dateM[3].length === 2 ? '20' + dateM[3] : dateM[3]}-${dateM[2]}-${dateM[1]}T${dateM[4]}:00`
            : null,
        });
      } catch { /* ignora erros por card */ }
    }
    if (lots.length > 0) return lots;
  }

  return [];
}

// ── Entry point ───────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
