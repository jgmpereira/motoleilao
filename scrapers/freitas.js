#!/usr/bin/env node
'use strict';

/**
 * Scraper automático — Freitas Leiloeiro
 *
 * Estratégia:
 *  1. GET direto ao endpoint /Leiloes/PesquisarLotes (retorna HTML, sem Playwright)
 *  2. Parseia os cards .cardlote via regex
 *  3. Agrupa por leilão (leilaoId do site) e upsert no Supabase
 *
 * O site retorna até ~30 lotes ativos de motos em uma única requisição (sem paginação real).
 *
 * Secrets necessários no GitHub:
 *   SUPABASE_KEY  — service_role key (ou anon key se RLS permitir)
 */

const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPA_URL   = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY   = process.env.SUPABASE_KEY;
const FREITAS_URL = 'https://www.freitasleiloeiro.com.br/Leiloes/PesquisarLotes'
  + '?Nome=&Categoria=1&TipoLoteId=3&FaixaValor=0&Condicao=0'
  + '&PatioId=0&AnoModeloMin=0&AnoModeloMax=0&Tag=&Pagina=1';
const CDN = 'https://cdn3.freitasleiloeiro.com.br';

if (!SUPA_KEY) {
  console.error('❌  SUPABASE_KEY não definido');
  process.exit(1);
}

// ── HTTP helper (sem dependências externas) ───────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer':    'https://www.freitasleiloeiro.com.br/',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
    };
    const req = https.get(opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpGet(res.headers.location));
      }
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

// ── Utilities ────────────────────────────────────────────────────────────────
function toTitle(str) {
  return (str || '').toLowerCase().replace(/(?:^|\s)\w/g, c => c.toUpperCase()).trim();
}

// Normaliza marca — mesmo padrão do index.html / sodre.js
const MARCA_NORM = {
  'honda': 'Honda', 'yamaha': 'Yamaha', 'kawasaki': 'Kawasaki', 'suzuki': 'Suzuki',
  'bmw': 'BMW', 'ktm': 'KTM', 'ducati': 'Ducati', 'triumph': 'Triumph',
  'harley-davidson': 'Harley-Davidson', 'harley davidson': 'Harley-Davidson',
  'royal enfield': 'Royal Enfield', 'aprilia': 'Aprilia', 'benelli': 'Benelli',
  'cfmoto': 'CFMoto', 'dafra': 'Dafra', 'shineray': 'Shineray', 'bajaj': 'Bajaj',
  'haojue': 'Haojue', 'jtz': 'JTZ', 'mv agusta': 'MV Agusta', 'indian': 'Indian',
  'zero': 'Zero', 'i': null,  // "I" = importado, marca fica no modelo
};

function normalizarMarca(raw) {
  if (!raw) return null;
  const low = raw.toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(MARCA_NORM, low)) return MARCA_NORM[low];
  return toTitle(raw);
}

