import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { db } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { DONO, EDITA, projectAccess, requirePapel } from '#middlewares/projectAccess.ts';
import { AppError } from '#utils/AppError.ts';
import { uuid } from '#utils/tokens.ts';
import { dateStr, idParams, longText, optText } from '#shared/schemas.ts';
import { reordenar } from '#shared/ordem.ts';
import { auditar } from '#services/audit.ts';
import { salvarArquivo } from '#services/arquivos.ts';
import { enfileirar } from '#services/fila.ts';
import { eSistematico } from '#modules/tipos-revisao/tiposRevisao.service.ts';
import { contagensEtapa, copiarChecklist, elegiveis, instanciarEtapas, painel } from './revisoes.service.ts';
import { fluxogramaSvg } from './fluxograma.ts';
import { detectarDuplicados } from '#modules/documentos/duplicados.ts';

// ------------------------------------------------ /projetos/:id/revisoes
export const revisoesDoProjeto = Router({ mergeParams: true });

const etapaAjustada = z.object({
  etapaModeloId: z.guid().nullable().optional(),
  nome: z.string().trim().min(1).max(120),
  categoria: z.enum(['PROTOCOLO', 'BUSCA', 'DEDUPLICACAO', 'TRIAGEM', 'INCLUSAO', 'ANALISE', 'SINTESE', 'DISCUSSAO', 'CHECKLIST', 'LIVRE']),
  exigeTriagem: z.boolean().optional(),
  permiteExclusao: z.boolean().optional(),
});

revisoesDoProjeto.get('/', async (req, res) => {
  res.json(
    await db('revisao as r')
      .join('tipoRevisao as t', 't.id', 'r.tipoRevisaoId')
      .leftJoin('diretrizRelato as d', 'd.id', 'r.diretrizRelatoId')
      .leftJoin('revisaoEtapa as e', 'e.id', 'r.etapaAtualId')
      .where('r.projetoId', req.projeto!.id)
      .orderBy('r.criadoEm')
      .select('r.*', 't.nome as tipoNome', 'd.sigla as diretrizSigla', 'd.versao as diretrizVersao', 'e.nome as etapaAtualNome', 'e.ordem as etapaAtualOrdem'),
  );
});

// RF21/RF22/UC06: cria a revisão, copia as etapas (RN08) e o checklist genérico vinculado (RN14)
revisoesDoProjeto.post(
  '/',
  requirePapel(...DONO),
  validate({
    body: z.object({
      titulo: z.string().trim().min(3).max(300),
      tipoRevisaoId: z.guid(),
      diretrizRelatoId: z.guid().nullable().optional(),
      checklistModeloId: z.guid().nullable().optional(),
      doisRevisores: z.boolean().optional(),
      etapas: z.array(etapaAjustada).min(1).max(40).optional(),
    }),
  }),
  async (req, res) => {
    const d = req.validated.body;
    const tipo = await db('tipoRevisao').where({ id: d.tipoRevisaoId, ativo: true }).first();
    if (!tipo || (tipo.projetoId && tipo.projetoId !== req.projeto!.id)) throw AppError.notFound('Tipo de revisão');
    let checklistId = d.checklistModeloId ?? null;
    if (!checklistId && d.diretrizRelatoId) {
      checklistId = (await db('diretrizRelato').where({ id: d.diretrizRelatoId }).first('checklistModeloId'))?.checklistModeloId ?? null;
    }
    if (!checklistId) checklistId = (await db('checklistModelo').where({ padrao: true }).whereNull('projetoId').first('id'))?.id ?? null;

    const id = uuid();
    await db.transaction(async (trx) => {
      await trx('revisao').insert({
        id,
        projetoId: req.projeto!.id,
        titulo: d.titulo,
        tipoRevisaoId: tipo.id,
        diretrizRelatoId: d.diretrizRelatoId ?? null,
        checklistModeloId: checklistId,
        doisRevisores: d.doisRevisores ?? false,
        status: 'EM_ANDAMENTO',
        criadoPor: req.user!.id,
      });
      const etapas = await instanciarEtapas(trx, id, tipo.id, d.etapas);
      await trx('revisaoEtapa').where({ id: etapas[0].id }).update({ status: 'EM_ANDAMENTO', iniciadaEm: new Date() });
      await trx('revisao').where({ id }).update({ etapaAtualId: etapas[0].id });
      await copiarChecklist(trx, id, checklistId);
      await auditar({ req, entidade: 'revisao', entidadeId: id, acao: 'CRIAR', depois: d }, trx);
    });
    res.status(201).json(await detalhe(id));
  },
);

