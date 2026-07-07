#!/usr/bin/env node
'use strict';

/**
 * Script de pré-população de FIPE (backfill manual — não é chamado por
 * nenhum workflow do GitHub Actions)
 * Busca FIPE de todas as motos sem fipe_csv e salva no banco
 *
 * Uso:
 *   node scripts/popular-fipe.js             # grava no banco
 *   DRY_RUN=1 node scripts/popular-fipe.js   # só loga, não grava nada
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SUPA_URL = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const FIPE_BASE = 'https://fipe.parallelum.com.br/api/v2/motorcycles';
const DRY_RUN = process.env.DRY_RUN === '1';

// Trava de cota diária da API FIPE — conta requisições HTTP reais (não
// modelos), igual ao reprocessar-fipe.js.
const REQ_LIMIT = parseInt(process.env.REQ_LIMIT || '900', 10);
let reqCount = 0;

if (!SUPA_KEY) { console.error('❌ SUPABASE_SERVICE_KEY (ou SUPABASE_KEY) não definido'); process.exit(1); }

// Cache em memória
let _marcas = null;
const _modelosCache = {};
const _anosCache = {};

function normFipe(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const SINONIMOS = {
  'honda|elite': 'elite 125',
  'honda|xre sahara': 'xre 300',
  'honda|xre sahara 300': 'xre 300',
  'royal enfield|classic': 'classic 350',
  'honda|cb 250 f': 'cb 250 f twister',
  'honda|pop 100': 'pop 100',
  'honda|biz ex': 'biz 125 ex',
};

const FIPE_HEADERS = process.env.FIPE_TOKEN
  ? { 'X-Subscription-Token': process.env.FIPE_TOKEN }
  : {};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiFetch(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    reqCount++;
    try {
      const r = await fetch(url, { headers: FIPE_HEADERS });
      if (r.status === 429) {
        process.stdout.write(' [rate limit, aguardando 2s]');
        await sleep(2000);
        continue;
      }
      if (!r.ok) {
        if (attempt === 0) {
          process.stdout.write(' [erro, retry em 2s]');
          await sleep(2000);
          continue;
        }
        return null;
      }
      await sleep(300);
      return await r.json();
    } catch(e) {
      if (attempt === 0) { await sleep(2000); continue; }
      return null;
    }
  }
  return null;
}

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

function scoreModelo(nome, termo) {
  const n = normFipe(nome);
  const t = normFipe(termo);
  const tokensN = n.split(/\s+/).filter(Boolean);
  const tokensT = t.split(/\s+/).filter(Boolean);
  if (!tokensT.length) return 0;
  let hits = 0;
  for (const tk of tokensT) {
    if (tokensN.some(tn => tn === tk || tn.startsWith(tk) || tk.startsWith(tn))) hits++;
  }
  if (hits === 0) return 0;
  const cobertura = hits / tokensT.length;
  const excesso = Math.max(0, tokensN.length - tokensT.length);
  return cobertura * 100 - excesso * 2;
}

function fipeKey(m) { return `${m.marca}|${m.modelo}|${(m.ano || '').split('/')[0]}`; }

async function buscarModeloFipe(m) {
  const marca = m.marca, modelo = m.modelo, ano = m.ano;

  // Carrega marcas (v2 retorna array direto de {code,name})
  if (!_marcas) {
    const rawMarcas = await apiFetch(`${FIPE_BASE}/brands`);
    if (!Array.isArray(rawMarcas)) return { erro: 'não foi possível carregar marcas FIPE' };
    _marcas = rawMarcas;
  }

  const marcaLimpa = normFipe(marca.replace(/\/[a-z]+\d*/gi, '').trim());
  const marcaObj = _marcas.find(x => normFipe(x.name) === marcaLimpa)
    || _marcas.find(x => normFipe(x.name).includes(marcaLimpa))
    || _marcas.find(x => marcaLimpa.includes(normFipe(x.name)));
  if (!marcaObj) return { erro: 'marca não encontrada' };

  // Carrega modelos (v2 retorna array direto de {code,name})
  if (!_modelosCache[marcaObj.code]) {
    const r = await apiFetch(`${FIPE_BASE}/brands/${marcaObj.code}/models`);
    _modelosCache[marcaObj.code] = Array.isArray(r) ? r : [];
  }
  const modelos = _modelosCache[marcaObj.code];
  if (!modelos.length) return { erro: 'sem modelos para a marca' };

  // Termos de busca
  const sinonKey1 = `${marcaLimpa}|${normFipe(modelo)}`;
  const sinonKey2 = `${normFipe(marca)}|${normFipe(modelo)}`;
  const termoBusca = SINONIMOS[sinonKey1] || SINONIMOS[sinonKey2] || normFipe(modelo);

  const tentativas = [termoBusca];

  const semSufixo = normFipe(termoBusca)
    .replace(/\b(abs|cbs|es|esd|esdi|adv|sed|seds|plus|sport|dlx|pro|limited|edition|ed|ex|ks|fan|titan|start|cargo)\b/g, '')
    .replace(/\s+/g, ' ').trim();
  if (semSufixo !== termoBusca && semSufixo.length > 2) tentativas.push(semSufixo);

  const numMatch = normFipe(modelo).match(/^([a-z]+[\s]?\d+)/);
  if (numMatch && !tentativas.includes(numMatch[1])) tentativas.push(numMatch[1]);

  const palavras = normFipe(modelo).split(/\s+/);
  const primeiraLetra = palavras.find(p => /^[a-z]+$/.test(p));
  const primeiroNum = normFipe(modelo).match(/\d{2,}/);
  if (primeiraLetra && primeiroNum) {
    const combo = `${primeiraLetra} ${primeiroNum[0]}`;
    if (!tentativas.includes(combo)) tentativas.push(combo);
  }

  let modeloObj = null;
  for (const tentativa of tentativas) {
    const scored = modelos
      .map(x => ({ x, score: scoreModelo(x.name, tentativa) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const nTokens = normFipe(tentativa).split(/\s+/).filter(p => p.length > 0).length;
    const minScore = nTokens <= 1 ? 15 : nTokens === 2 ? 22 : 30;
    if (scored.length && scored[0].score >= minScore) {
      modeloObj = scored[0].x;
      break;
    }
  }
  if (!modeloObj) return { erro: 'modelo não encontrado', tentativas };

  // Carrega anos (v2 retorna array direto de {code,name})
  const anosKey = `${marcaObj.code}_${modeloObj.code}`;
  if (!_anosCache[anosKey]) {
    const r = await apiFetch(`${FIPE_BASE}/brands/${marcaObj.code}/models/${modeloObj.code}/years`);
    _anosCache[anosKey] = Array.isArray(r) ? r : [];
  }
  const anos = _anosCache[anosKey];
  if (!anos.length) return { erro: 'sem anos disponíveis' };

  const anoFab = (ano || '').split('/')[0].replace(/\D/g, '');
  let anoObj = anos.find(a => a.name.startsWith(anoFab))
    || anos.find(a => a.name.includes(anoFab));

  if (!anoObj && anoFab) {
    const target = parseInt(anoFab);
    const comAno = anos.map(a => ({
      a,
      y: parseInt((a.name.match(/^(\d{4})/) || [])[1] || 0)
    })).filter(x => x.y);
    comAno.sort((a, b) => Math.abs(a.y - target) - Math.abs(b.y - target));
    if (comAno.length && Math.abs(comAno[0].y - target) <= 3) anoObj = comAno[0].a;
  }
  if (!anoObj) anoObj = anos[0];
  if (!anoObj) return { erro: 'ano não resolvido' };

  // Busca valor — campos v2: price/brand/model/codeFipe/referenceMonth/fuel
  const dados = await apiFetch(`${FIPE_BASE}/brands/${marcaObj.code}/models/${modeloObj.code}/years/${anoObj.code}`);
  if (!dados || !dados.price) return { erro: 'valor não retornado pela API' };

  const valor = parseFloat(dados.price.replace('R$ ', '').replace(/\./g, '').replace(',', '.'));

  return {
    valor,
    marcaCodigo: marcaObj.code,
    modeloCodigo: modeloObj.code,
    modeloNomeFipe: dados.model,
    marcaNomeFipe: dados.brand,
    codigoFipe: dados.codeFipe,
    mesReferencia: dados.referenceMonth,
    combustivel: dados.fuel,
  };
}

// ===================== LISTA DE FALHAS CONHECIDAS (compartilhada com reprocessar-fipe.js) =====================

const SKIP_LIST_PATH = path.join(__dirname, 'fipe-nao-encontrados.json');

function loadSkipList() {
  try {
    const arr = JSON.parse(fs.readFileSync(SKIP_LIST_PATH, 'utf8'));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveSkipList(set) {
  if (DRY_RUN) return;
  fs.writeFileSync(SKIP_LIST_PATH, JSON.stringify([...set].sort(), null, 2) + '\n');
}

function commitESendSkipList() {
  if (DRY_RUN) return;
  const cwd = path.join(__dirname, '..');
  try {
    const status = execSync('git status --porcelain -- scripts/fipe-nao-encontrados.json', { cwd }).toString().trim();
    if (!status) { console.log('\n(lista de falhas sem mudanças — commit pulado)'); return; }
    execSync('git add scripts/fipe-nao-encontrados.json', { cwd });
    execSync(`git commit -m ${JSON.stringify('chore: atualiza lista de modelos FIPE não encontrados (pré-população manual)')}`, { cwd });
    execSync('git push', { cwd });
    console.log('\n✅ scripts/fipe-nao-encontrados.json commitado e enviado (git push).');
  } catch (e) {
    console.error('\n⚠️  falha ao commitar/enviar lista de falhas:', e.message.split('\n')[0]);
  }
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
    marca_codigo: String(resultado.marcaCodigo),
    modelo_codigo: String(resultado.modeloCodigo),
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

async function main() {
  console.log(`🏍️  Pré-população FIPE${DRY_RUN ? ' — DRY RUN (nada será gravado)' : ''} iniciando...\n`);

  const motos = await supaFetch(
    'motos?fipe_csv=is.null&marca=not.is.null&modelo=not.is.null&select=id,marca,modelo,ano,leilao_id',
    { prefer: 'return=representation' }
  );
  console.log(`📋 ${motos.length} motos sem FIPE`);

  // Agrupa por modelo único (marca|modelo|ano) — evita reconsultar a API pra
  // cada moto individual, igual ao reprocessar-fipe.js.
  const grupos = new Map();
  for (const m of motos) {
    const key = fipeKey(m);
    if (!grupos.has(key)) grupos.set(key, { m, ids: [] });
    grupos.get(key).ids.push(m.id);
  }
  console.log(`   ${grupos.size} modelos únicos (marca|modelo|ano) a processar`);

  const skipSet = loadSkipList();
  console.log(`   ${skipSet.size} já na lista de falhas conhecidas (serão pulados sem custo de cota)\n`);

  let ok = 0, falhou = 0, pulados = 0, i = 0;
  let cortadoPorCota = false;
  const total = grupos.size;

  for (const [key, g] of grupos) {
    i++;

    if (skipSet.has(key)) { pulados++; continue; }

    if (reqCount >= REQ_LIMIT) {
      console.log(`\n🛑 Trava de cota acionada (${reqCount}/${REQ_LIMIT} requisições) — parando em [${i}/${total}].`);
      cortadoPorCota = true;
      break;
    }

    const { m, ids } = g;
    process.stdout.write(`[${i}/${total}] ${key} (${ids.length} motos) ... `);

    let resultado;
    try {
      resultado = await buscarModeloFipe(m);
    } catch (e) {
      resultado = { erro: e.message };
    }

    if (resultado.erro) {
      console.log(`❌ não encontrado (${resultado.erro})`);
      falhou++;
      skipSet.add(key);
      await sleep(200);
      continue;
    }

    console.log(`✅ "${resultado.modeloNomeFipe}" R$ ${resultado.valor.toLocaleString('pt-BR')}`);
    ok++;

    if (!DRY_RUN) {
      await supaFetch(`motos?id=in.(${ids.join(',')})`, {
        method: 'PATCH',
        body: JSON.stringify({ fipe_csv: resultado.valor }),
      });
    }
    try {
      await salvarFipeValores(m, resultado);
    } catch (e) {
      console.log(`   ⚠️  fipe_valores não gravado (${e.message.split('\n')[0]})`);
    }

    await sleep(200);
  }

  saveSkipList(skipSet);
  commitESendSkipList();

  console.log(`\n✅ Pré-população ${cortadoPorCota ? 'interrompida pela trava de cota' : 'concluída'}: ${ok} encontrados, ${falhou} não encontrados, ${pulados} pulados (falha conhecida) — de ${total} modelos únicos.`);
  console.log(`   Requisições usadas: ${reqCount}/${REQ_LIMIT}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
