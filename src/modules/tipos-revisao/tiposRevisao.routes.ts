import { Router } from 'express';
import { z } from 'zod';
import { db } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { AppError } from '#utils/AppError.ts';
import { uuid } from '#utils/tokens.ts';
import { idParams, longText } from '#shared/schemas.ts';
import { compactar, proximaOrdem, reordenar } from '#shared/ordem.ts';
import { erroOrdemDasFases } from '#shared/fasesTriagem.ts';
import { conferirCiclo, conferirEscrita, conferirLeitura, copiarEtapas, eSistematico } from './tiposRevisao.service.ts';

const router = Router();

const CATEGORIAS = ['PROTOCOLO', 'BUSCA', 'DEDUPLICACAO', 'TRIAGEM', 'INCLUSAO', 'ANALISE', 'SINTESE', 'DISCUSSAO', 'CHECKLIST', 'LIVRE'] as const;
const MOTIVOS = ['CRITERIO', 'DUPLICADO', 'SEM_ACESSO', 'OUTRO'] as const;

const tipoSchema = z.object({
  nome: z.string().trim().min(1).max(120),
  descricao: longText(5000),
  tipoPaiId: z.guid().nullable().optional(),
  sistematica: z.boolean().optional(),
  projetoId: z.guid().nullable().optional(),
  ativo: z.boolean().optional(),
});

const etapaSchema = z.object({
  nome: z.string().trim().min(1).max(120),
  descricao: longText(5000),
  categoria: z.enum(CATEGORIAS),
  exigeTriagem: z.boolean().optional(),
  permiteExclusao: z.boolean().optional(),
  motivosSugeridos: z.array(z.enum(MOTIVOS)).optional(),
  ordem: z.number().int().positive().optional(),
});

async function carregar(id: string) {
  const t = await db('tipoRevisao').where({ id }).first();
  if (!t) throw AppError.notFound('Tipo de revisão');
  return t;
}

// Nome único entre os tipos globais (no projeto a chave única do banco garante)
async function conferirNomeGlobal(nome: string, projetoId: string | null | undefined, id?: string) {
  if (projetoId) return;
  const q = db('tipoRevisao').whereNull('projetoId').where({ nome });
  if (id) q.whereNot({ id });
  if (await q.first('id')) throw AppError.conflict('Já existe um tipo de revisão global com esse nome');
}

// RF16: catálogo hierárquico — globais + do projeto pedido
router.get('/', validate({ query: z.object({ projetoId: z.guid().optional(), ativos: z.coerce.boolean().optional() }) }), async (req, res) => {
  const { projetoId, ativos } = req.validated.query;
  await conferirLeitura(req, projetoId);
  const q = db('tipoRevisao').where((w: any) => {
    w.whereNull('projetoId');
    if (projetoId) w.orWhere({ projetoId });
  });
  if (ativos) q.where({ ativo: true });
  const tipos = await q.orderBy('nome');
  const etapas = await db('etapaModelo').whereIn('tipoRevisaoId', tipos.map((t: any) => t.id)).count({ n: '*' }).groupBy('tipoRevisaoId').select('tipoRevisaoId');
  const porTipo = Object.fromEntries(etapas.map((e: any) => [e.tipoRevisaoId, Number(e.n)]));
  const out: any[] = [];
  for (const t of tipos) out.push({ ...t, sistematicaEfetiva: await eSistematico(t.id), totalEtapas: porTipo[t.id] ?? 0 });
  res.json(out);
});

// RF18/UC05: novo tipo; com tipo pai, copia as etapas do pai (RN07)
router.post('/', validate({ body: tipoSchema }), async (req, res) => {
  const d = req.validated.body;
  await conferirEscrita(req, d.projetoId);
  await conferirNomeGlobal(d.nome, d.projetoId);
  if (d.tipoPaiId) await carregar(d.tipoPaiId);
  const id = uuid();
  await db.transaction(async (trx) => {
    await trx('tipoRevisao').insert({ ...d, id, criadoPor: req.user!.id });
    if (d.tipoPaiId) await copiarEtapas(trx, d.tipoPaiId, id, uuid);
  });
  res.status(201).json(await detalhe(id));
});

async function detalhe(id: string) {
  const t = await carregar(id);
  const etapas = await db('etapaModelo').where({ tipoRevisaoId: id }).orderBy('ordem');
  const aviso =
    (await eSistematico(id)) && !etapas.some((e: any) => e.categoria === 'TRIAGEM')
      ? 'Tipo sistemático sem etapa de categoria TRIAGEM'
      : null;
  return { ...t, sistematicaEfetiva: await eSistematico(id), etapas, aviso };
}

router.get('/:id', validate({ params: idParams }), async (req, res) => {
  const t = await carregar(req.validated.params.id);
  await conferirLeitura(req, t.projetoId);
  res.json(await detalhe(t.id));
});

router.patch('/:id', validate({ params: idParams, body: tipoSchema.omit({ projetoId: true }).partial() }), async (req, res) => {
  const t = await carregar(req.validated.params.id);
  await conferirEscrita(req, t.projetoId);
  const d = req.validated.body;
  if (d.nome) await conferirNomeGlobal(d.nome, t.projetoId, t.id);
  if (d.tipoPaiId !== undefined) await conferirCiclo(t.id, d.tipoPaiId);
  await db('tipoRevisao').where({ id: t.id }).update(d);
  res.json(await detalhe(t.id));
});

