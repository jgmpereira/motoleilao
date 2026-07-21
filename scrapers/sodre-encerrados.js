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

  // 1. Busca leilões do Sodré na janela dos últimos 7 dias (encerrado ou não)
  // Reprocessa a janela pra atualizar condicionais que resolvem dias após o leilão E
  // pra reconferir valores já marcados 'vendido' — a API do Sodré pode corrigir o
  // bid_actual de um lote mesmo depois do status já ter virado definitivo (confirmado:
  // BMW F750 GS do leilão 2026-07-14 foi gravada 'vendido' R$18.000 e a API passou
  // a retornar R$40.000 pro mesmo lote dias depois, sem nunca ter voltado a 'condicional').
  // 7 dias = janela confirmada em que a API lots-finished ainda responde pro leilão.
  const hoje = new Date().toISOString().slice(0, 10);
  const hojeMenos7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const leiloesRecentes = await supaFetch(
    `leiloes?plataforma=eq.Sodré Santoro&data=gte.${hojeMenos7}&data=lte.${hoje}&select=id,link,data`,
    { prefer: 'return=representation' }
  ) || [];

  // 1b. Alguns condicionais do Sodré só resolvem (viram vendido) bem depois dos 7 dias —
  // busca leilões de QUALQUER data que ainda tenham arrematados pendurados em 'condicional'
  const condicionaisPendentes = await supaFetch(
    `arrematados?status_arrematado=eq.condicional&select=motos!inner(leilao_id)`,
    { prefer: 'return=representation' }
  ) || [];
  const idsJaNaJanela = new Set(leiloesRecentes.map(l => l.id));
  const idsCondicionaisFaltantes = [...new Set(
    condicionaisPendentes
      .map(a => a.motos?.leilao_id)
      .filter(id => id && id.startsWith('sodre_') && !idsJaNaJanela.has(id))
  )];

  // A API do Sodré só mantém dados de lotes encerrados por ~1 semana (confirmado:
  // auctionId de 10 dias atrás já retorna vazio) — reprocessar além disso é inútil,
  // por isso limita a 21 dias (margem de segurança) pra não repetir chamada pra sempre.
  const hojeMenos21 = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let leiloesAntigos = [];
  if (idsCondicionaisFaltantes.length > 0) {
    leiloesAntigos = await supaFetch(
      `leiloes?id=in.(${idsCondicionaisFaltantes.join(',')})&data=gte.${hojeMenos21}&select=id,link,data`,
      { prefer: 'return=representation' }
    ) || [];
    console.log(`\n🔁 ${leiloesAntigos.length} leilão(ões) antigo(s) com condicional pendente (últimos 21 dias), reprocessando também.`);
  }

  const leiloes = [...leiloesRecentes, ...leiloesAntigos];

  if (leiloes.length === 0) {
    console.log('ℹ️ Nenhum leilão do Sodré na janela de 7 dias nem condicional pendente.');
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

    // 2. Busca motos desse leilão no Supabase
    // IMPORTANTE: um leilao_id nosso pode conter motos de MAIS DE UM auction_id
    // real do Sodré — gerarLeilaoId() (sodre.js) gera o id só pela data, então se
    // a Sodré roda dois leilões distintos no mesmo dia, ambos caem no mesmo
    // leilao_id aqui, mas leiloes.link só guarda um dos auction_ids. Extrair um
    // único auction_id do link (como antes) faz as motos do outro auction_id
    // ficarem sem cobertura E colidirem por número de lote com as do auction_id
    // errado — bug real: BMW F750 GS (auction 28787, lote 32) recebeu o valor do
    // Fiat Uno (auction 28765, lote 32 também) porque o código casava só pelo
    // número de lote, ignorando de qual auction_id real ele veio.
    // Correção: extrai o auction_id de CADA moto (via url) e casa lote↔moto só
    // dentro do mesmo auction_id.
    const motos = await supaFetch(
      `motos?leilao_id=eq.${leilao.id}&select=id,lote,url`,
      { prefer: 'return=representation' }
    );

    if (!motos || motos.length === 0) {
      console.log(`  ⚠️ Nenhuma moto encontrada para o leilão ${leilao.id}`);
      continue;
    }

    const motosPorAuction = {};
    const motosSemAuction = [];
    for (const m of motos) {
      const matchMoto = (m.url || '').match(/\/leilao\/(\d+)/);
      if (matchMoto) {
        (motosPorAuction[matchMoto[1]] ||= []).push(m);
      } else {
        motosSemAuction.push(m);
      }
    }
    // Fallback: motos sem url própria (raro) usam o auction_id do link do leilão
    if (motosSemAuction.length > 0) {
      const matchLink = (leilao.link || '').match(/\/leilao\/(\d+)/);
      if (matchLink) (motosPorAuction[matchLink[1]] ||= []).push(...motosSemAuction);
    }

    const auctionIds = Object.keys(motosPorAuction);
    if (auctionIds.length === 0) {
      console.log(`  ⚠️ Sem auction_id — marcando como encerrado: ${leilao.id}`);
      continue;
    }
    if (auctionIds.length > 1) {
      console.log(`  ℹ️ Leilão contém ${auctionIds.length} auction_ids reais do Sodré: ${auctionIds.join(', ')}`);
    }

    // 3. Insere arrematados — busca e casa lote↔moto por auction_id, um de cada vez
    let inseridos = 0;
    let ignorados = 0;
    const inserts = [];

    for (const auctionId of auctionIds) {
      console.log(`  auction_id: ${auctionId}`);
      const lotes = await fetchLotesEncerrados(auctionId);
      console.log(`  Total lotes encerrados (auction ${auctionId}): ${lotes.length}`);
      if (lotes.length === 0) continue;

      // Mapa lote → moto_id, restrito às motos desse auction_id
      const motoMap = {};
      for (const m of motosPorAuction[auctionId]) {
        motoMap[String(m.lote).padStart(4, '0')] = m.id;
        motoMap[String(m.lote)] = m.id; // também sem padding
      }

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
