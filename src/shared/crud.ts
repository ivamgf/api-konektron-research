import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { db, json, type Trx } from '#database/connection.ts';
import { AppError } from '#utils/AppError.ts';
import { uuid } from '#utils/tokens.ts';
import { validate } from '#middlewares/validate.ts';
import { idParams } from '#shared/schemas.ts';
import { compactar, proximaOrdem, reordenar } from '#shared/ordem.ts';

type Opcoes = {
  table: string;
  /** where aplicado em todas as operações (ex.: { protocoloId }) */
  scope: (req: Request) => Promise<Record<string, unknown>> | Record<string, unknown>;
  createSchema: z.ZodObject<any>;
  updateSchema?: z.ZodType;
  /** middlewares exigidos para POST/PATCH/DELETE (papéis) */
  write?: RequestHandler[];
  ordered?: boolean;
  orderBy?: { column: string; order?: 'asc' | 'desc' }[];
  jsonFields?: string[];
  label?: string;
  beforeWrite?: (trx: Trx, req: Request, data: Record<string, any>, id?: string) => Promise<void> | void;
  afterWrite?: (trx: Trx, req: Request, row: Record<string, any>) => Promise<void> | void;
};

/**
 * CRUD escopado: GET /, POST /, GET /:id, PATCH /:id, DELETE /:id e, para listas
 * ordenadas, PUT /ordem com { ids: [...] }.
 */
export function crudRouter(o: Opcoes) {
  const router = Router({ mergeParams: true });
  const label = o.label ?? 'Registro';
  const updateSchema = o.updateSchema ?? o.createSchema.partial();
  const orderBy = o.orderBy ?? (o.ordered ? [{ column: 'ordem' }] : [{ column: 'id' }]);
  const write = o.write ?? [];
  const serial = (d: Record<string, any>) => {
    const out = { ...d };
    for (const f of o.jsonFields ?? []) if (f in out) out[f] = json(out[f]);
    return out;
  };

  router.get('/', async (req, res) => {
    res.json(await db(o.table).where(await o.scope(req)).orderBy(orderBy as any));
  });

  router.post('/', ...write, validate({ body: o.createSchema }), async (req, res) => {
    const scope = await o.scope(req);
    const id = uuid();
    const row = await db.transaction(async (trx) => {
      const data = { ...req.validated.body };
      await o.beforeWrite?.(trx, req, data);
      if (o.ordered && data.ordem == null) data.ordem = await proximaOrdem(trx, o.table, scope);
      await trx(o.table).insert({ ...serial(data), ...scope, id });
      const created = await trx(o.table).where({ id }).first();
      await o.afterWrite?.(trx, req, created);
      return created;
    });
    res.status(201).json(row);
  });

  if (o.ordered) {
    router.put('/ordem', ...write, validate({ body: z.object({ ids: z.array(z.uuid()).min(1) }) }), async (req, res) => {
      const scope = await o.scope(req);
      await db.transaction((trx) => reordenar(trx, o.table, scope, req.validated.body.ids));
      res.json(await db(o.table).where(scope).orderBy('ordem'));
    });
  }

  router.get('/:id', validate({ params: idParams }), async (req, res) => {
    const row = await db(o.table).where(await o.scope(req)).where({ id: req.validated.params.id }).first();
    if (!row) throw AppError.notFound(label);
    res.json(row);
  });

  router.patch('/:id', ...write, validate({ params: idParams, body: updateSchema }), async (req, res) => {
    const { id } = req.validated.params;
    const scope = await o.scope(req);
    const data = { ...req.validated.body };
    if (!Object.keys(data).length) throw new AppError('Nenhum campo para atualizar', 400);
    const row = await db.transaction(async (trx) => {
      const atual = await trx(o.table).where(scope).where({ id }).first();
      if (!atual) throw AppError.notFound(label);
      await o.beforeWrite?.(trx, req, data, id);
      await trx(o.table).where(scope).where({ id }).update(serial(data));
      const updated = await trx(o.table).where({ id }).first();
      await o.afterWrite?.(trx, req, updated);
      return updated;
    });
    res.json(row);
  });

  router.delete('/:id', ...write, validate({ params: idParams }), async (req, res) => {
    const scope = await o.scope(req);
    const n = await db.transaction(async (trx) => {
      const deleted = await trx(o.table).where(scope).where({ id: req.validated.params.id }).del();
      if (deleted && o.ordered) await compactar(trx, o.table, scope);
      return deleted;
    });
    if (!n) throw AppError.notFound(label);
    res.status(204).end();
  });

  return router;
}
