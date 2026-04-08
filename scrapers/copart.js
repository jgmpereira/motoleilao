#!/usr/bin/env node
'use strict';

/**
 * Scraper automático — Copart Brasil
 *
 * Estratégia:
 *  1. Abre a busca filtrada (Motos, 1980-2027) com Playwright — necessário para
 *     contornar o WAF Imperva/Incapsula que bloqueia fetch direto Node.js
 *  2. Aguarda o primeiro carregamento (cookies WAF estabelecidos)
 *  3. Faz chamadas paginadas ao endpoint /public/vehicleFinder/search via
 *     page.evaluate (fetch dentro do contexto do browser = sem bloqueio WAF)
 *  4. Filtra "vendas futuras" (stt: "Aguardando Classificação" ou ad vazio)
 *  5. Agrupa por data do leilão → id: copart_YYYYMMDD
 *  6. Upsert no Supabase
 *
 * Secrets necessários no GitHub:
 *   SUPABASE_KEY  — service_role key (ou anon key se RLS permitir)
 */

const { chromium } = require('playwright');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPA_URL = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY = process.env.SUPABASE_KEY;

if (!SUPA_KEY) {
  console.error('❌  SUPABASE_KEY não definido');
  process.exit(1);
}

// searchStr para o endpoint da API (mesmo valor do parâmetro da URL)
const COPART_SEARCH_STR = JSON.stringify({
  MISC: ['categoria:Motos', '#LotYear:[1980 TO 2027]'],
  sortByZip: false,
});

const COPART_SEARCH_URL = 'https://www.copart.com.br/vehicleFinderSearch?searchStr=' +
  encodeURIComponent(COPART_SEARCH_STR);

const PAGE_SIZE = 100;  // Copart suporta até 100 por página

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
  'zero': 'Zero', 'sundown': 'Sundown', 'hero': 'Hero', 'moto guzzi': 'Moto Guzzi',
  'norton': 'Norton', 'husqvarna': 'Husqvarna', 'can-am': 'Can-Am',
};

function normalizarMarca(raw) {
  if (!raw) return null;
  const low = raw.toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(MARCA_NORM, low)) return MARCA_NORM[low];
  return toTitle(raw);
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
  const FIXOS = {
    'AFRICA TWIN': 1084, 'PAN AMERICA': 1252, 'MULTISTRADA V4': 1158, 'MULTISTRADA': 1103,
    'HIMALAYAN': 411, 'METEOR 350': 349, 'STREET TRIPLE': 765,
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
    'YS150': 150, 'FZ25': 249, 'FZ15': 150, 'CRYPTON': 115,
    'Z400': 399, 'Z650': 649, 'Z900': 948, 'Z1000': 1043,
    'CBR 600': 599, 'CBR 1000': 999, 'CBR 250': 249,
    'CB 500': 471, 'CB 650': 649, 'CB300': 300, 'CB 300': 300,
    'XRE 300': 292, 'XRE 190': 184, 'NC 750': 745, 'SH 300': 279,
    'HORNET': 599, 'TWISTER': 250, 'PCX': 160,
    'NXR160': 160, 'BROS 160': 160, 'NXR150': 150, 'BROS 150': 150,
    'CG FAN': 150, 'FAN 150': 150, 'FAN 125': 125,
    'CG TITAN': 160, 'TITAN 160': 160, 'TITAN 150': 150,
    'CG125': 125, 'CG 125': 125, 'CG150': 150, 'CG 150': 150, 'CG160': 160, 'CG 160': 160,
    'BIZ 125': 125, 'BIZ 110': 110, 'POP 110': 110, 'POP 100': 100,
    'LEAD 110': 110, 'ELITE 125': 125,
    'S1000RR': 999, 'R1300GS': 1300, 'R1250GS': 1254, 'R1200GS': 1170,
    'F850GS': 853, 'F750GS': 853, 'F800': 798, 'G650GS': 652,
    'G310GS': 310, 'G310R': 310, 'G310': 310,
    'DUKE 390': 373, 'DUKE 250': 248, 'ADVENTURE 390': 373,
    'MONSTER 937': 937, 'MONSTER 821': 821,
    'SPORTSTER': 883, 'FAT BOY': 1868, 'ROAD KING': 1745, 'STREET BOB': 1745,
    'XL 1200': 1202, 'XL1200': 1202, 'XL883': 883,
    'SOFTAIL': 1745, 'DYNA': 1584, 'TOURING': 1745,
    'SCRAM 411': 411, 'HUNTER 350': 349, 'CLASSIC 350': 349,
  };
  const chaves = Object.keys(FIXOS).sort((a, b) => b.length - a.length);
  for (const key of chaves) {
    const re = new RegExp('(^|[\\s\\-/])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s\\-/0-9]|$)');
    if (re.test(texto)) return FIXOS[key];
  }
  // Fallback numérico — exclui anos (1900-2100) e valores fora de range
  const nums = [...texto.matchAll(/\b(\d{2,4})\b(?!\/)/g)].map(m => +m[1]);
  for (const n of nums) {
    if (n >= 50 && n <= 2500 && !(n >= 1900 && n <= 2100)) return n;
  }
  return null;
}

