import { Router, type Request } from 'express';
import { z } from 'zod';
import { db, type Trx } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { EDITA, projectAccess, requirePapel } from '#middlewares/projectAccess.ts';
import { AppError } from '#utils/AppError.ts';
import { uuid } from '#utils/tokens.ts';
import { auditar } from '#services/audit.ts';
import { membrosDoProjeto, notificar } from '#services/notificacoes.ts';
import { consolidarDecisoes, contagensEtapa, elegiveis, etapaComRevisao, exigeDoisRevisores, recalcularSituacao, resolverAguardando } from '#modules/revisoes/revisoes.service.ts';

// /etapas/:etapaId/... (UC08, UC09)
const router = Router();
router.use('/:etapaId', projectAccess('etapa', 'etapaId'));

const decisaoCampos = z.object({
  decisao: z.enum(['SELECIONADO', 'EXCLUIDO']),
  motivo: z.enum(['CRITERIO', 'DUPLICADO', 'SEM_ACESSO', 'OUTRO']).nullable().optional(),
  criterioId: z.guid().nullable().optional(),
  observacao: z.string().trim().max(5000).nullable().optional(),
});
// RN10: exclusão exige motivo; CRITERIO exige o critério; OUTRO exige texto
const regrasDecisao = (d: z.infer<typeof decisaoCampos>, ctx: z.RefinementCtx) => {
  if (d.decisao === 'SELECIONADO' && d.motivo) ctx.addIssue({ code: 'custom', path: ['motivo'], message: 'Selecionado não tem motivo' });
  if (d.decisao === 'EXCLUIDO' && !d.motivo) ctx.addIssue({ code: 'custom', path: ['motivo'], message: 'Informe o motivo da exclusão (RN10)' });
  if (d.motivo === 'CRITERIO' && !d.criterioId) ctx.addIssue({ code: 'custom', path: ['criterioId'], message: 'Escolha o critério de exclusão' });
  if (d.motivo === 'OUTRO' && !d.observacao) ctx.addIssue({ code: 'custom', path: ['observacao'], message: 'Descreva o motivo' });
};
const decisaoSchema = decisaoCampos.superRefine(regrasDecisao);
const decisaoEmLoteSchema = decisaoCampos.extend({ ids: z.array(z.guid()).min(1).max(2000) }).superRefine(regrasDecisao);

async function conferirCriterio(req: Request, criterioId?: string | null) {
  if (!criterioId) return;
  const c = await db('criterio as c')
    .join('protocolo as p', 'p.id', 'c.protocoloId')
    .where({ 'c.id': criterioId, 'p.projetoId': req.projeto!.id, 'c.tipo': 'EXCLUSAO' })
    .first('c.id');
  if (!c) throw AppError.unprocessable('O critério precisa ser um critério de exclusão do protocolo deste projeto');
}

// Excluído em qualquer etapa: EXCLUIDO; com a inclusão concluída e selecionado: INCLUIDO; senão EM_TRIAGEM
async function atualizarSituacao(trx: Trx, rdId: string) {
  const rd = await trx('revisaoDocumento').where({ id: rdId }).first('revisaoId');
  if (rd) await recalcularSituacao(trx, rd.revisaoId, [rdId]);
}

