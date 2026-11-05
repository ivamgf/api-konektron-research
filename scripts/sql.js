// Executa trechos do script src/database/sql/script_banco_pesquisa_mysql.sql
// respeitando aspas, comentários e blocos DELIMITER (usado pela migração base,
// pelo seed de teste e por npm run db:routines).
import { readFileSync } from 'node:fs';

const SCRIPT = new URL('../src/database/sql/script_banco_pesquisa_mysql.sql', import.meta.url);

export const MARCAS = {
  inicio: '-- 0. SESSÃO E BANCO',
  teste: '-- 7. DADOS PARA TESTE',
  verificacao: '-- 8. CONSULTAS DE VERIFICAÇÃO',
  rotinas: '-- 9. ROTINAS E GATILHOS',
};

export function lerTrecho(de, ate) {
  const sql = readFileSync(SCRIPT, 'utf8');
  const i = sql.indexOf(de);
  if (i < 0) throw new Error(`Marca não encontrada no script: ${de}`);
  const j = ate ? sql.indexOf(ate, i) : -1;
  // volta para o início da linha de "=====" que abre a seção seguinte
  const fim = j < 0 ? sql.length : sql.lastIndexOf('\n-- ====', j);
  return sql.slice(i, fim < 0 ? j : fim);
}

export function dividir(sql) {
  const out = [];
  let delim = ';';
  let buf = '';
  let q = null; // aspas abertas
  const linhas = sql.split('\n');
  for (const linha of linhas) {
    const t = linha.trim();
    if (!q && /^DELIMITER\s+/i.test(t)) {
      delim = t.split(/\s+/)[1];
      continue;
    }
    if (!q && !buf.trim() && t.startsWith('--')) continue;
    for (let k = 0; k < linha.length; k++) {
      const c = linha[k];
      if (q) {
        if (c === '\\') {
          buf += c + (linha[k + 1] ?? '');
          k++;
          continue;
        }
        if (c === q) q = null;
        buf += c;
        continue;
      }
      if (c === '-' && linha[k + 1] === '-' && (k + 2 >= linha.length || /\s/.test(linha[k + 2]))) break;
      if (c === "'" || c === '"' || c === '`') q = c;
      if (linha.startsWith(delim, k)) {
        if (buf.trim()) out.push(buf.trim());
        buf = '';
        k += delim.length - 1;
        continue;
      }
      buf += c;
    }
    buf += '\n';
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

export async function executar(conn, sql) {
  const { default: mysql } = await import('mysql2/promise');
  const c = await mysql.createConnection({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
  });
  try {
    for (const stmt of dividir(sql)) await c.query(stmt);
  } finally {
    await c.end();
  }
}
