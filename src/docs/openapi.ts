/**
 * Gera o documento OpenAPI 3.1 percorrendo o roteador do Express e lendo os schemas Zod
 * que o middleware validate() expõe. Assim a documentação não se afasta do código:
 * `npm run docs:openapi` grava docs/openapi.json e o CI (`npm run docs:check`) falha se ele
 * estiver desatualizado.
 *
 * O Express 5 não guarda o caminho de router.use('/x', ...) na camada, por isso
 * registrarCaminhos() precisa rodar ANTES de importar as rotas (ver scripts/openapi.js).
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAdmin } from '#middlewares/authenticate.ts';
import type { Schemas } from '#middlewares/validate.ts';

type Handler = ((...args: any[]) => unknown) & {
  schemas?: Schemas;
  papeis?: string[];
  recurso?: string;
  stack?: Layer[];
};
type Layer = {
  handle: Handler;
  route?: { path: string; stack: { method?: string; handle: Handler }[] };
  caminho?: string;
};
type JsonSchema = Record<string, any>;

const CAMINHO = Symbol.for('konektron.openapi.caminho');

/** Faz cada router.use() anotar na camada o caminho de montagem. Idempotente. */
export function registrarCaminhos() {
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(Router())) as any;
  if (proto[CAMINHO]) return;
  const use = proto.use;
  proto.use = function (this: { stack: Layer[] }, ...args: unknown[]) {
    const antes = this.stack.length;
    const result = use.apply(this, args);
    let primeiro = args[0];
    while (Array.isArray(primeiro) && primeiro.length) primeiro = primeiro[0];
    const caminho = typeof primeiro === 'string' ? primeiro : '/';
    for (const layer of this.stack.slice(antes)) layer.caminho = caminho;
    return result;
  };
  proto[CAMINHO] = true;
}

// ---------------------------------------------------------------- caminhos

const juntar = (a: string, b: string) => {
  const p = `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`.replace(/\/+$/, '');
  return p || '/';
};
const segmentos = (p: string) => p.split('/').filter(Boolean);
/** "/projetos/:id/x" casa com o prefixo "/projetos/:projeto"? (parâmetro casa com qualquer segmento) */
const temPrefixo = (caminho: string, prefixo: string) => {
  const a = segmentos(caminho);
  const b = segmentos(prefixo);
  return b.length <= a.length && b.every((s, i) => s.startsWith(':') || s === a[i]);
};
export const paraOpenApi = (p: string) => p.replace(/:(\w+)/g, '{$1}');
/** "/projetos/:id/temas/:id" → "/projetos/:id/temas/:itemId" (repete com sufixo se precisar) */
export const renomearRepetidos = (p: string) => {
  const vistos = new Set<string>();
  return p.replace(/:(\w+)/g, (_m, nome: string) => {
    let novo = vistos.has(nome) ? (nome === 'id' ? 'itemId' : `${nome}2`) : nome;
    while (vistos.has(novo)) novo += '2';
    vistos.add(novo);
    return `:${novo}`;
  });
};

// ---------------------------------------------------------------- coleta das rotas

export type Operacao = {
  metodo: string;
  caminho: string; // formato Express, ex.: /projetos/:id
  middlewares: Handler[];
  handler: Handler;
};