// ── Mapeamento de condição Copart ─────────────────────────────────────────────
// Campo `stt` da API:
//   "IRRECUPERÁVEL"         → sucata
//   "PARA DESMANCHE"        → sucata
//   "DANIFICADO"            → sinistro
//   "RECUPERÁVEL"           → sinistro
//   "AGUARDANDO CLASSIFICAÇÃO" → filtrado (venda futura)
//   outros                  → financiada
function mapCondicao(stt) {
  const s = (stt || '').toUpperCase().trim();
  if (s === 'IRRECUPERÁVEL' || s === 'PARA DESMANCHE' || s.includes('SUCATA')) return 'sucata';
  if (s === 'DANIFICADO' || s === 'RECUPERÁVEL' || s.includes('SINISTRO') ||
      s.includes('COLISÃO') || s.includes('INCENDIO') || s.includes('INCÊNDIO')) return 'sinistro';
  return 'financiada';
}

// ── Utilitários de data ───────────────────────────────────────────────────────
const MESES = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];

function nomeDoMes(dataISO) {
  const dt = new Date(dataISO + 'T00:00:00');
  return `${dt.getDate()}/${MESES[dt.getMonth()]}`;
}

// "2026-04-08 12:00:00" → { dataISO: "2026-04-08", hora: "12:00" }
function parseAdDate(ad) {
  if (!ad) return { dataISO: null, hora: '' };
  const m = String(ad).match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
  if (!m) return { dataISO: null, hora: '' };
  return { dataISO: m[1], hora: m[2] };
}

