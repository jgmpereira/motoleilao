#!/usr/bin/env node
'use strict';

const SUPA_URL = 'https://ntlwhwmtsyniinbkwjgg.supabase.co';
const SUPA_KEY = process.env.SUPABASE_KEY;
const fs = require('fs');
const path = require('path');

if (!SUPA_KEY) {
  console.error('❌ SUPABASE_KEY não definido');
  process.exit(1);
}

async function supaFetchAll(table) {
  const rows = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const res = await fetch(
      `${SUPA_URL}/rest/v1/${table}?select=*&limit=${limit}&offset=${offset}`,
      {
        headers: {
          'apikey': SUPA_KEY,
          'Authorization': `Bearer ${SUPA_KEY}`,
          'Accept': 'application/json',
        }
      }
    );
    if (!res.ok) throw new Error(`Erro ao buscar ${table}: ${res.status}`);
    const data = await res.json();
    rows.push(...data);
    console.log(`  ${table}: ${rows.length} registros carregados...`);
    if (data.length < limit) break;
    offset += limit;
  }
  return rows;
}

async function main() {
  console.log('💾 Backup Supabase iniciando');

  const hoje = new Date().toISOString().slice(0, 10);
  const dir = path.join('backups', hoje);
  fs.mkdirSync(dir, { recursive: true });

  const tabelas = ['leiloes', 'motos', 'arrematados', 'fipe_valores'];

  for (const tabela of tabelas) {
    console.log(`\n📋 Buscando ${tabela}...`);
    const dados = await supaFetchAll(tabela);
    const arquivo = path.join(dir, `${tabela}.json`);
    fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2));
    console.log(`  ✅ ${dados.length} registros salvos em ${arquivo}`);
  }

  // Remove backups com mais de 30 dias
  console.log('\n🧹 Limpando backups antigos...');
  const limite = new Date();
  limite.setDate(limite.getDate() - 30);
  const dirs = fs.readdirSync('backups').filter(d => d.match(/^\d{4}-\d{2}-\d{2}$/));
  for (const d of dirs) {
    if (new Date(d) < limite) {
      fs.rmSync(path.join('backups', d), { recursive: true });
      console.log(`  🗑️  Removido: backups/${d}`);
    }
  }

  console.log('\n✅ Backup concluído!');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
