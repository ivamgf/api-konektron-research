import { db } from '#database/connection.ts';
import { protocoloCompleto } from '#modules/protocolo/protocolo.service.ts';
import { dadosDiagrama, type DadosDiagrama } from '#modules/revisoes/diagrama.ts';
import { referenciaApa, referenciaNbr } from '#utils/referencias.ts';
import { normalizarCronograma, type DadosCronograma } from './cronograma.ts';

/**
 * Relatório de pesquisa (template Konektron Research): reúne do banco cada campo do modelo, filtrado
 * pelo projeto e pela revisão escolhida. O HTML sai de relatorio.html.ts (PDF e Word).
 */

/** Textos do pesquisador (o que o banco não tem): um conjunto por revisão */
export type TextosRelatorio = {
  resumoAchados?: string;
  resumoConclusao?: string;
  introducao?: string;
  metodoSintese?: string;
  distribuicao?: string;
  /** síntese por questão de análise, pelo código (QA1, QA2...) */
  sintese?: Record<string, string>;
  discussaoFechamento?: string;
  consideracoes?: string;
  limitacoes?: string;
  trabalhosFuturos?: string;
};

export type RascunhoRelatorio = {
  revisaoId?: string | null;
  opcoes?: Partial<OpcoesRelatorio>;
  /** textos por revisão (chave = id da revisão; "_" quando o projeto não tem revisão) */
  textos?: Record<string, TextosRelatorio>;
};

export const SECOES_RELATORIO = [
  'identificacao',
  'resumo',
  'introducao',
  'metodo',
  'cronograma',
  'resultados',
  'caracterizacao',
  'analise',
  'sintese',
  'checklist',
  'consideracoes',
  'referencias',
  'apendiceA',
  'apendiceB',
  'apendiceC',
  'apendiceD',
] as const;
export type SecaoRelatorio = (typeof SECOES_RELATORIO)[number];

export type OpcoesRelatorio = {
  secoes: SecaoRelatorio[];
  /** norma das referências: ABNT NBR 6023 ou APA */
  norma: 'ABNT' | 'APA';
  /** mostra em itálico a orientação ao pesquisador onde o texto ainda não foi escrito */
  orientacoes: boolean;
  capa: boolean;
};

/** Seções padrão: em revisão não sistemática (narrativa) a seleção em fases e o checklist ficam de fora */
export function secoesPadrao(sistematica: boolean): SecaoRelatorio[] {
  return SECOES_RELATORIO.filter(
    (s) => s !== 'apendiceD' && (sistematica || (s !== 'resultados' && s !== 'checklist')),
  );
}

const num = (v: unknown) => Number(v ?? 0) || 0;
const parse = <T>(v: unknown): T | null => {
  if (v && typeof v === 'object') return v as T;
  try {
    return JSON.parse(String(v ?? 'null')) as T | null;
  } catch {
    return null;
  }
};

const ORDEM_PAPEL: Record<string, number> = {
  RESPONSAVEL: 0,
  ORIENTADOR: 1,
  COLABORADOR: 2,
  LEITOR: 3,
};

export async function lerRascunho(
  projetoId: string,
): Promise<{ dados: RascunhoRelatorio | null; atualizadoEm: Date | null }> {
  const r = await db('relatorio').where({ projetoId }).first();
  return {
    dados: r ? parse<RascunhoRelatorio>(r.dados) : null,
    atualizadoEm: r?.atualizadoEm ?? null,
  };
}

export async function lerCronograma(
  projetoId: string,
): Promise<{ dados: DadosCronograma | null; atualizadoEm: Date | null }> {
  const c = await db('cronograma').where({ projetoId }).first();
  const dados = c ? parse<DadosCronograma>(c.dados) : null;
  return {
    dados: dados ? normalizarCronograma(dados) : null,
    atualizadoEm: c?.atualizadoEm ?? null,
  };
}

/** Revisões do projeto para o seletor (com o tipo e se é sistemática) */
export async function revisoesDoRelatorio(projetoId: string) {
  const linhas = await db('revisao as r')
    .join('tipoRevisao as t', 't.id', 'r.tipoRevisaoId')
    .where('r.projetoId', projetoId)
    .orderBy('r.criadoEm')
    .select(
      'r.id',
      'r.titulo',
      'r.status',
      'r.tipoRevisaoId',
      't.nome as tipoNome',
      't.sistematica',
    );
  return Promise.all(
    linhas.map(async (r: any) => ({
      ...r,
      sistematica: await ehSistematica(r.tipoRevisaoId, !!r.sistematica),
    })),
  );
}

