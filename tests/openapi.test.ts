import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { Router } from 'express';
import SwaggerParser from '@apidevtools/swagger-parser';

// Nenhuma conexão é aberta, mas src/config/env.ts exige estas variáveis.
process.env.DB_HOST ||= 'localhost';
process.env.DB_NAME ||= 'openapi_test';
process.env.DB_USER ||= 'test';
process.env.JWT_SECRET ||= 'teste-openapi-nao-usar-em-producao-0123456789';
process.env.LOG_LEVEL ||= 'warn';

const {
  coletarOperacoes,
  gerarOpenApi,
  registrarCaminhos,
  renomearRepetidos,
  statusDeSucesso,
  tagDe,
} = await import('../src/docs/openapi.ts');
registrarCaminhos(); // antes de carregar qualquer rota
const { validate } = await import('../src/middlewares/validate.ts');
const { requirePapel } = await import('../src/middlewares/projectAccess.ts');
const { default: routes } = await import('../src/routes.ts');
const { app } = await import('../src/app.ts');
const { db } = await import('../src/database/connection.ts');
const { z } = await import('zod');

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const gerado = () => gerarOpenApi(routes as any, { version: pkg.version });

test.after(() => db.destroy());

test('o documento gerado é um OpenAPI 3.1 válido', async () => {
  // validate() altera o objeto (resolve $ref), por isso uma cópia
  await SwaggerParser.validate(structuredClone(gerado()) as any);
});

