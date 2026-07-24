#!/usr/bin/env node
'use strict';

/**
 * Scraper de leilões encerrados — Copart Brasil
 *
 * 1. Busca leilões Copart encerrados dos últimos 21 dias no Supabase + qualquer
 *    moto de leilão Copart mais antigo que ainda tenha arrematado 'condicional'
 *    pendente (mesmo padrão do sodre-encerrados.js)
 * 2. Abre uma página do Copart com Playwright (contorna o WAF Imperva/Incapsula,
 *    igual ao copart.js) e a partir daí chama, via page.evaluate, o endpoint
 *    /public/data/lotdetails/solr/{lote} pra cada moto — o número do lote da
 *    Copart já É o lot_number usado na URL (/lot/{lote}), sem o problema de
 *    colisão entre auction_ids que existe no Sodré.
 * 3. Mapeia o campo `lss` (lot sale status) da resposta:
 *      Sold        → vendido      (currBid = valor final)
 *      ON_APPROVAL → condicional  (venda pendente de aprovação do comitente/financeira)
 *      NOT_ON_SALE → lote nunca foi a leilão — se havia um condicional gravado
 *                    antes (reversão), remove
 *      UNKNOWN     → status ambíguo retornado pela própria API da Copart em ~20%
 *                    dos lotes testados (não correlaciona com docType/comitente/
 *                    valor — parece um estado transitório do lado deles); ignora
 *                    e tenta de novo no próximo dia, dentro da janela de 21 dias
 *    currBid = 0 também é tratado como "ainda não sincronizado" e ignorado
 *    (mesmo padrão do `hasBids` do Superbid e do bid_actual do Sodré, que só
 *    populam alguns dias depois do leilão).
 * 4. Idempotente: pula motos que já têm arrematado 'vendido' — só reprocessa
 *    motos sem arrematado ainda ou com 'condicional' pendente.
 *
 * Secrets necessários no GitHub:
 *   SUPABASE_KEY — service_role key (ou anon key se RLS permitir)
 */

const { chromium } = require('playwright');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPA_URL = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY = process.env.SUPABASE_KEY;

if (!SUPA_KEY) {
  console.error('❌ SUPABASE_KEY não definido');
  process.exit(1);
}

const JANELA_DIAS = 21;
const LOT_DETAIL_URL = ln => `https://www.copart.com.br/public/data/lotdetails/solr/${ln}`;

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

