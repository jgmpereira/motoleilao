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

module.exports = { extrairUF, detectarAlertas };
