#!/usr/bin/env node
'use strict';

/**
 * Reprocessa descricao_resumo das motos Freitas já gravadas no banco,
 * removendo o bloco jurídico fixo de pagamento/transferência que contamina
 * o resumo útil do lote.
 *
 * Uso: SUPABASE_KEY=... node scrapers/freitas-limpar-resumos.js
 */

const SUPA_URL = process.env.SUPABASE_URL || 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY = process.env.SUPABASE_KEY;

if (!SUPA_KEY) {
  console.error('❌  SUPABASE_KEY não definido');
  process.exit(1);
}

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

// Deve ser idêntica à limparResumo de freitas-encerrados.js
const BLOCO_PAGAMENTO_RE = /A CONCRETIZA[ÇC][ÃA]O DA ARREMATA[ÇC][ÃA]O[\s\S]*?FIGURAR COMO COMPRADOR OU PAGADOR\.?/gi;

function limparResumo(texto) {
  return texto
    .replace(/<!--|-->/g, '')
    .replace(BLOCO_PAGAMENTO_RE, '')
    .replace(/(\s*\/\s*){2,}/g, ' / ')
    .replace(/^\s*\/\s*/, '')
    .replace(/\s*\/\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s\/\->]+/, '')
    .trim();
}

async function main() {
  console.log('🧹 Freitas — limpeza de descricao_resumo iniciando');
  console.log(`   Supabase: ${SUPA_URL}\n`);

  // Valida regex em exemplo antes de tocar no banco
  const exemplo = 'EMBREAGEM DANIFICADA / IPVA 2026 PAGO / A CONCRETIZAÇÃO DA ARREMATAÇÃO, MEDIANTE EMISSÃO DE NOTA DE VENDA SE DARÁ SOMENTE SE REALIZADA EM NOME DA MESMA PESSOA QUE EFETUOU O LANCE NO LEILÃO. O PAGAMENTO DO LOTE ARREMATADO DEVERÁ SER REALIZADO SOMENTE POR MEIO DE TRANSFERÊNCIA ELETRÔNICA COM ORIGEM EM CONTA BANCÁRIA DO PRÓPRIO ARREMATANTE/COMPRADOR (JAMAIS DE TERCEIROS). NÃO SENDO PERMITIDO A FORMALIZAÇÃO DE TRANSFERÊNCIA DA PROPRIEDADE EM NOME DE TERCEIROS. EM CASO DE PESSOA JURÍDICA NÃO É PERMITIDO AO SÓCIO PESSOA FÍSICA FIGURAR COMO COMPRADOR OU PAGADOR / VEICULO VENDIDO NO ESTADO / MECÂNICA SEM TESTE';
  const resultadoTeste = limparResumo(exemplo);
  const esperado = 'EMBREAGEM DANIFICADA / IPVA 2026 PAGO / VEICULO VENDIDO NO ESTADO / MECÂNICA SEM TESTE';
  if (resultadoTeste !== esperado) {
    console.error('❌ Falha no teste de regex:');
    console.error('   Obtido: ', resultadoTeste);
    console.error('   Esperado:', esperado);
    process.exit(1);
  }
  console.log('✅ Teste de regex OK:', resultadoTeste);
  console.log();

  const PAGE = 1000;
  let offset = 0;
  let totalAtualizado = 0;
  let totalSemMudanca = 0;

  while (true) {
    const motos = await supaFetch(
      `motos?leilao_id=like.freitas*&descricao_resumo=not.is.null&select=id,descricao_resumo&limit=${PAGE}&offset=${offset}`,
      { prefer: 'return=representation' }
    );

    if (!motos || motos.length === 0) break;

    for (const moto of motos) {
      const limpo = limparResumo(moto.descricao_resumo);
      if (limpo === moto.descricao_resumo) {
        totalSemMudanca++;
        continue;
      }
      await supaFetch(`motos?id=eq.${moto.id}`, {
        method: 'PATCH',
        body:   JSON.stringify({ descricao_resumo: limpo }),
      });
      console.log(`   ✅ moto ${moto.id}:`);
      console.log(`      antes:  "${moto.descricao_resumo.slice(0, 120)}"`);
      console.log(`      depois: "${limpo.slice(0, 120)}"`);
      totalAtualizado++;
    }

    if (motos.length < PAGE) break;
    offset += PAGE;
  }

  console.log(`\n📊 Atualizados: ${totalAtualizado}  Sem mudança: ${totalSemMudanca}`);
  console.log('✅ Limpeza concluída!');
}

main().catch(err => {
  console.error('\n❌ Erro fatal:', err.message);
  process.exit(1);
});
