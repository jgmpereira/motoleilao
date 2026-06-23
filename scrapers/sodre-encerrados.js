#!/usr/bin/env node
'use strict';

/**
 * Scraper de leilões encerrados — Sodré Santoro
 * 
 * 1. Busca leilões do Sodré no Supabase que ainda não foram marcados como encerrados
 * 2. Para cada um, chama a API lots-finished para pegar valores arrematados
 * 3. Insere na tabela arrematados e marca o leilão como encerrado
 */

const SUPA_URL = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY = process.env.SUPABASE_KEY;

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

// — Busca lotes encerrados da API do Sodré —
async function fetchLotesEncerrados(auctionId) {
  const lotes = [];
  let page = 1;
  let lastPage = 1;

  while (page <= lastPage) {
    let json = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const url = `https://prd-api.sodresantoro.com.br/api/v1/lots-finished?auctionId=${auctionId}&page=${page}`;
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        }
      });
      if (res.ok) {
        json = await res.json();
        break;
      }
      console.warn(`  ⚠️ página ${page} tentativa ${attempt}/3 falhou (status ${res.status})`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
    }

    if (!json) {
      console.warn(`  ⚠️ página ${page} falhou após 3 tentativas, pulando`);
      page++;
      continue;
    }

    const data = json.data || [];
    lotes.push(...data);
    lastPage = json.meta?.lastPage || lastPage;
    console.log(`  Página ${page}/${lastPage}: ${data.length} lotes`);
    page++;
  }

  return lotes;
}

// — Main —
async function main() {
  console.log('🏁 Sodré Santoro — scraper de encerrados iniciando');

  // 1. Busca leilões do Sodré na janela dos últimos 3 dias (encerrado ou não)
  // Reprocessa a janela para atualizar condicionais que resolvem dias após o leilão
  const hoje = new Date().toISOString().slice(0, 10);
  const hojeMenos3 = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const leiloes = await supaFetch(
    `leiloes?plataforma=eq.Sodré Santoro&data=gte.${hojeMenos3}&data=lte.${hoje}&select=id,link,data`,
    { prefer: 'return=representation' }
  );

  if (!leiloes || leiloes.length === 0) {
    console.log('ℹ️ Nenhum leilão do Sodré na janela de 3 dias.');
    return;
  }

  console.log(`\n📋 ${leiloes.length} leilão(ões) para processar:`);

  for (const leilao of leiloes) {
    console.log(`\n  Leilão: ${leilao.id} (${leilao.data})`);

    // Data já passou (a query filtra data<=hoje) → o leilão ESTÁ encerrado,
    // independente de conseguirmos capturar os valores. Marca já, pra não vazar na home.
    await supaFetch(`leiloes?id=eq.${leilao.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ encerrado: true }),
    });

    // 2. Extrai auction_id do link do leilão ou das motos
    let auctionId = null;
    const matchLink = (leilao.link || '').match(/\/leilao\/(\d+)/);
    if (matchLink) {
      auctionId = matchLink[1];
    } else {
      // Tenta extrair auction_id da URL de uma moto desse leilão
      const motosUrl = await supaFetch(
        `motos?leilao_id=eq.${leilao.id}&url=not.is.null&select=url&limit=1`,
        { prefer: 'return=representation' }
      );
      if (motosUrl && motosUrl[0]?.url) {
        const matchMoto = motosUrl[0].url.match(/\/leilao\/(\d+)/);
        if (matchMoto) auctionId = matchMoto[1];
      }
    }
    if (!auctionId) {
      console.log(`  ⚠️ Sem auction_id — marcando como encerrado: ${leilao.id}`);
      await supaFetch(`leiloes?id=eq.${leilao.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ encerrado: true }),
      });
      continue;
    }
    console.log(`  auction_id: ${auctionId}`);

    // 3. Busca lotes encerrados da API
    const lotes = await fetchLotesEncerrados(auctionId);
    console.log(`  Total lotes encerrados: ${lotes.length}`);

    if (lotes.length === 0) continue;

    // 4. Busca motos desse leilão no Supabase
    const motos = await supaFetch(
      `motos?leilao_id=eq.${leilao.id}&select=id,lote`,
      { prefer: 'return=representation' }
    );

    if (!motos || motos.length === 0) {
      console.log(`  ⚠️ Nenhuma moto encontrada para o leilão ${leilao.id}`);
      continue;
    }

    // Cria mapa lote → moto_id
    const motoMap = {};
    for (const m of motos) {
      motoMap[String(m.lote).padStart(4, '0')] = m.id;
      motoMap[String(m.lote)] = m.id; // também sem padding
    }

    // 5. Insere arrematados
    let inseridos = 0;
    let ignorados = 0;
    const inserts = [];

    for (const lote of lotes) {
      if (!lote.bid_actual || parseFloat(lote.bid_actual) === 0) { ignorados++; continue; }
      if (lote.lot_status !== 'vendido' && lote.lot_status !== 'condicional') { ignorados++; continue; }

      const lotNum = String(lote.lot_number);
      const motoId = motoMap[lotNum] || motoMap[lotNum.padStart(4, '0')];

      if (!motoId) {
        // Moto não é do segmento motos ou não foi cadastrada
        ignorados++;
        continue;
      }

      inserts.push({
        moto_id: motoId,
        valor:   parseFloat(lote.bid_actual),
        status_arrematado: lote.lot_status,
      });
      inseridos++;
    }

    if (inserts.length > 0) {
      // Remove arrematados anteriores desse leilão para evitar duplicatas
      for (const ins of inserts) {
        await supaFetch(
          `arrematados?moto_id=eq.${ins.moto_id}`,
          { method: 'DELETE' }
        );
      }
      // Insere novos
      await supaFetch('arrematados', {
        method: 'POST',
        body: JSON.stringify(inserts),
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
    }

    console.log(`  ✅ ${inseridos} arrematados inseridos, ${ignorados} ignorados`);
  }

  console.log('\n✅ Scraper de encerrados concluído!');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
