import { Router, type Request } from 'express';
import { z } from 'zod';
import { db, type Trx } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { DONO, EDITA, projectAccess, requirePapel } from '#middlewares/projectAccess.ts';
import { AppError } from '#utils/AppError.ts';
import { uuid } from '#utils/tokens.ts';
import { crudRouter } from '#shared/crud.ts';
import { longText, optText } from '#shared/schemas.ts';
import { auditar } from '#services/audit.ts';
import { enfileirar } from '#services/fila.ts';

const FONTES = ['INCLUIDOS_REVISAO', 'INTEGRADOS', 'REFERENCIAL_TEORICO', 'SELECAO_MANUAL'] as const;

// Documentos de cada fonte (RF37)
async function documentosDaFonte(trx: Trx, projetoId: string, fonte: string, revisaoId?: string | null, manual?: string[]) {
  if (fonte === 'SELECAO_MANUAL') {
    if (!manual?.length) return [];
    return (await trx('documento').where({ projetoId }).whereIn('id', manual).select('id')).map((r: any) => r.id as string);
  }
  const q = trx('revisaoDocumento as rd').join('revisao as r', 'r.id', 'rd.revisaoId').where('r.projetoId', projetoId).distinct('rd.documentoId');
  if (revisaoId) q.where('rd.revisaoId', revisaoId);
  if (fonte === 'INCLUIDOS_REVISAO') q.where('rd.situacao', 'INCLUIDO');
  if (fonte === 'INTEGRADOS') q.whereIn('rd.origem', ['INTEGRADO', 'REVISAO_ANTERIOR']);
  if (fonte === 'REFERENCIAL_TEORICO') q.whereNot('rd.situacao', 'EXCLUIDO');
  return (await q).map((r: any) => r.documentoId as string);
}

async function adicionarDocumentos(trx: Trx, analiseId: string, documentoIds: string[]) {
  const ja = new Set((await trx('analiseDocumento').where({ analiseId }).select('documentoId')).map((r: any) => r.documentoId));
  const fim = ((await trx('analiseDocumento').where({ analiseId }).max({ m: 'ordem' }).first())?.m ?? 0) as number;
  const novos = documentoIds.filter((id) => !ja.has(id));
  if (novos.length) await trx('analiseDocumento').insert(novos.map((documentoId, i) => ({ id: uuid(), analiseId, documentoId, ordem: fim + i + 1 })));
  return novos.length;
}

// RF39: progresso do documento pelas respostas às QAs da análise
async function recalcularProgresso(trx: Trx, analiseDocumentoId: string, usuarioId: string) {
  const ad = await trx('analiseDocumento').where({ id: analiseDocumentoId }).first('analiseId');
  const totalQ = Number((await trx('analiseQuestao').where({ analiseId: ad.analiseId }).count({ n: '*' }).first())?.n ?? 0);
  const respondidas = Number(
    (await trx('resposta as r')
      .join('analiseQuestao as aq', function () {
        this.on('aq.questaoAnaliseId', 'r.questaoAnaliseId').andOn('aq.analiseId', trx.raw('?', [ad.analiseId]));
      })
      .where('r.analiseDocumentoId', analiseDocumentoId)
      .whereRaw("TRIM(COALESCE(r.texto, '')) <> ''")
      .count({ n: '*' })
      .first())?.n ?? 0,
  );
  const progresso = respondidas === 0 ? 'NAO_INICIADO' : respondidas >= totalQ ? 'CONCLUIDO' : 'PARCIAL';
  await trx('analiseDocumento').where({ id: analiseDocumentoId }).update({ progresso, atualizadoPor: usuarioId });
  return progresso;
}

// ------------------------------------------------ /projetos/:id/analises
export const analisesDoProjeto = Router({ mergeParams: true });

analisesDoProjeto.get('/', async (req, res) => {
  res.json(
    await db('analise as a')
      .join('tipoRevisao as t', 't.id', 'a.tipoRevisaoId')
      .leftJoin('revisao as r', 'r.id', 'a.revisaoId')
      .where('a.projetoId', req.projeto!.id)
      .select(
        'a.*',
        't.nome as tipoNome',
        'r.titulo as revisaoTitulo',
        db.raw('(SELECT COUNT(*) FROM analise_documento ad WHERE ad.analise_id = a.id) AS documentos'),
        db.raw("(SELECT COUNT(*) FROM analise_documento ad WHERE ad.analise_id = a.id AND ad.progresso = 'CONCLUIDO') AS concluidos"),
      )
      .orderBy('a.criadoEm'),
  );
});

