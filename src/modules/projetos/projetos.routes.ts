import { Router } from 'express';
import { z } from 'zod';
import { env } from '#config/env.ts';
import { db } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { DONO, projectAccess, requirePapel } from '#middlewares/projectAccess.ts';
import { AppError } from '#utils/AppError.ts';
import { generateOpaqueToken, hashToken, uuid } from '#utils/tokens.ts';
import { dateStr, idParams, optText } from '#shared/schemas.ts';
import { auditar } from '#services/audit.ts';
import { enviarEmail } from '#services/mailer.ts';
import { notificar } from '#services/notificacoes.ts';

const router = Router();

const projetoSchema = z.object({
  titulo: z.string().trim().min(3).max(300),
  area: optText(150),
  instituicao: optText(200),
  programa: optText(200),
  dataInicio: dateStr.nullable().optional(),
  dataFim: dateStr.nullable().optional(),
});

const conferirDatas = (d: { dataInicio?: string | null; dataFim?: string | null }) => {
  if (d.dataInicio && d.dataFim && d.dataFim < d.dataInicio) {
    throw AppError.unprocessable('A data de fim deve ser igual ou posterior à de início');
  }
};

// Painel de projetos: projetos em que o usuário é membro, com papel e situação do protocolo
router.get('/', validate({ query: z.object({ status: z.enum(['ATIVO', 'ARQUIVADO']).optional(), lixeira: z.coerce.boolean().optional() }) }), async (req, res) => {
  const { status, lixeira } = req.validated.query;
  const q = db('projeto as p')
    .join('projetoMembro as pm', function () {
      this.on('pm.projetoId', 'p.id').andOn('pm.usuarioId', db.raw('?', [req.user!.id]));
    })
    .leftJoin('protocolo as pr', 'pr.projetoId', 'p.id')
    .whereNotNull('pm.aceitoEm')
    .select(
      'p.*',
      'pm.papel',
      'pr.status as protocoloStatus',
      'pr.passoAtual as protocoloPasso',
      db.raw('(SELECT COUNT(*) FROM revisao r WHERE r.projeto_id = p.id) AS revisoes'),
    )
    .orderBy('p.atualizadoEm', 'desc');
  if (lixeira) q.whereNotNull('p.excluidoEm');
  else q.whereNull('p.excluidoEm');
  if (status) q.where('p.status', status);
  res.json(await q);
});

// RF05: cria o projeto com o criador como responsável e o protocolo em rascunho (RN01)
router.post('/', validate({ body: projetoSchema }), async (req, res) => {
  conferirDatas(req.validated.body);
  const id = uuid();
  await db.transaction(async (trx) => {
    await trx('projeto').insert({ ...req.validated.body, id, criadoPor: req.user!.id });
    await trx('projetoMembro').insert({ projetoId: id, usuarioId: req.user!.id, papel: 'RESPONSAVEL', aceitoEm: new Date() });
    await trx('protocolo').insert({ id: uuid(), projetoId: id });
    await auditar({ req, projetoId: id, entidade: 'projeto', entidadeId: id, acao: 'CRIAR', depois: req.validated.body }, trx);
  });
  res.status(201).json(await db('projeto').where({ id }).first());
});