// ── Parse da descrição do lote ────────────────────────────────────────────────
// Formato Freitas: "MARCA/MODELO, ANO, PLACA: X__-__X, COMBUSTIVEL, COR"
// Exemplos:
//   "YAMAHA/FLUO 125, 22/23, PLACA: E__-___4, GASOLINA, PRETA"
//   "I/ROYAL ENFIELD HIMALAYA, 20/21, PLACA: E__-___8, GASOLINA, AZUL"
//   "BMW/R1250GS, 21/21, PLACA: G__-___6, GASOLINA, PRETA"
//   "HARLEY DAVIDSON/XL883 R, 10/10, PLACA: E__-___8, GASOLINA, PRETA"
function parseDescricao(desc) {
  if (!desc) return null;
  // Divide pela primeira vírgula para separar "MARCA/MODELO" do resto
  const firstComma = desc.indexOf(',');
  if (firstComma < 0) return null;
  const marcaModelo = desc.slice(0, firstComma).trim();
  const resto = desc.slice(firstComma + 1).trim();

  // MARCA/MODELO — divide pelo primeiro "/"
  const slash = marcaModelo.indexOf('/');
  if (slash < 0) return null;
  const marcaRaw  = marcaModelo.slice(0, slash).trim();
  const modeloRaw = marcaModelo.slice(slash + 1).trim();

  let marca  = normalizarMarca(marcaRaw);
  let modelo = toTitle(modeloRaw);

  // Quando marca é "I" (importado), o modelo já contém marca + modelo juntos
  // ex: "I/ROYAL ENFIELD HIMALAYA" → marca=null, modelo="Royal Enfield Himalaya"
  // Tenta separar a marca do modelo pelo padrão de marcas conhecidas
  if (!marca && modelo) {
    for (const [key, val] of Object.entries(MARCA_NORM)) {
      if (val && modelo.toUpperCase().startsWith(key.toUpperCase())) {
        marca  = val;
        modelo = toTitle(modelo.slice(key.length).trim());
        break;
      }
    }
    if (!marca) marca = modelo.split(' ')[0]; // fallback: primeira palavra
  }
  if (!marca || !modelo) return null;

  // Resto: "ANO, PLACA: ..., COMBUSTIVEL, COR"
  const partes = resto.split(',').map(s => s.trim());
  // Primeiro elemento que combina com padrão de ano (YY/YY ou YYYY/YYYY)
  const anoRaw = partes.find(p => /^\d{2,4}\/\d{2,4}$/.test(p)) ?? null;
  const ano = anoRaw ? anoRaw.replace(/(\d{4})/g, m => m.slice(-2)) : null; // normaliza YYYY→YY

  // Última parte é a cor (quando não é número ou "PLACA" ou "GASOL")
  const COR_RE = /^(PRETA|BRANCA|VERMELHA|AZUL|CINZA|PRATA|AMARELA|VERDE|ROSA|LARANJA|ROXA|MARROM|GRAFITE|TITANIO|TITÂNIO|BEGE|DOURADA|VINHO|LILÁS|CINZA\/PRETA|PRATA\/PRETA|BRANCA\/AZUL)$/i;
  const cor = partes.slice().reverse().find(p => COR_RE.test(p)) ?? null;

  return { marca, modelo, ano, cor: cor ? toTitle(cor) : null };
}

// ── Parse do campo "details" ─────────────────────────────────────────────────
// Formato: "FINANCEIRA" | "SEGURADORA SINISTRO/PEQUENA MONTA" | "SEGURADORA SINISTRO/MÉDIA MONTA"
function parseDetails(details) {
  const txt = (details || '').toUpperCase().replace(/\s+/g, ' ').trim();

  let financeira = 'Particular/Empresa';
  if (txt.startsWith('SEGURADORA'))      financeira = 'Seguradora';
  else if (txt.startsWith('FINANCEIRA')) financeira = 'Financeira';
  else if (txt.startsWith('BANCO'))      financeira = 'Financeira';

  let condicao = 'financiada';
  if (txt.includes('SUCATA'))   condicao = 'sucata';
  else if (txt.includes('SINISTRO') || txt.includes('COLISÃO') ||
           txt.includes('ROUBO')    || txt.includes('FURTO'))   condicao = 'sinistro';

  let monta = null;
  if (txt.includes('PEQUENA MONTA'))            monta = 'pequena';
  else if (txt.includes('MÉDIA MONTA') ||
           txt.includes('MEDIA MONTA'))         monta = 'media';
  else if (txt.includes('GRANDE MONTA'))        monta = 'grande';

  return { financeira, condicao, monta };
}

// ── Parse do lance ────────────────────────────────────────────────────────────
function parseLance(vlr) {
  if (!vlr || vlr === '-') return null;
  const num = parseFloat(vlr.replace(/[R$\s.]/g, '').replace(',', '.'));
  return isNaN(num) || num <= 0 ? null : num;
}

// ── Helpers de data ───────────────────────────────────────────────────────────
const MESES = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];

