#!/usr/bin/env node
'use strict';

/**
 * Scraper de leilões encerrados — Freitas Leiloeiro
 *
 * 1. Busca leilões Freitas na janela de 3 dias no Supabase (independente de encerrado)
 * 2. Para cada moto com URL LoteDetalhes: GET único na página de detalhe (retry 3x)
 * 3. Extrai: status, valor (maior lance), estado/UF, descricao_resumo, alertas
 * 4. Grava arrematados (DELETE + INSERT) para vendido/condicional com valor
 * 5. PATCH motos com estado (se vazio), descricao_resumo e alertas
 *
 * ⚠️ Domínio freitasleiloeiro.com.br bloqueado no Codespaces — só roda via Actions.
 */

const https = require('https');
const { extrairUF, detectarAlertas } = require('./_utils');

const SUPA_URL = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY = process.env.SUPABASE_KEY;

if (!SUPA_KEY) {
  console.error('❌  SUPABASE_KEY não definido');
  process.exit(1);
}

// ── HTTP helper (mesmo padrão do freitas.js) ──────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer':         'https://www.freitasleiloeiro.com.br/',
        'Accept-Language': 'pt-BR,pt;q=0.9',
      },
      rejectUnauthorized: false,
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

// ── parseLance: "40.000,00" → 40000 ──────────────────────────────────────────
function parseLance(vlr) {
  if (!vlr) return null;
  const num = parseFloat(vlr.replace(/[R$\s.]/g, '').replace(',', '.'));
  return isNaN(num) || num <= 0 ? null : num;
}

// ── Fetch HTML com retry (falha de 1 lote não aborta o leilão) ────────────────
async function fetchDetalhes(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await httpGet(url);
      if (res.status === 200) return res.body;
      console.warn(`    ⚠️ HTTP ${res.status} tentativa ${attempt}/3: ${url}`);
    } catch (err) {
      console.warn(`    ⚠️ Erro tentativa ${attempt}/3: ${err.message}`);
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
  }
  return null;
}

