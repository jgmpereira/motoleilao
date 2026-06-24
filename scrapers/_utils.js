'use strict';

const UFS = new Set([
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
  'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO',
]);

/**
 * Extrai a UF (2 letras) de uma string de local/pátio.
 * Ex.: "Guarulhos I / Sp" → "SP", "CAMPO GRANDE - MS" → "MS", "PI" → "PI"
 */
function extrairUF(texto) {
  if (!texto) return null;
  const partes = texto.split(/[\/\-]/);
  const candidato = partes[partes.length - 1].trim().toUpperCase();
  return UFS.has(candidato) ? candidato : null;
}

// ── detectarAlertas ──────────────────────────────────────────────────────────
// Recebe texto (HTML já removido) e retorna array de flags de alerta.
// Reutilizável por qualquer scraper de encerrados.
const ALERTAS_MAP = [
  [/SINISTRAD/i,                                                     'sinistrado'],
  [/PEQ(?:UENA)?\s+MONTA/i,                                          'peq_monta'],
  [/M[EÉ]DIA\s+MONTA/i,                                             'media_monta'],
  [/GRANDE\s+MONTA/i,                                               'grande_monta'],
  [/CIRCUL\.?\s*(?:A[ÇC][ÃA]O\s+)?VEDADA/i,                       'circul_vedada'],
  [/DANOS\s+ESTRUTURAIS/i,                                      'danos_estruturais'],
  [/SEM\s+CHAVE/i,                                                    'sem_chave'],
  [/SUSPENS[ÃA]O\s+DANIFICADA/i,                            'suspensao_danificada'],
  [/HOD[OÔ]METRO\s+DANIFICADO/i,                            'hodometro_danificado'],
  [/RECUPERAD[OA]\s+DE\s+ROUBO|ROUBO\/FURTO/i,              'recuperado_roubo'],
  [/RECALL/i,                                                           'recall'],
];

function detectarAlertas(texto) {
  if (!texto) return [];
  return ALERTAS_MAP
    .filter(([re]) => re.test(texto))
    .map(([, flag]) => flag);
}

// ── stripHtml ─────────────────────────────────────────────────────────────────
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

// ── Filtro por allowlist de trechos úteis (shared com freitas-encerrados.js) ──
const NOISE_RE  = /DECLARA|PORTARIA|\bDETRAN\b|\bCONTRAN\b|RESOLU[ÇC][ÃA]O|\bATPV\b|DOCUMENTA[ÇC][ÃA]O|\bDOCUMENTOS\b|PRAZO|RESPONSABILIDADE|TERMO\s+DE\s+RESP|REC\.?\s*DE\s+FIRMA|CAT[ÁA]LOGO|CONCRETIZA[ÇC][ÃA]O|PAGAMENTO|TRANSFER[ÊE]NCIA|ARREMATANTE|COMITENTE|D[ÉE]BITOS|MULTAS|AVERBA[ÇC][ÃA]O|PONTUA[ÇC][ÃA]O|RESTRI[ÇC][ÃA]O|EMPLACAMENTO|REGULARIZA[ÇC]|LACRA[ÇC]|MERCOSUL|ESTAMPAGEM|PER[ÍI]CIA|\bLAUDO\b|\bECV\b|\bCSV\b|BANC[ÁA]RIA|PROPRIEDADE|PESSOA\s+JUR[ÍI]DICA|S[ÓO]CIO/i;
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

function extrairDescricao(html) {
  const corteRe = /SEM\s+GARANTIAS\s+QUANTO\s+[AÀ]\s+ESTRUTURA/i;
  const texto   = stripHtml(html);
  const blocos  = texto.split(/\n{2,}/);
  for (const bloco of blocos) {
    if (!corteRe.test(bloco)) continue;
    const result = filtrarSegmentos(bloco.slice(0, bloco.search(corteRe)));
    if (result && result.length >= 5) return result;
  }
  const kwRe = /VEICULO\s+VENDIDO\s+NO\s+ESTADO|MEC[ÂA]NICA\s+SEM\s+TESTE|SINISTRADO|PEQ.{0,5}MONTA/i;
  for (const bloco of blocos) {
    if (!kwRe.test(bloco)) continue;
    const result = filtrarSegmentos(bloco.slice(0, 500));
    if (result && result.length >= 5) return result;
  }
  return null;
}

// ── extrairEstadoFreitas ──────────────────────────────────────────────────────
// Ex.: "AV. DOS ESTADOS, 584 - PORTÃO 2 - UTINGA - SANTO ANDRÉ/SP" → "SP"
function extrairEstadoFreitas(html) {
  const m = html.match(
    /Local\s+do\s+leil(?:[ãa]|&atilde;)o:?\s*(?:<[^>]+>\s*)*([^\n<]{3,150})/i
  );
  if (!m) return null;
  const local = m[1].replace(/&[a-z]+;/gi, ' ').replace(/<[^>]+>/g, '').trim();
  console.log(`   📍 Local: "${local}"`);
  const ufMatch = local.match(/[\/\-]\s*([A-Z]{2})\s*$/);
  if (!ufMatch) return null;
  return extrairUF(ufMatch[1]);
}

module.exports = { extrairUF, detectarAlertas, stripHtml, filtrarSegmentos, extrairDescricao, extrairEstadoFreitas };