// "07/04/2026" → "2026-04-07"
function parseDateBR(str) {
  const m = (str || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function gerarLeilaoId(freitasId) {
  return `freitas_${freitasId}`;
}

function gerarLeilaoObj(freitasId, dataISO, hora) {
  const dt  = new Date(dataISO + 'T00:00:00');
  const dia = dt.getDate();
  const mes = MESES[dt.getMonth()];
  return {
    id:         gerarLeilaoId(freitasId),
    nome:       `Freitas Leiloeiro — ${dia}/${mes}`,
    plataforma: 'Freitas Leiloeiro',
    data:       dataISO,
    hora:       hora || '',
    local:      'Online',
    link:       `https://www.freitasleiloeiro.com.br/Leiloes/Pesquisar?Categoria=1&TipoLoteId=3`,
    encerrado:  false,
  };
}

// ── Parseia o HTML dos cards ──────────────────────────────────────────────────
function parseCards(html) {
  // Separa em blocos de card
  const cardBlocks = html.split('<div class="cardlote">').slice(1);
  const lots = [];

  for (const block of cardBlocks) {
    const g = (re) => (block.match(re)||[])[1]?.trim() ?? null;

    // IDs
    const leilaoIdSite = g(/leilaoId=(\d+)/);
    const loteNum      = g(/loteNumero=(\d+)/);
    if (!leilaoIdSite || !loteNum) continue;

    // Data / hora
    const datas = [...block.matchAll(/<span class="fw-bold">([^<]+)<\/span>/g)].map(m => m[1].trim());
    const dataStr = datas.find(d => /^\d{2}\/\d{2}\/\d{4}$/.test(d)) ?? null;
    const hora    = datas.find(d => /^\d{2}:\d{2}$/.test(d)) ?? null;
    const dataISO = parseDateBR(dataStr);
    if (!dataISO) continue;

    // Descrição do veículo
    const descRaw = g(/<div class="cardLote-descVeic">\s*<span>([^<]+)<\/span>/);
    const parsed  = parseDescricao(descRaw);
    if (!parsed) continue;

    // Valor / lance
    const vlrRaw = g(/<div class="cardLote-vlr">\s*([^<]+?)\s*<\/div>/);
    const lance  = parseLance(vlrRaw);

    // Detalhes (financeira / condição / monta)
    const detailsRaw = g(/<div class="cardLote-details">[^<]*<span[^>]*>([\s\S]*?)<\/span>/);
    const details    = parseDetails(detailsRaw);

    // Foto (URL construída pelo padrão do CDN)
    const loteNum3 = loteNum.padStart(3, '0');
    const foto = `${CDN}/LEILOES/${leilaoIdSite}/FOTOS/${loteNum3}/LT${loteNum3}_01.JPG`;

    // URL do lote
    const url = `https://www.freitasleiloeiro.com.br/Leiloes/LoteDetalhes?leilaoId=${leilaoIdSite}&loteNumero=${loteNum}`;

    lots.push({
      leilaoIdSite,
      dataISO,
      hora,
      loteNum,
      foto,
      url,
      lance,
      ...parsed,
      ...details,
    });
  }

  return lots;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🏍  Freitas Leiloeiro — scraper iniciando');
  console.log(`    Endpoint: ${FREITAS_URL}`);
  console.log(`    Supabase: ${SUPA_URL}`);

  // ── 1. Busca o HTML dos lotes ─────────────────────────────────────────────
  console.log('\n🌐 Buscando lotes...');
  const { status, body } = await httpGet(FREITAS_URL);
  console.log(`   HTTP ${status}, ${body.length} bytes`);

  if (status !== 200) {
    console.error(`❌  Resposta inesperada: ${status}`);
    process.exit(1);
  }

  // ── 2. Parseia os cards ───────────────────────────────────────────────────
  const lots = parseCards(body);
  console.log(`   ${lots.length} lotes parseados`);

  if (lots.length === 0) {
    console.log('ℹ️  Nenhum lote encontrado. Encerrando sem salvar.');
    return;
  }

  // Debug: imprime o primeiro lote
  console.log('\n🔍 Primeiro lote (para verificação):');
  console.log(JSON.stringify(lots[0], null, 2));

  // ── 3. Agrupa por leilão ──────────────────────────────────────────────────
  const leiloesPorId   = {};
  const motosPorLeilao = {};
  const hoje = new Date().toISOString().slice(0, 10);

  for (const lot of lots) {
    // Descarta lotes de leilões muito passados (>3 dias atrás)
    if (lot.dataISO < hoje) {
      const diffDias = (Date.now() - new Date(lot.dataISO + 'T12:00:00').getTime()) / 86_400_000;
      if (diffDias > 3) continue;
    }

    const lid = gerarLeilaoId(lot.leilaoIdSite);
    if (!leiloesPorId[lid]) {
      leiloesPorId[lid]   = gerarLeilaoObj(lot.leilaoIdSite, lot.dataISO, lot.hora);
      motosPorLeilao[lid] = [];
    }

    const { marca, modelo, ano, cor, condicao, financeira, monta, lance, foto, url, loteNum } = lot;
    const cilindrada = extractCilindrada(marca, modelo);
    const montaFinal = monta ?? (cilindrada == null ? null
      : cilindrada <= 150 ? 'pequena'
      : cilindrada <= 500 ? 'media'
      : 'grande');

    motosPorLeilao[lid].push({
      leilao_id:    lid,
      lote:         loteNum,
      marca,
      modelo,
      ano,
      cor,
      condicao,
      lance_inicial: lance,
      financeira,
      cilindrada,
      monta:        montaFinal,
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
    console.log('ℹ️  Nenhum leilão futuro encontrado. Encerrando.');
    return;
  }

  // ── 4. Upsert no Supabase ─────────────────────────────────────────────────
  console.log('\n💾 Salvando no Supabase...');

  for (const lid of leilaoIds) {
    const l = leiloesPorId[lid];
    console.log(`\n  Leilão: ${lid}  (${l.data} ${l.hora})`);

    // Upsert leilão (merge — não sobrescreve encerrado=true)
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
}

// ── extractCilindrada (portada do index.html) ─────────────────────────────────
function extractCilindrada(marca, modelo) {
  const texto = ((marca || '') + ' ' + (modelo || '')).toUpperCase();
  const FIXOS = {
    'AFRICA TWIN': 1084, 'AFRICA-TWIN': 1084, 'PAN AMERICA': 1252,
    'MULTISTRADA V4': 1158, 'MTS V4': 1158, 'MULTISTRADA': 1103,
    'ROYAL ENFIELD HIMALAYAN': 411, 'ROYAL ENFIELD HIMALAYA': 411,
    'HIMALAYAN': 411, 'HIMALAYA': 411, 'METEOR 350': 349,
    'STREET TRIPLE': 765, 'TIGER EXPLORER': 1215, 'TIGER EXPLOR': 1215,
    'BONNEVILLE': 1200, 'TIGER 900': 888, 'TIGER 800': 800,
    'SCRAMBLER 1200': 1200, 'SCRAMBLER 400': 400, 'SCRAMBLER': 803,
    'SPEED 400': 400,
    'NINJA ZX-10R': 998, 'NINJA ZX-6R': 636,
    'VERSYS-X 300': 296, 'VERSYS X 300': 296, 'VERSYS 300': 296,
    'VERSYS 650': 649, 'NINJA 1000': 1043, 'NINJA 650': 649, 'NINJA 400': 399,
    'ELIMINATOR 500': 500,
    'V-STROM 650': 645, 'V-STROM650': 645,
    'GSX-R1000': 999, 'GSR750': 749, 'GSX-8': 776,
    'INTRUDER 125': 125, 'INTRUDER125': 125,
    'BURGMAN 650': 638, 'BURGMAN 400': 400,
    'FAZER 250': 249, 'FAZER250': 249, 'FAZER 150': 150, 'FAZER150': 150, 'FAZER SED': 150,
    'FACTOR 150': 150, 'FACTOR150': 150,
    'LANDER 250': 249, 'XTZ 250': 249, 'XTZ250': 249,
    'CROSSER 150': 150, 'CROSSER150': 150, 'XTZ 150': 150, 'XTZ150': 150,
    'TENERE 700': 689, 'TENERE 250': 249,
    'XT660': 660, 'XT 660': 660,
    'YZF-R15': 155, 'YZF R15': 155, 'R15': 155,
    'YZF-R3': 321, 'YZF R3': 321, 'R3': 321,
    'YZF-R6': 599, 'YZF R6': 599, 'R6': 599,
    'YZF-R7': 689, 'YZF R7': 689, 'R7': 689,
    'YZF-R1': 998, 'YZF R1': 998,
    'MT-03': 321, 'MT03': 321, 'MT 03': 321,
    'MT-07': 689, 'MT07': 689, 'MT 07': 689,
    'MT-09': 890, 'MT09': 890, 'MT 09': 890,
    'NMAX': 155, 'N-MAX': 155, 'XMAX': 292, 'X-MAX': 292, 'TMAX': 560, 'T-MAX': 560,
    'YBR 150': 150, 'YBR150': 150, 'YBR 125': 125, 'YBR125': 125,
    'YS150': 150, 'YS 150': 150,
    'FZ25': 249, 'FZ 25': 249, 'FZ15': 150, 'FZ 15': 150,
    'FLUO 125': 125, 'FLUO125': 125,
    'CRYPTON': 115, 'NEO AT': 113,
    'Z400': 399, 'Z 400': 399, 'Z650': 649, 'Z 650': 649,
    'Z900': 948, 'Z 900': 948, 'Z1000': 1043, 'Z 1000': 1043,
    'CBR 600': 599, 'CBR600': 599,
    'CBR 1000': 999, 'CBR1000': 999,
    'CBR 250': 249, 'CBR250': 249,
    'CB 500': 471, 'CB500': 471, 'CB 650': 649, 'CB650': 649,
    'CB300': 300, 'CB 300': 300,
    'XRE 300': 292, 'XRE300': 292, 'XRE 190': 184, 'XRE190': 184,
    'NC 750': 745, 'NC750': 745,
    'SH 300': 279, 'SH300': 279,
    'HORNET': 599, 'TWISTER': 250, 'TORNADO': 230,
    'PCX': 160,
    'NXR160': 160, 'NXR 160': 160, 'BROS 160': 160,
    'NXR150': 150, 'NXR 150': 150, 'BROS 150': 150, 'BROS': 160,
    'CG FAN': 150, 'FAN 150': 150, 'FAN 125': 125,
    'CG TITAN': 160, 'TITAN 160': 160, 'TITAN 150': 150,
    'CG125': 125, 'CG 125': 125, 'CG150': 150, 'CG 150': 150,
    'CG160': 160, 'CG 160': 160,
    'BIZ 125': 125, 'BIZ125': 125, 'BIZ 110': 110, 'BIZ110': 110,
    'POP 110': 110, 'POP110': 110, 'POP 100': 100, 'POP100': 100,
    'LEAD 110': 110, 'LEAD110': 110,
    'PCX': 160,
    'ELITE 125': 125,
    'S1000RR': 999, 'S1000 RR': 999, 'S1000XR': 999,
    'R1300GS': 1300, 'R1250GS': 1254, 'R1200GS': 1170,
    'F850GS': 853, 'F750GS': 853, 'F850': 853, 'F 850': 853, 'F750': 853,
    'F800': 798, 'F 800': 798, 'G650GS': 652, 'G 650': 652,
    'G310GS': 310, 'G310R': 310, 'G310': 310, 'G 310': 310,
    'DUKE 990': 999, 'DUKE 390': 373, 'DUKE 250': 248,
    '990 SUPER DUKE': 999, 'ADVENTURE 390': 373,
    'MONSTER 937': 937, 'MONSTER 821': 821,
    'SPORTSTER': 883, 'FAT BOY': 1868, 'FATBOY': 1868, 'FXLRST': 1868,
    'ROAD KING': 1745, 'STREET BOB': 1745, 'VRSC': 1131,
    'XL 1200': 1202, 'XL1200': 1202, 'XL883': 883,
    'SCRAM 411': 411, 'SCRAM411': 411,
    'HUNTER 350': 349, 'CLASSIC 350': 349, 'THUNDERBIRD': 350,
    'XJ6': 600,
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

main().catch(err => {
  console.error('\n❌ Erro fatal:', err.message);
  process.exit(1);
});
