#!/usr/bin/env node
'use strict';

/**
 * Reprocessamento de FIPE — corrige valores errados salvos por versões antigas
 * do matching (popular-fipe.js/atualizar-fipe-mensal.js gravavam modelo_nome/
 * marca_nome IGUAIS ao texto do banco em vez do nome real da FIPE, e nunca
 * validavam o valor contra a cilindrada).
 *
 * Porta o matching bom do index.html (normFipe/scoreModelo por cobertura de
 * tokens + penalização de número divergente, FIPE_SINONIMOS, fallbacks) e
 * adiciona uma trava de sanidade: nunca salva um valor incompatível com a
 * cilindrada da moto.
 *
 * Uso:
 *   node scripts/reprocessar-fipe.js              # motos de leilões ativos, grava no banco
 *   DRY_RUN=1 node scripts/reprocessar-fipe.js     # só loga, não grava nada
 *   ESCOPO=all node scripts/reprocessar-fipe.js    # todas as motos (histórico incluso)
 */

const SUPA_URL = process.env.SUPABASE_URL || 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';
const ESCOPO = (process.env.ESCOPO || 'ativos').toLowerCase(); // 'ativos' | 'all'

// A API v1 (sem token) tem cota baixa e rate-limita rápido em processamento em
// lote. Com FIPE_TOKEN configurado, usa a v2 (autenticada, cota maior) — os
// nomes de campo divergem entre as duas, normalizados abaixo para o resto do
// código (matching, sinônimos) não precisar saber a diferença.
const FIPE_TOKEN = process.env.FIPE_TOKEN || '';
const USE_V2 = !!FIPE_TOKEN;
const FIPE_BASE = USE_V2 ? 'https://fipe.parallelum.com.br/api/v2/motorcycles' : 'https://parallelum.com.br/fipe/api/v1/motos';
const FIPE_HEADERS = USE_V2 ? { 'X-Subscription-Token': FIPE_TOKEN } : {};

if (!SUPA_KEY) { console.error('❌ SUPABASE_SERVICE_KEY (ou SUPABASE_KEY) não definido'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===================== SUPABASE =====================

async function supaFetch(path, opts = {}) {
  const { method = 'GET', body, prefer = 'return=minimal' } = opts;
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': prefer,
    },
    body,
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`${method} ${path} → ${res.status}: ${t}`); }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text || !text.trim()) return null;
  return JSON.parse(text);
}

async function supaFetchAll(pathComQuery) {
  const rows = [];
  const limit = 1000;
  let offset = 0;
  const sep = pathComQuery.includes('?') ? '&' : '?';
  while (true) {
    const page = await supaFetch(`${pathComQuery}${sep}limit=${limit}&offset=${offset}`, { prefer: 'return=representation' });
    if (!page || !page.length) break;
    rows.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return rows;
}

// ===================== FIPE FETCH (com retry/backoff, igual ao index.html) =====================

async function fipeFetch(url) {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    try {
      const r = await fetch(url, { headers: FIPE_HEADERS });
      if (r.status === 429) {
        await sleep(3000 * (tentativa + 1));
        continue;
      }
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      if (tentativa < 2) await sleep(2000);
    }
  }
  return null;
}

// Normaliza listas {code,name} da v2 para {codigo,nome} (formato v1) —
// o resto do código só conhece codigo/nome.
function normLista(arr) {
  if (!Array.isArray(arr)) return arr;
  if (!USE_V2) return arr;
  return arr.map(x => ({ codigo: x.code, nome: x.name }));
}

// ===================== NORMALIZAÇÃO DE MARCA (porta de index.html) =====================

const MARCA_NORM = {
  'honda/cg': 'Honda', 'honda/cg150': 'Honda', 'honda/cb': 'Honda',
  'honda/pcx': 'Honda', 'honda/nxr': 'Honda', 'honda/xre': 'Honda',
  'honda/biz': 'Honda', 'honda/pop': 'Honda', 'honda/lead': 'Honda',
  'yamaha/factor': 'Yamaha', 'yamaha/ybr': 'Yamaha', 'yamaha/fazer': 'Yamaha',
  'yamaha/yzf': 'Yamaha', 'yamaha/mt': 'Yamaha', 'yamaha/xtz': 'Yamaha',
  'shineray/xy': 'Shineray', 'shineray': 'Shineray',
  'suzuki/en125': 'Suzuki', 'suzuki/en': 'Suzuki',
  'i/leopard': 'Leopard', 'i/kawasaki': 'Kawasaki', 'i/bmw': 'BMW',
  'i/ducati': 'Ducati', 'i/triumph': 'Triumph', 'i/harley-davidson': 'Harley-Davidson',
  'i/royal enfield': 'Royal Enfield', 'i/yamaha': 'Yamaha', 'i/honda': 'Honda',
  'i/suzuki': 'Suzuki', 'i/ktm': 'KTM', 'i/aprilia': 'Aprilia',
  'i/benelli': 'Benelli', 'i/cfmoto': 'CFMoto', 'i/dafra': 'Dafra',
  'i': null,
  'bmw': 'BMW', 'jtz': 'JTZ', 'ktm': 'KTM',
  'harley-davidson': 'Harley-Davidson', 'harley davidson': 'Harley-Davidson',
  'royal enfield': 'Royal Enfield',
  'veiculo': null, 'veículo': null, 'vveiculo': null, 'vveículo': null,
  'moto': null, 'motocicleta': null, 'sucata': null, '—': null, '-': null, '': null,
};

