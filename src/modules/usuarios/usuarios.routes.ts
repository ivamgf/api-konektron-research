import { Router } from 'express';
import { z } from 'zod';
import { db } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { AppError } from '#utils/AppError.ts';
import { idParams, paginar, pagination } from '#shared/schemas.ts';
import { usuarioPublico } from '#modules/auth/auth.service.ts';
import { expiraEm, mudarPlano, PLANOS, planoEfetivo, projetosCriados } from '#modules/planos/planos.service.ts';

/** Na administração aparecem também a opção interna "vitalício" e o prazo do plano gratuito */
const usuarioAdmin = async (u: any) => ({
  ...usuarioPublico(u),
  planoVitalicio: !!u.planoVitalicio,
  descontoEstudante: !!u.descontoEstudante,
  planoEfetivo: planoEfetivo(u),
  planoExpiraEm: expiraEm(u),
  planoBloqueadoEm: u.planoBloqueadoEm,
  projetosCriados: await projetosCriados(u.id),
});

// RF03: administrador gerencia usuários (ativar, bloquear, redefinir perfil)
const router = Router();

router.get('/', validate({ query: pagination.extend({ q: z.string().max(100).optional() }) }), async (req, res) => {
  const { page, pageSize, q } = req.validated.query;
  const query = db('usuario').orderBy('nome');
  if (q) query.where((w: any) => w.where('nome', 'like', `%${q}%`).orWhere('email', 'like', `%${q}%`));
  const r = await paginar(query, page, pageSize);
  res.json({ ...r, itens: await Promise.all(r.itens.map(usuarioAdmin)) });
});

router.patch(
  '/:id',
  validate({
    params: idParams,
    body: z.object({
      ativo: z.boolean().optional(),
      perfilGlobal: z.enum(['ADMIN', 'USUARIO']).optional(),
      plano: z.enum(PLANOS).optional(),
      planoVitalicio: z.boolean().optional(),
      descontoEstudante: z.boolean().optional(),
    }),
  }),
  async (req, res) => {
    const { id } = req.validated.params;
    if (id === req.user!.id && (req.validated.body.ativo === false || req.validated.body.perfilGlobal === 'USUARIO')) {
      throw AppError.unprocessable('Você não pode bloquear nem rebaixar a própria conta');
    }
    const { plano, planoVitalicio, ...resto } = req.validated.body;
    if (!(await db('usuario').where({ id }).first('id'))) throw AppError.notFound('Usuário');
    if (Object.keys(resto).length) await db('usuario').where({ id }).update(resto);
    if (plano !== undefined || planoVitalicio !== undefined) await mudarPlano(id, { plano, planoVitalicio });
    if (req.validated.body.ativo === false) {
      await db('refreshToken').where({ usuarioId: id }).whereNull('revogadoEm').update({ revogadoEm: new Date() });
    }
    res.json(await usuarioAdmin(await db('usuario').where({ id }).first()));
  },
);

export default router;
