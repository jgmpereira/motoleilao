#!/usr/bin/env node
'use strict';

/**
 * Reprocessa descricao_resumo das motos Freitas já gravadas no banco,
 * aplicando a mesma lógica de filtragem por allowlist de trechos úteis
 * usada em freitas-encerrados.js (filtrarSegmentos).
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

// ── Filtro por allowlist — idêntico ao de freitas-encerrados.js ───────────────
const NOISE_RE = /DECLARA|PORTARIA|\bDETRAN\b|\bCONTRAN\b|RESOLU[ÇC][ÃA]O|\bATPV\b|DOCUMENTA[ÇC][ÃA]O|\bDOCUMENTOS\b|PRAZO|RESPONSABILIDADE|TERMO\s+DE\s+RESP|REC\.?\s*DE\s+FIRMA|CAT[ÁA]LOGO|CONCRETIZA[ÇC][ÃA]O|PAGAMENTO|TRANSFER[ÊE]NCIA|ARREMATANTE|COMITENTE|D[ÉE]BITOS|MULTAS|AVERBA[ÇC][ÃA]O|PONTUA[ÇC][ÃA]O|RESTRI[ÇC][ÃA]O|EMPLACAMENTO|REGULARIZA[ÇC]|LACRA[ÇC]|MERCOSUL|ESTAMPAGEM|PER[ÍI]CIA|\bLAUDO\b|\bECV\b|\bCSV\b|BANC[ÁA]RIA|PROPRIEDADE|PESSOA\s+JUR[ÍI]DICA|S[ÓO]CIO/i;
const USEFUL_RE = /SINISTRAD|MONTA|CIRCUL|VEDADA|DANOS\s+ESTRUTURAIS|SEM\s+CHAVE|SUSPENS[ÃA]O|HOD[OÔ]METRO|ROUBO|FURTO|DANIFICAD|AUSENTE|FALTA|EMBREAGEM|CORRENTE|C[ÂA]MBIO|VENDIDO\s+NO\s+ESTADO|MEC[ÂA]NICA\s+SEM\s+TESTE|CABO\s+CARREGAMENTO|RECUPERAD|\bMOTOR\b/i;
const STRONG_RE = /SINISTRAD|MONTA|CIRCUL|VEDADA|DANOS\s+ESTRUTURAIS|SEM\s+CHAVE|SUSPENS[ÃA]O|ROUBO|FURTO|RECUPERAD|DANIFICAD/i;
const IPVA_PAGO_RE = /IPVA.{0,80}(?:PAGO|POR\s+CONTA\s+DA\s+(?:COMPANHIA|SEGURADORA|COMITENTE))/i;
const IPVA_COMP_RE = /IPVA.{0,80}(?:P\/C\s+DO\s+COMPRADOR|POR\s+CONTA\s+DO\s+COMPRADOR)/i;

function filtrarSegmentos(texto) {
  if (!texto) return null;
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
    if (/\bIPVA\b|\bDPVAT\b|\bLICENIAMENTO\b/i.test(seg)) {
      if (ipvaTag && !ipvaInserido) { mantidos.push(ipvaTag); ipvaInserido = true; }
      continue;
    }
    const temNoise  = NOISE_RE.test(seg);
    const temUtil   = USEFUL_RE.test(seg);
    const temFort   = STRONG_RE.test(seg);
    const nPalavras = seg.split(/\s+/).filter(Boolean).length;
    if (!temNoise) {
      if (temUtil || nPalavras <= 5) mantidos.push(seg);
    } else if (temFort) {
      const m  = NOISE_RE.exec(seg);
      const ap = m && m.index > 0
        ? seg.slice(0, m.index).replace(/\s*[\/,;\-]+\s*$/, '').trim()
        : seg;
      mantidos.push(ap.length >= 3 ? ap : seg);
    }
  }
  const seen = new Set();
  const dedup = mantidos.filter(s => { if (seen.has(s)) return false; seen.add(s); return true; });
  if (!dedup.length) return null;
  return dedup.join(' / ').replace(/\s+/g, ' ').trim();
}

// ── Testes embutidos — aborta se qualquer exemplo falhar ─────────────────────
function rodarTestes() {
  const casos = [
    {
      entrada: 'SINISTRADO / MEDIA MONTA CIRCUL. VEDADA / DANOS ESTRUTURAIS (COLUNA DE DIRECAO) REGULARIZACOES POR CONTA DO COMPRADOR / IPVA 2026 POR CONTA DA COMPANHIA DE SEGUROS / O COMPRADOR DECLARA QUE ESTA CIENTE / VEICULO VENDIDO NO ESTADO / MECÂNICA SEM TESTE',
      esperado: 'SINISTRADO / MEDIA MONTA CIRCUL. VEDADA / DANOS ESTRUTURAIS (COLUNA DE DIRECAO) / IPVA pago / VEICULO VENDIDO NO ESTADO / MECÂNICA SEM TESTE',
    },
    {
      entrada: 'IPVA, DPVAT E LICENCIAMENTO 2026 P/C DO COMPRADOR / DOCUMENTAÇÃO SERÁ ENTREGUE EM ATÉ 30 DIAS APÓS A REGULARIZAÇÃO / VEICULO VENDIDO NO ESTADO / MECÂNICA SEM TESTE',
      esperado: 'IPVA por conta do comprador / VEICULO VENDIDO NO ESTADO / MECÂNICA SEM TESTE',
    },
    {
      entrada: 'EMBREAGEM DANIFICADA / IPVA 2026 PAGO / A CONCRETIZAÇÃO DA ARREMATAÇÃO, MEDIANTE EMISSÃO DE NOTA DE VENDA SE DARÁ SOMENTE SE REALIZADA EM NOME DA MESMA PESSOA QUE EFETUOU O LANCE NO LEILÃO. O PAGAMENTO DO LOTE ARREMATADO DEVERÁ SER REALIZADO SOMENTE POR MEIO DE TRANSFERÊNCIA ELETRÔNICA COM ORIGEM EM CONTA BANCÁRIA DO PRÓPRIO ARREMATANTE/COMPRADOR (JAMAIS DE TERCEIROS). NÃO SENDO PERMITIDO A FORMALIZAÇÃO DE TRANSFERÊNCIA DA PROPRIEDADE EM NOME DE TERCEIROS. EM CASO DE PESSOA JURÍDICA NÃO É PERMITIDO AO SÓCIO PESSOA FÍSICA FIGURAR COMO COMPRADOR OU PAGADOR / VEICULO VENDIDO NO ESTADO / MECÂNICA SEM TESTE',
      esperado: 'EMBREAGEM DANIFICADA / IPVA pago / VEICULO VENDIDO NO ESTADO / MECÂNICA SEM TESTE',
    },
  ];

  let ok = true;
  for (const { entrada, esperado } of casos) {
    const resultado = filtrarSegmentos(entrada);
    if (resultado !== esperado) {
      console.error('❌ Teste falhou:');
      console.error('   Entrada: ', entrada.slice(0, 100));
      console.error('   Obtido:  ', resultado);
      console.error('   Esperado:', esperado);
      ok = false;
    }
  }
  if (!ok) process.exit(1);
  console.log('✅ Todos os testes passaram\n');
}

async function main() {
  console.log('🧹 Freitas — reprocessamento de descricao_resumo por allowlist');
  console.log(`   Supabase: ${SUPA_URL}\n`);

  rodarTestes();

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
      const limpo = filtrarSegmentos(moto.descricao_resumo);
      const novo  = limpo || null;
      if (novo === moto.descricao_resumo) { totalSemMudanca++; continue; }

      await supaFetch(`motos?id=eq.${moto.id}`, {
        method: 'PATCH',
        body:   JSON.stringify({ descricao_resumo: novo }),
      });
      console.log(`   ✅ moto ${moto.id}:`);
      console.log(`      antes:  "${(moto.descricao_resumo || '').slice(0, 120)}"`);
      console.log(`      depois: "${(novo || '').slice(0, 120)}"`);
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
