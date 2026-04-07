#!/usr/bin/env node
'use strict';

/**
 * Scraper automático — Superbid Exchange
 *
 * Estratégia:
 *  1. GET direto ao offer-query.superbid.net (SSR, sem Playwright)
 *  2. Parseia JSON da listagem de motos
 *  3. Agrupa por auction.id → um leilão por evento Superbid
 *  4. Upsert no Supabase
 *
 * product.shortDesc: "YAMAHA YBR150 FACTOR PRO, 2020/2020, Placa FINAL 7 (SP),"
 *
 * Secrets necessários no GitHub:
 *   SUPABASE_KEY  — service_role key (ou anon key se RLS permitir)
 */

const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPA_URL   = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY   = process.env.SUPABASE_KEY;

// offer-query.superbid.net aceita requisições com Origin: exchange.superbid.net
const OFFER_QUERY_HOST = 'offer-query.superbid.net';
const OFFER_QUERY_BASE = '/seo/offers/?locale=pt_BR&portalId=%5B2%2C15%5D' +
  '&requestOrigin=marketplace&timeZoneId=UTC&searchType=opened' +
  '&urlSeo=https%3A%2F%2Fwww.superbid.net%2Fcategorias%2Fcarros-motos%2Fmotos';
const PAGE_SIZE = 30;