function normalizarMarca(marca) {
  if (!marca) return null;
  const low = marca.toLowerCase().trim();
  if (MARCA_NORM.hasOwnProperty(low)) return MARCA_NORM[low];
  if (low.includes('/')) {
    const [prefix] = low.split('/');
    if (MARCA_NORM.hasOwnProperty(prefix)) return MARCA_NORM[prefix];
    if (prefix === 'i') return null;
    if (['veiculo', 'veículo', 'vveiculo', 'vveículo'].includes(prefix)) return null;
    return prefix.charAt(0).toUpperCase() + prefix.slice(1);
  }
  if (['veiculo', 'veículo', 'vveiculo', 'vveículo', 'moto', 'motocicleta', '-', '—'].includes(low)) return null;
  return marca.trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// ===================== MAPA DE SINÔNIMOS FIPE (porta exata de index.html) =====================

const FIPE_SINONIMOS = {
  'honda|cg 160 fan':       'CG 160 FAN',
  'honda|cg 160 titan':     'CG 160 TITAN',
  'honda|cg 160 start':     'CG 160 START',
  'honda|cg 160 cargo':     'CG 160 CARGO',
  'honda|cg 160':           'CG 160',
  'honda|cg 125 fan':       'CG 125 FAN',
  'honda|cg 125i fan':      'CG 125i FAN',
  'honda|cg 125':           'CG 125 TITAN',
  'honda|cg 150 titan ks':  'CG 150 TITAN KS',
  'honda|cg 150 titan esd': 'CG 150 TITAN ESD',
  'honda|cg150 fan esdi':   'CG 150 FAN ESDI',
  'honda|cg 150 titan ex':  'CG 150 TITAN EX',
  'honda|cg 150 titan':     'CG 150 TITAN KS',
  'honda|cg 150 fan':       'CG 150 FAN ESDI',
  'honda|cg 150 start':     'CG 150 START',
  'honda|cg150 start':      'CG 150 START',
  'honda|cg150':            'CG 150 TITAN KS',
  'honda|nxr 160 bros':     'NXR 160 BROS',
  'honda|nxr160 bros esdd': 'NXR 160 BROS ESDD',
  'honda|nxr150 bros es':   'NXR 150 BROS ES',
  'honda|nxr150 bros esd':  'NXR 150 BROS ESD',
  'honda|nxr125 bros es':   'NXR 125 BROS ES',
  'honda|nxr 160':          'NXR 160 BROS',
  'honda|nxr':              'NXR 160 BROS',
  'honda|pcx 160':          'PCX 160',
  'honda|pcx 160 abs':      'PCX 160 ABS',
  'honda|pcx 160 sport':    'PCX 160 SPORT',
  'honda|pcx 160 sport abs':'PCX 160 SPORT ABS',
  'honda|pcx 160 dlx abs':  'PCX 160 DLX ABS',
  'honda|pcx 150':          'PCX 150',
  'honda|pcx 150 dlx':      'PCX 150 DLX',
  'honda|pcx':              'PCX 160',
  'honda|cb250f twister cbs': 'CB 250F TWISTER CBS',
  'honda|cb 250f twister':    'CB 250F TWISTER',
  'honda|cbx 250 twister':    'CBX 250 TWISTER',
  'honda|cb 350f twister':    'CB 350F TWISTER',
  'honda|cb 300f':            'CB 300F',
  'honda|cb 300r':            'CB 300R',
  'honda|cb 500x':            'CB 500X',
  'honda|cb 250 f':           'CB 250F TWISTER',
  'honda|xre 300 abs':      'XRE 300 ABS',
  'honda|xre 300':          'XRE 300',
  'honda|xre 195 adv':      'XRE 195 ADV',
  'honda|xre 190':          'XRE 190',
  'honda|elite':            'ELITE 125',
  'honda|xre sahara 300':   'XRE 300',
  'honda|xre sahara':       'XRE 300',
  'honda|biz 125':          'BIZ 125',
  'honda|biz 125 es':       'BIZ 125 ES',
  'honda|biz es 25':        'BIZ 125 ES',
  'honda|biz':              'BIZ 125',
  'honda|elite 125':        'ELITE 125',
  'honda|pop 110 es':       'POP 110i ES',
  'honda|sh 300i':          'SH 300i',
  'honda|nc 750x':          'NC 750X',
  'honda|300s':             'CB 300R',
  'honda|xlr 125':          'XLR 125',
  'yamaha|yzf r6':          'YZF R-6 600',
  'yamaha|yzf r-6':         'YZF R-6 600',
  'yamaha|yzf r15':         'YZF R-15 155 ABS',
  'yamaha|yzf r-15':        'YZF R-15 155 ABS',
  'yamaha|yzf r3':          'YZF R-3 321/ABS',
  'yamaha|yzf r-3':         'YZF R-3 321/ABS',
  'yamaha|yzf r3 monster':  'YZF-R3',
  'yamaha|yzf r3 abs':      'YZF-R3 ABS',
  'yamaha|xtz250 tenere':   'XTZ 250 TENERE/TENERE BLUEFLEX',
  'yamaha|xtz 250 tenere':  'XTZ 250 TENERE/TENERE BLUEFLEX',
  'yamaha|mt03 abs':        'MT-03 ABS',
  'yamaha|mt-03 abs':       'MT-03 ABS',
  'yamaha|xmax 300':        'XMAX 300',
  'yamaha|nmax 160':        'NMAX 160',
  'yamaha|nmax':            'NMAX',
  'yamaha|fz25 fazer':      'FZ25 FAZER',
  'yamaha|fz15 fazer abs':  'FZ15 FAZER ABS',
  'yamaha|ys 150 fazer':    'YS 150 FAZER SED',
  'yamaha|ys150 fazer sed': 'YS 150 FAZER SED',
  'yamaha|ys150 factor':    'YS150 FACTOR',
  'yamaha|ybr 150 factor ed':'YBR 150 FACTOR ED',
  'yamaha|ybr150 factor ed': 'YBR 150 FACTOR ED',
  'yamaha|ybr 125k':        'YBR 125K',
  'yamaha|crosser s abs':   'CROSSER S ABS',
  'yamaha|xtz250 lander':   'XTZ 250 LANDER',
  'yamaha|xtz 250 lander':  'XTZ 250 LANDER',
  'yamaha|xtz 250':         'XTZ 250 LANDER',
  'yamaha|fazer250 blueflex':'FAZER 250 BLUEFLEX',
  'yamaha|fazer 250 blueflex':'FAZER 250 BLUEFLEX',
  'yamaha|neo 125':         'NEO 125',
  'yamaha|fluo 125':        'FLUO 125',
  'yamaha|xj6':             'XJ6',
  'yamaha|fazer 125':       'FAZER 125',
  'yamaha|biz 125':         'YBR 125K',
  'yamaha|factor ybr125 k':  'YBR 125K FACTOR',
  'yamaha|ybr125i factor ed':'YBR 150 FACTOR ED',
  'yamaha|ybr150 factor':    'YBR 150 FACTOR',
  'yamaha|fazer ys250':      'YS 250 FAZER',
  'yamaha|ybr 125':         'YBR 125K',
  'yamaha|fazer250':         'FAZER 250',
  'yamaha|ys 250 fazer':     'YS 250 FAZER',
  'yamaha|ys250 fazer':      'YS 250 FAZER',
  'yamaha|fz 25 fazer':      'FZ25 FAZER',
  'yamaha|fz25':             'FZ25 FAZER',
  'yamaha|mt 03':            'MT-03',
  'yamaha|mt 03 abs':        'MT-03 ABS',
  'yamaha|lander 250':       'XTZ 250 LANDER',
  'yamaha|xtz250':           'XTZ 250 LANDER',
  'yamaha|crosser 150':      'XTZ 150 CROSSER',
  'yamaha|xtz 150 crosser':  'XTZ 150 CROSSER',
  'bmw|s 1000 rr m package': 'S 1000 RR',
  'bmw|s 1000 rr h package': 'S 1000 RR',
  'bmw|s 1000 sr':           'S 1000 RR',
  'bmw|s1000 rr':            'S 1000 RR',
  'bmw|r1300gs triple black':'R 1300 GS',
  'bmw|r1250 gs a':          'R 1250 GS',
  'bmw|r1200 gs':            'R 1200 GS',
  'bmw|r1200 gs adventure':  'R 1200 GS Adventure',
  'bmw|f 900':               'F 900 R',
  'bmw|f800 gs':             'F 800 GS',
  'bmw|f750 gs':             'F 750 GS',
  'bmw|g 310 gs':            'G 310 GS',
  'honda|pop 110i es':       'POP 110i ES',
  'honda|pop 110i':          'POP 110i',
  'honda|pop110i':           'POP 110i',
  'honda|biz es':            'BIZ 125 ES',
  'honda|biz 125 ex':        'BIZ 125 EX',
  'honda|biz 125ex':         'BIZ 125 EX',
  'honda|biz 100 es':        'BIZ 100 ES',
  'honda|biz100 es':         'BIZ 100 ES',
  'honda|cb300f twister cbs':'CB 300F TWISTER CBS',
  'honda|xre 190 adv':       'XRE 190 ADV',
  'honda|lead 110':          'LEAD 110',
  'honda|pcx 150 sport abs': 'PCX 150 SPORT ABS',
  'honda|pcx 150 sport':     'PCX 150 SPORT',
  'honda|cg 160 fan esdi':   'CG 160 FAN ESDI',
  'honda|cg 160 titan ex':   'CG 160 TITAN EX',
  'honda|cg 160 fan ex':     'CG 160 FAN EX',
  'honda|cg160 fan':         'CG 160 FAN',
  'honda|cg160 titan':       'CG 160 TITAN',
  'honda|cg160 start':       'CG 160 START',
  'honda|cg160':             'CG 160',
  'ducati|multistrada v4 s': 'MULTISTRADA V4 S',
  'ducati|mts v4 rally':     'MULTISTRADA V4 RALLY',
  'ducati|mts 1260 s pt':    'MULTISTRADA 1260 S',
  'ducati|mts 1260 s':       'MULTISTRADA 1260 S',
  'ducati|mts 1260':         'MULTISTRADA 1260',
  'ducati|multistrada 1260': 'MULTISTRADA 1260 S',
  'harley-davidson|fl hc':   'HERITAGE CLASSIC FLHC/FLHCS',
  'harley-davidson|flhc':    'HERITAGE CLASSIC FLHC/FLHCS',
  'harley-davidson|fl trx':  'ROAD GLIDE FLTRX',
  'harley-davidson|fltrx':   'ROAD GLIDE FLTRX',
  'triumph|speed 400':       'SPEED 400',
  'royal enfield|classic':   'CLASSIC 350',
  'royal enfield|int 650':   'INTERCEPTOR 650',
  'kawasaki|versys-x 300 tr':'VERSYS-X 300 TOURER',
  'kawasaki|versys x 300':   'VERSYS-X 300',
  'kawasaki|ninja 300':          'NINJA 300',
  'kawasaki|ninja 400':          'NINJA 400',
  'kawasaki|ninja 400 abs':      'NINJA 400 ABS',
  'kawasaki|ninja 650':          'NINJA 650',
  'kawasaki|ninja 650 abs':      'NINJA 650 ABS',
  'kawasaki|z400 abs':           'Z 400 ABS',
  'kawasaki|z 400':              'Z 400',
  'kawasaki|z650 abs':           'Z 650 ABS',
  'kawasaki|z 650':              'Z 650',
  'kawasaki|z900 abs':           'Z 900 ABS',
  'kawasaki|z 900':              'Z 900',
  'kawasaki|versys 650':         'VERSYS 650',
  'kawasaki|versys 650 abs':     'VERSYS 650 ABS',
  'kawasaki|er-6n':              'ER-6N',
  'kawasaki|er6n':               'ER-6N',
  'kawasaki|z300':               'Z 300',
  'kawasaki|klx 300':            'KLX 300',
  'kawasaki|z 800':              'Z 800',
  'suzuki|gsx-s 1000':           'GSX-S 1000',
  'suzuki|gsxs 1000':            'GSX-S 1000',
  'suzuki|gsx-s 750':            'GSX-S 750',
  'suzuki|v-strom 650':          'V-STROM 650',
  'suzuki|vstrom 650':           'V-STROM 650',
  'suzuki|v-strom 1000':         'V-STROM 1000',
  'suzuki|vstrom 1000':          'V-STROM 1000',
  'suzuki|intruder 125':         'INTRUDER 125',
  'suzuki|yes 125':              'YES 125',
  'suzuki|yes 125 se':           'YES 125 SE',
  'suzuki|gsr 150i':             'GSR 150I',
  'suzuki|gs 120':               'GS 120',
  'suzuki|burgman 125':          'BURGMAN 125',
  'suzuki|burgman 400':          'BURGMAN 400',
  'suzuki|gsx-r 750':            'GSX-R 750',
  'suzuki|gsx-r 1000':          'GSX-R 1000',
  'ktm|duke 200':                'DUKE 200',
  'ktm|duke 390':                'DUKE 390',
  'ktm|duke 390 abs':            'DUKE 390 ABS',
  'ktm|adventure 390':           'ADVENTURE 390',
  'ktm|adventure 390 abs':       'ADVENTURE 390 ABS',
  'ktm|duke 890':                'DUKE 890',
  'ktm|rc 390':                  'RC 390',
  'ktm|exc':                     'EXC',
  'triumph|speed twin 900':      'SPEED TWIN 900',
  'triumph|speed twin':          'SPEED TWIN 900',
  'triumph|street triple 765':   'STREET TRIPLE 765 RS',
  'triumph|street triple':       'STREET TRIPLE 765 RS',
  'triumph|tiger sport':         'TIGER 660 SPORT',
  'triumph|tiger 660 sport':    'TIGER 660 SPORT',
  'triumph|tiger 900':           'TIGER 900',
  'triumph|tiger 900 gt':        'TIGER 900 GT',
  'triumph|tiger 900 gt pro':    'TIGER 900 GT PRO',
  'triumph|tiger 900 gt ae':     'TIGER 900 GT',
  'triumph|tiger 1200':          'TIGER 1200',
  'triumph|bonneville t100':     'BONNEVILLE T100',
  'triumph|scrambler 400':       'SCRAMBLER 400 X',
  'triumph|trident 660':         'TRIDENT 660',
  'dafra|apache 150':            'APACHE 150',
  'dafra|kansas 150':            'KANSAS 150',
  'dafra|citycom 300':           'CITYCOM 300i',
  'dafra|citycom300':            'CITYCOM 300i',
  'dafra|super 50':              'SUPER 50',
  'dafra|speed 150':             'SPEED 150',
  'dafra|horizon 250':           'HORIZON 250',
  'dafra|riva 150':              'RIVA 150',
  'bajaj|dominar 400':           'DOMINAR 400',
  'bajaj|dominar 400 ug':        'DOMINAR 400 UG',
  'bajaj|pulsar ns 160':         'PULSAR NS 160',
  'bajaj|pulsar ns 200':         'PULSAR NS 200',
  'bajaj|pulsar 200 ns':         'PULSAR NS 200',
  'bajaj|rouser ns 160':         'PULSAR NS 160',
  'bajaj|rouser ns 200':         'PULSAR NS 200',
  'bajaj|pulsar rs 200':         'PULSAR RS 200',
  'royal enfield|meteor 350':    'METEOR 350',
  'royal enfield|classic 350':   'CLASSIC 350',
  'royal enfield|bullet 350':    'BULLET 350',
  'royal enfield|himalayan':     'HIMALAYAN',
  'royal enfield|scram 411':     'SCRAM 411',
  'royal enfield|hunter 350':    'HUNTER 350',
  'royal enfield|guerrilla 450': 'GUERRILLA 450',
  'shineray|xy125-6a':           'XY 125',
  'jtz|downtown 300':            'DOWNTOWN 300i',
  'jtz|dr160':                   'DR 160',
};

// ===================== MATCHING (porta exata do index.html, cobertura de tokens) =====================

function normFipe(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[-./]/g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreModelo(fipeNome, termo) {
  const fn = normFipe(fipeNome);
  const mn = normFipe(termo);
  if (fn === mn) return 1000;

  const tokensQuery = mn.split(/\s+/).filter(p => p.length > 0);
  const tokensFipe  = fn.split(/\s+/).filter(p => p.length > 0);

  let matched = 0;
  for (const t of tokensQuery) {
    if (tokensFipe.includes(t)) matched += 1;
    else if (tokensFipe.some(f => f.startsWith(t) || t.startsWith(f))) matched += 0.5;
  }
  const coverage = matched / tokensQuery.length;
  const extra = Math.max(0, tokensFipe.length - tokensQuery.length);
  let score = coverage * 100 - extra * 3;

  const nums = tokensQuery.filter(t => /^\d{2,4}$/.test(t));
  for (const n of nums) { if (!tokensFipe.includes(n)) score -= 40; }

  return score;
}

function fipeKey(m) { return `${m.marca}|${m.modelo}|${(m.ano || '').split('/')[0]}`; }

// Converte ano curto (2 dígitos) pro ano completo antes de comparar com os
// anos de 4 dígitos retornados pela FIPE — sem isso, parseInt("26") vira 26 e
// a diferença contra qualquer ano real (ex: 2016) nunca fica <=3, então o
// fallback de "ano mais próximo" nunca dispara e sempre cai em anos[0].
function anoParaAnoCompleto(ano) {
  const n = parseInt(ano, 10);
  if (!n) return null;
  if (n >= 1900) return n;
  return n <= 30 ? 2000 + n : 1900 + n;
}

// ===================== CILINDRADA / TRAVA DE SANIDADE =====================

function extrairCilindrada(modelo) {
  if (!modelo) return null;
  const nums = (String(modelo).match(/\d{2,4}/g) || []).map(Number).filter(n => n >= 49 && n <= 2500);
  return nums.length ? nums[0] : null;
}

function tetoPorCilindrada(cc) {
  if (!cc) return Infinity;
  if (cc <= 160) return 25000;
  if (cc <= 300) return 40000;
  if (cc <= 650) return 80000;
  return Infinity;
}

// ===================== CACHES (memória, por execução) =====================

let _marcas = null;
const _modelosCache = {};
const _anosCache = {};

async function carregarMarcas() {
  if (_marcas) return _marcas;
  const r = await fipeFetch(`${FIPE_BASE}/${USE_V2 ? 'brands' : 'marcas'}`);
  if (!Array.isArray(r)) throw new Error('não foi possível carregar marcas FIPE');
  _marcas = normLista(r);
  return _marcas;
}

async function carregarModelos(marcaCodigo) {
  if (_modelosCache[marcaCodigo]) return _modelosCache[marcaCodigo];
  const path = USE_V2 ? `brands/${marcaCodigo}/models` : `marcas/${marcaCodigo}/modelos`;
  const r = await fipeFetch(`${FIPE_BASE}/${path}`);
  const lista = USE_V2 ? r : (r ? r.modelos : []); // v2 retorna array direto; v1 vem envelopado em {modelos:[...]}
  _modelosCache[marcaCodigo] = normLista(lista || []);
  return _modelosCache[marcaCodigo];
}

async function carregarAnos(marcaCodigo, modeloCodigo) {
  const key = `${marcaCodigo}_${modeloCodigo}`;
  if (_anosCache[key]) return _anosCache[key];
  const path = USE_V2 ? `brands/${marcaCodigo}/models/${modeloCodigo}/years` : `marcas/${marcaCodigo}/modelos/${modeloCodigo}/anos`;
  const r = await fipeFetch(`${FIPE_BASE}/${path}`);
  _anosCache[key] = normLista(r || []);
  return _anosCache[key];
}

// Busca o modelo/valor FIPE para uma moto (marca→modelo→ano→valor), com os
// mesmos fallbacks e desambiguação por ano do index.html.
async function buscarModeloFipe(m) {
  const marcas = await carregarMarcas();

  const marcaLimpa = (normalizarMarca(m.marca) || m.marca).toLowerCase().replace(/[^a-z\s\-]/g, '').trim();
  const marcaNorm = normFipe(marcaLimpa);
  const marcaObj = marcas.find(x => normFipe(x.nome) === marcaNorm)
    || marcas.find(x => normFipe(x.nome).includes(marcaNorm))
    || marcas.find(x => marcaNorm.includes(normFipe(x.nome)))
    || marcas.find(x => normFipe(x.nome) === marcaNorm.split(' ')[0]);
  if (!marcaObj) return { erro: 'marca não encontrada' };

  const modelos = await carregarModelos(marcaObj.codigo);
  if (!modelos || !modelos.length) return { erro: 'sem modelos para a marca' };

  const sinonKeyOrig = `${marcaLimpa}|${m.modelo.toLowerCase()}`;
  const sinonKeyNorm = `${marcaNorm}|${normFipe(m.modelo)}`;
  const termoBusca = FIPE_SINONIMOS[sinonKeyOrig] || FIPE_SINONIMOS[sinonKeyNorm]
    || FIPE_SINONIMOS[`${m.marca.toLowerCase()}|${m.modelo.toLowerCase()}`]
    || m.modelo;

  const tentativas = [termoBusca];

  const semSufixo = normFipe(termoBusca)
    .replace(/\b(abs|cbs|es|esd|esdi|esdd|adv|sed|seds|plus|sport|dlx|pro|limited|edition|ed|ex|ks|fan|titan|start|cargo)\b/g, '')
    .replace(/\s+/g, ' ').trim();
  if (semSufixo !== normFipe(termoBusca) && semSufixo.length > 2) tentativas.push(semSufixo);

  const numMatch = normFipe(m.modelo).match(/^([a-z]+[\s]?\d+[a-z]?)/);
  if (numMatch && !tentativas.includes(numMatch[1])) tentativas.push(numMatch[1]);

  const soNum = normFipe(m.modelo).match(/\b(\d{3})\b/);
  if (soNum) {
    const prefixo = normFipe(m.modelo).match(/^([a-z]+)/);
    if (prefixo) tentativas.push(`${prefixo[1]} ${soNum[1]}`);
  }

  const fb4Sigla = normFipe(m.modelo).match(/^([a-z]{2,})/);
  const fb4Num = normFipe(m.modelo).match(/\b(\d{2,4})\b/);
  if (fb4Sigla && fb4Num) {
    const fb4 = `${fb4Sigla[1]} ${fb4Num[1]}`;
    if (!tentativas.some(t => normFipe(t) === fb4)) tentativas.push(fb4);
  }

  let modeloObj = null;
  let altCandidatos = [];
  for (const tentativa of tentativas) {
    const scored = modelos
      .map(x => ({ x, score: scoreModelo(x.nome, tentativa) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score
        || normFipe(a.x.nome).split(/\s+/).length - normFipe(b.x.nome).split(/\s+/).length);
    const minScore = 55;
    if (scored.length && scored[0].score >= minScore) {
      modeloObj = scored[0].x;
      altCandidatos = scored.slice(1).filter(x => x.score >= scored[0].score * 0.7 && x.score >= minScore).map(x => x.x);
      break;
    }
  }
  if (!modeloObj) return { erro: 'modelo não encontrado', tentativas };

  const anoFab = (m.ano || '').split('/')[0].replace(/\D/g, '');
  const anoMod = (m.ano || '').split('/')[1]?.replace(/\D/g, '');
  let anos = await carregarAnos(marcaObj.codigo, modeloObj.codigo);
  if (!anos || !anos.length) return { erro: 'sem anos disponíveis' };

  if (anoFab && altCandidatos.length) {
    const temAno = anos.some(a => a.nome.startsWith(anoFab) || a.nome.includes(anoFab));
    if (!temAno) {
      for (const alt of altCandidatos) {
        const anosAlt = await carregarAnos(marcaObj.codigo, alt.codigo);
        if (anosAlt && anosAlt.some(a => a.nome.startsWith(anoFab) || a.nome.includes(anoFab))) {
          modeloObj = alt;
          anos = anosAlt;
          break;
        }
      }
    }
  }

  let anoObj = anos.find(a => a.nome.startsWith(anoFab))
    || anos.find(a => a.nome.includes(anoFab))
    || (anoMod ? anos.find(a => a.nome.includes(anoMod)) : null);
  if (!anoObj && anoFab) {
    const target = anoParaAnoCompleto(anoFab);
    const comAno = anos.map(a => ({ a, y: parseInt((a.nome.match(/^(\d{4})/) || [])[1] || 0) })).filter(x => x.y);
    comAno.sort((a, b) => Math.abs(a.y - target) - Math.abs(b.y - target));
    if (target && comAno.length && Math.abs(comAno[0].y - target) <= 3) anoObj = comAno[0].a;
  }
  if (!anoObj) anoObj = anos[0];
  if (!anoObj) return { erro: 'ano não resolvido' };

  const valorPath = USE_V2
    ? `brands/${marcaObj.codigo}/models/${modeloObj.codigo}/years/${anoObj.codigo}`
    : `marcas/${marcaObj.codigo}/modelos/${modeloObj.codigo}/anos/${anoObj.codigo}`;
  const dados = await fipeFetch(`${FIPE_BASE}/${valorPath}`);
  const valorStr = USE_V2 ? dados?.price : dados?.Valor;
  if (!dados || !valorStr) return { erro: 'valor não retornado pela API' };
  const valor = parseFloat(valorStr.replace('R$ ', '').replace(/\./g, '').replace(',', '.'));

  return {
    valor,
    marcaCodigo: marcaObj.codigo,
    modeloCodigo: modeloObj.codigo,
    modeloNomeFipe: USE_V2 ? dados.model : dados.Modelo,
    marcaNomeFipe: USE_V2 ? dados.brand : dados.Marca,
    codigoFipe: USE_V2 ? dados.codeFipe : dados.CodigoFipe,
    mesReferencia: USE_V2 ? dados.referenceMonth : dados.MesReferencia,
    combustivel: USE_V2 ? dados.fuel : dados.Combustivel,
  };
}

// ===================== PERSISTÊNCIA =====================

const MESES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

async function salvarFipeValores(m, resultado) {
  const key = fipeKey(m);
  const mesRef = (resultado.mesReferencia || '').trim();
  const partes = mesRef.toLowerCase().split(' de ');
  const refMes = MESES_PT.indexOf(partes[0]) + 1 || null;
  const refAno = partes[1] ? parseInt(partes[1]) : new Date().getFullYear();
  const anoFab = parseInt((m.ano || '').split('/')[0]) || null;

  const payload = {
    marca_codigo: resultado.marcaCodigo,
    modelo_codigo: resultado.modeloCodigo,
    ano_modelo: anoFab,
    combustivel: resultado.combustivel || null,
    valor: resultado.valor,
    mes_referencia: resultado.mesReferencia || null,
    codigo_fipe: resultado.codigoFipe || null,
    lookup_key: key,
    marca_nome: resultado.marcaNomeFipe || null,
    modelo_nome: resultado.modeloNomeFipe || null,
    referencia_mes: refMes,
    referencia_ano: refAno,
  };

  if (DRY_RUN) return;
  await supaFetch('fipe_valores?on_conflict=lookup_key', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify(payload),
  });
}

async function atualizarFipeCsv(ids, valor) {
  if (!ids.length || DRY_RUN) return;
  await supaFetch(`motos?id=in.(${ids.join(',')})`, {
    method: 'PATCH',
    body: JSON.stringify({ fipe_csv: valor }),
  });
}

// ===================== ETAPA 1: LIMPEZA DE fipe_valores COM BUG ANTIGO =====================
// Assinatura do bug: o script antigo gravava marca_nome/modelo_nome com o texto
// cru do banco (ex: "Yamaha"/"Fz25 Fazer") em vez do nome real da FIPE (que a
// API sempre retorna em CAIXA ALTA, ex: "YAMAHA"/"FZ25 FAZER THOR FLEX").
async function limparFipeValoresRuins() {
  console.log('\n🧹 Etapa 1/2 — varrendo fipe_valores em busca de registros do bug antigo...\n');
  const rows = await supaFetchAll('fipe_valores?select=id,lookup_key,marca_nome,modelo_nome,valor');
  console.log(`   ${rows.length} registros em fipe_valores`);

  // Só a assinatura do bug (marca_nome com o texto cru do banco em vez do nome
  // real da FIPE) é usada para apagar histórico. O teto por cilindrada é uma
  // heurística grosseira (existem scooters premium — ADV 160, SXR 160 — cujo
  // valor real passa dos ~25k para 160cc); aplicar esse teto aqui apagaria
  // registros corretos. Ele só entra como trava em cima de matches NOVOS na
  // Etapa 2, onde uma rejeição errada apenas pula a atualização (sem perda).
  const ruins = [];
  for (const r of rows) {
    const marcaSuspeita = r.marca_nome && r.marca_nome !== r.marca_nome.toUpperCase();
    if (marcaSuspeita) {
      ruins.push({ ...r, motivo: 'marca_nome não é nome FIPE real' });
    }
  }

  console.log(`   ${ruins.length} registros suspeitos (serão ${DRY_RUN ? 'listados' : 'apagados'})\n`);
  for (const r of ruins) {
    console.log(`   ${DRY_RUN ? '[dry-run] apagaria' : '🗑️  apagando'} id=${r.id} "${r.lookup_key}" — ${r.motivo}`);
  }

  if (!DRY_RUN && ruins.length) {
    const ids = ruins.map(r => r.id);
    const chunkSize = 200;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      await supaFetch(`fipe_valores?id=in.(${chunk.join(',')})`, { method: 'DELETE' });
    }
  }

  return { total: rows.length, ruins: ruins.length };
}

// ===================== ETAPA 2: REPROCESSAMENTO =====================

async function buscarMotosEscopo() {
  if (ESCOPO === 'all') {
    console.log('   Escopo: TODAS as motos (histórico incluso)');
    return supaFetchAll('motos?select=id,marca,modelo,ano,cilindrada,fipe_csv&marca=not.is.null&modelo=not.is.null&ano=not.is.null');
  }
  console.log('   Escopo: motos de leilões ATIVOS (encerrado=false)');
  return supaFetchAll('motos?select=id,marca,modelo,ano,cilindrada,fipe_csv,leiloes!inner(encerrado)&leiloes.encerrado=eq.false&marca=not.is.null&modelo=not.is.null&ano=not.is.null');
}

async function reprocessar() {
  console.log('\n🔍 Etapa 2/2 — reprocessando FIPE das motos...\n');
  const motos = await buscarMotosEscopo();
  console.log(`   ${motos.length} motos no escopo`);

  const grupos = new Map(); // key -> { m: moto-exemplar, ids: [...], ccs: Set }
  for (const m of motos) {
    const key = fipeKey(m);
    if (!grupos.has(key)) grupos.set(key, { m, ids: [], ccs: new Set() });
    const g = grupos.get(key);
    g.ids.push(m.id);
    if (m.cilindrada) g.ccs.add(m.cilindrada);
  }
  console.log(`   ${grupos.size} modelos únicos (marca|modelo|ano) a processar\n`);

  let corrigidos = 0, descartados = 0, naoEncontrados = 0, i = 0;
  const total = grupos.size;

  for (const [key, g] of grupos) {
    i++;
    const { m, ids } = g;
    const cc = g.ccs.size ? [...g.ccs][0] : extrairCilindrada(m.modelo);
    process.stdout.write(`[${i}/${total}] ${key} (${ids.length} motos, ~${cc || '?'}cc) ... `);

    let resultado;
    try {
      resultado = await buscarModeloFipe(m);
    } catch (e) {
      resultado = { erro: e.message };
    }

    if (resultado.erro) {
      console.log(`❌ não encontrado (${resultado.erro})`);
      naoEncontrados++;
      await limparFipeCsvSeAcimaDoTeto(ids, cc);
      await sleep(350);
      continue;
    }

    const teto = tetoPorCilindrada(cc);
    const ccMatch = extrairCilindrada(resultado.modeloNomeFipe);
    const ccDivergente = cc && ccMatch && (ccMatch > cc * 2.2 || ccMatch < cc / 2.2);

    if (resultado.valor > teto) {
      console.log(`⚠️  descartado (valor suspeito: R$ ${resultado.valor.toLocaleString('pt-BR')} > teto R$ ${teto.toLocaleString('pt-BR')} para ~${cc}cc — match: "${resultado.modeloNomeFipe}")`);
      descartados++;
      await limparFipeCsvSeAcimaDoTeto(ids, cc);
    } else if (ccDivergente) {
      console.log(`⚠️  descartado (cilindrada do match muito diferente: query ~${cc}cc vs match "${resultado.modeloNomeFipe}" ~${ccMatch}cc)`);
      descartados++;
      await limparFipeCsvSeAcimaDoTeto(ids, cc);
    } else {
      console.log(`✅ match "${resultado.modeloNomeFipe}" R$ ${resultado.valor.toLocaleString('pt-BR')}`);
      corrigidos++;
      try {
        await salvarFipeValores(m, resultado);
      } catch (e) {
        // Duas motos com "modelo" textual diferente podem casar no mesmo
        // (marca_codigo, modelo_codigo, ano_modelo, combustivel) da FIPE —
        // constraint única colide mesmo com on_conflict=lookup_key. Não é
        // fatal: fipe_csv da moto (o que importa pro usuário) é gravado
        // independente disso.
        console.log(`   ⚠️  fipe_valores não gravado (${e.message.split('\n')[0]})`);
      }
      await atualizarFipeCsv(ids, resultado.valor);
    }

    await sleep(350);
  }

  console.log(`\n✅ Reprocessamento concluído: ${corrigidos} corrigidos/preenchidos, ${descartados} descartados por sanidade, ${naoEncontrados} não encontrados — de ${total} modelos únicos.`);
}

async function limparFipeCsvSeAcimaDoTeto(ids, cc) {
  const teto = tetoPorCilindrada(cc);
  if (teto === Infinity) return;
  // Só limpa quem já tem fipe_csv preenchido e acima do teto (não mexe no resto)
  if (DRY_RUN) return;
  await supaFetch(`motos?id=in.(${ids.join(',')})&fipe_csv=gt.${teto}`, {
    method: 'PATCH',
    body: JSON.stringify({ fipe_csv: null }),
  });
}

// ===================== MAIN =====================

async function main() {
  console.log(`🏍️  Reprocessamento FIPE${DRY_RUN ? ' — DRY RUN (nada será gravado)' : ''}`);
  const limpeza = await limparFipeValoresRuins();
  await reprocessar();
  console.log(`\n📊 Resumo: ${limpeza.ruins}/${limpeza.total} registros de fipe_valores estavam com o bug antigo.`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