// Convite: aceitar pelo token do e-mail (o e-mail do convite precisa ser o do usuário logado)
router.post('/convites/aceitar', validate({ body: z.object({ token: z.string().min(20) }) }), async (req, res) => {
  const c = await db('convite').where({ tokenHash: hashToken(req.validated.body.token) }).first();
  if (!c || c.aceitoEm || new Date(c.expiraEm) < new Date()) throw AppError.unprocessable('Convite inválido ou expirado', undefined, 'CONVITE_INVALIDO');
  const u = await db('usuario').where({ id: req.user!.id }).first('email');
  if (u.email.toLowerCase() !== c.email.toLowerCase()) throw AppError.forbidden('Este convite foi enviado para outro e-mail');
  await db.transaction(async (trx) => {
    const membro = await trx('projetoMembro').where({ projetoId: c.projetoId, usuarioId: req.user!.id }).first();
    if (membro) await trx('projetoMembro').where({ projetoId: c.projetoId, usuarioId: req.user!.id }).update({ papel: membro.papel === 'RESPONSAVEL' ? 'RESPONSAVEL' : c.papel, aceitoEm: new Date() });
    else await trx('projetoMembro').insert({ projetoId: c.projetoId, usuarioId: req.user!.id, papel: c.papel, aceitoEm: new Date() });
    await trx('convite').where({ id: c.id }).update({ aceitoEm: new Date() });
  });
  res.json(await db('projeto').where({ id: c.projetoId }).first());
});

router.get('/:id', projectAccess('projeto'), async (req, res) => {
  const protocolo = await db('protocolo').where({ projetoId: req.projeto!.id }).first('id', 'status', 'versaoAtual', 'passoAtual');
  res.json({ ...req.projeto, papel: req.papel, protocolo });
});

router.patch(
  '/:id',
  projectAccess('projeto'),
  requirePapel(...DONO),
  validate({ body: projetoSchema.partial().extend({ status: z.enum(['ATIVO', 'ARQUIVADO']).optional() }) }),
  async (req, res) => {
    const novo = { ...req.projeto, ...req.validated.body };
    conferirDatas(novo as any);
    await db('projeto').where({ id: req.projeto!.id }).update(req.validated.body);
    auditar({ req, entidade: 'projeto', entidadeId: req.projeto!.id, acao: 'ALTERAR', antes: req.projeto, depois: req.validated.body });
    res.json(await db('projeto').where({ id: req.projeto!.id }).first());
  },
);

// RN17: exclusão lógica (lixeira por 30 dias); a remoção física roda no worker
router.delete('/:id', projectAccess('projeto'), requirePapel(...DONO), async (req, res) => {
  await db('projeto').where({ id: req.projeto!.id }).update({ excluidoEm: new Date() });
  auditar({ req, entidade: 'projeto', entidadeId: req.projeto!.id, acao: 'EXCLUIR' });
  res.status(204).end();
});

router.post('/:id/restaurar', validate({ params: idParams }), async (req, res) => {
  const { id } = req.validated.params;
  const dono = await db('projetoMembro').where({ projetoId: id, usuarioId: req.user!.id, papel: 'RESPONSAVEL' }).first();
  const p = await db('projeto').where({ id }).whereNotNull('excluidoEm').first();
  if (!p || (!dono && req.user!.perfil !== 'ADMIN')) throw AppError.notFound('Projeto na lixeira');
  await db('projeto').where({ id }).update({ excluidoEm: null });
  res.json(await db('projeto').where({ id }).first());
});

// RF06: membros e convites
router.get('/:id/membros', projectAccess('projeto'), async (req, res) => {
  const membros = await db('projetoMembro as pm')
    .join('usuario as u', 'u.id', 'pm.usuarioId')
    .where('pm.projetoId', req.projeto!.id)
    .select('u.id', 'u.nome', 'u.email', 'u.instituicao', 'u.orcid', 'pm.papel', 'pm.convidadoEm', 'pm.aceitoEm')
    .orderBy('u.nome');
  const convites = await db('convite')
    .where({ projetoId: req.projeto!.id })
    .whereNull('aceitoEm')
    .select('id', 'email', 'papel', 'expiraEm', 'criadoEm');
  res.json({ membros, convites });
});