// ── Busca paginada via page.evaluate ──────────────────────────────────────────
async function fetchAllLots(page) {
  const allContent = [];
  let firstRecord = 0;
  let totalElements = null;

  while (true) {
    const result = await page.evaluate(async ({ searchStr, firstRecord, displayLength }) => {
      try {
        const body = {
          query: '',
          searchStr,
          watchListOnly: false,
          externalZipCode: '',
          ignoreStorage: false,
          isBuyItNow: false,
          isNotable: false,
          isUpcoming: false,
          isMember: false,
          defaultSort: true,
          displayLength,
          firstRecord,
          sortOrder: 'DESC',
          sortName: '',
        };
        const res = await fetch('/public/vehicleFinder/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'include',
        });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        return await res.json();
      } catch (e) {
        return { error: e.message };
      }
    }, { searchStr: COPART_SEARCH_STR, firstRecord, displayLength: PAGE_SIZE });

    if (result?.error) {
      console.error(`  ❌ Erro na página ${firstRecord / PAGE_SIZE + 1}: ${result.error}`);
      break;
    }

    const results = result?.data?.results;
    const content = results?.content ?? [];
    const total   = results?.totalElements ?? results?.total ?? 0;

    if (totalElements === null) {
      totalElements = total;
      console.log(`  📊 Total de lotes Copart (motos): ${totalElements}`);
    }

    allContent.push(...content);
    console.log(`  Página ${Math.floor(firstRecord / PAGE_SIZE) + 1}: ${content.length} lotes (acumulado: ${allContent.length})`);

    firstRecord += PAGE_SIZE;
    if (content.length === 0 || firstRecord >= totalElements) break;

    // Pausa entre páginas para não sobrecarregar
    await new Promise(r => setTimeout(r, 400));
  }

  return allContent;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🏍  Copart Brasil — scraper iniciando');
  console.log(`    Supabase: ${SUPA_URL}`);
  console.log(`    URL: ${COPART_SEARCH_URL}`);

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
    userAgent:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:   { width: 1280, height: 900 },
    locale:     'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
  });

  // Remove flag webdriver para evitar detecção
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    // ── 1. Navega para estabelecer cookies WAF ────────────────────────────────
    console.log('\n🌐 Navegando para a busca (estabelecendo cookies WAF)...');
    const navResp = await page.goto(COPART_SEARCH_URL, {
      waitUntil: 'networkidle',
      timeout:   60_000,
    });
    console.log(`   Status HTTP: ${navResp?.status()}`);

    // Aguarda a SPA Angular inicializar
    await page.waitForTimeout(3_000);

    // ── 2. Busca todos os lotes via fetch dentro do browser ───────────────────
    console.log('\n🔍 Buscando lotes (paginado via fetch interno)...');
    const allContent = await fetchAllLots(page);

    console.log(`\n   Total bruto: ${allContent.length} lotes`);

    if (allContent.length === 0) {
      console.log('⚠️  Nenhum lote obtido. Salvando screenshot de debug...');
      await page.screenshot({ path: 'copart-debug.png', fullPage: false });
      console.log('   📸 Screenshot: copart-debug.png');
      return;
    }

    // Debug — mostra primeiro lote
    console.log('\n🔍 Primeiro lote (verificação de campos):');
    console.log(JSON.stringify(allContent[0], null, 2));

    // ── 3. Filtra e processa os lotes ─────────────────────────────────────────
    const hoje = new Date().toISOString().slice(0, 10);
    const leiloesPorData  = {};
    const motosPorLeilao  = {};
    let skippedFutura = 0, skippedNaoMoto = 0, skippedSemData = 0;

    for (const lot of allContent) {
      // "Aguardando Classificação" = venda futura sem data definida → ignora
      const status = (lot.stt || '').trim();
      if (status === 'Aguardando Classificação' || status === 'AGUARDANDO CLASSIFICAÇÃO') {
        skippedFutura++;
        continue;
      }

      // Data do leilão — campo `ad` ex: "2026-04-08 12:00:00"
      const { dataISO, hora } = parseAdDate(lot.ad);
      if (!dataISO) {
        skippedSemData++;
        continue;
      }

      // Ignora lotes com data muito passada (>3 dias)
      if (dataISO < hoje) {
        const diffDias = (Date.now() - new Date(dataISO + 'T12:00:00').getTime()) / 86_400_000;
        if (diffDias > 3) continue;
      }

      // Marca e modelo
      const marcaRaw  = String(lot.mkn ?? lot.mk  ?? '').trim();
      const modeloRaw = String(lot.lm  ?? lot.m   ?? '').trim();
      const anoNum    = lot.lcy ?? lot.y ?? null;

      const marca  = normalizarMarca(marcaRaw) || toTitle(marcaRaw);
      const modelo = toTitle(modeloRaw) || null;

      if (!isMoto(marca)) {
        skippedNaoMoto++;
        if (marcaRaw) console.log(`  ⚠️  ignorado (não é moto): ${marcaRaw} ${modeloRaw}`);
        continue;
      }

      // Ano — lcy: 2022 → "22/22"
      let ano = null;
      if (anoNum) {
        const y = String(anoNum).slice(-2);
        ano = `${y}/${y}`;
      }

      // Cilindrada e monta
      const cilindrada = extractCilindrada(marca, modelo);
      const monta = cilindrada == null ? null
        : cilindrada <= 150 ? 'pequena'
        : cilindrada <= 500 ? 'media'
        : 'grande';

      // Condição
      const condicao = mapCondicao(status);

      // Lance/bid — hb (highest bid) ou ob (opening bid)
      const lanceRaw = parseFloat(lot.hb ?? lot.ob ?? lot.hbn ?? 0);
      const lance = lanceRaw > 0 ? lanceRaw : null;

      // Foto
      const foto = lot.tims
        ? `https://cs.copart.com/v1/AUTH_svc.pdoc00001/${lot.tims}`
        : null;

      // Número do lote e pátio
      const lote  = String(lot.ln ?? '').trim() || null;
      const patio = String(lot.yn ?? lot.yrd ?? '').trim() || null;

      // Link do lote
      const lotNum = lot.ln ?? '';
      const url = lotNum
        ? `https://www.copart.com.br/lot/${lotNum}`
        : 'https://www.copart.com.br/vehicleFinderSearch?searchStr=' + encodeURIComponent(COPART_SEARCH_STR);

      // Agrupa por data
      const lid = `copart_${dataISO.replace(/-/g, '')}`;
      if (!leiloesPorData[lid]) {
        leiloesPorData[lid] = {
          id:         lid,
          nome:       `Copart — ${nomeDoMes(dataISO)}`,
          plataforma: 'Copart',
          data:       dataISO,
          hora:       hora || '',
          local:      'Online',
          link:       'https://www.copart.com.br/vehicleFinderSearch?searchStr=' + encodeURIComponent(COPART_SEARCH_STR),
          encerrado:  false,
        };
        motosPorLeilao[lid] = [];
      }

      motosPorLeilao[lid].push({
        leilao_id:    lid,
        lote,
        marca,
        modelo,
        ano,
        cor:          null,
        condicao,
        lance_inicial: lance,
        financeira:   'Particular/Empresa',
        cilindrada,
        monta,
        foto,
        url,
        fipe_csv:     null,
        patio,
      });
    }

    const leilaoIds  = Object.keys(leiloesPorData);
    const totalMotos = Object.values(motosPorLeilao).reduce((s, a) => s + a.length, 0);

    console.log(`\n📋 Resumo:`);
    console.log(`   ${leilaoIds.length} leilão(ões)`);
    console.log(`   ${totalMotos} motos válidas`);
    console.log(`   ${skippedFutura} ignorados (venda futura / sem data)`);
    console.log(`   ${skippedNaoMoto} ignorados (não é moto)`);
    leilaoIds.forEach(lid => {
      const l = leiloesPorData[lid];
      console.log(`   → ${lid}: ${l.nome} (${l.data} ${l.hora}) — ${motosPorLeilao[lid].length} motos`);
    });

    if (leilaoIds.length === 0) {
      console.log('ℹ️  Nenhum leilão futuro. Encerrando.');
      return;
    }

    // ── 4. Upsert no Supabase ─────────────────────────────────────────────────
    console.log('\n💾 Salvando no Supabase...');

    for (const lid of leilaoIds) {
      const l = leiloesPorData[lid];
      console.log(`\n  Leilão: ${lid}  (${l.data} ${l.hora})`);

      await supaFetch('leiloes?on_conflict=id', {
        method: 'POST',
        body:   JSON.stringify(l),
        prefer: 'resolution=merge-duplicates,return=minimal',
      });

      // Remove motos antigas sem arrematado
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

    // ── 5. Marca leilões Copart passados como encerrados ──────────────────────
    const leiloesPast = await supaFetch(
      `leiloes?id=like.copart_*&encerrado=eq.false&data=lt.${hoje}&select=id,data`
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

    console.log('\n✅ Scraper Copart concluído com sucesso!');

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('\n❌ Erro fatal:', err.message);
  process.exit(1);
});