// ── Busca detalhe de um lote via fetch no contexto do browser (sem bloqueio WAF) ──
async function fetchLotDetail(page, lote) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, { headers: { 'Accept': 'application/json' }, credentials: 'include' });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        return await res.json();
      } catch (e) {
        return { error: e.message };
      }
    }, LOT_DETAIL_URL(lote));

    if (!result?.error) return result?.data?.lotDetails || null;
    console.warn(`    ⚠️ lote ${lote} tentativa ${attempt}/3: ${result.error}`);
    if (attempt < 3) await new Promise(r => setTimeout(r, 800));
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🏁 Copart Brasil — scraper de encerrados iniciando');

  const hoje       = new Date().toISOString().slice(0, 10);
  const hojeMenosN = new Date(Date.now() - JANELA_DIAS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // 1. Leilões Copart encerrados na janela
  const leiloesJanela = await supaFetch(
    `leiloes?plataforma=eq.Copart&encerrado=eq.true&data=gte.${hojeMenosN}&data=lte.${hoje}&select=id,data`,
    { prefer: 'return=representation' }
  ) || [];

  if (leiloesJanela.length === 0) {
    console.log(`ℹ️ Nenhum leilão Copart encerrado nos últimos ${JANELA_DIAS} dias. Encerrando.`);
    return;
  }

  console.log(`\n📋 ${leiloesJanela.length} leilão(ões) na janela de ${JANELA_DIAS} dias:`);
  for (const l of leiloesJanela) console.log(`   → ${l.id} (${l.data})`);

  const leilaoIds = leiloesJanela.map(l => l.id);

  // 2. Motos desses leilões
  const motos = await supaFetch(
    `motos?leilao_id=in.(${leilaoIds.join(',')})&select=id,lote,leilao_id`,
    { prefer: 'return=representation' }
  ) || [];

  // 3. Arrematados já existentes pra essas motos — pula 'vendido' (já final),
  //    reprocessa 'condicional' (pode resolver ou reverter)
  const idsExist = motos.map(m => m.id);
  const arrematadosMap = {};
  if (idsExist.length > 0) {
    const BATCH = 300;
    for (let i = 0; i < idsExist.length; i += BATCH) {
      const chunk = idsExist.slice(i, i + BATCH);
      const arr = await supaFetch(`arrematados?moto_id=in.(${chunk.join(',')})&select=id,moto_id,status_arrematado`) || [];
      for (const a of arr) arrematadosMap[a.moto_id] = a;
    }
  }

  const motosParaChecar = motos.filter(m => {
    const a = arrematadosMap[m.id];
    return !a || a.status_arrematado === 'condicional';
  });

  // 4. Condicionais pendentes de leilões Copart FORA da janela (não têm expiração
  //    conhecida na API da Copart, mas limita a reprocessar só o que ainda importa)
  const condicionaisPendentes = await supaFetch(
    `arrematados?status_arrematado=eq.condicional&select=id,moto_id,motos!inner(id,lote,leilao_id)`,
    { prefer: 'return=representation' }
  ) || [];
  const idsJaNaJanela = new Set(idsExist);
  for (const c of condicionaisPendentes) {
    const m = c.motos;
    if (m && m.leilao_id?.startsWith('copart_') && !idsJaNaJanela.has(m.id)) {
      motosParaChecar.push({ id: m.id, lote: m.lote, leilao_id: m.leilao_id });
    }
  }

  if (motosParaChecar.length === 0) {
    console.log('ℹ️ Nenhuma moto pendente de checagem. Encerrando.');
    return;
  }

  console.log(`\n🔍 ${motosParaChecar.length} moto(s) a checar (sem arrematado ou condicional pendente)`);

  // 5. Playwright — estabelece cookies do WAF navegando uma vez
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  const page = await context.newPage();

  let vendido = 0, condicional = 0, revertido = 0, ignorado = 0, erro = 0;

  try {
    const primeiraMoto = motosParaChecar.find(m => m.lote);
    if (!primeiraMoto) {
      console.log('ℹ️ Nenhuma moto com número de lote válido. Encerrando.');
      return;
    }
    console.log(`\n🌐 Estabelecendo sessão via lote ${primeiraMoto.lote}...`);
    await page.goto(`https://www.copart.com.br/lot/${primeiraMoto.lote}`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(2_000);

    for (const moto of motosParaChecar) {
      if (!moto.lote) { ignorado++; continue; }

      const detail = await fetchLotDetail(page, moto.lote);
      if (!detail) { erro++; await new Promise(r => setTimeout(r, 400)); continue; }

      const lss = detail.lss;
      const currBid = parseFloat(detail.currBid) || 0;
      const existente = arrematadosMap[moto.id];

      if ((lss === 'Sold' || lss === 'ON_APPROVAL') && currBid > 0) {
        const novoStatus = lss === 'Sold' ? 'vendido' : 'condicional';
        // Evita DELETE+INSERT desnecessário quando nada mudou
        if (!existente || existente.status_arrematado !== novoStatus) {
          if (existente) await supaFetch(`arrematados?id=eq.${existente.id}`, { method: 'DELETE' });
          await supaFetch('arrematados', {
            method: 'POST',
            body: JSON.stringify({ moto_id: moto.id, valor: currBid, status_arrematado: novoStatus }),
            prefer: 'resolution=merge-duplicates,return=minimal',
          });
        }
        if (novoStatus === 'vendido') vendido++; else condicional++;
      } else if (lss === 'NOT_ON_SALE' && existente?.status_arrematado === 'condicional') {
        // Condicional que caiu — comitente/financeira não aprovou, lote volta a não vendido
        console.log(`  ↩️ condicional revertido (moto_id ${moto.id}, lote ${moto.lote}) — Copart marca NOT_ON_SALE, removendo arrematado`);
        await supaFetch(`arrematados?id=eq.${existente.id}`, { method: 'DELETE' });
        revertido++;
      } else {
        // UNKNOWN, currBid=0 ainda não sincronizado, ou outro status — deixa como está
        ignorado++;
      }

      await new Promise(r => setTimeout(r, 350 + Math.random() * 200));
    }
  } finally {
    await browser.close();
  }

  console.log('\n📊 Totais finais:');
  console.log(`   vendido=${vendido}  condicional=${condicional}  revertido=${revertido}  ignorado=${ignorado}  erro=${erro}`);
  console.log('\n✅ Scraper Copart encerrados concluído!');
}

main().catch(err => {
  console.error('\n❌ Erro fatal:', err.message);
  process.exit(1);
});