async function detalhe(id: string) {
  const r = await db('revisao as r')
    .join('tipoRevisao as t', 't.id', 'r.tipoRevisaoId')
    .leftJoin('diretrizRelato as d', 'd.id', 'r.diretrizRelatoId')
    .where('r.id', id)
    .first('r.*', 't.nome as tipoNome', 'd.nome as diretrizNome', 'd.sigla as diretrizSigla', 'd.versao as diretrizVersao', 'd.urlOficial as diretrizUrl');
  const etapas = await db('revisaoEtapa').where({ revisaoId: id }).orderBy('ordem');
  return { ...r, sistematica: await eSistematico(r.tipoRevisaoId), etapas };
}

// ------------------------------------------------ /revisoes/:id
export const revisoes = Router();
revisoes.use('/:id', projectAccess('revisao'));

revisoes.get('/:id', async (req, res) => {
  res.json(await detalhe(String(req.params.id)));
});

revisoes.patch(
  '/:id',
  requirePapel(...DONO),
  validate({
    body: z.object({
      titulo: z.string().trim().min(3).max(300).optional(),
      status: z.enum(['PLANEJADA', 'EM_ANDAMENTO', 'CONCLUIDA', 'CANCELADA']).optional(),
      doisRevisores: z.boolean().optional(),
      diretrizRelatoId: z.guid().nullable().optional(),
      tipoRevisaoId: z.guid().optional(),
    }),
  }),
  async (req, res) => {
    const id = String(req.params.id);
    const { tipoRevisaoId, ...resto } = req.validated.body;
    await db.transaction(async (trx) => {
      const r = await trx('revisao').where({ id }).first();
      if (tipoRevisaoId && tipoRevisaoId !== r.tipoRevisaoId) {
        // RN08: trocar o tipo só enquanto nenhuma etapa foi iniciada de fato (só a 1ª aberta, sem decisões)
        const iniciadas = await trx('revisaoEtapa').where({ revisaoId: id }).whereIn('status', ['CONCLUIDA', 'DISPENSADA']).first('id');
        const temDados = (await trx('busca').where({ revisaoId: id }).first('id')) || (await trx('revisaoDocumento').where({ revisaoId: id }).first('id'));
        if (iniciadas || temDados) throw AppError.conflict('O tipo só pode ser trocado antes de iniciar as etapas (RN08)');
        const tipo = await trx('tipoRevisao').where({ id: tipoRevisaoId, ativo: true }).first();
        if (!tipo || (tipo.projetoId && tipo.projetoId !== req.projeto!.id)) throw AppError.notFound('Tipo de revisão');
        await trx('revisao').where({ id }).update({ etapaAtualId: null, tipoRevisaoId });
        const etapas = await instanciarEtapas(trx, id, tipoRevisaoId);
        await trx('revisaoEtapa').where({ id: etapas[0].id }).update({ status: 'EM_ANDAMENTO', iniciadaEm: new Date() });
        await trx('revisao').where({ id }).update({ etapaAtualId: etapas[0].id });
      }
      if (Object.keys(resto).length) await trx('revisao').where({ id }).update(resto);
    });
    res.json(await detalhe(id));
  },
);

revisoes.delete('/:id', requirePapel(...DONO), async (req, res) => {
  await db('revisao').where({ id: String(req.params.id) }).del();
  auditar({ req, entidade: 'revisao', entidadeId: String(req.params.id), acao: 'EXCLUIR' });
  res.status(204).end();
});

// ---- etapas (RF22/RF23)
revisoes.get('/:id/etapas', async (req, res) => {
  const etapas = await db('revisaoEtapa').where({ revisaoId: String(req.params.id) }).orderBy('ordem');
  const out: any[] = [];
  for (const e of etapas) out.push(e.exigeTriagem || e.permiteExclusao ? { ...e, contagens: await contagensEtapa(e) } : e);
  res.json(out);
});

