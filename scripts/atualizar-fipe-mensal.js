#!/usr/bin/env node
'use strict';

/**
 * Atualização mensal de valores FIPE
 * Roda no dia 1 de cada mês via GitHub Actions
 * Atualiza todos os registros de fipe_valores com os preços do mês atual
 */

const SUPA_URL = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const FIPE_BASE = 'https://fipe.parallelum.com.br/api/v2/motorcycles';
const DRY_RUN = process.env.DRY_RUN === '1';

// Trava de cota diária — compartilhada com popular-fipe.js quando os dois
// rodam no mesmo processo via scripts/fipe-diario.js (ver fipe-budget.js).
// A retomada continua via referencia_mes/referencia_ano (só gravados no
// sucesso) — parar aqui no meio não quebra isso, o resto fica pra amanhã.
const budget = require('./fipe-budget');

if (!SUPA_KEY) { console.error('❌ SUPABASE_SERVICE_KEY (ou SUPABASE_KEY) não definido'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const FIPE_HEADERS = process.env.FIPE_TOKEN
  ? { 'X-Subscription-Token': process.env.FIPE_TOKEN }
  : {};

async function apiFetch(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    budget.count++;
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

// fipe_valores.ano_modelo foi gravado por scripts antigos com só 2 dígitos
// (ex: 3, 12, 15 em vez de 2003, 2012, 2015) — o code de ano da API FIPE
// exige o ano completo (ex: "2003-1"), então sem essa conversão a consulta
// sempre dá 404.
function anoParaCodigoFipe(ano) {
  const n = parseInt(ano, 10);
  if (!n) return null;
  if (n >= 1900) return n;
  return n <= 30 ? 2000 + n : 1900 + n;
}

async function main() {
  const now = new Date();
  const mesAtual = now.getMonth() + 1;
  const anoAtual = now.getFullYear();

  console.log(`🔄 Atualização FIPE mensal — ${mesAtual}/${anoAtual}\n`);

  // Busca todos os registros de fipe_valores que NÃO são do mês atual
  const todos = await supaFetch(
    `fipe_valores?select=id,marca_codigo,modelo_codigo,ano_modelo,lookup_key&order=id.asc`,
    { prefer: 'return=representation' }
  );

  if (!todos || todos.length === 0) {
    console.log('ℹ️ Nenhum registro em fipe_valores.');
    return;
  }

  // Filtra apenas os que não são do mês atual
  const jaAtualizados = await supaFetch(
    `fipe_valores?referencia_mes=eq.${mesAtual}&referencia_ano=eq.${anoAtual}&select=lookup_key`,
    { prefer: 'return=representation' }
  );
  const jaAtualizadosSet = new Set((jaAtualizados || []).map(r => r.lookup_key));
  
  const paraAtualizar = todos.filter(r => !jaAtualizadosSet.has(r.lookup_key));

  console.log(`📋 Total: ${todos.length} registros`);
  console.log(`✅ Já atualizados este mês: ${jaAtualizadosSet.size}`);
  console.log(`🔄 Para atualizar: ${paraAtualizar.length}\n`);

  if (paraAtualizar.length === 0) {
    console.log('✅ Todos os registros já estão atualizados para este mês!');
    return;
  }

  let ok = 0, erros = 0, nullConsec = 0, pulados = 0;
  let cortadoPorCota = false;

  for (let i = 0; i < paraAtualizar.length; i++) {
    const r = paraAtualizar[i];

    if (budget.count >= budget.limit) {
      console.log(`\n🛑 Trava de cota acionada (${budget.count}/${budget.limit} requisições) — parando em [${i+1}/${paraAtualizar.length}]. Resto fica pra amanhã (referencia_mes/ano não gravados).`);
      cortadoPorCota = true;
      pulados = paraAtualizar.length - i;
      break;
    }

    process.stdout.write(`[${i+1}/${paraAtualizar.length}] lookup: ${r.lookup_key} ... `);

    try {
      const anoCompleto = anoParaCodigoFipe(r.ano_modelo);
      if (!anoCompleto) {
        console.log(`❌ ano_modelo inválido (${r.ano_modelo})`);
        erros++;
        nullConsec++;
        await sleep(200);
        continue;
      }

      const url = `${FIPE_BASE}/brands/${r.marca_codigo}/models/${r.modelo_codigo}/years/${anoCompleto}-1`;
      const dados = await apiFetch(url);

      if (dados && dados.price) {
        const val = parseFloat(dados.price.replace('R$ ', '').replace(/\./g, '').replace(',', '.'));

        if (!DRY_RUN) {
          await supaFetch(`fipe_valores?id=eq.${r.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              valor: val,
              referencia_mes: mesAtual,
              referencia_ano: anoAtual,
              updated_at: new Date().toISOString(),
            }),
          });
        }

        console.log(`✅ R$ ${val.toLocaleString('pt-BR')}`);
        ok++;
        nullConsec = 0;
      } else {
        console.log(`❌ sem dados`);
        erros++;
        nullConsec++;
      }
    } catch(e) {
      console.log(`❌ ${e.message}`);
      erros++;
      nullConsec++;
    }

    const delay = nullConsec >= 5 ? 2000 : nullConsec >= 3 ? 1000 : 200;
    await sleep(delay);
  }

  console.log(`\n${cortadoPorCota ? '🛑 Interrompido pela trava de cota' : '✅ Concluído'}: ${ok} atualizados, ${erros} erros, ${pulados} deixados pra amanhã — de ${paraAtualizar.length} total.`);
  console.log(`   Requisições usadas: ${budget.count}/${budget.limit}`);
}

module.exports = { run: main };

if (require.main === module) {
  main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