// RN09: documentos elegíveis da etapa, com a decisão do usuário e o resultado
router.get(
  '/:etapaId/documentos',
  validate({ query: z.object({ filtro: z.enum(['todos', 'pendentes', 'minhas-pendentes', 'selecionados', 'excluidos', 'conflitos', 'aguardando']).optional() }) }),
  async (req, res) => {
    const etapa = await etapaComRevisao(String(req.params.etapaId));
    if (!etapa.exigeTriagem && !etapa.permiteExclusao) throw AppError.unprocessable('Esta etapa não tem triagem');
    const filtro = req.validated.query.filtro ?? 'todos';
    await resolverAguardando(etapa);
    const q = elegiveis(etapa)
      .join('documento as d', 'd.id', 'rd.documentoId')
      .leftJoin('busca as b', 'b.id', 'rd.buscaId')
      .leftJoin('baseDados as bd', 'bd.id', 'b.baseDadosId')
      .leftJoin('triagemResultado as tr', function () {
        this.on('tr.revisaoDocumentoId', 'rd.id').andOn('tr.revisaoEtapaId', db.raw('?', [etapa.id]));
      })
      .leftJoin('triagemDecisao as minha', function () {
        this.on('minha.revisaoDocumentoId', 'rd.id').andOn('minha.revisaoEtapaId', db.raw('?', [etapa.id])).andOn('minha.revisorId', db.raw('?', [req.user!.id]));
      })
      .select(
        'rd.id as revisaoDocumentoId',
        'rd.origem',
        'd.id as documentoId',
        'd.titulo',
        'd.autores',
        'd.resumo',
        'd.palavrasChave',
        'd.ano',
        'd.periodico',
        'd.doi',
        'd.link',
        'd.arquivoId',
        'bd.nome as baseNome',
        'tr.decisaoFinal',
        'tr.motivo',
        'tr.conflito',
        'minha.decisao as minhaDecisao',
        'minha.motivo as meuMotivo',
      )
      .orderBy('d.titulo');
    if (filtro === 'pendentes') q.whereNull('tr.decisaoFinal').where((w: any) => w.whereNull('tr.conflito').orWhere('tr.conflito', false));
    if (filtro === 'minhas-pendentes') q.whereNull('minha.id');
    if (filtro === 'selecionados') q.where('tr.decisaoFinal', 'SELECIONADO');
    if (filtro === 'excluidos') q.where('tr.decisaoFinal', 'EXCLUIDO');
    if (filtro === 'conflitos') q.where('tr.conflito', true);
    if (filtro === 'aguardando') q.whereNotNull('tr.revisaoDocumentoId').whereNull('tr.decisaoFinal').where('tr.conflito', false);
    // doisRevisores: se a segunda decisão é exigida de fato (RN12; com um só membro que decide, não)
    res.json({ etapa, doisRevisores: await exigeDoisRevisores(db, etapa), contagens: await contagensEtapa(etapa), documentos: await q });
  },
);

type Etapa = Awaited<ReturnType<typeof etapaComRevisao>>;

function conferirEtapa(etapa: Etapa) {
  // decisões podem ser corrigidas também depois de a etapa ser concluída
  if (etapa.status !== 'EM_ANDAMENTO' && etapa.status !== 'CONCLUIDA') throw AppError.conflict('A etapa não foi iniciada ou foi dispensada');
  if (!etapa.exigeTriagem && !etapa.permiteExclusao) throw AppError.unprocessable('Esta etapa não aceita decisões');
}

/** Grava a mesma decisão do usuário para vários documentos e consolida o resultado */
async function decidir(req: Request, etapa: Etapa, rdIds: string[], d: z.infer<typeof decisaoCampos>) {
  return db.transaction(async (trx) => {
    if (!etapa.exigeTriagem && d.decisao === 'SELECIONADO') {
      // etapas que só permitem exclusão (ex.: duplicados): "selecionado" desfaz a exclusão
      await trx('triagemDecisao').where({ revisaoEtapaId: etapa.id }).whereIn('revisaoDocumentoId', rdIds).del();
      await trx('triagemResultado').where({ revisaoEtapaId: etapa.id }).whereIn('revisaoDocumentoId', rdIds).del();
      await trx('revisaoDocumento').whereIn('id', rdIds).update({ duplicadoDeId: null });
      await recalcularSituacao(trx, etapa.revisaoId, rdIds);
      return { novosConflitos: [] as string[] };
    }
    const agora = new Date();
    for (let i = 0; i < rdIds.length; i += 500) {
      await trx('triagemDecisao')
        .insert(
          rdIds.slice(i, i + 500).map((rdId) => ({
            id: uuid(),
            revisaoDocumentoId: rdId,
            revisaoEtapaId: etapa.id,
            revisorId: req.user!.id,
            decisao: d.decisao,
            motivo: d.motivo ?? null,
            criterioId: d.criterioId ?? null,
            observacao: d.observacao ?? null,
            decididoEm: agora,
          })),
        )
        .onConflict()
        .merge(['decisao', 'motivo', 'criterioId', 'observacao', 'decididoEm']);
    }
    const r = await consolidarDecisoes(trx, etapa, rdIds);
    await auditar(
      { req, entidade: 'triagem_decisao', entidadeId: rdIds.length === 1 ? rdIds[0] : etapa.id, acao: 'DECIDIR', depois: { etapaId: etapa.id, ...d, documentos: rdIds.length > 1 ? rdIds : undefined } },
      trx,
    );
    if (r.novosConflitos.length) {
      const orientadores = await membrosDoProjeto(req.projeto!.id, ['ORIENTADOR', 'RESPONSAVEL'], trx);
      await notificar(orientadores, 'CONFLITO', `${r.novosConflitos.length} conflito(s) de triagem em "${etapa.nome}"`, { etapaId: etapa.id, revisaoDocumentoId: r.novosConflitos[0] }, trx);
    }
    return r;
  });
}

