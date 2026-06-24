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

module.exports = { extrairUF };
