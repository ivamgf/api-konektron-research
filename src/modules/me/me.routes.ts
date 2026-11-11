import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, json } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { AppError } from '#utils/AppError.ts';
import { BCRYPT_CUSTO, usuarioPublico } from '#modules/auth/auth.service.ts';
import { trocarSenhaSchema } from '#modules/auth/auth.schemas.ts';
import { resumoPlano } from '#modules/planos/planos.service.ts';

const router = Router();

const perfilSchema = z.object({
  nome: z.string().trim().min(2).max(150).optional(),
  instituicao: z.string().trim().max(200).nullable().optional(),
  orcid: z
    .string()
    .regex(/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/)
    .nullable()
    .optional(),
  // RF04: tema e idioma das referências
  preferencias: z
    .object({
      tema: z.enum(['claro', 'escuro', 'sistema']).optional(),
      idiomaReferencias: z.enum(['NBR', 'APA']).optional(),
    })
    .loose()
    .optional(),
});

router.get('/', async (req, res) => {
  const u = await db('usuario').where({ id: req.user!.id }).first();
  if (!u) throw AppError.notFound('Usuário');
  res.json(usuarioPublico(u));
});

// Plano do usuário: limite e uso de projetos, recursos, prazo do plano gratuito e bloqueio
router.get('/plano', async (req, res) => {
  res.json(await resumoPlano(req.user!.id));
});

router.patch('/', validate({ body: perfilSchema }), async (req, res) => {
  const { preferencias, ...resto } = req.validated.body;
  const atual = await db('usuario').where({ id: req.user!.id }).first();
  const data: Record<string, unknown> = { ...resto };
  if (preferencias) data.preferencias = json({ ...(atual.preferencias ?? {}), ...preferencias });
  if (Object.keys(data).length) await db('usuario').where({ id: req.user!.id }).update(data);
  res.json(usuarioPublico(await db('usuario').where({ id: req.user!.id }).first()));
});

router.put('/senha', validate({ body: trocarSenhaSchema }), async (req, res) => {
  const u = await db('usuario').where({ id: req.user!.id }).first();
  if (!(await bcrypt.compare(req.validated.body.senhaAtual, u.senhaHash))) {
    throw AppError.unprocessable('Senha atual incorreta', undefined, 'SENHA_INCORRETA');
  }
  await db('usuario').where({ id: u.id }).update({ senhaHash: await bcrypt.hash(req.validated.body.novaSenha, BCRYPT_CUSTO) });
  res.status(204).end();
});

// RNF07 (LGPD): exportação dos dados pessoais
router.get('/dados', async (req, res) => {
  const id = req.user!.id;
  const [usuario, projetos, comentarios, notificacoes] = await Promise.all([
    db('usuario').where({ id }).first(),
    db('projetoMembro as pm').join('projeto as p', 'p.id', 'pm.projetoId').where('pm.usuarioId', id).select('p.id', 'p.titulo', 'pm.papel'),
    db('comentario').where({ autorId: id }).select('id', 'projetoId', 'entidade', 'texto', 'criadoEm'),
    db('notificacao').where({ usuarioId: id }),
  ]);
  res.json({ usuario: usuarioPublico(usuario), projetos, comentarios, notificacoes });
});

// RNF07 (LGPD): exclusão a pedido — anonimiza a conta e mantém a autoria dos registros de pesquisa
router.delete('/', async (req, res) => {
  const id = req.user!.id;
  const dono = await db('projetoMembro as pm')
    .join('projeto as p', 'p.id', 'pm.projetoId')
    .where({ 'pm.usuarioId': id, 'pm.papel': 'RESPONSAVEL' })
    .whereNull('p.excluidoEm')
    .first('p.id');
  if (dono) throw AppError.conflict('Transfira ou exclua seus projetos antes de excluir a conta');
  await db.transaction(async (trx) => {
    await trx('usuario')
      .where({ id })
      .update({
        nome: 'Usuário removido',
        email: `removido-${id}@invalid.local`,
        senhaHash: '!',
        instituicao: null,
        orcid: null,
        preferencias: json({}),
        ativo: false,
      });
    await trx('refreshToken').where({ usuarioId: id }).del();
    await trx('notificacao').where({ usuarioId: id }).del();
  });
  res.status(204).end();
});

export default router;