// Renomear/reordenar só etapas que ainda não começaram
revisoes.put('/:id/etapas/ordem', requirePapel(...DONO), validate({ body: z.object({ ids: z.array(z.guid()).min(1) }) }), async (req, res) => {
  const revisaoId = String(req.params.id);
  await db.transaction(async (trx) => {
    const atuais = await trx('revisaoEtapa').where({ revisaoId }).orderBy('ordem');
    req.validated.body.ids.forEach((id: string, i: number) => {
      const e = atuais.find((x: any) => x.id === id);
      if (e && e.ordem !== i + 1 && e.status !== 'PENDENTE') throw AppError.conflict(`A etapa "${e.nome}" já começou e não pode mudar de posição`);
    });
    await reordenar(trx, 'revisaoEtapa', { revisaoId }, req.validated.body.ids);
  });
  res.json(await db('revisaoEtapa').where({ revisaoId }).orderBy('ordem'));
});

revisoes.patch(
  '/:id/etapas/:etapaId',
  requirePapel(...EDITA),
  validate({
    body: z.object({
      acao: z.enum(['INICIAR', 'CONCLUIR', 'DISPENSAR', 'REABRIR']).optional(),
      nome: z.string().trim().min(1).max(120).optional(),
      justificativa: z.string().trim().min(3).max(5000).optional(),
    }),
  }),
  async (req, res) => {
    const revisaoId = String(req.params.id);
    const etapaId = String(req.params.etapaId);
    const { acao, nome, justificativa } = req.validated.body;
    await db.transaction(async (trx) => {
      const etapas = await trx('revisaoEtapa').where({ revisaoId }).orderBy('ordem').forUpdate();
      const e = etapas.find((x: any) => x.id === etapaId);
      if (!e) throw AppError.notFound('Etapa');
      if (nome) {
        if (e.status !== 'PENDENTE') throw AppError.conflict('Só é possível renomear etapas que ainda não começaram');
        await trx('revisaoEtapa').where({ id: e.id }).update({ nome });
      }
      if (!acao) return;
      const anteriores = etapas.filter((x: any) => x.ordem < e.ordem);
      const posteriores = etapas.filter((x: any) => x.ordem > e.ordem);
      const fechada = (x: any) => x.status === 'CONCLUIDA' || x.status === 'DISPENSADA';

      if (acao === 'INICIAR') {
        // RF23: só avança com as anteriores concluídas ou dispensadas
        const aberta = anteriores.find((x: any) => !fechada(x));
        if (aberta) throw AppError.conflict(`Conclua ou dispense antes a etapa "${aberta.nome}"`);
        if (e.status !== 'PENDENTE') throw AppError.conflict('A etapa já foi iniciada');
        await trx('revisaoEtapa').where({ id: e.id }).update({ status: 'EM_ANDAMENTO', iniciadaEm: new Date() });
        await trx('revisao').where({ id: revisaoId }).update({ etapaAtualId: e.id, status: 'EM_ANDAMENTO' });
      }

      if (acao === 'CONCLUIR' || acao === 'DISPENSAR') {
        if (e.status !== 'EM_ANDAMENTO' && !(acao === 'DISPENSAR' && e.status === 'PENDENTE')) {
          throw AppError.conflict('A etapa não está em andamento');
        }
        if (acao === 'DISPENSAR' && !justificativa) throw AppError.unprocessable('Informe a justificativa para dispensar a etapa', undefined, 'JUSTIFICATIVA_OBRIGATORIA');
        if (acao === 'CONCLUIR' && (e.exigeTriagem || e.permiteExclusao)) {
          const c = await contagensEtapa(e);
          if (c.conflitos) throw AppError.conflict(`Há ${c.conflitos} conflito(s) de triagem abertos (RN12)`, c);
          if (e.exigeTriagem && c.semDecisao) throw AppError.conflict(`Há ${c.semDecisao} documento(s) sem decisão nesta etapa`, c);
        }
        if (acao === 'CONCLUIR' && e.categoria === 'INCLUSAO') await marcarIncluidos(trx, revisaoId, e.ordem);
        await trx('revisaoEtapa')
          .where({ id: e.id })
          .update({
            status: acao === 'CONCLUIR' ? 'CONCLUIDA' : 'DISPENSADA',
            justificativaDispensa: acao === 'DISPENSAR' ? justificativa : null,
            iniciadaEm: e.iniciadaEm ?? new Date(),
            concluidaEm: new Date(),
          });
        // abre a próxima etapa pendente; sem próxima, a revisão termina
        const proxima = posteriores.find((x: any) => x.status === 'PENDENTE');
        if (proxima) {
          await trx('revisaoEtapa').where({ id: proxima.id }).update({ status: 'EM_ANDAMENTO', iniciadaEm: new Date() });
          await trx('revisao').where({ id: revisaoId }).update({ etapaAtualId: proxima.id });
        } else if (!posteriores.some((x: any) => !fechada(x))) {
          await trx('revisao').where({ id: revisaoId }).update({ etapaAtualId: null, status: 'CONCLUIDA' });
        }
        await auditar({ req, entidade: 'revisao_etapa', entidadeId: e.id, acao: 'CONCLUIR', depois: { acao, justificativa } }, trx);
      }

      if (acao === 'REABRIR') {
        if (!fechada(e)) throw AppError.conflict('A etapa não está concluída');
        if (posteriores.some((x: any) => x.status === 'CONCLUIDA')) throw AppError.conflict('Reabra antes as etapas seguintes concluídas');
        await trx('revisaoEtapa').whereIn('id', posteriores.filter((x: any) => x.status === 'EM_ANDAMENTO').map((x: any) => x.id)).update({ status: 'PENDENTE' });
        await trx('revisaoEtapa').where({ id: e.id }).update({ status: 'EM_ANDAMENTO', concluidaEm: null, justificativaDispensa: null });
        await trx('revisao').where({ id: revisaoId }).update({ etapaAtualId: e.id, status: 'EM_ANDAMENTO' });
      }
    });
    res.json(await detalhe(revisaoId));
  },
);

