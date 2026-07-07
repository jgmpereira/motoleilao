'use strict';

/**
 * Cota diária compartilhada da API FIPE (fipe.parallelum.com.br).
 * Singleton via cache de módulos do Node: qualquer script que fizer
 * `require('./fipe-budget')` no mesmo processo recebe a MESMA instância —
 * é assim que scripts/fipe-diario.js consegue somar as requisições de
 * popular-fipe.js + atualizar-fipe-mensal.js num teto único.
 * Rodando cada script isolado (fora do orquestrador), o processo é outro e
 * o objeto nasce zerado — cada um respeita o teto sozinho, como antes.
 */
module.exports = {
  count: 0,
  limit: parseInt(process.env.REQ_LIMIT || '900', 10),
};