test('docs/openapi.json está em dia com as rotas', async () => {
  const salvo = JSON.parse(
    await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(salvo, JSON.parse(JSON.stringify(gerado())), 'rode "npm run docs:openapi"');
});

test('cobre as rotas da tabela do README, com autenticação e papéis', () => {
  const { paths } = gerado() as any;
  for (const [caminho, metodo] of [
    ['/auth/login', 'post'],
    ['/me', 'get'],
    ['/admin/usuarios', 'get'],
    ['/projetos', 'post'],
    ['/projetos/{id}/protocolo', 'put'],
    ['/projetos/{id}/questoes/ordem', 'put'],
    ['/revisoes/{id}/etapas/{etapaId}', 'patch'],
    ['/etapas/{etapaId}/documentos/{rdId}/decisao', 'put'],
    ['/analises/{id}/questoes/{qId}/comparativo', 'get'],
    ['/tarefas/{id}', 'get'],
    ['/sync', 'post'],
  ]) {
    assert.ok(paths[caminho]?.[metodo], `${metodo.toUpperCase()} ${caminho} ausente`);
  }

  const login = paths['/auth/login'].post;
  assert.deepEqual(login.security, [], 'login é público');
  assert.ok(login.requestBody.content['application/json'].schema.required.includes('email'));

  const projetos = paths['/projetos'].post;
  assert.equal(projetos.security, undefined, 'herda o bearerAuth global');
  assert.ok(projetos.responses['201'] && projetos.responses['401'] && projetos.responses['422']);

  assert.ok(paths['/admin/usuarios'].get.responses['403'], 'requireAdmin vira 403');
  assert.deepEqual(paths['/projetos/{id}'].delete['x-papeis'], ['RESPONSAVEL']);
  assert.ok(
    paths['/projetos/{id}/protocolo/pdf'].post.responses['202'],
    'tarefas do worker respondem 202',
  );

  const busca = paths['/revisoes/{id}/buscas'].post;
  assert.ok(
    busca.requestBody.content['multipart/form-data'].schema.properties.arquivo,
    'upload multipart',
  );
  assert.deepEqual(
    Object.keys(busca.responses).filter((s) => s < '300'),
    ['201', '202'],
  );
});

test('matriz e discussão usam {adId} para o pai (o :id do item não o sobrescreve)', () => {
  const { paths } = gerado() as any;
  for (const sub of ['matriz', 'discussao']) {
    const item = paths[`/analise-documentos/{adId}/${sub}/{id}`];
    assert.ok(item?.patch && item?.delete, `PATCH/DELETE /analise-documentos/{adId}/${sub}/{id}`);
    assert.equal(paths[`/analise-documentos/{id}/${sub}/{itemId}`], undefined);
  }
});

test('parâmetro repetido (/projetos/:id/temas/:id) vira {itemId}', () => {
  assert.equal(renomearRepetidos('/projetos/:id/temas/:id'), '/projetos/:id/temas/:itemId');
  assert.equal(renomearRepetidos('/a/:x/b/:x/c/:x'), '/a/:x/b/:x2/c/:x22');
  const { paths } = gerado() as any;
  assert.ok(paths['/projetos/{id}/temas/{itemId}'].patch);
  assert.equal(paths['/projetos/{id}/temas/{id}'], undefined);

  // o swagger-parser aceita nome repetido, então conferimos aqui: cada {param} do caminho
  // aparece uma vez e tem exatamente um parâmetro "in: path" correspondente
  for (const [caminho, metodos] of Object.entries<any>(paths)) {
    const noCaminho = [...caminho.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    assert.equal(new Set(noCaminho).size, noCaminho.length, `${caminho}: parâmetro repetido`);
    for (const [metodo, op] of Object.entries<any>(metodos)) {
      const declarados = (op.parameters ?? [])
        .filter((p: any) => p.in === 'path')
        .map((p: any) => p.name);
      assert.deepEqual(declarados, noCaminho, `${metodo.toUpperCase()} ${caminho}`);
    }
  }
});

test('coleta caminhos de routers aninhados e só aplica middleware ao prefixo certo', () => {
  const filho = Router({ mergeParams: true });
  filho.get('/', (_req, res) => res.json([]));
  filho.post('/', validate({ body: z.object({ nome: z.string() }) }), (_req, res) =>
    res.status(201).json({}),
  );
  const raiz = Router();
  const soItens = requirePapel('RESPONSAVEL');
  raiz.use('/x/:id/itens', soItens);
  raiz.use('/x/:id/itens', filho);
  raiz.use('/x/:id/outros', filho);

  const ops = coletarOperacoes(raiz as any);
  const chave = (o: any) => `${o.metodo} ${o.caminho}`;
  assert.deepEqual(ops.map(chave), [
    'get /x/:id/itens',
    'post /x/:id/itens',
    'get /x/:id/outros',
    'post /x/:id/outros',
  ]);
  assert.ok(ops[1].middlewares.includes(soItens as any));
  assert.ok(!ops[3].middlewares.includes(soItens as any));
  assert.ok(ops[1].middlewares.some((m: any) => m.schemas?.body));
});

test('status de sucesso lidos do handler', () => {
  assert.deepEqual(statusDeSucesso(((_q: any, res: any) => res.json({})) as any), ['200']);
  assert.deepEqual(statusDeSucesso(((_q: any, res: any) => res.status(204).end()) as any), ['204']);
  assert.deepEqual(
    statusDeSucesso(((_q: any, res: any, f = true) => res.status(f ? 202 : 201).json({})) as any),
    ['201', '202'],
  );
});

test('agrupa por tag como no README', () => {
  assert.equal(tagDe('/projetos/:id/protocolo/pdf'), 'Protocolo');
  assert.equal(tagDe('/projetos/:id/questoes/ordem'), 'Itens do protocolo');
  assert.equal(tagDe('/revisoes/:id/buscas'), 'Buscas');
  assert.equal(tagDe('/revisoes/:id/relatorio'), 'Relatórios');
  assert.equal(tagDe('/projetos/:id/membros'), 'Projetos');
});

test('a API serve /openapi.json e o Swagger UI em /docs (públicos)', async () => {
  const server = app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

    const json = await fetch(`${base}/openapi.json`);
    assert.equal(json.status, 200);
    assert.equal(((await json.json()) as { openapi: string }).openapi, '3.1.0');

    const html = await fetch(`${base}/docs/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /swagger-ui/i);
    const csp = html.headers.get('content-security-policy') ?? '';
    assert.doesNotMatch(csp, /upgrade-insecure-requests/);

    const init = await fetch(`${base}/docs/swagger-ui-init.js`);
    assert.equal(init.status, 200);
    assert.match(await init.text(), /Konektron Research API/);

    // o resto da API continua protegido
    assert.equal((await fetch(`${base}/me`)).status, 401);
  } finally {
    server.close();
  }
});