// Na conclusão da etapa de inclusão: selecionados na última triagem + revisão anterior + integrados (RN13)
async function marcarIncluidos(trx: any, revisaoId: string, ordemInclusao: number) {
  const ultima = await trx('revisaoEtapa').where({ revisaoId, exigeTriagem: true }).where('ordem', '<', ordemInclusao).orderBy('ordem', 'desc').first();
  if (ultima) {
    const sel = trx('triagemResultado').where({ revisaoEtapaId: ultima.id, decisaoFinal: 'SELECIONADO' }).select('revisaoDocumentoId');
    await trx('revisaoDocumento').where({ revisaoId }).whereIn('id', sel).update({ situacao: 'INCLUIDO' });
  }
  await trx('revisaoDocumento').where({ revisaoId }).whereIn('origem', ['REVISAO_ANTERIOR', 'INTEGRADO']).update({ situacao: 'INCLUIDO' });
}

// ---- buscas (RF24/RF25/UC07)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

revisoes.get('/:id/buscas', async (req, res) => {
  res.json(
    await db('busca as b')
      .join('baseDados as bd', 'bd.id', 'b.baseDadosId')
      .where('b.revisaoId', String(req.params.id))
      .orderBy('b.dataBusca')
      .select('b.*', 'bd.nome as baseNome'),
  );
});

const buscaSchema = z.object({
  baseDadosId: z.guid(),
  stringBuscaId: z.guid().nullable().optional(),
  expressaoUsada: z.string().trim().min(1).max(10_000),
  campo: z.enum(['TITULO', 'RESUMO', 'PALAVRAS_CHAVE', 'TODOS']).optional(),
  filtros: longText(5000),
  dataBusca: dateStr.optional(),
  qtdRetornada: z.coerce.number().int().min(0).optional(),
});

revisoes.post('/:id/buscas', requirePapel(...EDITA), upload.single('arquivo'), validate({ body: buscaSchema }), async (req, res) => {
  const revisaoId = String(req.params.id);
  const d = req.validated.body;
  const etapaBusca = await db('revisaoEtapa').where({ revisaoId, categoria: 'BUSCA' }).orderBy('ordem').first();
  if (etapaBusca && etapaBusca.status === 'PENDENTE') throw AppError.conflict('A etapa de identificação (buscas) ainda não foi iniciada');
  const id = uuid();
  let arquivoId: string | null = null;
  if (req.file) {
    const ext = (req.file.originalname.split('.').pop() ?? 'txt').toLowerCase();
    if (!['ris', 'bib', 'bibtex', 'csv', 'txt', 'xlsx', 'nbib'].includes(ext)) throw AppError.unprocessable('Formato não suportado: envie RIS, BibTeX, CSV ou XLSX');
    arquivoId = await salvarArquivo({
      projetoId: req.projeto!.id,
      chave: `projetos/${req.projeto!.id}/buscas/${id}.${ext}`,
      nomeOriginal: req.file.originalname,
      mimeType: req.file.mimetype || 'application/octet-stream',
      dados: req.file.buffer,
      criadoPor: req.user!.id,
    });
  }
  await db('busca').insert({
    ...d,
    id,
    revisaoId,
    revisaoEtapaId: etapaBusca?.id ?? null,
    dataBusca: d.dataBusca ?? new Date().toISOString().slice(0, 10),
    arquivoId,
    statusImportacao: arquivoId ? 'PENDENTE' : 'SEM_ARQUIVO',
    criadoPor: req.user!.id,
  });
  if (arquivoId) await enfileirar('importar-busca', { buscaId: id, usuarioId: req.user!.id });
  res.status(arquivoId ? 202 : 201).json(await db('busca').where({ id }).first());
});