// RF29: decisão de triagem
router.put('/:etapaId/documentos/:rdId/decisao', requirePapel(...EDITA), validate({ body: decisaoSchema }), async (req, res) => {
  const etapa = await etapaComRevisao(String(req.params.etapaId));
  const rdId = String(req.params.rdId);
  conferirEtapa(etapa);
  const d = req.validated.body;
  if (etapa.exigeTriagem || d.decisao === 'EXCLUIDO') {
    const elegivel = await elegiveis(etapa).where('rd.id', rdId).first('rd.id');
    if (!elegivel) throw AppError.unprocessable('O documento não está elegível nesta etapa (RN09)', undefined, 'NAO_ELEGIVEL');
  }
  await conferirCriterio(req, d.criterioId);
  await decidir(req, etapa, [rdId], d);
  const resultado = (await db('triagemResultado').where({ revisaoDocumentoId: rdId, revisaoEtapaId: etapa.id }).first()) ?? null;
  res.json({ resultado, contagens: await contagensEtapa(etapa) });
});

// Mesma decisão (e mesmo motivo) para vários documentos marcados na lista
router.put('/:etapaId/decisoes', requirePapel(...EDITA), validate({ body: decisaoEmLoteSchema }), async (req, res) => {
  const etapa = await etapaComRevisao(String(req.params.etapaId));
  conferirEtapa(etapa);
  const { ids, ...d } = req.validated.body;
  const pedidos = [...new Set<string>(ids)];
  const validos: string[] = [];
  for (let i = 0; i < pedidos.length; i += 500) {
    validos.push(...(await elegiveis(etapa).whereIn('rd.id', pedidos.slice(i, i + 500)).pluck('rd.id')));
  }
  if (!validos.length) throw AppError.unprocessable('Nenhum dos documentos está elegível nesta etapa (RN09)', undefined, 'NAO_ELEGIVEL');
  await conferirCriterio(req, d.criterioId);
  const r = await decidir(req, etapa, validos, d);
  res.json({ decididos: validos.length, ignorados: pedidos.length - validos.length, conflitos: r.novosConflitos.length, contagens: await contagensEtapa(etapa) });
});

// RF30/UC09: conflitos e desempate
router.get('/:etapaId/conflitos', async (req, res) => {
  const etapaId = String(req.params.etapaId);
  const conflitos = await db('triagemResultado as tr')
    .join('revisaoDocumento as rd', 'rd.id', 'tr.revisaoDocumentoId')
    .join('documento as d', 'd.id', 'rd.documentoId')
    .where({ 'tr.revisaoEtapaId': etapaId, 'tr.conflito': true })
    .select('rd.id as revisaoDocumentoId', 'd.titulo', 'd.autores', 'd.ano', 'd.resumo');
  const decisoes = conflitos.length
    ? await db('triagemDecisao as td')
        .join('usuario as u', 'u.id', 'td.revisorId')
        .where('td.revisaoEtapaId', etapaId)
        .whereIn('td.revisaoDocumentoId', conflitos.map((c: any) => c.revisaoDocumentoId))
        .select('td.revisaoDocumentoId', 'td.decisao', 'td.motivo', 'td.criterioId', 'td.observacao', 'td.decididoEm', 'u.nome as revisorNome')
    : [];
  res.json(conflitos.map((c: any) => ({ ...c, decisoes: decisoes.filter((d: any) => d.revisaoDocumentoId === c.revisaoDocumentoId) })));
});

router.put('/:etapaId/conflitos/:rdId', requirePapel('ORIENTADOR', 'RESPONSAVEL'), validate({ body: decisaoSchema }), async (req, res) => {
  const etapa = await etapaComRevisao(String(req.params.etapaId));
  const rdId = String(req.params.rdId);
  const d = req.validated.body;
  await conferirCriterio(req, d.criterioId);
  const atual = await db('triagemResultado').where({ revisaoDocumentoId: rdId, revisaoEtapaId: etapa.id }).first();
  if (!atual?.conflito) throw AppError.notFound('Conflito');
  await db.transaction(async (trx) => {
    await trx('triagemResultado')
      .where({ revisaoDocumentoId: rdId, revisaoEtapaId: etapa.id })
      .update({ decisaoFinal: d.decisao, motivo: d.motivo ?? null, criterioId: d.criterioId ?? null, conflito: false, resolvidoPor: req.user!.id, resolvidoEm: new Date() });
    await atualizarSituacao(trx, rdId);
    await auditar({ req, entidade: 'triagem_resultado', entidadeId: rdId, acao: 'DECIDIR', depois: { etapaId: etapa.id, desempate: d } }, trx);
  });
  res.json({ resultado: await db('triagemResultado').where({ revisaoDocumentoId: rdId, revisaoEtapaId: etapa.id }).first(), contagens: await contagensEtapa(etapa) });
});

export default router;
