// Gera docs/openapi.json a partir das rotas (src/docs/openapi.ts).
//   npm run docs:openapi   grava o arquivo
//   npm run docs:check     só confere (sai com 1 se estiver desatualizado) — usado no CI
import { readFile, writeFile } from 'node:fs/promises';

// Nenhuma conexão é aberta, mas src/config/env.ts exige estas variáveis.
process.env.DB_HOST ||= 'localhost';
process.env.DB_NAME ||= 'openapi';
process.env.DB_USER ||= 'openapi';
process.env.JWT_SECRET ||= 'openapi-gerador-nao-usar-em-producao-0123456789';
process.env.LOG_LEVEL ||= 'warn';

const { gerarOpenApi, registrarCaminhos } = await import('../src/docs/openapi.ts');
registrarCaminhos(); // antes de carregar as rotas
const { default: routes } = await import('../src/routes.ts');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const arquivo = new URL('../docs/openapi.json', import.meta.url);
const novo = `${JSON.stringify(gerarOpenApi(routes, { version: pkg.version }), null, 2)}\n`;

let codigo = 0;
if (process.argv.includes('--check')) {
  const atual = await readFile(arquivo, 'utf8').catch(() => '');
  if (atual.replace(/\r\n/g, '\n') !== novo) {
    console.error(
      'docs/openapi.json está desatualizado. Rode "npm run docs:openapi" e faça commit.',
    );
    codigo = 1;
  } else {
    console.log('docs/openapi.json em dia.');
  }
} else {
  await writeFile(arquivo, novo);
  console.log(`docs/openapi.json gerado (${Object.keys(JSON.parse(novo).paths).length} caminhos).`);
}

// o pool do Knex não chega a abrir conexões, mas encerra para o processo sair na hora
const { db } = await import('../src/database/connection.ts');
await db.destroy();
process.exit(codigo);