// ---- documentos da revisão (RF31) e duplicados (RF28)
revisoes.get(
  '/:id/documentos',
  validate({ query: z.object({ situacao: z.enum(['EM_TRIAGEM', 'INCLUIDO', 'EXCLUIDO']).optional(), origem: z.enum(['BUSCA', 'REVISAO_ANTERIOR', 'INTEGRADO', 'MANUAL']).optional() }) }),
  async (req, res) => {
    const q = db('revisaoDocumento as rd')
      .join('documento as d', 'd.id', 'rd.documentoId')
      .leftJoin('categoria as c', 'c.id', 'rd.categoriaId')
      .leftJoin('busca as b', 'b.id', 'rd.buscaId')
      .leftJoin('baseDados as bd', 'bd.id', 'b.baseDadosId')
      .where('rd.revisaoId', String(req.params.id))
      .select('rd.*', 'd.titulo', 'd.autores', 'd.ano', 'd.periodico', 'd.doi', 'd.arquivoId', 'c.nome as categoriaNome', 'bd.nome as baseNome')
      .orderBy('rd.criadoEm');
    if (req.validated.query.situacao) q.where('rd.situacao', req.validated.query.situacao);
    if (req.validated.query.origem) q.where('rd.origem', req.validated.query.origem);
    res.json(await q);
  },
);

revisoes.post(
  '/:id/documentos',
  requirePapel(...EDITA),
  validate({
    body: z.object({
      documentoIds: z.array(z.guid()).min(1).max(500),
      origem: z.enum(['REVISAO_ANTERIOR', 'INTEGRADO', 'MANUAL']),
      categoriaId: z.guid().nullable().optional(),
    }),
  }),
  async (req, res) => {
    const revisaoId = String(req.params.id);
    const { documentoIds, origem, categoriaId } = req.validated.body;
    const docs = await db('documento').where({ projetoId: req.projeto!.id }).whereIn('id', documentoIds).select('id');
    if (docs.length !== documentoIds.length) throw AppError.unprocessable('Algum documento não pertence a este projeto');
    const ja = new Set((await db('revisaoDocumento').where({ revisaoId }).whereIn('documentoId', documentoIds).select('documentoId')).map((r: any) => r.documentoId));
    const novos = documentoIds.filter((id: string) => !ja.has(id));
    if (novos.length) {
      // UC07 5a: revisão anterior e integrados entram direto como incluídos
      await db('revisaoDocumento').insert(
        novos.map((documentoId: string) => ({
          id: uuid(),
          revisaoId,
          documentoId,
          origem,
          categoriaId: categoriaId ?? null,
          situacao: origem === 'MANUAL' ? 'EM_TRIAGEM' : 'INCLUIDO',
        })),
      );
    }
    res.status(201).json({ incluidos: novos.length, jaExistiam: ja.size });
  },
);

revisoes.patch(
  '/:id/documentos/:rdId',
  requirePapel(...EDITA),
  validate({ body: z.object({ categoriaId: z.guid().nullable() }) }),
  async (req, res) => {
    const n = await db('revisaoDocumento').where({ id: String(req.params.rdId), revisaoId: String(req.params.id) }).update(req.validated.body);
    if (!n) throw AppError.notFound('Documento da revisão');
    res.json(await db('revisaoDocumento').where({ id: String(req.params.rdId) }).first());
  },
);

revisoes.post('/:id/duplicados/detectar', requirePapel(...EDITA), async (req, res) => {
  res.json(await detectarDuplicados(String(req.params.id), req));
});