router.delete('/:id', validate({ params: idParams }), async (req, res) => {
  const t = await carregar(req.validated.params.id);
  await conferirEscrita(req, t.projetoId);
  const emUso =
    (await db('revisao').where({ tipoRevisaoId: t.id }).first('id')) ||
    (await db('analise').where({ tipoRevisaoId: t.id }).first('id')) ||
    (await db('tipoRevisao').where({ tipoPaiId: t.id }).first('id'));
  if (emUso) throw AppError.conflict('Tipo em uso (revisões, análises ou subtipos). Desative-o em vez de excluir.');
  await db('tipoRevisao').where({ id: t.id }).del();
  res.status(204).end();
});

// RF18: novo tipo a partir de um existente (cópia)
router.post(
  '/:id/copiar',
  validate({ params: idParams, body: z.object({ nome: z.string().trim().min(1).max(120), projetoId: z.guid().nullable().optional(), comoSubtipo: z.boolean().optional() }) }),
  async (req, res) => {
    const origem = await carregar(req.validated.params.id);
    await conferirLeitura(req, origem.projetoId);
    const { nome, projetoId, comoSubtipo } = req.validated.body;
    await conferirEscrita(req, projetoId);
    await conferirNomeGlobal(nome, projetoId);
    const id = uuid();
    await db.transaction(async (trx) => {
      await trx('tipoRevisao').insert({
        id,
        nome,
        descricao: origem.descricao,
        tipoPaiId: comoSubtipo ? origem.id : origem.tipoPaiId,
        sistematica: origem.sistematica,
        projetoId: projetoId ?? null,
        criadoPor: req.user!.id,
      });
      await copiarEtapas(trx, origem.id, id, uuid);
    });
    res.status(201).json(await detalhe(id));
  },
);

// RF17: etapas padrão do tipo
router.get('/:id/etapas', validate({ params: idParams }), async (req, res) => {
  const t = await carregar(req.validated.params.id);
  await conferirLeitura(req, t.projetoId);
  res.json(await db('etapaModelo').where({ tipoRevisaoId: t.id }).orderBy('ordem'));
});

router.post('/:id/etapas', validate({ params: idParams, body: etapaSchema }), async (req, res) => {
  const t = await carregar(req.validated.params.id);
  await conferirEscrita(req, t.projetoId);
  const { motivosSugeridos, ordem, ...d } = req.validated.body;
  const id = uuid();
  await db.transaction(async (trx) => {
    const fim = await proximaOrdem(trx, 'etapaModelo', { tipoRevisaoId: t.id });
    await trx('etapaModelo').insert({ ...d, id, tipoRevisaoId: t.id, ordem: fim, motivosSugeridos: JSON.stringify(motivosSugeridos ?? []) });
    if (ordem && ordem < fim) {
      const ids: string[] = (await trx('etapaModelo').where({ tipoRevisaoId: t.id }).orderBy('ordem').select('id')).map((r: any) => r.id).filter((x: string) => x !== id);
      ids.splice(ordem - 1, 0, id);
      await reordenar(trx, 'etapaModelo', { tipoRevisaoId: t.id }, ids);
    }
  });
  res.status(201).json(await db('etapaModelo').where({ id }).first());
});

router.put('/:id/etapas/ordem', validate({ params: idParams, body: z.object({ ids: z.array(z.guid()).min(1) }) }), async (req, res) => {
  const t = await carregar(req.validated.params.id);
  await conferirEscrita(req, t.projetoId);
  const atuais = await db('etapaModelo').where({ tipoRevisaoId: t.id });
  const fora = erroOrdemDasFases(req.validated.body.ids.map((id: string) => atuais.find((x: any) => x.id === id)).filter(Boolean));
  if (fora) throw AppError.unprocessable(fora);
  await db.transaction((trx) => reordenar(trx, 'etapaModelo', { tipoRevisaoId: t.id }, req.validated.body.ids));
  res.json(await db('etapaModelo').where({ tipoRevisaoId: t.id }).orderBy('ordem'));
});

router.patch(
  '/:id/etapas/:etapaId',
  validate({ params: idParams.extend({ etapaId: z.guid() }), body: etapaSchema.omit({ ordem: true }).partial() }),
  async (req, res) => {
    const t = await carregar(req.validated.params.id);
    await conferirEscrita(req, t.projetoId);
    const { motivosSugeridos, ...d } = req.validated.body;
    const n = await db('etapaModelo')
      .where({ id: req.validated.params.etapaId, tipoRevisaoId: t.id })
      .update({ ...d, ...(motivosSugeridos ? { motivosSugeridos: JSON.stringify(motivosSugeridos) } : {}) });
    if (!n) throw AppError.notFound('Etapa');
    res.json(await db('etapaModelo').where({ id: req.validated.params.etapaId }).first());
  },
);

router.delete('/:id/etapas/:etapaId', validate({ params: idParams.extend({ etapaId: z.guid() }) }), async (req, res) => {
  const t = await carregar(req.validated.params.id);
  await conferirEscrita(req, t.projetoId);
  const total = await db('etapaModelo').where({ tipoRevisaoId: t.id }).count({ n: '*' }).first();
  if (Number(total?.n) <= 1) throw AppError.unprocessable('O tipo de revisão precisa de ao menos 1 etapa');
  await db.transaction(async (trx) => {
    const n = await trx('etapaModelo').where({ id: req.validated.params.etapaId, tipoRevisaoId: t.id }).del();
    if (!n) throw AppError.notFound('Etapa');
    await compactar(trx, 'etapaModelo', { tipoRevisaoId: t.id });
  });
  res.status(204).end();
});

export default router;