router.post(
  '/:id/membros',
  projectAccess('projeto'),
  requirePapel(...DONO),
  validate({ body: z.object({ email: z.email().transform((e) => e.toLowerCase()), papel: z.enum(['COLABORADOR', 'ORIENTADOR', 'LEITOR']) }) }),
  async (req, res) => {
    const { email, papel } = req.validated.body;
    const jaMembro = await db('projetoMembro as pm')
      .join('usuario as u', 'u.id', 'pm.usuarioId')
      .where({ 'pm.projetoId': req.projeto!.id, 'u.email': email })
      .whereNotNull('pm.aceitoEm')
      .first('u.id');
    if (jaMembro) throw AppError.conflict('Esta pessoa já é membro do projeto');

    const token = generateOpaqueToken();
    const id = uuid();
    await db.transaction(async (trx) => {
      await trx('convite').where({ projetoId: req.projeto!.id, email }).whereNull('aceitoEm').del();
      await trx('convite').insert({
        id,
        projetoId: req.projeto!.id,
        email,
        papel,
        tokenHash: hashToken(token),
        convidadoPor: req.user!.id,
        expiraEm: new Date(Date.now() + 7 * 86_400_000),
      });
      const existente = await trx('usuario').where({ email }).first('id');
      if (existente) await notificar([existente.id], 'CONVITE', `Convite para o projeto "${req.projeto!.titulo}"`, { projetoId: req.projeto!.id, conviteId: id }, trx);
    });
    await enviarEmail(
      email,
      `Convite para o projeto "${req.projeto!.titulo}" — Konektron Research`,
      `Você foi convidado(a) como ${papel.toLowerCase()} do projeto "${req.projeto!.titulo}".\n\nAceite em: ${env.APP_URL}/convites?token=${token}\n\nO convite vale por 7 dias.`,
    );
    res.status(201).json(await db('convite').where({ id }).first('id', 'email', 'papel', 'expiraEm', 'criadoEm'));
  },
);

router.patch(
  '/:id/membros/:usuarioId',
  projectAccess('projeto'),
  requirePapel(...DONO),
  validate({ body: z.object({ papel: z.enum(['COLABORADOR', 'ORIENTADOR', 'LEITOR']) }) }),
  async (req, res) => {
    const n = await db('projetoMembro')
      .where({ projetoId: req.projeto!.id, usuarioId: String(req.params.usuarioId) })
      .whereNot({ papel: 'RESPONSAVEL' })
      .update({ papel: req.validated.body.papel });
    if (!n) throw AppError.notFound('Membro');
    res.status(204).end();
  },
);

router.delete('/:id/membros/:usuarioId', projectAccess('projeto'), requirePapel(...DONO), async (req, res) => {
  const n = await db('projetoMembro')
    .where({ projetoId: req.projeto!.id, usuarioId: String(req.params.usuarioId) })
    .whereNot({ papel: 'RESPONSAVEL' })
    .del();
  if (!n) throw AppError.notFound('Membro');
  res.status(204).end();
});

router.delete('/:id/convites/:conviteId', projectAccess('projeto'), requirePapel(...DONO), async (req, res) => {
  const n = await db('convite').where({ projetoId: req.projeto!.id, id: String(req.params.conviteId) }).whereNull('aceitoEm').del();
  if (!n) throw AppError.notFound('Convite');
  res.status(204).end();
});

// RF44: trilha de auditoria do projeto
router.get(
  '/:id/auditoria',
  projectAccess('projeto'),
  requirePapel('RESPONSAVEL', 'ORIENTADOR'),
  validate({ query: z.object({ entidade: z.string().max(50).optional(), limite: z.coerce.number().int().min(1).max(500).default(100), antesDe: z.coerce.number().int().optional() }) }),
  async (req, res) => {
    const { entidade, limite, antesDe } = req.validated.query;
    const q = db('auditoria as a')
      .leftJoin('usuario as u', 'u.id', 'a.usuarioId')
      .where('a.projetoId', req.projeto!.id)
      .select('a.*', 'u.nome as usuarioNome')
      .orderBy('a.id', 'desc')
      .limit(limite);
    if (entidade) q.where('a.entidade', entidade);
    if (antesDe) q.where('a.id', '<', antesDe);
    res.json(await q);
  },
);

export default router;
