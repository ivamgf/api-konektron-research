import { Router } from 'express';
import { z } from 'zod';
import { db, json } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { EDITA, requirePapel } from '#middlewares/projectAccess.ts';
import { auditar } from '#services/audit.ts';
import { enfileirar } from '#services/fila.ts';
import { esquemaCronograma, normalizarCronograma } from './cronograma.ts';
import { htmlRelatorio, opcoesCompletas } from './relatorio.html.ts';
import {
  dadosRelatorio,
  lerCronograma,
  lerRascunho,
  questoesDaRevisao,
  revisoesDoRelatorio,
  secoesPadrao,
  SECOES_RELATORIO,
} from './relatorio.service.ts';

const LIMITE = 1_000_000; // caracteres do JSON salvo

/** Grava (ou cria) a linha do projeto numa tabela de rascunho em JSON */
async function salvarJson(
  tabela: 'cronograma' | 'relatorio',
  projetoId: string,
  usuarioId: string,
  dados: unknown,
) {
  const texto = JSON.stringify(dados);
  if (texto.length > LIMITE) return null;
  const linha = { dados: json(dados), atualizadoPor: usuarioId, atualizadoEm: new Date() };
  const existe = await db(tabela).where({ projetoId }).first('projetoId');
  if (existe) await db(tabela).where({ projetoId }).update(linha);
  else await db(tabela).insert({ ...linha, projetoId });
  return linha.atualizadoEm;
}

// ------------------------------------------------------------------ /projetos/:id/cronograma
export const cronogramaRoutes = Router({ mergeParams: true });

// Cronograma salvo (ou null) e o que o app usa para montá-lo: período do projeto e etapas das revisões
cronogramaRoutes.get('/', async (req, res) => {
  const projetoId = req.projeto!.id;
  const [salvo, projeto, etapas] = await Promise.all([
    lerCronograma(projetoId),
    db('projeto').where({ id: projetoId }).first('dataInicio', 'dataFim'),
    db('revisaoEtapa as e')
      .join('revisao as r', 'r.id', 'e.revisaoId')
      .where('r.projetoId', projetoId)
      .orderBy([{ column: 'r.criadoEm' }, { column: 'e.ordem' }])
      .select(
        'e.id',
        'e.nome',
        'e.ordem',
        'e.categoria',
        'e.status',
        'e.iniciadaEm',
        'e.concluidaEm',
        'r.id as revisaoId',
        'r.titulo as revisaoTitulo',
      ),
  ]);
  res.json({
    dados: salvo.dados,
    atualizadoEm: salvo.atualizadoEm,
    sugestoes: {
      dataInicio: projeto?.dataInicio ?? null,
      dataFim: projeto?.dataFim ?? null,
      etapasRevisao: etapas,
    },
  });
});

cronogramaRoutes.put(
  '/',
  requirePapel(...EDITA),
  validate({ body: z.object({ dados: esquemaCronograma }) }),
  async (req, res) => {
    const dados = normalizarCronograma(req.validated.body.dados);
    const atualizadoEm = await salvarJson('cronograma', req.projeto!.id, req.user!.id, dados);
    if (!atualizadoEm)
      return res.status(413).json({ message: 'O cronograma passou do limite de tamanho' });
    res.json({ atualizadoEm, dados });
  },
);

// ------------------------------------------------------------------ /projetos/:id/relatorio
export const relatorioRoutes = Router({ mergeParams: true });

const secao = z.enum(SECOES_RELATORIO);
const opcoes = z.object({
  secoes: z.array(secao).max(SECOES_RELATORIO.length).optional(),
  norma: z.enum(['ABNT', 'APA']).optional(),
  orientacoes: z.boolean().optional(),
  capa: z.boolean().optional(),
});
const textoLivre = z.string().max(50_000).optional();
const textos = z.object({
  resumoAchados: textoLivre,
  resumoConclusao: textoLivre,
  introducao: textoLivre,
  metodoSintese: textoLivre,
  distribuicao: textoLivre,
  sintese: z.record(z.string().max(20), z.string().max(50_000)).optional(),
  discussaoFechamento: textoLivre,
  consideracoes: textoLivre,
  limitacoes: textoLivre,
  trabalhosFuturos: textoLivre,
});
const revisaoId = z.guid().nullable().optional();

// Rascunho (textos e opções), revisões do projeto e as questões de análise da revisão escolhida
relatorioRoutes.get(
  '/',
  validate({ query: z.object({ revisaoId: z.guid().optional() }) }),
  async (req, res) => {
    const projetoId = req.projeto!.id;
    const [rascunho, revisoes] = await Promise.all([
      lerRascunho(projetoId),
      revisoesDoRelatorio(projetoId),
    ]);
    const escolhida =
      revisoes.find((r: any) => r.id === req.validated.query.revisaoId) ??
      revisoes.find((r: any) => r.id === rascunho.dados?.revisaoId) ??
      revisoes[0] ??
      null;
    res.json({
      dados: rascunho.dados,
      atualizadoEm: rascunho.atualizadoEm,
      revisoes,
      revisaoId: escolhida?.id ?? null,
      questoes: await questoesDaRevisao(projetoId, escolhida?.id ?? null),
      secoes: SECOES_RELATORIO,
      secoesPadrao: secoesPadrao(!!escolhida?.sistematica),
    });
  },
);

relatorioRoutes.put(
  '/',
  requirePapel(...EDITA),
  validate({
    body: z.object({
      dados: z.object({
        revisaoId,
        opcoes: opcoes.optional(),
        textos: z.record(z.string().max(36), textos).optional(),
      }),
    }),
  }),
  async (req, res) => {
    const atualizadoEm = await salvarJson(
      'relatorio',
      req.projeto!.id,
      req.user!.id,
      req.validated.body.dados,
    );
    if (!atualizadoEm)
      return res
        .status(413)
        .json({ message: 'O rascunho do relatório passou do limite de tamanho' });
    res.json({ atualizadoEm });
  },
);

// Prévia em HTML (o mesmo do PDF), com os textos ainda não salvos quando enviados
relatorioRoutes.post(
  '/previa',
  validate({ body: z.object({ revisaoId, opcoes: opcoes.optional(), textos: textos.optional() }) }),
  async (req, res) => {
    const { revisaoId: rid, opcoes: o, textos: tx } = req.validated.body;
    const d = await dadosRelatorio(req.projeto!.id, rid ?? null, tx);
    res.json({
      html: htmlRelatorio(d, o),
      opcoes: opcoesCompletas(o, d.sistematica),
      revisaoId: d.revisao?.id ?? null,
    });
  },
);

// PDF ou Word gerado no worker (os textos vêm do rascunho salvo)
relatorioRoutes.post(
  '/gerar',
  validate({
    body: z.object({
      revisaoId,
      formato: z.enum(['pdf', 'docx']).optional(),
      opcoes: opcoes.optional(),
    }),
  }),
  async (req, res) => {
    const { revisaoId: rid, formato, opcoes: o } = req.validated.body;
    const tarefaId = await enfileirar('relatorio-pesquisa', {
      projetoId: req.projeto!.id,
      revisaoId: rid ?? null,
      formato: formato ?? 'pdf',
      opcoes: o ?? null,
      usuarioId: req.user!.id,
    });
    auditar({
      req,
      entidade: 'relatorio',
      entidadeId: req.projeto!.id,
      acao: 'IMPRIMIR',
      depois: { revisaoId: rid ?? null, formato: formato ?? 'pdf', secoes: o?.secoes ?? null },
    });
    res.status(202).json({ tarefaId, acompanhar: `/api/v1/tarefas/${tarefaId}` });
  },
);