// RF36/RF37/UC11 (RN15: tipo novo criado na análise fica gravado no projeto)
analisesDoProjeto.post(
  '/',
  requirePapel(...DONO),
  validate({
    body: z
      .object({
        nome: z.string().trim().min(1).max(200),
        descricao: longText(5000),
        tipoRevisaoId: z.guid().optional(),
        novoTipo: z.object({ nome: z.string().trim().min(1).max(120), tipoPaiId: z.guid().nullable().optional(), sistematica: z.boolean().optional() }).optional(),
        revisaoId: z.guid().nullable().optional(),
        fonte: z.enum(FONTES).optional(),
        questaoIds: z.array(z.guid()).optional(),
        documentoIds: z.array(z.guid()).optional(),
      })
      .refine((d) => !!d.tipoRevisaoId !== !!d.novoTipo, { message: 'Informe tipoRevisaoId ou novoTipo', path: ['tipoRevisaoId'] }),
  }),
  async (req, res) => {
    const d = req.validated.body;
    const projetoId = req.projeto!.id;
    if (d.revisaoId && !(await db('revisao').where({ id: d.revisaoId, projetoId }).first('id'))) throw AppError.notFound('Revisão');
    const protocolo = await db('protocolo').where({ projetoId }).first('id');
    const id = uuid();
    await db.transaction(async (trx) => {
      let tipoId = d.tipoRevisaoId;
      if (d.novoTipo) {
        tipoId = uuid();
        await trx('tipoRevisao').insert({ id: tipoId, ...d.novoTipo, projetoId, criadoPor: req.user!.id });
        if (d.novoTipo.tipoPaiId) {
          const { copiarEtapas } = await import('#modules/tipos-revisao/tiposRevisao.service.ts');
          await copiarEtapas(trx, d.novoTipo.tipoPaiId, tipoId, uuid);
        }
      } else {
        const t = await trx('tipoRevisao').where({ id: tipoId }).first('projetoId');
        if (!t || (t.projetoId && t.projetoId !== projetoId)) throw AppError.notFound('Tipo de revisão');
      }
      const fonte = d.fonte ?? 'INCLUIDOS_REVISAO';
      await trx('analise').insert({ id, projetoId, nome: d.nome, descricao: d.descricao ?? null, tipoRevisaoId: tipoId, revisaoId: d.revisaoId ?? null, fonte, criadoPor: req.user!.id });
      const qs = trx('questaoAnalise').where({ protocoloId: protocolo.id, ativo: true }).orderBy('ordem');
      if (d.questaoIds?.length) qs.whereIn('id', d.questaoIds);
      const questoes = await qs.select('id');
      if (questoes.length) await trx('analiseQuestao').insert(questoes.map((q: any, i: number) => ({ analiseId: id, questaoAnaliseId: q.id, ordem: i + 1 })));
      await adicionarDocumentos(trx, id, await documentosDaFonte(trx, projetoId, fonte, d.revisaoId, d.documentoIds));
      await auditar({ req, entidade: 'analise', entidadeId: id, acao: 'CRIAR', depois: d }, trx);
    });
    res.status(201).json(await detalhe(id));
  },
);

async function detalhe(id: string) {
  const a = await db('analise as a').join('tipoRevisao as t', 't.id', 'a.tipoRevisaoId').where('a.id', id).first('a.*', 't.nome as tipoNome');
  if (!a) throw AppError.notFound('Análise');
  const questoes = await db('analiseQuestao as aq').join('questaoAnalise as q', 'q.id', 'aq.questaoAnaliseId').where('aq.analiseId', id).orderBy('aq.ordem').select('q.id', 'q.codigo', 'q.enunciado', 'aq.ordem');
  return { ...a, questoes };
}

// ------------------------------------------------ /analises/:id
export const analises = Router();
analises.use('/:id', projectAccess('analise'));

analises.get('/:id', async (req, res) => {
  res.json(await detalhe(String(req.params.id)));
});