// ---- painel (RF32), fluxograma (RF33) e checklist (RF35)
revisoes.get('/:id/painel', async (req, res) => {
  res.json(await painel(String(req.params.id)));
});

revisoes.get('/:id/fluxograma', validate({ query: z.object({ formato: z.enum(['svg', 'json']).optional() }) }), async (req, res) => {
  const p = await painel(String(req.params.id));
  if (req.validated.query.formato === 'json') return res.json(p.totais);
  res.type('image/svg+xml').send(fluxogramaSvg(p));
});

revisoes.get('/:id/checklist', async (req, res) => {
  const itens = await db('revisaoChecklistItem').where({ revisaoId: String(req.params.id) }).orderBy('ordem');
  const secoes: Record<string, { total: number; realizados: number }> = {};
  for (const i of itens) {
    secoes[i.secao] ??= { total: 0, realizados: 0 };
    secoes[i.secao].total++;
    if (i.situacao === 'REALIZADO') secoes[i.secao].realizados++;
  }
  const aplicaveis = itens.filter((i: any) => i.situacao !== 'ND').length;
  const realizados = itens.filter((i: any) => i.situacao === 'REALIZADO').length;
  res.json({ itens, secoes, progresso: aplicaveis ? Math.round((realizados / aplicaveis) * 100) : 0 });
});

const itemChecklist = z.object({ situacao: z.enum(['ND', 'REALIZADO', 'PENDENTE', 'NAO_REALIZADO']).optional(), localRelato: optText(300) });

revisoes.patch(
  '/:id/checklist',
  requirePapel(...EDITA),
  validate({ body: z.object({ itens: z.array(itemChecklist.extend({ id: z.guid() })).min(1).max(200) }) }),
  async (req, res) => {
    const revisaoId = String(req.params.id);
    await db.transaction(async (trx) => {
      for (const { id, ...d } of req.validated.body.itens) {
        await trx('revisaoChecklistItem').where({ id, revisaoId }).update({ ...d, atualizadoPor: req.user!.id });
      }
    });
    res.json(await db('revisaoChecklistItem').where({ revisaoId }).orderBy('ordem'));
  },
);

revisoes.patch('/:id/checklist/:itemId', requirePapel(...EDITA), validate({ body: itemChecklist }), async (req, res) => {
  const n = await db('revisaoChecklistItem')
    .where({ id: String(req.params.itemId), revisaoId: String(req.params.id) })
    .update({ ...req.validated.body, atualizadoPor: req.user!.id });
  if (!n) throw AppError.notFound('Item do checklist');
  res.json(await db('revisaoChecklistItem').where({ id: String(req.params.itemId) }).first());
});

// RF43: relatório da revisão em PDF (gerado no worker)
revisoes.post('/:id/relatorio', async (req, res) => {
  const tarefaId = await enfileirar('relatorio-revisao', { revisaoId: String(req.params.id), projetoId: req.projeto!.id, usuarioId: req.user!.id });
  res.status(202).json({ tarefaId, acompanhar: `/api/v1/tarefas/${tarefaId}` });
});

// ------------------------------------------------ /buscas/:id
export const buscas = Router();
buscas.use('/:id', projectAccess('busca'));

buscas.get('/:id', validate({ params: idParams }), async (req, res) => {
  const b = await db('busca as b').join('baseDados as bd', 'bd.id', 'b.baseDadosId').where('b.id', req.validated.params.id).first('b.*', 'bd.nome as baseNome');
  res.json(b);
});

buscas.patch(
  '/:id',
  requirePapel(...EDITA),
  validate({ params: idParams, body: buscaSchema.omit({ baseDadosId: true }).partial() }),
  async (req, res) => {
    await db('busca').where({ id: req.validated.params.id }).update(req.validated.body);
    res.json(await db('busca').where({ id: req.validated.params.id }).first());
  },
);

buscas.delete('/:id', requirePapel(...EDITA), validate({ params: idParams }), async (req, res) => {
  const usados = await db('revisaoDocumento').where({ buscaId: req.validated.params.id }).first('id');
  if (usados) throw AppError.conflict('A busca já tem documentos importados. Exclua os documentos antes.');
  await db('busca').where({ id: req.validated.params.id }).del();
  res.status(204).end();
});

// Tarefa de importação/elegíveis: helper usado pela triagem
export { elegiveis };
