#!/usr/bin/env node
'use strict';

/**
 * Scraper de leilões encerrados — VIP Leilões
 *
 * 1. Busca leilões VIP na janela de 3 dias no Supabase (independente da flag encerrado)
 * 2. Para cada leilão, faz GET em cada URL de anúncio das motos
 * 3. Extrai status (Vendido/EmAnalise/Encerrado) e valor de arremate do HTML
 * 4. Grava em `arrematados` com DELETE + INSERT para permitir reprocessamento
 */

const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPA_URL   = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY   = process.env.SUPABASE_KEY;
const VIP_HOST   = 'www.vipleiloes.com.br';
const CANAL_PATH = '/canal?returnUrl=%2Fpesquisa%3Fclassificacao%3DMotos';

if (!SUPA_KEY) {
  console.error('❌  SUPABASE_KEY não definido');
  process.exit(1);
}

// ── HTTP helper (idêntico ao vip.js) ─────────────────────────────────────────
function httpRequest(opts, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      const cookies = res.headers['set-cookie'] || [];
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, cookies, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function getCookieValue(cookieHeaders, name) {
  for (const h of cookieHeaders) {
    const m = h.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

function parseCookies(cookieHeaders) {
  return cookieHeaders
    .map(h => h.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

// ── Supabase REST helper (idêntico ao vip.js) ─────────────────────────────────
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

// ── parseLance: "5.000,00" → 5000 (idêntico ao vip.js) ──────────────────────
function parseLance(vlr) {
  if (!vlr) return null;
  const num = parseFloat(vlr.replace(/[R$\s.]/g, '').replace(',', '.'));
  return isNaN(num) || num <= 0 ? null : num;
}

// ── Obtém cookie __CBCanal (mesmo fluxo do vip.js) ───────────────────────────
async function getCanalCookie() {
  const res = await httpRequest({
    hostname: VIP_HOST,
    path: CANAL_PATH,
    method: 'GET',
    headers: {
      'User-Agent':      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
  });
  // 200 ou 302 são válidos — cookies vêm nos headers
  if (res.status !== 200 && res.status !== 302) {
    throw new Error(`/canal retornou HTTP ${res.status}`);
  }
  return parseCookies(res.cookies);
}

// ── Busca página de anúncio e extrai status + valor ───────────────────────────
// Retorna { statusArrematado, valor } ou null (pular este lote)
async function fetchAnuncio(url, cookieStr) {
  const pathMatch = url.match(/^https?:\/\/[^/]+(\/.*)/);
  if (!pathMatch) return null;
  const path = pathMatch[1];

  let html = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await httpRequest({
        hostname: VIP_HOST,
        path,
        method: 'GET',
        headers: {
          'User-Agent':      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9',
          'Referer':         'https://www.vipleiloes.com.br/pesquisa?classificacao=Motos',
          'Cookie':          cookieStr,
        },
      });
      if (res.status !== 200) {
        console.warn(`    ⚠️ HTTP ${res.status} tentativa ${attempt}/3: ${url}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }
      html = res.body;
      break;
    } catch (err) {
      console.warn(`    ⚠️ Erro tentativa ${attempt}/3: ${err.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  if (!html) return null;

  // STATUS: data-bind-situacaoClass="Vendido|EmAnalise|Encerrado|Aberto|..."
  const situacaoMatch = html.match(/data-bind-situacaoClass\s*=\s*["']([^"']+)["']/i);
  let statusArrematado = null;

  if (situacaoMatch) {
    const classe = situacaoMatch[1].trim();
    if (classe === 'Vendido')    statusArrematado = 'vendido';
    else if (classe === 'EmAnalise') statusArrematado = 'condicional';
    else if (classe === 'Encerrado') statusArrematado = 'não vendido';
    // 'Aberto' ou outro → null (lote ainda ativo, pular)
  }

  if (!statusArrematado) return null;

  // VALOR: data-bind-valorAtual ... R$ X.XXX,XX
  const valorMatch = html.match(/data-bind-valorAtual[^>]*>[\s\S]*?R\$\s*([\d.,]+)/i);
  const valor = valorMatch ? parseLance(valorMatch[1]) : null;

  // Lote deserto (não vendido sem valor): registrar sem valor
  // Vendido/condicional sem valor: registrar mesmo assim
  return { statusArrematado, valor };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🏁 VIP Leilões — scraper de encerrados iniciando');
  console.log(`   Supabase: ${SUPA_URL}`);

  // 1. Janela de 3 dias
  const hoje       = new Date().toISOString().slice(0, 10);
  const hojeMenos3 = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  console.log(`\n📅 Janela: ${hojeMenos3} → ${hoje}`);

  // 2. Busca leilões VIP na janela (independente da flag encerrado)
  const leiloes = await supaFetch(
    `leiloes?plataforma=eq.VIP Leilões&data=gte.${hojeMenos3}&data=lte.${hoje}&select=id,data`,
    { prefer: 'return=representation' }
  );

  if (!leiloes || leiloes.length === 0) {
    console.log('ℹ️  Nenhum leilão VIP na janela de 3 dias. Encerrando.');
    return;
  }

  console.log(`\n📋 ${leiloes.length} leilão(ões) para processar:`);
  for (const l of leiloes) console.log(`   → ${l.id} (${l.data})`);

  // 3. Cookie (1x)
  console.log('\n🌐 Obtendo cookie VIP...');
  const cookieStr = await getCanalCookie();
  console.log(`   Cookie: ${cookieStr.slice(0, 60)}...`);

  // 4. Processa cada leilão
  let totVendido = 0, totCondicional = 0, totNaoVendido = 0, totPulado = 0;

  for (const leilao of leiloes) {
    console.log(`\n📦 Leilão: ${leilao.id} (${leilao.data})`);

    const motos = await supaFetch(
      `motos?leilao_id=eq.${leilao.id}&select=id,url,modelo`,
      { prefer: 'return=representation' }
    );

    if (!motos || motos.length === 0) {
      console.log('   ⚠️ Nenhuma moto encontrada. Pulando.');
      continue;
    }

    const motosVip = motos.filter(m => m.url && m.url.includes('/evento/anuncio/'));
    console.log(`   ${motosVip.length}/${motos.length} motos com URL de anúncio VIP`);

    let vendido = 0, condicional = 0, naoVendido = 0, pulado = 0;

    for (const moto of motosVip) {
      const resultado = await fetchAnuncio(moto.url, cookieStr);

      if (!resultado) {
        pulado++;
        // Delay mesmo nos pulados para não martelar
        await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
        continue;
      }

      const { statusArrematado, valor } = resultado;

      // 5. DELETE + INSERT para garantir atualização em reprocessamentos
      await supaFetch(`arrematados?moto_id=eq.${moto.id}`, { method: 'DELETE' });
      await supaFetch('arrematados', {
        method: 'POST',
        body: JSON.stringify({
          moto_id:           moto.id,
          valor:             valor ?? 0,
          status_arrematado: statusArrematado,
        }),
        prefer: 'resolution=merge-duplicates,return=minimal',
      });

      if (statusArrematado === 'vendido')       vendido++;
      else if (statusArrematado === 'condicional') condicional++;
      else                                         naoVendido++;

      await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
    }

    console.log(`   ✅ vendido=${vendido}  condicional=${condicional}  não_vendido=${naoVendido}  pulado=${pulado}`);

    totVendido     += vendido;
    totCondicional += condicional;
    totNaoVendido  += naoVendido;
    totPulado      += pulado;
  }

  console.log('\n📊 Totais finais:');
  console.log(`   vendido=${totVendido}  condicional=${totCondicional}  não_vendido=${totNaoVendido}  pulado=${totPulado}`);
  console.log('\n✅ Scraper VIP encerrados concluído!');
}

main().catch(err => {
  console.error('\n❌ Erro fatal:', err.message);
  process.exit(1);
});