/** Achata a árvore de roteadores em operações (método + caminho + middlewares aplicáveis). */
export function coletarOperacoes(
  router: { stack: Layer[] },
  base = '',
  herdados: { prefixo: string; fn: Handler }[] = [],
) {
  const ops: Operacao[] = [];
  const ativos = [...herdados];
  for (const layer of router.stack) {
    if (layer.route) {
      const caminho = juntar(base, layer.route.path);
      const doCaminho = ativos.filter((m) => temPrefixo(caminho, m.prefixo)).map((m) => m.fn);
      const porMetodo = new Map<string, Handler[]>();
      const comuns: Handler[] = []; // route.all(...)
      for (const l of layer.route.stack) {
        if (!l.method) comuns.push(l.handle);
        else porMetodo.set(l.method, [...(porMetodo.get(l.method) ?? []), l.handle]);
      }
      for (const [metodo, fns] of porMetodo) {
        if (metodo === 'head' || metodo === 'options') continue;
        const todos = [...doCaminho, ...comuns, ...fns];
        ops.push({
          metodo,
          caminho,
          middlewares: todos.slice(0, -1),
          handler: todos[todos.length - 1],
        });
      }
      continue;
    }
    const prefixo = juntar(base, layer.caminho ?? '/');
    if (Array.isArray(layer.handle.stack)) {
      ops.push(...coletarOperacoes(layer.handle as { stack: Layer[] }, prefixo, ativos));
    } else {
      ativos.push({ prefixo, fn: layer.handle });
    }
  }
  return ops;
}

// ---------------------------------------------------------------- Zod → JSON Schema

const paraJsonSchema = (schema: z.ZodType): JsonSchema => {
  const { $schema: _, ...js } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    reused: 'inline',
    // uuid, email, date...: o "format" já diz tudo; a regex interna do Zod só polui a documentação
    override: ({ jsonSchema }) => {
      if (jsonSchema.format && jsonSchema.pattern) delete jsonSchema.pattern;
    },
  }) as JsonSchema;
  return js;
};

const parametros = (schema: z.ZodType | undefined, onde: 'path' | 'query') => {
  if (!schema) return [];
  const js = paraJsonSchema(schema);
  const obrigatorios = new Set<string>(js.required ?? []);
  return Object.entries<JsonSchema>(js.properties ?? {}).map(([name, s]) => {
    const { description, ...semDescricao } = s;
    return {
      name,
      in: onde,
      required: onde === 'path' || obrigatorios.has(name),
      ...(description ? { description } : {}),
      schema: semDescricao,
    };
  });
};

// ---------------------------------------------------------------- agrupamento (tags)