analises.patch(
  '/:id',
  requirePapel(...EDITA),
  validate({ body: z.object({ nome: z.string().trim().min(1).max(200).optional(), descricao: longText(5000), status: z.enum(['ABERTA', 'CONCLUIDA']).optional() }) }),
  async (req, res) => {
    await db('analise').where({ id: String(req.params.id) }).update(req.validated.body);
    res.json(await detalhe(String(req.params.id)));
  },
);

analises.delete('/:id', requirePapel(...DONO), async (req, res) => {
  await db('analise').where({ id: String(req.params.id) }).del();
  auditar({ req, entidade: 'analise', entidadeId: String(req.params.id), acao: 'EXCLUIR' });
  res.status(204).end();
});

analises.put('/:id/questoes', requirePapel(...EDITA), validate({ body: z.object({ questaoIds: z.array(z.guid()).min(1) }) }), async (req, res) => {
  const analiseId = String(req.params.id);
  const protocolo = await db('protocolo').where({ projetoId: req.projeto!.id }).first('id');
  const validas = await db('questaoAnalise').where({ protocoloId: protocolo.id }).whereIn('id', req.validated.body.questaoIds).select('id');
  if (validas.length !== req.validated.body.questaoIds.length) throw AppError.unprocessable('Questão não pertence ao protocolo deste projeto');
  await db.transaction(async (trx) => {
    await trx('analiseQuestao').where({ analiseId }).del();
    await trx('analiseQuestao').insert(req.validated.body.questaoIds.map((q: string, i: number) => ({ analiseId, questaoAnaliseId: q, ordem: i + 1 })));
    for (const ad of await trx('analiseDocumento').where({ analiseId }).select('id')) await recalcularProgresso(trx, ad.id, req.user!.id);
  });
  res.json(await detalhe(analiseId));
});

// RF38/RF39: lista de documentos com progresso
analises.get('/:id/documentos', async (req, res) => {
  res.json(
    await db('analiseDocumento as ad')
      .join('documento as d', 'd.id', 'ad.documentoId')
      .where('ad.analiseId', String(req.params.id))
      .orderBy('ad.ordem')
      .select('ad.id', 'ad.documentoId', 'ad.ordem', 'ad.progresso', 'ad.atualizadoEm', 'd.titulo', 'd.autores', 'd.ano', 'd.periodico', 'd.arquivoId'),
  );
});

analises.post('/:id/documentos', requirePapel(...EDITA), validate({ body: z.object({ documentoIds: z.array(z.guid()).min(1).max(500) }) }), async (req, res) => {
  const ids = (await db('documento').where({ projetoId: req.projeto!.id }).whereIn('id', req.validated.body.documentoIds).select('id')).map((r: any) => r.id);
  const n = await db.transaction((trx) => adicionarDocumentos(trx, String(req.params.id), ids));
  res.status(201).json({ adicionados: n });
});

analises.delete('/:id/documentos/:docId', requirePapel(...EDITA), async (req, res) => {
  const n = await db('analiseDocumento').where({ analiseId: String(req.params.id), documentoId: String(req.params.docId) }).del();
  if (!n) throw AppError.notFound('Documento da análise');
  res.status(204).end();
});

async function analiseDocumento(req: Request) {
  const ad = await db('analiseDocumento').where({ analiseId: String(req.params.id), documentoId: String(req.params.docId) }).first();
  if (!ad) throw AppError.notFound('Documento da análise');
  return ad;
}

// Página única: metadados, respostas, matriz, discussão, considerações (UC12)
analises.get('/:id/documentos/:docId', async (req, res) => {
  const ad = await analiseDocumento(req);
  const [documento, respostas, matriz, discussao] = await Promise.all([
    db('documento').where({ id: ad.documentoId }).first('id', 'titulo', 'autores', 'resumo', 'palavrasChave', 'ano', 'periodico', 'doi', 'link', 'arquivoId', 'refNbr', 'refApa'),
    db('resposta').where({ analiseDocumentoId: ad.id }),
    db('matrizSinteseItem').where({ analiseDocumentoId: ad.id }).orderBy('ordem'),
    db('discussaoItem').where({ analiseDocumentoId: ad.id }).orderBy('ordem'),
  ]);
  res.json({ ...ad, documento, respostas, matriz, discussao });
});

