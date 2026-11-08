import { Router, type Request } from 'express';
import { z } from 'zod';
import { db, type Trx } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { EDITA, projectAccess, requirePapel } from '#middlewares/projectAccess.ts';
import { AppError } from '#utils/AppError.ts';
import { uuid } from '#utils/tokens.ts';
import { auditar } from '#services/audit.ts';
import { membrosDoProjeto, notificar } from '#services/notificacoes.ts';
import { contagensEtapa, elegiveis, etapaComRevisao } from '#modules/revisoes/revisoes.service.ts';

// /etapas/:etapaId/... (UC08, UC09)
const router = Router();
router.use('/:etapaId', projectAccess('etapa', 'etapaId'));

const decisaoSchema = z
  .object({
    decisao: z.enum(['SELECIONADO', 'EXCLUIDO']),
    motivo: z.enum(['CRITERIO', 'DUPLICADO', 'SEM_ACESSO', 'OUTRO']).nullable().optional(),
    criterioId: z.guid().nullable().optional(),
    observacao: z.string().trim().max(5000).nullable().optional(),
  })
  // RN10: exclusão exige motivo; CRITERIO exige o critério; OUTRO exige texto
  .superRefine((d, ctx) => {
    if (d.decisao === 'SELECIONADO' && d.motivo) ctx.addIssue({ code: 'custom', path: ['motivo'], message: 'Selecionado não tem motivo' });
    if (d.decisao === 'EXCLUIDO' && !d.motivo) ctx.addIssue({ code: 'custom', path: ['motivo'], message: 'Informe o motivo da exclusão (RN10)' });
    if (d.motivo === 'CRITERIO' && !d.criterioId) ctx.addIssue({ code: 'custom', path: ['criterioId'], message: 'Escolha o critério de exclusão' });
    if (d.motivo === 'OUTRO' && !d.observacao) ctx.addIssue({ code: 'custom', path: ['observacao'], message: 'Descreva o motivo' });
  });

async function conferirCriterio(req: Request, criterioId?: string | null) {
  if (!criterioId) return;
  const c = await db('criterio as c')
    .join('protocolo as p', 'p.id', 'c.protocoloId')
    .where({ 'c.id': criterioId, 'p.projetoId': req.projeto!.id, 'c.tipo': 'EXCLUSAO' })
    .first('c.id');
  if (!c) throw AppError.unprocessable('O critério precisa ser um critério de exclusão do protocolo deste projeto');
}

// Consolida as decisões dos revisores no resultado da etapa (RN12)
async function consolidar(trx: Trx, rdId: string, etapa: any) {
  const decisoes = await trx('triagemDecisao').where({ revisaoDocumentoId: rdId, revisaoEtapaId: etapa.id }).orderBy('decididoEm');
  let resultado: Record<string, unknown>;
  if (!decisoes.length) {
    await trx('triagemResultado').where({ revisaoDocumentoId: rdId, revisaoEtapaId: etapa.id }).del();
    return null;
  }
  const atual = await trx('triagemResultado').where({ revisaoDocumentoId: rdId, revisaoEtapaId: etapa.id }).first();
  if (atual?.resolvidoPor) return atual; // desempate do orientador prevalece
  const ultima = decisoes.at(-1);
  if (etapa.doisRevisores && etapa.exigeTriagem) {
    if (decisoes.length < 2) resultado = { decisaoFinal: null, motivo: null, criterioId: null, conflito: false };
    else {
      const [a, b] = decisoes.slice(-2);
      const concordam = a.decisao === b.decisao;
      resultado = concordam
        ? { decisaoFinal: b.decisao, motivo: b.motivo, criterioId: b.criterioId, conflito: false }
        : { decisaoFinal: null, motivo: null, criterioId: null, conflito: true };
    }
  } else {
    resultado = { decisaoFinal: ultima.decisao, motivo: ultima.motivo, criterioId: ultima.criterioId, conflito: false };
  }
  await trx('triagemResultado')
    .insert({ revisaoDocumentoId: rdId, revisaoEtapaId: etapa.id, ...resultado })
    .onConflict()
    .merge(['decisaoFinal', 'motivo', 'criterioId', 'conflito']);
  await atualizarSituacao(trx, rdId);
  return trx('triagemResultado').where({ revisaoDocumentoId: rdId, revisaoEtapaId: etapa.id }).first();
}

