#!/usr/bin/env node
'use strict';

/**
 * Atualização mensal de valores FIPE
 * Roda no dia 1 de cada mês via GitHub Actions
 * Atualiza todos os registros de fipe_valores com os preços do mês atual
 */

const SUPA_URL = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY = process.env.SUPABASE_KEY;
const FIPE_BASE = 'https://parallelum.com.br/fipe/api/v1/motos';

if (!SUPA_KEY) { console.error('❌ SUPABASE_KEY não definido'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

  let ok = 0, erros = 0, nullConsec = 0;

  for (let i = 0; i < paraAtualizar.length; i++) {
    const r = paraAtualizar[i];
    process.stdout.write(`[${i+1}/${paraAtualizar.length}] lookup: ${r.lookup_key} ... `);

    try {
      const url = `${FIPE_BASE}/marcas/${r.marca_codigo}/modelos/${r.modelo_codigo}/anos/${r.ano_modelo}-1`;
      const dados = await apiFetch(url);

      if (dados && dados.Valor) {
        const val = parseFloat(dados.Valor.replace('R$ ', '').replace(/\./g, '').replace(',', '.'));
        
        await supaFetch(`fipe_valores?id=eq.${r.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            valor: val,
            referencia_mes: mesAtual,
            referencia_ano: anoAtual,
            updated_at: new Date().toISOString(),
          }),
        });

        // Atualiza também fipe_csv nas motos que usam esse lookup_key
        await supaFetch(`motos?fipe_csv=not.is.null&leilao_id=in.(${
          await getLeiloesFuturos()
        })`, {
          method: 'GET',
        });

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

    // Backoff progressivo
    const delay = nullConsec >= 5 ? 3000 : nullConsec >= 3 ? 1500 : 500;
    await sleep(delay);
  }

  console.log(`\n✅ Concluído: ${ok} atualizados, ${erros} erros de ${paraAtualizar.length} total`);
}

async function getLeiloesFuturos() {
  const hoje = new Date().toISOString().slice(0, 10);
  const leiloes = await supaFetch(
    `leiloes?encerrado=eq.false&select=id`,
    { prefer: 'return=representation' }
  );
  return (leiloes || []).map(l => `"${l.id}"`).join(',') || '""';
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
