import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '#database/connection.ts';
import { AppError } from '#utils/AppError.ts';
import type { Papel } from '../types/papel.ts';

type Resolver = (id: string) => Promise<string | undefined>;

// Como chegar ao projeto a partir de cada recurso das rotas "planas" da ERS 10.2
const via =
  (sql: string): Resolver =>
  async (id) => {
    const [rows] = (await db.raw(sql, [id])) as any;
    return rows[0]?.projetoId;
  };

export const RESOLVERS = {
  projeto: async (id: string) => id,
  revisao: via('SELECT projeto_id FROM revisao WHERE id = ?'),
  etapa: via(
    'SELECT r.projeto_id FROM revisao_etapa e JOIN revisao r ON r.id = e.revisao_id WHERE e.id = ?',
  ),
  busca: via(
    'SELECT r.projeto_id FROM busca b JOIN revisao r ON r.id = b.revisao_id WHERE b.id = ?',
  ),
  documento: via('SELECT projeto_id FROM documento WHERE id = ?'),
  analise: via('SELECT projeto_id FROM analise WHERE id = ?'),
  analiseDocumento: via(
    'SELECT a.projeto_id FROM analise_documento ad JOIN analise a ON a.id = ad.analise_id WHERE ad.id = ?',
  ),
} satisfies Record<string, Resolver>;

const uuid = z.guid();

/**
 * Carrega req.projeto e req.papel a partir de req.params[param], resolvido pelo tipo de recurso.
 * Só membros com convite aceito (ou o administrador) passam; projeto na lixeira não aparece.
 */
export const projectAccess = (kind: keyof typeof RESOLVERS = 'projeto', param = 'id') =>
  Object.assign(acessoAoProjeto(kind, param), { recurso: kind }); // exposto para o gerador do OpenAPI

const acessoAoProjeto =
  (kind: keyof typeof RESOLVERS, param: string) =>
  async (req: Request, _res: Response, next: NextFunction) => {
    const id = String(req.params[param] ?? '');
    if (!uuid.safeParse(id).success) throw AppError.notFound('Recurso');
    const projetoId = await RESOLVERS[kind](id);
    if (!projetoId) throw AppError.notFound('Recurso');

    const projeto = await db('projeto').where({ id: projetoId }).whereNull('excluidoEm').first();
    if (!projeto) throw AppError.notFound('Projeto');

    if (req.user?.perfil === 'ADMIN') {
      req.papel = 'ADMIN';
    } else {
      const m = await db('projetoMembro')
        .where({ projetoId, usuarioId: req.user!.id })
        .whereNotNull('aceitoEm')
        .first('papel');
      if (!m) throw AppError.notFound('Projeto');
      req.papel = m.papel;
    }
    req.projeto = projeto;
    next();
  };

// Papéis da ERS 2.2: o administrador passa em tudo
// (os papéis ficam expostos no middleware para o gerador do OpenAPI)
export const requirePapel = (...papeis: Papel[]) =>
  Object.assign(
    (req: Request, _res: Response, next: NextFunction) =>
      req.papel === 'ADMIN' || papeis.includes(req.papel as Papel)
        ? next()
        : next(AppError.forbidden('Seu papel no projeto não permite esta ação')),
    { papeis },
  );

export const EDITA: Papel[] = ['RESPONSAVEL', 'COLABORADOR'];
export const DONO: Papel[] = ['RESPONSAVEL'];
