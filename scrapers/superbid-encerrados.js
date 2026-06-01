#!/usr/bin/env node
'use strict';

/**
 * Scraper de leilões encerrados — Superbid Exchange
 *
 * Diferente do feed `searchType=closed` (que é um pool de SEO randômico,
 * não-paginável e desatualizado), aqui buscamos o resultado de CADA oferta
 * individualmente pela página SSR do site:
 *
 *   https://www.superbid.net/oferta/{offerId}
 *
 * A página é um Next.js com o JSON embutido em <script id="__NEXT_DATA__">.
 * O objeto da oferta fica em props.pageProps.offerDetails.offers[0]. O ciclo de
 * vida observado:
 *   statusId 1                   → aberto (ainda em leilão)        → pula
 *   statusId 3 + hasBids:true    → encerrado com lances (vendido)  → arremata
 *   statusId 11 + hasBids:true   → lance único no mínimo (condic.) → arremata
 *   statusId 6 + hasBids:false   → encerrado sem lances (deserto)  → pula
 *
 * Sinal confiável de arremate = `hasBids` (NÃO `winnerBid.currentWinner`, que só
 * é populado dias depois, na confirmação). Valor final = offerDetail.currentMaxBid.
 *
 * O offerId de cada moto está em motos.url (padrão .../oferta/{id}), gravado
 * pelo scraper ativo (superbid.js).
 *
 * Estratégia (idempotente, à prova de corrida com o superbid.js ativo):
 *   1. Busca leilões Superbid numa janela recente (data <= hoje e >= hoje-7),
 *      independente da flag `encerrado` (o superbid.js já pode tê-la setado).
 *   2. Para cada leilão, pega as motos que AINDA NÃO têm arrematado.
 *   3. Busca o resultado de cada oferta na página SSR.
 *   4. Insere em `arrematados` quando houver arrematante.
 *   5. Marca o leilão como encerrado.
 *
 * Secrets necessários:
 *   SUPABASE_KEY — service_role key (ou anon key se RLS permitir)
 */

const SUPA_URL = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY = process.env.SUPABASE_KEY;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Janela (em dias) para trás a partir de hoje — dá margem de retry se um dia falhar
const JANELA_DIAS = 7;

if (!SUPA_KEY) {
  console.error('❌ SUPABASE_KEY não definido');
  process.exit(1);
}

// — Supabase REST helper —
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

// — Extrai o JSON do Next.js da página SSR —
function extractNextData(html) {
  const marker = 'id="__NEXT_DATA__" type="application/json">';
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = i + marker.length;
  const end = html.indexOf('</script>', start);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    return null;
  }
}

// — Busca o resultado de uma oferta pela página SSR —
async function fetchOfferResult(offerId) {
  const res = await fetch(`https://www.superbid.net/oferta/${offerId}`, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
  });
  if (!res.ok) {
    console.log(`    ⚠️ oferta ${offerId}: HTTP ${res.status}`);
    return null;
  }
  const html = await res.text();
  const data = extractNextData(html);
  const offer = data?.props?.pageProps?.offerDetails?.offers?.[0];
  return offer || null;
}

// — Extrai o offerId do campo url da moto (.../oferta/{id}) —
function offerIdFromUrl(url) {
  const m = (url || '').match(/\/oferta\/(\d+)/);
  return m ? m[1] : null;
}

// — Main —
async function main() {
  console.log('🏁 Superbid — scraper de encerrados iniciando');

  const hoje = new Date().toISOString().slice(0, 10);
  const limite = new Date(Date.now() - JANELA_DIAS * 86_400_000).toISOString().slice(0, 10);

  // 1. Leilões Superbid na janela recente (independe da flag encerrado)
  const leiloes = await supaFetch(
    `leiloes?plataforma=eq.Superbid&data=lte.${hoje}&data=gte.${limite}&select=id,data&order=data.asc`,
    { prefer: 'return=representation' }
  );

  if (!leiloes || leiloes.length === 0) {
    console.log('ℹ️ Nenhum leilão Superbid recente para processar.');
    return;
  }

  console.log(`\n📋 ${leiloes.length} leilão(ões) na janela (${limite} a ${hoje}):`);

  let totalInseridos = 0;

  for (const leilao of leiloes) {
    console.log(`\n  Leilão: ${leilao.id} (${leilao.data})`);

    // 2. Motos do leilão
    const motos = await supaFetch(
      `motos?leilao_id=eq.${leilao.id}&select=id,url`,
      { prefer: 'return=representation' }
    );

    if (!motos || motos.length === 0) {
      console.log('  ⚠️ Nenhuma moto cadastrada — marcando como encerrado.');
      await supaFetch(`leiloes?id=eq.${leilao.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ encerrado: true }),
      });
      continue;
    }

    // 2b. Quais motos já têm arrematado (pula essas — idempotência)
    const idsMotos = motos.map(m => m.id);
    const comArr = await supaFetch(
      `arrematados?moto_id=in.(${idsMotos.join(',')})&select=moto_id`,
      { prefer: 'return=representation' }
    );
    const jaArrematadas = new Set((comArr || []).map(a => a.moto_id));

    const pendentes = motos.filter(m => !jaArrematadas.has(m.id) && offerIdFromUrl(m.url));
    console.log(`  ${motos.length} motos | ${jaArrematadas.size} já com arrematado | ${pendentes.length} a verificar`);

    // 3. Busca o resultado de cada oferta pendente
    const inserts = [];
    let semArremate = 0, abertos = 0, falhas = 0;

    for (const moto of pendentes) {
      const offerId = offerIdFromUrl(moto.url);
      const offer = await fetchOfferResult(offerId);
      await new Promise(r => setTimeout(r, 300)); // throttle

      if (!offer) { falhas++; continue; }

      const aberto = offer.statusId === 1 || offer.offerStatus?.available === true
        || (offer.endDate || '').slice(0, 10) > hoje;
      if (aberto) { abertos++; continue; }

      // Encerrado: arrematado sse houve lances. O valor final é o maior lance.
      if (offer.hasBids !== true || (offer.totalBids || 0) <= 0) { semArremate++; continue; }

      const valor = Number(offer.offerDetail?.currentMaxBid ?? offer.price) || 0;
      if (valor <= 0) { semArremate++; continue; }

      // statusId 11 = lance único no mínimo (condicional); demais encerrados c/ lances = vendido.
      const status = offer.statusId === 11 ? 'condicional' : 'vendido';

      inserts.push({ moto_id: moto.id, valor, status_arrematado: status });
    }

    // 4. Insere arrematados (apenas os novos — sem delete, pois filtramos)
    if (inserts.length > 0) {
      await supaFetch('arrematados', {
        method: 'POST',
        body: JSON.stringify(inserts),
        prefer: 'return=minimal',
      });
    }
    totalInseridos += inserts.length;
    console.log(`  ✅ ${inserts.length} arrematados | ${semArremate} sem lances | ${abertos} ainda abertos | ${falhas} falhas`);

    // 5. Marca como encerrado só se nenhuma oferta continua aberta
    if (abertos === 0) {
      await supaFetch(`leiloes?id=eq.${leilao.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ encerrado: true }),
      });
      console.log(`  🔒 Leilão ${leilao.id} marcado como encerrado`);
    } else {
      console.log(`  ⏳ Leilão ${leilao.id} tem ofertas abertas — não encerrado ainda`);
    }
  }

  console.log(`\n✅ Scraper de encerrados concluído! Total: ${totalInseridos} arrematados.`);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