/** fn_tipo_e_sistematico considera os tipos-pai; sem a função instalada, vale a coluna do próprio tipo */
async function ehSistematica(tipoRevisaoId: string, padrao: boolean): Promise<boolean> {
  try {
    const [linhas] = (await db.raw('SELECT fn_tipo_e_sistematico(?) AS s', [tipoRevisaoId])) as any;
    const s = linhas?.[0]?.s;
    return s === null || s === undefined ? padrao : Number(s) === 1 || s === true;
  } catch {
    return padrao;
  }
}

/** Questões de análise das análises ligadas à revisão (para os campos de síntese no app) */
export async function questoesDaRevisao(projetoId: string, revisaoId: string | null) {
  const analises = await analisesDaRevisao(projetoId, revisaoId);
  if (!analises.length) return [];
  const qs = await db('analiseQuestao as aq')
    .join('questaoAnalise as q', 'q.id', 'aq.questaoAnaliseId')
    .whereIn(
      'aq.analiseId',
      analises.map((a: any) => a.id),
    )
    .orderBy(['aq.ordem', 'q.codigo'])
    .select('q.id', 'q.codigo', 'q.enunciado');
  const vistos = new Set<string>();
  return qs.filter((q: any) => !vistos.has(q.id) && vistos.add(q.id));
}

/** Análises da revisão; sem nenhuma ligada a ela, as do projeto que não têm revisão */
async function analisesDaRevisao(projetoId: string, revisaoId: string | null) {
  if (revisaoId) {
    const ligadas = await db('analise').where({ projetoId, revisaoId }).orderBy('criadoEm');
    if (ligadas.length) return ligadas;
  }
  return db('analise').where({ projetoId }).whereNull('revisaoId').orderBy('criadoEm');
}

export type AnaliseRelatorio = {
  id: string;
  nome: string;
  status: string;
  questoes: { id: string; codigo: string; enunciado: string }[];
  documentos: {
    id: string;
    documentoId: string;
    autores: string | null;
    ano: number | null;
    titulo: string;
    progresso: string;
    consideracoes: string | null;
    respostas: Record<string, string>;
  }[];
  matriz: {
    autores: string | null;
    ano: number | null;
    titulo: string;
    citacao: string | null;
    textoOriginal: string | null;
    textoParafraseado: string | null;
    pagina: string | null;
    documentoId: string;
  }[];
  discussao: {
    pontoPrincipal: string | null;
    discussao: string | null;
    autores: string | null;
    ano: number | null;
    titulo: string;
  }[];
};

async function dadosAnalise(a: any): Promise<AnaliseRelatorio> {
  const questoes = await db('analiseQuestao as aq')
    .join('questaoAnalise as q', 'q.id', 'aq.questaoAnaliseId')
    .where('aq.analiseId', a.id)
    .orderBy('aq.ordem')
    .select('q.id', 'q.codigo', 'q.enunciado');
  const docs = await db('analiseDocumento as ad')
    .join('documento as d', 'd.id', 'ad.documentoId')
    .where('ad.analiseId', a.id)
    .orderBy(['ad.ordem', 'd.titulo'])
    .select(
      'ad.id',
      'ad.documentoId',
      'ad.progresso',
      'ad.consideracoes',
      'd.titulo',
      'd.autores',
      'd.ano',
    );
  const respostas = docs.length
    ? await db('resposta').whereIn(
        'analiseDocumentoId',
        docs.map((d: any) => d.id),
      )
    : [];
  const matriz = await db('matrizSinteseItem as m')
    .join('analiseDocumento as ad', 'ad.id', 'm.analiseDocumentoId')
    .join('documento as d', 'd.id', 'ad.documentoId')
    .where('ad.analiseId', a.id)
    .orderBy(['ad.ordem', 'm.ordem'])
    .select(
      'd.id as documentoId',
      'd.titulo',
      'd.autores',
      'd.ano',
      'm.citacao',
      'm.textoOriginal',
      'm.textoParafraseado',
      'm.pagina',
    );
  const discussao = await db('discussaoItem as x')
    .join('analiseDocumento as ad', 'ad.id', 'x.analiseDocumentoId')
    .join('documento as d', 'd.id', 'ad.documentoId')
    .where('ad.analiseId', a.id)
    .orderBy(['ad.ordem', 'x.ordem'])
    .select('d.titulo', 'd.autores', 'd.ano', 'x.pontoPrincipal', 'x.discussao');
  return {
    id: a.id,
    nome: a.nome,
    status: a.status,
    questoes,
    documentos: docs.map((d: any) => ({
      ...d,
      respostas: Object.fromEntries(
        questoes.map((q: any) => [
          q.codigo,
          respostas.find((r: any) => r.analiseDocumentoId === d.id && r.questaoAnaliseId === q.id)
            ?.texto ?? '',
        ]),
      ),
    })),
    matriz,
    discussao,
  };
}