// ── stripHtml: converte HTML em texto limpo (blocos → \n\n) ───────────────────
function stripHtml(html) {
  return html
    .replace(/<\/(p|div|li|td|tr|section|article|h[1-6])\b[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ');
}

// ── Filtro por allowlist de conteúdo útil ────────────────────────────────────
// Ruído: qualquer trecho que contenha estas palavras é descartado
const NOISE_RE = /DECLARA|PORTARIA|\bDETRAN\b|\bCONTRAN\b|RESOLU[ÇC][ÃA]O|\bATPV\b|DOCUMENTA[ÇC][ÃA]O|\bDOCUMENTOS\b|PRAZO|RESPONSABILIDADE|TERMO\s+DE\s+RESP|REC\.?\s*DE\s+FIRMA|CAT[ÁA]LOGO|CONCRETIZA[ÇC][ÃA]O|PAGAMENTO|TRANSFER[ÊE]NCIA|ARREMATANTE|COMITENTE|D[ÉE]BITOS|MULTAS|AVERBA[ÇC][ÃA]O|PONTUA[ÇC][ÃA]O|RESTRI[ÇC][ÃA]O|EMPLACAMENTO|REGULARIZA[ÇC]|LACRA[ÇC]|MERCOSUL|ESTAMPAGEM|PER[ÍI]CIA|\bLAUDO\b|\bECV\b|\bCSV\b|BANC[ÁA]RIA|PROPRIEDADE|PESSOA\s+JUR[ÍI]DICA|S[ÓO]CIO/i;
// Útil: indica condição ou defeito relevante para o comprador
const USEFUL_RE = /SINISTRAD|MONTA|CIRCUL|VEDADA|DANOS\s+ESTRUTURAIS|SEM\s+CHAVE|SUSPENS[ÃA]O|HOD[OÔ]METRO|ROUBO|FURTO|DANIFICAD|AUSENTE|FALTA|EMBREAGEM|CORRENTE|C[ÂA]MBIO|VENDIDO\s+NO\s+ESTADO|MEC[ÂA]NICA\s+SEM\s+TESTE|CABO\s+CARREGAMENTO|RECUPERAD|\bMOTOR\b/i;
// Útil forte: justifica aparar rabo de ruído no mesmo trecho
const STRONG_RE = /SINISTRAD|MONTA|CIRCUL|VEDADA|DANOS\s+ESTRUTURAIS|SEM\s+CHAVE|SUSPENS[ÃA]O|ROUBO|FURTO|RECUPERAD|DANIFICAD/i;
// IPVA
const IPVA_PAGO_RE = /IPVA.{0,80}(?:PAGO|POR\s+CONTA\s+DA\s+(?:COMPANHIA|SEGURADORA|COMITENTE))/i;
const IPVA_COMP_RE = /IPVA.{0,80}(?:P\/C\s+DO\s+COMPRADOR|POR\s+CONTA\s+DO\s+COMPRADOR)/i;

// Filtra trechos do resumo mantendo só o conteúdo reconhecidamente útil
function filtrarSegmentos(texto) {
  if (!texto) return null;

  // Detecta IPVA no texto completo antes de quebrar em segmentos
  let ipvaTag = null;
  if (/\bIPVA\b/i.test(texto)) {
    if (IPVA_PAGO_RE.test(texto))      ipvaTag = 'IPVA pago';
    else if (IPVA_COMP_RE.test(texto)) ipvaTag = 'IPVA por conta do comprador';
  }

  const segs = texto
    .split(/\s+\/\s+|\n+/)
    .map(s => s.replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const mantidos = [];
  let ipvaInserido = false;

  for (const seg of segs) {
    // Segmentos de IPVA/DPVAT/licenciamento → substituir por tag simplificada (uma vez)
    if (/\bIPVA\b|\bDPVAT\b|\bLICENIAMENTO\b/i.test(seg)) {
      if (ipvaTag && !ipvaInserido) { mantidos.push(ipvaTag); ipvaInserido = true; }
      continue;
    }

    const temNoise  = NOISE_RE.test(seg);
    const temUtil   = USEFUL_RE.test(seg);
    const temFort   = STRONG_RE.test(seg);
    const nPalavras = seg.split(/\s+/).filter(Boolean).length;

    if (!temNoise) {
      // Sem ruído: manter se útil OU trecho curto (sigla, observação pontual)
      if (temUtil || nPalavras <= 5) mantidos.push(seg);
    } else if (temFort) {
      // Tem ruído mas também alerta grave: apara no início do primeiro ruído
      const m  = NOISE_RE.exec(seg);
      const ap = m && m.index > 0
        ? seg.slice(0, m.index).replace(/\s*[\/,;\-]+\s*$/, '').trim()
        : seg;
      mantidos.push(ap.length >= 3 ? ap : seg);
    }
    // Tem ruído sem alerta forte → descarta
  }

  const seen = new Set();
  const dedup = mantidos.filter(s => { if (seen.has(s)) return false; seen.add(s); return true; });
  if (!dedup.length) return null;
  return dedup.join(' / ').replace(/\s+/g, ' ').trim();
}

// ── Extrai e filtra descricao_resumo do HTML ─────────────────────────────────
function extrairDescricao(html) {
  const corteRe = /SEM\s+GARANTIAS\s+QUANTO\s+[AÀ]\s+ESTRUTURA/i;
  const texto   = stripHtml(html);
  const blocos  = texto.split(/\n{2,}/);

  for (const bloco of blocos) {
    if (!corteRe.test(bloco)) continue;
    const result = filtrarSegmentos(bloco.slice(0, bloco.search(corteRe)));
    if (result && result.length >= 5) return result;
  }

  // Fallback: bloco com palavras-chave típicas sem marcador "SEM GARANTIAS"
  const kwRe = /VEICULO\s+VENDIDO\s+NO\s+ESTADO|MEC[ÂA]NICA\s+SEM\s+TESTE|SINISTRADO|PEQ.{0,5}MONTA/i;
  for (const bloco of blocos) {
    if (!kwRe.test(bloco)) continue;
    const result = filtrarSegmentos(bloco.slice(0, 500));
    if (result && result.length >= 5) return result;
  }

  return null;
}

// ── Extrai UF do endereço local do Freitas ────────────────────────────────────
// Endereços têm vários "-" no meio; a UF são sempre as 2 letras maiúsculas
// no FINAL da string, após o último "/" ou "-".
// Ex.: "AV. DOS ESTADOS, 584 - PORTÃO 2 - UTINGA - SANTO ANDRÉ/SP" → "SP"
function extrairEstadoFreitas(html) {
  // Permite tags HTML entre o rótulo e o texto do endereço
  const m = html.match(
    /Local\s+do\s+leil(?:[ãa]|&atilde;)o:?\s*(?:<[^>]+>\s*)*([^\n<]{3,150})/i
  );
  if (!m) return null;
  const local = m[1].replace(/&[a-z]+;/gi, ' ').replace(/<[^>]+>/g, '').trim();
  console.log(`   📍 Local: "${local}"`);
  // Pega as 2 letras maiúsculas no final após "/" ou "-"
  const ufMatch = local.match(/[\/\-]\s*([A-Z]{2})\s*$/);
  if (!ufMatch) return null;
  return extrairUF(ufMatch[1]); // valida contra lista de UFs conhecidas
}

// ── Parseia campos do HTML de LoteDetalhes ────────────────────────────────────
function parseLoteDetalhes(html) {
  // STATUS — SOMENTE dentro de <div class="text-success|text-danger">
  // ⚠️ Não buscar no texto solto (há "VENDIDO/CONDICIONAL" nas condições gerais)
  const statusMatch = html.match(
    /<div[^>]*class="[^"]*text-(?:success|danger)[^"]*"[^>]*>\s*(VENDIDO|CONDICIONAL|ABERTO|N[ÃA]O\s*VENDIDO|ENCERRADO|DESERTO)\s*<\/div>/i
  );
  const statusRaw = statusMatch ? statusMatch[1].replace(/\s+/g, ' ').trim().toUpperCase() : null;
  let statusArrematado = null;
  if (statusRaw === 'VENDIDO')    statusArrematado = 'vendido';
  else if (statusRaw === 'CONDICIONAL') statusArrematado = 'condicional';
  // ABERTO / NÃO VENDIDO / ENCERRADO / DESERTO → null (não grava arrematado)

  // VALOR — maior lance
  const valorMatch = html.match(/Maior\s+lance:?\s*R?\$?\s*([\d.,]+)/i);
  const valor      = valorMatch ? parseLance(valorMatch[1]) : null;

  // ESTADO/UF — BUG 3: regex tolerante a tags + UF no final da string
  const estado = extrairEstadoFreitas(html);

  // DESCRIÇÃO RESUMIDA
  const descricaoResumo = extrairDescricao(html);

  // ALERTAS — BUG 2: só sobre descricao_resumo (parte útil já cortada),
  // não sobre o HTML completo que contém "RECALL" na ladainha jurídica fixa
  const alertasArr = detectarAlertas(descricaoResumo || '');
  const alertas    = alertasArr.length > 0 ? alertasArr.join(',') : null;

  return { statusArrematado, valor, estado, descricaoResumo, alertas };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🏁 Freitas Leiloeiro — scraper de encerrados iniciando');
  console.log(`   Supabase: ${SUPA_URL}`);

  // Janela de 3 dias
  const hoje       = new Date().toISOString().slice(0, 10);
  const hojeMenos3 = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  console.log(`\n📅 Janela: ${hojeMenos3} → ${hoje}`);

  const leiloes = await supaFetch(
    `leiloes?plataforma=eq.Freitas%20Leiloeiro&data=gte.${hojeMenos3}&data=lte.${hoje}&select=id,data`,
    { prefer: 'return=representation' }
  );

  if (!leiloes || leiloes.length === 0) {
    console.log('ℹ️  Nenhum leilão Freitas na janela de 3 dias. Encerrando.');
    return;
  }

  console.log(`\n📋 ${leiloes.length} leilão(ões) para processar:`);
  for (const l of leiloes) console.log(`   → ${l.id} (${l.data})`);

  let totVendido = 0, totCondicional = 0, totPulado = 0, totAlertas = 0, totEstado = 0;

  for (const leilao of leiloes) {
    console.log(`\n📦 Leilão: ${leilao.id} (${leilao.data})`);

    const motos = await supaFetch(
      `motos?leilao_id=eq.${leilao.id}&select=id,url,estado`,
      { prefer: 'return=representation' }
    );

    if (!motos || motos.length === 0) {
      console.log('   ⚠️ Nenhuma moto. Pulando.');
      continue;
    }

    const motosFreitas = motos.filter(m => m.url && m.url.includes('LoteDetalhes'));
    console.log(`   ${motosFreitas.length}/${motos.length} motos com URL LoteDetalhes`);

    let vendido = 0, condicional = 0, pulado = 0, comAlertas = 0, estadoPreenchido = 0;

    for (const moto of motosFreitas) {
      const html = await fetchDetalhes(moto.url);
      if (!html) {
        console.warn(`    ⚠️ Sem HTML para moto ${moto.id} — pulando`);
        pulado++;
        await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
        continue;
      }

      const { statusArrematado, valor, estado, descricaoResumo, alertas } = parseLoteDetalhes(html);

      // Grava arrematado (DELETE + INSERT para permitir reprocessamento)
      if (statusArrematado && valor != null) {
        await supaFetch(`arrematados?moto_id=eq.${moto.id}`, { method: 'DELETE' });
        await supaFetch('arrematados', {
          method: 'POST',
          body: JSON.stringify({
            moto_id:           moto.id,
            valor,
            status_arrematado: statusArrematado,
          }),
          prefer: 'resolution=merge-duplicates,return=minimal',
        });
        if (statusArrematado === 'vendido') vendido++;
        else                                condicional++;
      } else {
        pulado++;
      }

      // PATCH motos: estado só se vazio; descricao_resumo e alertas sempre
      const patch = {};
      if (!moto.estado && estado) { patch.estado = estado; estadoPreenchido++; }
      if (descricaoResumo != null) patch.descricao_resumo = descricaoResumo;
      patch.alertas = alertas; // null limpa alertas stale de execuções anteriores

      await supaFetch(`motos?id=eq.${moto.id}`, {
        method: 'PATCH',
        body:   JSON.stringify(patch),
        prefer: 'return=minimal',
      });

      if (alertas) comAlertas++;

      await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
    }

    console.log(`   ✅ vendido=${vendido}  condicional=${condicional}  pulado=${pulado}  com_alertas=${comAlertas}  estado_preenchido=${estadoPreenchido}`);
    totVendido     += vendido;
    totCondicional += condicional;
    totPulado      += pulado;
    totAlertas     += comAlertas;
    totEstado      += estadoPreenchido;
  }

  console.log('\n📊 Totais finais:');
  console.log(`   vendido=${totVendido}  condicional=${totCondicional}  pulado=${totPulado}  com_alertas=${totAlertas}  estado_preenchido=${totEstado}`);
  console.log('\n✅ Scraper Freitas encerrados concluído!');
}

main().catch(err => {
  console.error('\n❌ Erro fatal:', err.message);
  process.exit(1);
});
