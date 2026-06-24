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
const { extrairUF, detectarAlertas } = require('./_utils');

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

// ── stripHtml: converte HTML em texto limpo (blocos → \n\n) ───────────────────
function stripHtml(html) {
  return html
    .replace(/<\/(p|div|li|td|tr|section|article|h[1-6])\b[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ');
}

// Bloco jurídico fixo de pagamento/transferência — aparece no meio do resumo útil
const BLOCO_PAGAMENTO_RE = /A CONCRETIZA[ÇC][ÃA]O DA ARREMATA[ÇC][ÃA]O[\s\S]*?FIGURAR COMO COMPRADOR OU PAGADOR\.?/gi;

// ── Limpa lixo de comentário HTML, bloco de pagamento e separadores órfãos ──
function limparResumo(texto) {
  return texto
    .replace(/<!--|-->/g, '')          // remove marcadores de comentário HTML
    .replace(BLOCO_PAGAMENTO_RE, '')   // remove bloco jurídico fixo de pagamento
    .replace(/(\s*\/\s*){2,}/g, ' / ') // colapsa separadores duplicados resultantes
    .replace(/^\s*\/\s*/, '')          // remove / solto no início
    .replace(/\s*\/\s*$/, '')          // remove / solto no fim
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s\/\->]+/, '')        // remove qualquer combinação de /, -, > no início
    .trim();
}

// ── Extrai descricao_resumo do HTML ──────────────────────────────────────────
// Localiza o bloco (parágrafo) que contém "SEM GARANTIAS QUANTO A ESTRUTURA"
// e retorna tudo antes desse marcador (a parte útil variável do lote).
function extrairDescricao(html) {
  const corteRe = /SEM\s+GARANTIAS\s+QUANTO\s+[AÀ]\s+ESTRUTURA/i;
  const texto   = stripHtml(html);

  // Divide em parágrafos lógicos (separados por linha em branco)
  const blocos = texto.split(/\n{2,}/);

  for (const bloco of blocos) {
    if (!corteRe.test(bloco)) continue;
    const idx   = bloco.search(corteRe);
    const antes = limparResumo(bloco.slice(0, idx));
    if (antes.length >= 5) return antes;
  }

  // Fallback: bloco com palavras-chave típicas de condição, sem "SEM GARANTIAS"
  const kwRe = /VEICULO\s+VENDIDO\s+NO\s+ESTADO|MECA(?:N|Â)ICA\s+SEM\s+TESTE|SINISTRADO|PEQ.{0,5}MONTA/i;
  for (const bloco of blocos) {
    if (!kwRe.test(bloco)) continue;
    const texto2 = limparResumo(bloco.slice(0, 300));
    if (texto2.length >= 5) return texto2;
  }

  return null;
}

// ── Extrai UF do endereço local do Freitas ────────────────────────────────────
// Endereços têm vários "-" no meio; a UF são sempre as 2 letras maiúsculas
// no FINAL da string, após o último "/" ou "-".
// Ex.: "AV. DOS ESTADOS, 584 - PORTÃO 2 - UTINGA - SANTO ANDRÉ/SP" → "SP"
function extrairEstadoFreitas(html) {
  // Permite tags HTML entre o rótulo e o texto do endereço
  const m = html.match(
    /Local\s+do\s+leil(?:[ãa]|&atilde;)o:?\s*(?:<[^>]+>\s*)*([^\n<]{3,150})/i
  );
  if (!m) return null;
  const local = m[1].replace(/&[a-z]+;/gi, ' ').replace(/<[^>]+>/g, '').trim();
  console.log(`   📍 Local: "${local}"`);
  // Pega as 2 letras maiúsculas no final após "/" ou "-"
  const ufMatch = local.match(/[\/\-]\s*([A-Z]{2})\s*$/);
  if (!ufMatch) return null;
  return extrairUF(ufMatch[1]); // valida contra lista de UFs conhecidas
}

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

      // PATCH motos: estado só se vazio; descricao_resumo e alertas sempre
      const patch = {};
      if (!moto.estado && estado) { patch.estado = estado; estadoPreenchido++; }
      if (descricaoResumo != null) patch.descricao_resumo = descricaoResumo;
      patch.alertas = alertas; // null limpa alertas stale de execuções anteriores

      await supaFetch(`motos?id=eq.${moto.id}`, {
        method: 'PATCH',
        body:   JSON.stringify(patch),
        prefer: 'return=minimal',
      });

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