// Mesmos grupos da tabela de rotas do README. A primeira regra que casar vence.
const TAGS: [RegExp, string][] = [
  [/^\/(health)?$/, 'Sistema'],
  [/^\/auth\//, 'Autenticação'],
  [/^\/arquivos\//, 'Arquivos'],
  [/^\/me(\/|$)/, 'Perfil'],
  [/^\/admin\//, 'Administração'],
  [/^\/(bases-dados|idiomas|tipos-documento|diretrizes|checklists)(\/|$)/, 'Catálogos'],
  [/^\/projetos\/[^/]+\/protocolo(\/|$)/, 'Protocolo'],
  [
    /^\/projetos\/[^/]+\/(outras-questoes|objetivos|palavras-chave|descritores|strings|criterios|questoes)(\/|$)/,
    'Itens do protocolo',
  ],
  [/^\/tipos-revisao(\/|$)/, 'Tipos de revisão'],
  [/^\/(revisoes\/[^/]+\/buscas|buscas)(\/|$)/, 'Buscas'],
  [/^\/revisoes\/[^/]+\/(painel|fluxograma|checklist)(\/|$)/, 'Painel e checklist'],
  [
    /^\/(projetos\/[^/]+\/exportar|revisoes\/[^/]+\/relatorio|analises\/[^/]+\/exportar|tarefas)(\/|$)/,
    'Relatórios',
  ],
  [
    /^\/(documentos|projetos\/[^/]+\/documentos|revisoes\/[^/]+\/(documentos|duplicados))(\/|$)/,
    'Documentos',
  ],
  [/^\/(revisoes|projetos\/[^/]+\/revisoes)(\/|$)/, 'Revisões'],
  [/^\/etapas\//, 'Triagem'],
  [/^\/(analises|analise-documentos|projetos\/[^/]+\/analises)(\/|$)/, 'Análises'],
  [/^\/(projetos\/[^/]+\/(temas|categorias|comentarios|busca)|notificacoes|sync)(\/|$)/, 'Apoio'],
  [/^\/projetos(\/|$)/, 'Projetos'],
];
export const tagDe = (caminho: string) => TAGS.find(([re]) => re.test(caminho))?.[1] ?? 'Outros';

// ---------------------------------------------------------------- respostas

const ERRO = { $ref: '#/components/responses/Erro' };

/** Status 2xx que o handler pode devolver, lidos do próprio código (res.status(201) etc.). */
export const statusDeSucesso = (handler: Handler) => {
  const fonte = Function.prototype.toString.call(handler);
  // inclui o condicional res.status(arquivoId ? 202 : 201)
  const achados = [...fonte.matchAll(/\.status\(([^)]*)\)/g)].flatMap(
    (m) => m[1].match(/\b2\d\d\b/g) ?? [],
  );
  // sem status explícito, ou com res.json()/res.send()/res.type() direto → 200
  if (!achados.length || /\bres\s*\.\s*(json|send|type)\(/.test(fonte)) achados.push('200');
  return [...new Set(achados)].sort();
};

/** Erros lançados no próprio handler (os dos services não aparecem aqui). */
const errosDoHandler = (handler: Handler) => {
  const fonte = Function.prototype.toString.call(handler);
  return {
    '403': /AppError\.forbidden\(/.test(fonte),
    '404': /AppError\.notFound\(/.test(fonte),
    '409': /AppError\.conflict\(/.test(fonte),
  };
};

const DESCRICAO_STATUS: Record<string, string> = {
  '200': 'Sucesso',
  '201': 'Criado',
  '202': 'Aceito: tarefa enfileirada no worker; acompanhe em GET /tarefas/{id}',
  '204': 'Sem conteúdo',
};

// ---------------------------------------------------------------- documento

export function gerarOpenApi(router: { stack: Layer[] }, info: { version: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  const ops = coletarOperacoes(router).sort(
    (a, b) =>
      a.caminho.localeCompare(b.caminho) ||
      ORDEM_METODOS.indexOf(a.metodo) - ORDEM_METODOS.indexOf(b.metodo),
  );

  for (const op of ops) {
    const mws = op.middlewares;
    const validacao: Schemas = Object.assign({}, ...mws.map((m) => m.schemas ?? {}));
    const autenticada = mws.includes(authenticate as Handler);
    const admin = mws.includes(requireAdmin as Handler);
    const papeis = mws.findLast((m) => m.papeis)?.papeis;
    const recurso = mws.findLast((m) => m.recurso)?.recurso;
    const upload = mws.some((m) => m.name === 'multerMiddleware');

    // Parâmetros de caminho. CRUDs montados em /projetos/:id também usam /:id (no Express o
    // filho prevalece e o projeto vem de req.projeto), mas o OpenAPI não aceita nome repetido:
    // o de dentro vira {itemId}. O schema do validate() vale para a ocorrência mais interna.
    const noSchema = parametros(validacao.params, 'path');
    const nomes = [...op.caminho.matchAll(/:(\w+)/g)].map((m) => m[1]);
    const caminhoDoc =
      nomes.length === new Set(nomes).size ? op.caminho : renomearRepetidos(op.caminho);
    const nomesDoc = [...caminhoDoc.matchAll(/:(\w+)/g)].map((m) => m[1]);
    const doCaminho = nomes.map((name, i) => {
      const interno = nomes.lastIndexOf(name) === i;
      const doSchema = interno ? noSchema.find((p) => p.name === name) : undefined;
      return {
        ...(doSchema ?? {
          in: 'path',
          required: true,
          schema:
            recurso || name.endsWith('Id') || name === 'id'
              ? { type: 'string', format: 'uuid' }
              : { type: 'string' },
        }),
        name: nomesDoc[i],
      };
    });
    const parameters = [...doCaminho, ...parametros(validacao.query, 'query')];

    let requestBody: unknown;
    if (upload) {
      const campos = validacao.body
        ? paraJsonSchema(validacao.body)
        : { type: 'object', properties: {} };
      requestBody = {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              ...campos,
              properties: { arquivo: { type: 'string', format: 'binary' }, ...campos.properties },
              required: ['arquivo', ...(campos.required ?? [])],
            },
          },
        },
      };
    } else if (validacao.body) {
      const schema = paraJsonSchema(validacao.body);
      requestBody = {
        required: (schema.required ?? []).length > 0,
        content: { 'application/json': { schema } },
      };
    }

    const lancados = errosDoHandler(op.handler);
    const respostas: Record<string, unknown> = {};
    for (const s of statusDeSucesso(op.handler))
      respostas[s] = { description: DESCRICAO_STATUS[s] ?? 'Sucesso' };
    if (autenticada) respostas['401'] = ERRO;
    if (admin || papeis || lancados['403']) respostas['403'] = ERRO;
    if (recurso || doCaminho.length || lancados['404']) respostas['404'] = ERRO;
    if (lancados['409']) respostas['409'] = ERRO;
    if (Object.keys(validacao).length || upload) respostas['422'] = ERRO;
    const responses = Object.fromEntries(
      Object.entries(respostas).sort(([a], [b]) => a.localeCompare(b)),
    );

    const notas: string[] = [];
    if (admin) notas.push('Somente administrador.');
    if (papeis)
      notas.push(`Papéis no projeto: ${papeis.join(', ')} (o administrador sempre passa).`);
    else if (recurso) notas.push('Requer ser membro do projeto (qualquer papel).');

    const caminho = paraOpenApi(caminhoDoc);
    paths[caminho] ??= {};
    paths[caminho][op.metodo] = {
      tags: [tagDe(op.caminho)],
      operationId: operationId(op.metodo, caminhoDoc),
      ...(notas.length ? { description: notas.join(' ') } : {}),
      ...(autenticada ? {} : { security: [] }),
      ...(parameters.length ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses,
      ...(papeis ? { 'x-papeis': papeis } : {}),
    };
  }

  const tagsUsadas = new Set(ops.map((o) => tagDe(o.caminho)));
  return {
    openapi: '3.1.0',
    info: {
      title: 'Konektron Research API',
      version: info.version,
      description:
        'API do Konektron Research (ERS v1.1). Documento gerado a partir das rotas e dos schemas Zod — não edite à mão; rode `npm run docs:openapi`.\n\n' +
        'Erros seguem `{ "erro": { "codigo", "mensagem", "campos" } }`. PDFs, importações e exportações respondem `202` com `tarefaId`; consulte `GET /tarefas/{id}` até `CONCLUIDA`.',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ bearerAuth: [] }],
    tags: [...new Set(TAGS.map(([, t]) => t)), 'Outros']
      .filter((t) => tagsUsadas.has(t))
      .map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'accessToken de POST /auth/login',
        },
      },
      schemas: {
        Erro: {
          type: 'object',
          required: ['erro'],
          properties: {
            erro: {
              type: 'object',
              required: ['codigo', 'mensagem'],
              properties: {
                codigo: { type: 'string', examples: ['DADOS_INVALIDOS'] },
                mensagem: { type: 'string' },
                campos: {
                  type: 'object',
                  additionalProperties: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
      responses: {
        Erro: {
          description: 'Erro',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Erro' } } },
        },
      },
    },
  };
}

const ORDEM_METODOS = ['get', 'post', 'put', 'patch', 'delete'];

const operationId = (metodo: string, caminho: string) =>
  metodo +
  segmentos(caminho)
    .map((s) => (s.startsWith(':') ? `By${s.slice(1)}` : s))
    .map((s) => s.replace(/(^|[-_])(\w)/g, (_m, _sep, c: string) => c.toUpperCase()))
    .join('');
