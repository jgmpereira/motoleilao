#!/usr/bin/env node
'use strict';

/**
 * Orquestrador diário da FIPE — roda no workflow fipe-diario.yml, depois dos
 * scrapers da manhã.
 *
 * Chama, no MESMO processo, popular-fipe.js (motos novas sem preço —
 * prioridade, aparecem sem FIPE no site) e depois atualizar-fipe-mensal.js
 * (preços desatualizados do mês anterior — pode esperar). Os dois compartilham
 * o mesmo teto de requisições/dia (scripts/fipe-budget.js) porque rodam no
 * mesmo processo Node: require() é cacheado, então ambos enxergam o mesmo
 * objeto de contador. Se a fase 1 já consumir a cota toda, a fase 2 fica pra
 * amanhã sem gastar nada (e sem quebrar a retomada dela, que é por
 * referencia_mes/referencia_ano).
 *
 * Uso:
 *   node scripts/fipe-diario.js             # grava no banco
 *   DRY_RUN=1 node scripts/fipe-diario.js   # só loga, não grava nada
 */

const budget = require('./fipe-budget');

async function main() {
  console.log(`🎯 Cota diária compartilhada da FIPE: ${budget.limit} requisições\n`);

  console.log('════════════════════════════════════════');
  console.log('FASE 1/2 — motos novas sem FIPE (prioridade)');
  console.log('════════════════════════════════════════');
  const popular = require('./popular-fipe');
  await popular.run();
  console.log(`\n📊 Cota após fase 1: ${budget.count}/${budget.limit}`);

  if (budget.count >= budget.limit) {
    console.log('\n🛑 Cota esgotada na fase 1 — fase 2 (atualização mensal) fica pra amanhã, nada foi gasto nela.');
    return;
  }

  console.log('\n════════════════════════════════════════');
  console.log('FASE 2/2 — atualização mensal (preços desatualizados)');
  console.log('════════════════════════════════════════');
  const mensal = require('./atualizar-fipe-mensal');
  await mensal.run();
  console.log(`\n📊 Cota final do dia: ${budget.count}/${budget.limit}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