// Excluído em qualquer etapa: situação EXCLUIDO; senão volta a EM_TRIAGEM (a inclusão é marcada ao concluir a etapa de inclusão)
async function atualizarSituacao(trx: Trx, rdId: string) {
  const exc = await trx('triagemResultado').where({ revisaoDocumentoId: rdId, decisaoFinal: 'EXCLUIDO' }).first('revisaoEtapaId');
  const rd = await trx('revisaoDocumento').where({ id: rdId }).first('situacao', 'duplicadoDeId');
  if (exc) await trx('revisaoDocumento').where({ id: rdId }).update({ situacao: 'EXCLUIDO' });
  else if (rd?.situacao === 'EXCLUIDO' && !rd.duplicadoDeId) await trx('revisaoDocumento').where({ id: rdId }).update({ situacao: 'EM_TRIAGEM' });
}

// RN09: documentos elegíveis da etapa, com a decisão do usuário e o resultado
router.get(
  '/:etapaId/documentos',
  validate({ query: z.object({ filtro: z.enum(['todos', 'pendentes', 'minhas-pendentes', 'selecionados', 'excluidos', 'conflitos']).optional() }) }),
  async (req, res) => {
    const etapa = await etapaComRevisao(String(req.params.etapaId));
    if (!etapa.exigeTriagem && !etapa.permiteExclusao) throw AppError.unprocessable('Esta etapa não tem triagem');
    const filtro = req.validated.query.filtro ?? 'todos';
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
    res.json({ etapa, contagens: await contagensEtapa(etapa), documentos: await q });
  },
);

// RF29: decisão de triagem
router.put('/:etapaId/documentos/:rdId/decisao', requirePapel(...EDITA), validate({ body: decisaoSchema }), async (req, res) => {
  const etapa = await etapaComRevisao(String(req.params.etapaId));
  const rdId = String(req.params.rdId);
  if (etapa.status !== 'EM_ANDAMENTO') throw AppError.conflict('A etapa não está em andamento');
  if (!etapa.exigeTriagem && !etapa.permiteExclusao) throw AppError.unprocessable('Esta etapa não aceita decisões');
  if (!etapa.exigeTriagem && req.validated.body.decisao === 'SELECIONADO') {
    // etapas que só permitem exclusão (ex.: duplicados): "selecionado" desfaz a exclusão
    await db.transaction(async (trx) => {
      await trx('triagemDecisao').where({ revisaoDocumentoId: rdId, revisaoEtapaId: etapa.id }).del();
      await trx('triagemResultado').where({ revisaoDocumentoId: rdId, revisaoEtapaId: etapa.id }).del();
      await trx('revisaoDocumento').where({ id: rdId }).update({ duplicadoDeId: null });
      await atualizarSituacao(trx, rdId);
    });
    return res.json({ resultado: null, contagens: await contagensEtapa(etapa) });
  }
  const elegivel = await elegiveis(etapa).where('rd.id', rdId).first('rd.id');
  if (!elegivel) throw AppError.unprocessable('O documento não está elegível nesta etapa (RN09)', undefined, 'NAO_ELEGIVEL');
  const d = req.validated.body;
  await conferirCriterio(req, d.criterioId);

  const resultado = await db.transaction(async (trx) => {
    await trx('triagemDecisao')
      .insert({
        id: uuid(),
        revisaoDocumentoId: rdId,
        revisaoEtapaId: etapa.id,
        revisorId: req.user!.id,
        decisao: d.decisao,
        motivo: d.motivo ?? null,
        criterioId: d.criterioId ?? null,
        observacao: d.observacao ?? null,
        decididoEm: new Date(),
      })
      .onConflict()
      .merge(['decisao', 'motivo', 'criterioId', 'observacao', 'decididoEm']);
    const r = await consolidar(trx, rdId, etapa);
    await auditar({ req, entidade: 'triagem_decisao', entidadeId: rdId, acao: 'DECIDIR', depois: { etapaId: etapa.id, ...d } }, trx);
    if (r?.conflito) {
      const orientadores = await membrosDoProjeto(req.projeto!.id, ['ORIENTADOR', 'RESPONSAVEL'], trx);
      await notificar(orientadores, 'CONFLITO', `Conflito de triagem em "${etapa.nome}"`, { etapaId: etapa.id, revisaoDocumentoId: rdId }, trx);
    }
    return r;
  });
  res.json({ resultado, contagens: await contagensEtapa(etapa) });
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
