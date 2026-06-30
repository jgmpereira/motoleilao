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
const { extrairUF, detectarAlertas, stripHtml, filtrarSegmentos, extrairDescricao, extrairEstadoFreitas } = require('./_utils');

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

// stripHtml, filtrarSegmentos, extrairDescricao, extrairEstadoFreitas → importados de ./_utils

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
  let debugCount = 0; // limita logs de diagnóstico a 3 lotes — remover após diagnóstico

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

      if (debugCount < 3) {
        const idx = html.indexOf('dvStatusLoteMenu');
        const STATUS_RE_DEBUG = /<div[^>]*class="[^"]*text-(?:success|danger)[^"]*"[^>]*>\s*(VENDIDO|CONDICIONAL|ABERTO|N[ÃA]O\s*VENDIDO|ENCERRADO|DESERTO)\s*<\/div>/i;
        console.log(`[DEBUG status] moto=${moto.id} len=${html.length} hasMenu=${idx >= 0} hasVendido=${html.includes('VENDIDO')} match=${JSON.stringify(STATUS_RE_DEBUG.exec(html)?.[1] ?? null)}`);
        if (idx >= 0) console.log('[DEBUG trecho]', JSON.stringify(html.slice(idx - 60, idx + 140)));
        debugCount++;
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

      // PATCH motos — conservador: nunca sobrescreve com vazio/null.
      // Trade-off aceito: se um anúncio remover um alerta real, o valor antigo persiste.
      // Preferimos manter dado bom a apagar por página incompleta.
      const patch = {};
      if (!moto.estado && estado) { patch.estado = estado; estadoPreenchido++; }
      if (descricaoResumo && descricaoResumo.trim()) patch.descricao_resumo = descricaoResumo;
      if (alertas && alertas.trim()) patch.alertas = alertas;

      if (Object.keys(patch).length > 0) {
        await supaFetch(`motos?id=eq.${moto.id}`, {
          method: 'PATCH',
          body:   JSON.stringify(patch),
          prefer: 'return=minimal',
        });
      }

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