if (!SUPA_KEY) {
  console.error('❌  SUPABASE_KEY não definido');
  process.exit(1);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':     'application/json, text/plain, */*',
        'Origin':     'https://exchange.superbid.net',
        'Referer':    'https://exchange.superbid.net/',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
    };
    const req = https.get(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
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

const MESES = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];

// "2026-04-23 14:00:00" → "2026-04-23"
function parseDatatime(dt) {
  return (dt || '').slice(0, 10);
}
// "2026-04-23 14:00:00" → "14:00"
function parseHora(dt) {
  const m = (dt || '').match(/(\d{2}:\d{2})/);
  return m ? m[1] : '';
}

function nomeDoMes(dataISO) {
  const dt = new Date(dataISO + 'T00:00:00');
  return `${dt.getDate()}/${MESES[dt.getMonth()]}`;
}

// ── Parse da descrição do produto ─────────────────────────────────────────────
// Formato: "YAMAHA YBR150 FACTOR PRO, 2020/2020, Placa FINAL 7 (SP),"
// Mais simples: "HONDA CG 160 CARGO, 2018/2019, Placa FINAL 9 (BA),"
// Formato raro: "BMW R 1250 GS ADV, 2019/2020, PLACA FINAL 3 (SP)"
function parseShortDesc(desc) {
  if (!desc) return null;
  const parts = desc.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 1) return null;

  const marcaModelo = parts[0];
  // Separa primeira palavra (marca) do resto (modelo)
  const spaceIdx = marcaModelo.indexOf(' ');
  if (spaceIdx < 0) return null;
  const marcaRaw  = marcaModelo.slice(0, spaceIdx).trim();
  const modeloRaw = marcaModelo.slice(spaceIdx + 1).trim();

  const marca  = normalizarMarca(marcaRaw);
  const modelo = toTitle(modeloRaw);

  // Ano: primeiro campo que casa com YYYY/YYYY ou YY/YY
  const anoRaw = parts.find(p => /^\d{2,4}\/\d{2,4}$/.test(p)) ?? null;
  let ano = null;
  if (anoRaw) {
    const [a, b] = anoRaw.split('/');
    ano = `${a.slice(-2)}/${b.slice(-2)}`;
  }

  if (!marca || !modelo) return null;
  return { marca, modelo, ano };
}

// ── extractCilindrada ─────────────────────────────────────────────────────────
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
    'FAZER 250': 249, 'FAZER 150': 150, 'FACTOR 150': 150,
    'LANDER 250': 249, 'XTZ 250': 249, 'CROSSER 150': 150, 'XTZ 150': 150,
    'TENERE 700': 689, 'TENERE 250': 249, 'XT660': 660, 'XT 660': 660,
    'YZF-R15': 155, 'YZF-R3': 321, 'YZF-R6': 599, 'YZF-R7': 689, 'YZF-R1': 998,
    'MT-03': 321, 'MT-07': 689, 'MT-09': 890,
    'NMAX': 155, 'XMAX': 292, 'TMAX': 560, 'YBR 150': 150, 'YBR 125': 125,
    'YS150': 150, 'FZ25': 249, 'FZ15': 150, 'FLUO 125': 125,
    'CRYPTON': 115, 'NEO AT': 113,
    'Z400': 399, 'Z650': 649, 'Z900': 948, 'Z1000': 1043,
    'CBR 600': 599, 'CBR 1000': 999, 'CBR 250': 249,
    'CB 500': 471, 'CB 650': 649, 'CB300': 300, 'CB 300': 300,
    'XRE 300': 292, 'XRE 190': 184, 'NC 750': 745, 'SH 300': 279,
    'HORNET': 599, 'TWISTER': 250, 'PCX': 160,
    'NXR160': 160, 'BROS 160': 160, 'NXR150': 150, 'BROS 150': 150, 'BROS': 160,
    'CG FAN': 150, 'FAN 150': 150, 'FAN 125': 125,
    'CG TITAN': 160, 'TITAN 160': 160, 'TITAN 150': 150,
    'CG125': 125, 'CG 125': 125, 'CG150': 150, 'CG 150': 150, 'CG160': 160, 'CG 160': 160,
    'BIZ 125': 125, 'BIZ 110': 110, 'POP 110': 110, 'POP 100': 100, 'LEAD 110': 110,
    'S1000RR': 999, 'R1300GS': 1300, 'R1250GS': 1254, 'R1200GS': 1170,
    'F850GS': 853, 'F750GS': 853, 'F800': 798, 'G650GS': 652,
    'G310GS': 310, 'G310R': 310, 'DUKE 390': 373, 'DUKE 250': 248,
    'MONSTER 937': 937, 'MONSTER 821': 821,
    'SPORTSTER': 883, 'FAT BOY': 1868, 'ROAD KING': 1745, 'STREET BOB': 1745,
    'XL 1200': 1202, 'XL883': 883, 'SCRAM 411': 411,
    'HUNTER 350': 349, 'CLASSIC 350': 349,
    'CARGO': 160, 'START': 160,
    'FACTOR PRO': 150,
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

// ── Classifica financeira a partir do nome do leilão/lote ─────────────────────
// Exemplos: "Heineken" → Particular/Empresa, "Banco Itaú" → Financeira
const FINANCEIRAS_RE = /\b(banco|financeira|financ|bv|bradesco|itaú|itau|santander|caixa|sicoob|itapeva|safra|bco)\b/i;
const SEGURADORAS_RE = /\b(segur|allianz|porto|mapfre|tokio|sompo|azul\s+seguros)\b/i;

function inferirFinanceira(leilaoDesc) {
  const txt = (leilaoDesc || '').toLowerCase();
  if (SEGURADORAS_RE.test(txt)) return 'Seguradora';
  if (FINANCEIRAS_RE.test(txt)) return 'Financeira';
  return 'Particular/Empresa';
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🏍  Superbid — scraper iniciando');
  console.log(`    API: ${OFFER_QUERY_HOST}`);
  console.log(`    Supabase: ${SUPA_URL}`);

  // ── 1. Busca primeira página para descobrir o total ───────────────────────
  console.log('\n🌐 Buscando primeira página...');
  const url0 = `https://${OFFER_QUERY_HOST}${OFFER_QUERY_BASE}&start=0`;
  const res0 = await httpGet(url0);
  if (res0.status !== 200) throw new Error(`HTTP ${res0.status} na primeira página`);

  const data0 = JSON.parse(res0.body);
  const total = data0.total || 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  console.log(`   ${total} motos encontradas → ${totalPages} páginas`);

  // ── 2. Coleta todas as páginas ────────────────────────────────────────────
  const allOffers = [...(data0.offers || [])];
  console.log(`   Página 1: ${allOffers.length} lotes`);

  for (let page = 1; page < totalPages; page++) {
    const url = `https://${OFFER_QUERY_HOST}${OFFER_QUERY_BASE}&start=${page * PAGE_SIZE}`;
    const res  = await httpGet(url);
    if (res.status !== 200) {
      console.warn(`   ⚠️  Página ${page + 1} retornou HTTP ${res.status}, pulando`);
      continue;
    }
    const data = JSON.parse(res.body);
    const offers = data.offers || [];
    allOffers.push(...offers);
    console.log(`   Página ${page + 1}: ${offers.length} lotes`);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n   Total coletado: ${allOffers.length} lotes`);

  if (allOffers.length === 0) {
    console.log('ℹ️  Nenhum lote encontrado. Encerrando.');
    return;
  }

  // ── 3. Debug: primeiro lote ───────────────────────────────────────────────
  const first = allOffers[0];
  console.log('\n🔍 Primeiro lote (verificação):');
  console.log(`   desc: ${first.product?.shortDesc}`);
  console.log(`   auction: ${first.auction?.id} / ${first.auction?.desc}`);
  console.log(`   lance: ${first.offerDetail?.initialBidValue}`);

  // ── 4. Agrupa por auction.id ──────────────────────────────────────────────
  const hoje = new Date().toISOString().slice(0, 10);
  const leiloesPorId   = {};
  const motosPorLeilao = {};

  for (const offer of allOffers) {
    const auc = offer.auction || {};
    const aucId = auc.id;
    if (!aucId) continue;

    const lid = `superbid_${aucId}`;
    // Usa endDate para exibir quando o leilão fecha; fallback para beginDate
    const dataISO = parseDatatime(auc.endDate || auc.beginDate || '');
    if (!dataISO) continue;

    // Não filtra por data — a API já retorna só leilões abertos (searchType=opened)

    if (!leiloesPorId[lid]) {
      const addr = auc.address || {};
      const localDesc = addr.city && addr.stateCode
        ? `${addr.city} (${addr.stateCode})`
        : addr.stateCode || 'Online';

      leiloesPorId[lid] = {
        id:         lid,
        nome:       `Superbid — ${auc.desc || 'Leilão'} — ${nomeDoMes(dataISO)}`,
        plataforma: 'Superbid',
        data:       dataISO,
        hora:       parseHora(auc.beginDate || ''),
        local:      localDesc,
        link:       `https://exchange.superbid.net/leilao/${aucId}`,
        encerrado:  false,
      };
      motosPorLeilao[lid] = [];
    }

    const desc    = offer.product?.shortDesc || '';
    const parsed  = parseShortDesc(desc);
    if (!parsed) continue;

    const { marca, modelo, ano } = parsed;
    const lance = offer.offerDetail?.initialBidValue ?? null;
    const foto  = offer.product?.thumbnailUrl || null;
    const lote  = offer.lotNumber ? String(offer.lotNumber) : null;
    const url   = `https://exchange.superbid.net/oferta/${offer.id}`;

    const financeira = inferirFinanceira(auc.desc);
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
      financeira,
      cilindrada,
      monta,
      foto,
      url,
      fipe_csv:     null,
      patio:        null,
    });
  }

  const leilaoIds  = Object.keys(leiloesPorId);
  const totalMotos = Object.values(motosPorLeilao).reduce((s, a) => s + a.length, 0);

  console.log(`\n📋 Resumo:`);
  console.log(`   ${leilaoIds.length} leilão(ões)`);
  console.log(`   ${totalMotos} motos válidas`);
  leilaoIds.forEach(lid => {
    const l = leiloesPorId[lid];
    console.log(`   → ${lid}: ${l.nome} (${l.data}) — ${motosPorLeilao[lid].length} motos`);
  });

  if (leilaoIds.length === 0) {
    console.log('ℹ️  Nenhum leilão futuro. Encerrando.');
    return;
  }

  // ── 5. Upsert no Supabase ─────────────────────────────────────────────────
  console.log('\n💾 Salvando no Supabase...');

  for (const lid of leilaoIds) {
    const l = leiloesPorId[lid];
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

  // ── 6. Marca leilões Superbid passados como encerrados ────────────────────
  const leiloesPast = await supaFetch(
    `leiloes?id=like.superbid_*&encerrado=eq.false&data=lt.${hoje}&select=id,data`
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

  console.log('\n✅ Scraper Superbid concluído com sucesso!');
}

main().catch(err => {
  console.error('\n❌ Erro fatal:', err.message);
  process.exit(1);
});
