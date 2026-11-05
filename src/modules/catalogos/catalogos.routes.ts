import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { db } from '#database/connection.ts';
import { requireAdmin } from '#middlewares/authenticate.ts';
import { validate } from '#middlewares/validate.ts';
import { AppError } from '#utils/AppError.ts';
import { uuid } from '#utils/tokens.ts';
import { optText } from '#shared/schemas.ts';
import { crudRouter } from '#shared/crud.ts';

// UC14: catálogos globais (leitura para todos, escrita só do administrador)
const router = Router();
const admin: RequestHandler[] = [requireAdmin];

router.use(
  '/bases-dados',
  crudRouter({
    table: 'baseDados',
    scope: () => ({}),
    write: admin,
    orderBy: [{ column: 'nome' }],
    label: 'Base de dados',
    createSchema: z.object({
      nome: z.string().trim().min(1).max(100),
      sigla: optText(30),
      url: z.url().max(300).nullable().optional(),
      ativo: z.boolean().optional(),
    }),
  }),
);

// idioma e tipo_documento usam id numérico (AUTO_INCREMENT)
function catalogoNumerico(table: string, label: string, schema: z.ZodObject<any>) {
  const r = Router();
  const idNum = z.object({ id: z.coerce.number().int().positive() });
  r.get('/', async (_req, res) => res.json(await db(table).orderBy('nome')));
  r.post('/', ...admin, validate({ body: schema }), async (req, res) => {
    const [id] = await db(table).insert(req.validated.body);
    res.status(201).json(await db(table).where({ id }).first());
  });
  r.patch('/:id', ...admin, validate({ params: idNum, body: schema.partial() }), async (req, res) => {
    const n = await db(table).where({ id: req.validated.params.id }).update(req.validated.body);
    if (!n) throw AppError.notFound(label);
    res.json(await db(table).where({ id: req.validated.params.id }).first());
  });
  r.delete('/:id', ...admin, validate({ params: idNum }), async (req, res) => {
    const n = await db(table).where({ id: req.validated.params.id }).del();
    if (!n) throw AppError.notFound(label);
    res.status(204).end();
  });
  return r;
}

router.use('/idiomas', catalogoNumerico('idioma', 'Idioma', z.object({ codigo: z.string().trim().min(2).max(10), nome: z.string().trim().min(1).max(50) })));
router.use('/tipos-documento', catalogoNumerico('tipoDocumento', 'Tipo de documento', z.object({ nome: z.string().trim().min(1).max(60) })));

// RF19: diretrizes de relato (só nome, sigla, versão e link — RNF16)
router.use(
  '/diretrizes',
  crudRouter({
    table: 'diretrizRelato',
    scope: () => ({}),
    write: admin,
    orderBy: [{ column: 'sigla' }],
    label: 'Diretriz',
    createSchema: z.object({
      nome: z.string().trim().min(1).max(200),
      sigla: z.string().trim().min(1).max(30),
      versao: optText(20),
      urlOficial: z.url().max(300).nullable().optional(),
      checklistModeloId: z.uuid().nullable().optional(),
      ativo: z.boolean().optional(),
    }),
  }),
);

// RF20: checklists genéricos (modelo + itens)
const checklistSchema = z.object({
  nome: z.string().trim().min(1).max(150),
  descricao: z.string().max(5000).nullable().optional(),
  padrao: z.boolean().optional(),
  ativo: z.boolean().optional(),
});
router.get('/checklists', async (_req, res) => {
  res.json(await db('checklistModelo').whereNull('projetoId').orderBy('nome'));
});
router.post('/checklists', ...admin, validate({ body: checklistSchema }), async (req, res) => {
  const id = uuid();
  await db('checklistModelo').insert({ ...req.validated.body, id });
  res.status(201).json(await db('checklistModelo').where({ id }).first());
});
router.use(
  '/checklists/:checklistId/itens',
  crudRouter({
    table: 'checklistItemModelo',
    scope: async (req) => {
      const c = await db('checklistModelo').where({ id: String(req.params.checklistId) }).first('id');
      if (!c) throw AppError.notFound('Checklist');
      return { checklistModeloId: c.id };
    },
    write: admin,
    ordered: true,
    label: 'Item do checklist',
    createSchema: z.object({
      codigo: z.string().trim().min(1).max(10),
      secao: z.string().trim().min(1).max(40),
      descricao: z.string().trim().min(1).max(5000),
      ordem: z.number().int().positive().optional(),
    }),
  }),
);
router.patch('/checklists/:id', ...admin, validate({ params: z.object({ id: z.uuid() }), body: checklistSchema.partial() }), async (req, res) => {
  const n = await db('checklistModelo').where({ id: req.validated.params.id }).update(req.validated.body);
  if (!n) throw AppError.notFound('Checklist');
  res.json(await db('checklistModelo').where({ id: req.validated.params.id }).first());
});

export default router;