export type DadosRelatorio = Awaited<ReturnType<typeof dadosRelatorio>>;

export async function dadosRelatorio(
  projetoId: string,
  revisaoIdPedido: string | null,
  textosOverride?: TextosRelatorio,
) {
  const projeto = await db('projeto').where({ id: projetoId }).first();
  const equipe = (
    await db('projetoMembro as m')
      .join('usuario as u', 'u.id', 'm.usuarioId')
      .where('m.projetoId', projetoId)
      .whereNotNull('m.aceitoEm')
      .whereNot('m.papel', 'LEITOR')
      .select('u.nome', 'u.orcid', 'u.instituicao', 'm.papel')
  ).sort(
    (a: any, b: any) =>
      (ORDEM_PAPEL[a.papel] ?? 9) - (ORDEM_PAPEL[b.papel] ?? 9) ||
      a.nome.localeCompare(b.nome, 'pt-BR'),
  );

  const pr = await db('protocolo as p')
    .leftJoin('usuario as u', 'u.id', 'p.aprovadoPor')
    .where('p.projetoId', projetoId)
    .first('p.id', 'u.nome as aprovadoPorNome');
  const protocolo = pr
    ? { ...(await protocoloCompleto(pr.id)), aprovadoPorNome: pr.aprovadoPorNome ?? null }
    : null;
  const versoes = pr
    ? await db('protocoloVersao as v')
        .leftJoin('usuario as u', 'u.id', 'v.criadoPor')
        .leftJoin('arquivo as a', 'a.id', 'v.pdfArquivoId')
        .where('v.protocoloId', pr.id)
        .orderBy('v.versao')
        .select(
          'v.versao',
          'v.criadoEm',
          'v.justificativa',
          'u.nome as autor',
          'a.nomeOriginal as arquivo',
        )
    : [];

  const revisoes = await revisoesDoRelatorio(projetoId);
  const escolhida = revisoes.find((r: any) => r.id === revisaoIdPedido) ?? revisoes[0] ?? null;
  const revisaoId: string | null = escolhida?.id ?? null;

  const rascunho = (await lerRascunho(projetoId)).dados;
  const textos: TextosRelatorio = textosOverride ?? rascunho?.textos?.[revisaoId ?? '_'] ?? {};
  const cronograma = (await lerCronograma(projetoId)).dados;

  const base = {
    geradoEm: new Date(),
    projeto,
    equipe,
    protocolo,
    versoes,
    textos,
    cronograma,
    sistematica: escolhida?.sistematica ?? false,
  };
  if (!revisaoId)
    return {
      ...base,
      revisao: null,
      revisaoDados: null,
      analises: [] as AnaliseRelatorio[],
      referencias: [] as RefRelatorio[],
    };

  const revisao = await db('revisao as r')
    .join('tipoRevisao as t', 't.id', 'r.tipoRevisaoId')
    .leftJoin('diretrizRelato as d', 'd.id', 'r.diretrizRelatoId')
    .leftJoin('checklistModelo as cm', 'cm.id', 'r.checklistModeloId')
    .where('r.id', revisaoId)
    .first(
      'r.id',
      'r.titulo',
      'r.status',
      'r.doisRevisores',
      'r.registroUrl',
      'r.registroIdentificador',
      't.nome as tipoNome',
      't.descricao as tipoDescricao',
      'd.nome as diretrizNome',
      'd.sigla as diretrizSigla',
      'd.versao as diretrizVersao',
      'd.urlOficial as diretrizUrl',
      'cm.nome as checklistNome',
    );

  const [etapas, buscas, porBaseRaw, origens, painelRaw, exclCriterio, incluidos, checklist] =
    await Promise.all([
      db('revisaoEtapa').where({ revisaoId }).orderBy('ordem'),
      db('busca as b')
        .join('baseDados as bd', 'bd.id', 'b.baseDadosId')
        .where('b.revisaoId', revisaoId)
        .orderBy(['b.dataBusca', 'bd.nome'])
        .select(
          'b.id',
          'bd.nome as baseNome',
          'b.dataBusca',
          'b.campo',
          'b.expressaoUsada',
          'b.filtros',
          'b.qtdRetornada',
          'b.qtdImportada',
          'b.stringBuscaId',
        ),
      db.raw('SELECT * FROM vw_consultados_por_base WHERE revisao_id = ? ORDER BY base', [
        revisaoId,
      ]),
      db('revisaoDocumento')
        .where({ revisaoId })
        .whereNot('origem', 'BUSCA')
        .groupBy('origem')
        .select('origem')
        .count({ n: '*' }),
      db.raw(
        `SELECT etapa_ordem, etapa_nome, SUM(selecionados) AS selecionados, SUM(excluidos) AS excluidos,
              SUM(excluidos_criterio) AS excluidos_criterio, SUM(excluidos_duplicados) AS excluidos_duplicados,
              SUM(excluidos_sem_acesso) AS excluidos_sem_acesso, SUM(conflitos) AS conflitos, SUM(sem_decisao) AS sem_decisao
         FROM vw_painel_etapas WHERE revisao_id = ?
        GROUP BY revisao_etapa_id, etapa_ordem, etapa_nome ORDER BY etapa_ordem`,
        [revisaoId],
      ),
      db('triagemResultado as tr')
        .join('revisaoEtapa as e', 'e.id', 'tr.revisaoEtapaId')
        .join('criterio as c', 'c.id', 'tr.criterioId')
        .where('e.revisaoId', revisaoId)
        .where({ 'tr.decisaoFinal': 'EXCLUIDO', 'tr.motivo': 'CRITERIO' })
        .groupBy('c.nome', 'e.nome', 'e.ordem')
        .orderBy(['e.ordem', 'c.nome'])
        .select('c.nome as criterio', 'e.nome as etapa')
        .count({ n: '*' }),
      db('revisaoDocumento as rd')
        .join('documento as d', 'd.id', 'rd.documentoId')
        .leftJoin('idioma as i', 'i.id', 'd.idiomaId')
        .leftJoin('tipoDocumento as td', 'td.id', 'd.tipoDocumentoId')
        .leftJoin('categoria as c', 'c.id', 'rd.categoriaId')
        .leftJoin('busca as b', 'b.id', 'rd.buscaId')
        .leftJoin('baseDados as bd', 'bd.id', db.raw('COALESCE(b.base_dados_id, d.base_dados_id)'))
        .where({ 'rd.revisaoId': revisaoId, 'rd.situacao': 'INCLUIDO' })
        .whereNull('rd.duplicadoDeId')
        .orderBy([{ column: 'd.ano', order: 'desc' }, { column: 'd.autores' }])
        .select(
          'd.id',
          'd.titulo',
          'd.autores',
          'd.ano',
          'd.periodico',
          'd.doi',
          'd.link',
          'd.refNbr',
          'd.refApa',
          'rd.origem',
          'i.nome as idioma',
          'td.nome as tipo',
          'c.nome as categoria',
          'bd.nome as base',
        ),
      db('revisaoChecklistItem').where({ revisaoId }).orderBy('ordem'),
    ]);

  const temas = incluidos.length
    ? await db('documentoTema as dt')
        .join('tema as t', 't.id', 'dt.temaId')
        .whereIn(
          'dt.documentoId',
          incluidos.map((d: any) => d.id),
        )
        .groupBy('t.nome')
        .orderBy('t.nome')
        .select('t.nome')
        .count({ n: '*' })
    : [];

  // exclusões na última etapa de triagem (leitura completa) com motivo, critério e observação
  const triagens = etapas.filter((e: any) => e.exigeTriagem);
  const ultima = triagens.at(-1);
  const excluidosLeitura = ultima
    ? await db('triagemResultado as tr')
        .join('revisaoDocumento as rd', 'rd.id', 'tr.revisaoDocumentoId')
        .join('documento as d', 'd.id', 'rd.documentoId')
        .leftJoin('criterio as c', 'c.id', 'tr.criterioId')
        .where({ 'tr.revisaoEtapaId': ultima.id, 'tr.decisaoFinal': 'EXCLUIDO' })
        .orderBy(['d.autores', 'd.ano'])
        .select(
          'd.autores',
          'd.ano',
          'd.titulo',
          'tr.motivo',
          'c.nome as criterio',
          db.raw(
            `(SELECT td.observacao FROM triagem_decisao td WHERE td.revisao_documento_id = tr.revisao_documento_id
               AND td.revisao_etapa_id = tr.revisao_etapa_id AND TRIM(COALESCE(td.observacao, '')) <> ''
             ORDER BY td.decidido_em DESC LIMIT 1) AS observacao`,
          ),
        )
    : [];

  const auditoria = await db('auditoria as a')
    .leftJoin('usuario as u', 'u.id', 'a.usuarioId')
    .where('a.projetoId', projetoId)
    .whereIn('a.acao', ['CONCLUIR', 'ALTERAR', 'IMPRIMIR'])
    .orderBy('a.criadoEm')
    .limit(500)
    .select('a.criadoEm', 'u.nome as usuario', 'a.entidade', 'a.acao');

  const analises: AnaliseRelatorio[] = [];
  for (const a of await analisesDaRevisao(projetoId, revisaoId))
    analises.push(await dadosAnalise(a));

  const porBase = ((porBaseRaw as any)[0] as any[]).map((b) => ({
    base: b.base,
    consultados: num(b.artigosConsultados),
    importados: num(b.importados),
    duplicados: num(b.duplicados),
  }));
  const porEtapa = ((painelRaw as any)[0] as any[]).map((e) => {
    const selecionados = num(e.selecionados);
    const excluidos = num(e.excluidos);
    const conflitos = num(e.conflitos);
    const semDecisao = num(e.semDecisao);
    const criterio = num(e.excluidosCriterio);
    const duplicados = num(e.excluidosDuplicados);
    const semAcesso = num(e.excluidosSemAcesso);
    return {
      ordem: num(e.etapaOrdem),
      nome: e.etapaNome as string,
      avaliados: selecionados + excluidos + conflitos + semDecisao,
      selecionados,
      excluidos,
      criterio,
      duplicados,
      semAcesso,
      outro: Math.max(0, excluidos - criterio - duplicados - semAcesso),
      conflitos,
      semDecisao,
    };
  });
  const porOrigem = Object.fromEntries(origens.map((o: any) => [o.origem, num(o.n)])) as Record<
    string,
    number
  >;
  const diagrama: DadosDiagrama = await dadosDiagrama(revisaoId);

  // referências: incluídos + documentos citados na matriz de síntese
  const refs = new Map<string, RefRelatorio>();
  for (const d of incluidos as any[]) refs.set(d.id, refDoc(d));
  const citados = [...new Set(analises.flatMap((a) => a.matriz.map((m) => m.documentoId)))].filter(
    (id) => !refs.has(id),
  );
  if (citados.length) {
    for (const d of await db('documento')
      .whereIn('id', citados)
      .select('id', 'titulo', 'autores', 'ano', 'periodico', 'doi', 'link', 'refNbr', 'refApa'))
      refs.set(d.id, refDoc(d));
  }

  return {
    ...base,
    revisao,
    revisaoDados: {
      etapas,
      buscas,
      porBase,
      porOrigem,
      porEtapa,
      exclCriterio: exclCriterio.map((x: any) => ({ ...x, n: num(x.n) })),
      incluidos,
      temas: temas.map((t: any) => ({ nome: t.nome, n: num(t.n) })),
      checklist,
      excluidosLeitura,
      auditoria,
      diagrama,
    },
    analises,
    referencias: [...refs.values()],
  };
}

export type RefRelatorio = { abnt: string; apa: string };

function refDoc(d: any): RefRelatorio {
  const base = {
    titulo: d.titulo,
    autores: d.autores,
    ano: d.ano,
    periodico: d.periodico,
    doi: d.doi,
    link: d.link,
  };
  return {
    abnt: d.refNbr?.trim() || referenciaNbr(base),
    apa: d.refApa?.trim() || referenciaApa(base),
  };
}
