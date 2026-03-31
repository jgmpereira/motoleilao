#!/usr/bin/env node
'use strict';

/**
 * Script de pré-população de FIPE
 * Busca FIPE de todas as motos sem fipe_csv e salva no banco
 */

const SUPA_URL = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY = process.env.SUPABASE_KEY;
const FIPE_BASE = 'https://parallelum.com.br/fipe/api/v1/motos';

if (!SUPA_KEY) { console.error('❌ SUPABASE_KEY não definido'); process.exit(1); }

// Cache em memória
const _marcasCache = null;
let _marcas = null;
const _modelosCache = {};
const _anosCache = {};

function normFipe(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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

async function apiFetch(url) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) { await sleep(3000 * (t+1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch(e) { await sleep(2000); }
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function buscarFipe(marca, modelo, ano) {
  // Carrega marcas
  if (!_marcas) {
    _marcas = await apiFetch(`${FIPE_BASE}/marcas`);
    if (!_marcas) return null;
  }

  const marcaLimpa = normFipe(marca.replace(/\/[a-z]+\d*/gi, '').trim());
  const marcaObj = _marcas.find(x => normFipe(x.nome) === marcaLimpa)
    || _marcas.find(x => normFipe(x.nome).includes(marcaLimpa))
    || _marcas.find(x => marcaLimpa.includes(normFipe(x.nome)));
  if (!marcaObj) return null;

  // Carrega modelos
  if (!_modelosCache[marcaObj.codigo]) {
    const r = await apiFetch(`${FIPE_BASE}/marcas/${marcaObj.codigo}/modelos`);
    _modelosCache[marcaObj.codigo] = r ? r.modelos : [];
  }
  const modelos = _modelosCache[marcaObj.codigo];

  // Termos de busca
  const sinonKey1 = `${marcaLimpa}|${normFipe(modelo)}`;
  const sinonKey2 = `${normFipe(marca)}|${normFipe(modelo)}`;
  const termoBusca = SINONIMOS[sinonKey1] || SINONIMOS[sinonKey2] || normFipe(modelo);

  const tentativas = [termoBusca];
  
  // Fallback sem sufixos
  const semSufixo = normFipe(termoBusca)
    .replace(/\b(abs|cbs|es|esd|esdi|adv|sed|seds|plus|sport|dlx|pro|limited|edition|ed|ex|ks|fan|titan|start|cargo)\b/g, '')
    .replace(/\s+/g, ' ').trim();
  if (semSufixo !== termoBusca && semSufixo.length > 2) tentativas.push(semSufixo);

  // Fallback letra+número
  const numMatch = normFipe(modelo).match(/^([a-z]+[\s]?\d+)/);
  if (numMatch && !tentativas.includes(numMatch[1])) tentativas.push(numMatch[1]);

  // Fallback sigla + número de qualquer posição
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
      .map(x => ({ x, score: scoreModelo(x.nome, tentativa) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const nTokens = normFipe(tentativa).split(/\s+/).filter(p => p.length > 0).length;
    const minScore = nTokens <= 1 ? 15 : nTokens === 2 ? 22 : 30;
    if (scored.length && scored[0].score >= minScore) {
      modeloObj = scored[0].x;
      break;
    }
  }
  if (!modeloObj) return null;

  // Carrega anos
  const anosKey = `${marcaObj.codigo}_${modeloObj.codigo}`;
  if (!_anosCache[anosKey]) {
    const r = await apiFetch(`${FIPE_BASE}/marcas/${marcaObj.codigo}/modelos/${modeloObj.codigo}/anos`);
    _anosCache[anosKey] = r || [];
  }
  const anos = _anosCache[anosKey];
  if (!anos.length) return null;

  // Encontra ano
  const anoFab = (ano || '').split('/')[0].replace(/\D/g, '');
  let anoObj = anos.find(a => a.nome.startsWith(anoFab))
    || anos.find(a => a.nome.includes(anoFab));
  
  if (!anoObj && anoFab) {
    const target = parseInt(anoFab);
    const comAno = anos.map(a => ({
      a,
      y: parseInt((a.nome.match(/^(\d{4})/) || [])[1] || 0)
    })).filter(x => x.y);
    comAno.sort((a, b) => Math.abs(a.y - target) - Math.abs(b.y - target));
    if (comAno.length && Math.abs(comAno[0].y - target) <= 3) anoObj = comAno[0].a;
  }
  if (!anoObj) anoObj = anos[0];
  if (!anoObj) return null;

  // Busca valor
  const dados = await apiFetch(`${FIPE_BASE}/marcas/${marcaObj.codigo}/modelos/${modeloObj.codigo}/anos/${anoObj.codigo}`);
  if (!dados || !dados.Valor) return null;
  
  const val = parseFloat(dados.Valor.replace('R$ ', '').replace(/\./g, '').replace(',', '.'));
  
  return {
    valor: val,
    marcaCodigo: marcaObj.codigo,
    modeloCodigo: modeloObj.codigo,
    codigoFipe: dados.CodigoFipe,
    modeloNome: modeloObj.nome,
  };
}

async function main() {
  console.log('🏍️  Pré-população FIPE iniciando...\n');

  // Busca motos sem fipe_csv
  const motos = await supaFetch(
    'motos?fipe_csv=is.null&marca=not.is.null&modelo=not.is.null&select=id,marca,modelo,ano,leilao_id',
    { prefer: 'return=representation' }
  );

  console.log(`📋 ${motos.length} motos sem FIPE\n`);

  let ok = 0, falhou = 0, i = 0;

  for (const m of motos) {
    i++;
    process.stdout.write(`[${i}/${motos.length}] ${m.marca} ${m.modelo} ${m.ano} ... `);

    try {
      const result = await buscarFipe(m.marca, m.modelo, m.ano);
      
      if (result) {
        // Salva fipe_csv na moto (prioritário)
        await supaFetch(`motos?id=eq.${m.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ fipe_csv: result.valor }),
        });

        // Salva em fipe_valores para cache futuro (erro 409 não impede o fipe_csv)
        try {
        const mesAtual = new Date().getMonth() + 1;
        const anoAtual = new Date().getFullYear();
        const lookupKey = `${m.marca}|${m.modelo}|${(m.ano||'').split('/')[0].replace(/\D/g,'')}`;
        
        await supaFetch('fipe_valores?on_conflict=lookup_key', {
          method: 'POST',
          body: JSON.stringify({
            marca_codigo: String(result.marcaCodigo),
            modelo_codigo: String(result.modeloCodigo),
            ano_modelo: parseInt((m.ano||'').split('/')[0]) || 0,
            combustivel: 'Gasolina',
            valor: result.valor,
            mes_referencia: `${String(mesAtual).padStart(2,'0')}/${anoAtual}`,
            lookup_key: lookupKey,
            codigo_fipe: result.codigoFipe || '',
            marca_nome: m.marca,
            modelo_nome: m.modelo,
            referencia_mes: mesAtual,
            referencia_ano: anoAtual,
          }),
          prefer: 'resolution=merge-duplicates,return=minimal',
        });
        } catch(cacheErr) { /* ignora erro de cache duplicado */ }

        console.log(`✅ R$ ${result.valor.toLocaleString('pt-BR')}`);
        ok++;
      } else {
        console.log(`❌ não encontrado`);
        falhou++;
      }
    } catch(e) {
      console.log(`❌ erro: ${e.message}`);
      falhou++;
    }

    // Pausa pequena para não sobrecarregar a API
    await sleep(300);
  }

  console.log(`\n✅ Concluído: ${ok} encontrados, ${falhou} não encontrados de ${motos.length} total`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