// Salvamento automático das respostas (RF39)
analises.put(
  '/:id/documentos/:docId/respostas',
  requirePapel(...EDITA),
  validate({
    body: z.object({
      respostas: z.array(z.object({ questaoAnaliseId: z.guid(), texto: z.string().max(65_000).nullable() })).max(200).optional(),
      consideracoes: longText(),
      observacoes: longText(),
    }),
  }),
  async (req, res) => {
    const ad = await analiseDocumento(req);
    const { respostas = [], consideracoes, observacoes } = req.validated.body;
    const permitidas = new Set((await db('analiseQuestao').where({ analiseId: ad.analiseId }).select('questaoAnaliseId')).map((r: any) => r.questaoAnaliseId));
    const invalida = respostas.find((r: any) => !permitidas.has(r.questaoAnaliseId));
    if (invalida) throw AppError.unprocessable('Questão não faz parte desta análise', { questaoAnaliseId: invalida.questaoAnaliseId });
    const progresso = await db.transaction(async (trx) => {
      for (const r of respostas) {
        await trx('resposta')
          .insert({ id: uuid(), analiseDocumentoId: ad.id, questaoAnaliseId: r.questaoAnaliseId, texto: r.texto, atualizadoPor: req.user!.id })
          .onConflict()
          .merge(['texto', 'atualizadoPor']);
      }
      const extra: Record<string, unknown> = {};
      if (consideracoes !== undefined) extra.consideracoes = consideracoes;
      if (observacoes !== undefined) extra.observacoes = observacoes;
      if (Object.keys(extra).length) await trx('analiseDocumento').where({ id: ad.id }).update(extra);
      return recalcularProgresso(trx, ad.id, req.user!.id);
    });
    res.json({ progresso, salvoEm: new Date().toISOString() });
  },
);

// RF40: respostas de uma QA em todos os documentos
analises.get('/:id/questoes/:qId/comparativo', async (req, res) => {
  res.json(
    await db('analiseDocumento as ad')
      .join('documento as d', 'd.id', 'ad.documentoId')
      .leftJoin('resposta as r', function () {
        this.on('r.analiseDocumentoId', 'ad.id').andOn('r.questaoAnaliseId', db.raw('?', [String(req.params.qId)]));
      })
      .where('ad.analiseId', String(req.params.id))
      .orderBy('ad.ordem')
      .select('ad.documentoId', 'd.titulo', 'd.autores', 'd.ano', 'r.texto', 'r.atualizadoEm'),
  );
});

// RF41: exportação (gerada no worker)
analises.post('/:id/exportar', validate({ body: z.object({ formato: z.enum(['xlsx', 'pdf', 'docx']) }) }), async (req, res) => {
  const tarefaId = await enfileirar('exportar-analise', { analiseId: String(req.params.id), projetoId: req.projeto!.id, formato: req.validated.body.formato, usuarioId: req.user!.id });
  res.status(202).json({ tarefaId, acompanhar: `/api/v1/tarefas/${tarefaId}` });
});

// ------------------------------------------------ /analise-documentos/:id/matriz e /discussao
export const analiseDocumentos = Router();
// :adId (e não :id): os CRUDs abaixo também usam /:id e, com mergeParams, o do item sobrescreveria o do pai
analiseDocumentos.use('/:adId', projectAccess('analiseDocumento', 'adId'));

analiseDocumentos.use(
  '/:adId/matriz',
  crudRouter({
    table: 'matrizSinteseItem',
    scope: (req) => ({ analiseDocumentoId: String(req.params.adId) }),
    write: [requirePapel(...EDITA)],
    ordered: true,
    label: 'Item da matriz',
    createSchema: z.object({ citacao: longText(5000), textoOriginal: longText(), textoParafraseado: longText(), pagina: optText(20), ordem: z.number().int().positive().optional() }),
  }),
);

analiseDocumentos.use(
  '/:adId/discussao',
  crudRouter({
    table: 'discussaoItem',
    scope: (req) => ({ analiseDocumentoId: String(req.params.adId) }),
    write: [requirePapel(...EDITA)],
    ordered: true,
    label: 'Item da discussão',
    createSchema: z.object({ pontoPrincipal: longText(5000), discussao: longText(), ordem: z.number().int().positive().optional() }),
  }),
);
