import { db, json, type Trx } from '#database/connection.ts';
import { AppError } from '#utils/AppError.ts';
import { uuid } from '#utils/tokens.ts';
import { limparDoi, normalizarTitulo } from '#utils/normalize.ts';
import { referenciaApa, referenciaNbr } from '#utils/referencias.ts';
import { lerCsv, tabelaParaRegistros, type Registro } from '#jobs/parsers.ts';
import { recalcularSituacao } from './revisoes.service.ts';

/**
 * Importação de CSV por etapa da revisão: uma linha por documento, com a decisão daquela etapa
 * (ex.: triagem feita no Rayyan ou numa planilha). Cada linha:
 * 1. casa com um documento da revisão (DOI ou título normalizado), do projeto, ou cria um novo
 *    (novos entram por uma "busca" de importação da base informada, para o painel contar por base);
 * 2. grava a decisão na etapa (ou, na etapa de inclusão, na última triagem antes dela);
 * 3. marca como selecionado nas triagens anteriores ainda sem decisão — se o documento chegou
 *    a esta etapa, passou pelas anteriores (RN09).
 */

export const CATEGORIAS_IMPORTAVEIS = [
  'BUSCA',
  'DEDUPLICACAO',
  'TRIAGEM',
  'INCLUSAO',
  'LIVRE',
] as const;
export const MAX_LINHAS = 10_000;

function* emLotes<T>(itens: T[], tamanho = 500) {
  for (let i = 0; i < itens.length; i += tamanho) yield itens.slice(i, i + tamanho);
}

type Decisao = {
  decisao: 'SELECIONADO' | 'EXCLUIDO';
  motivo: 'CRITERIO' | 'DUPLICADO' | 'SEM_ACESSO' | 'OUTRO' | null;
  criterio: string | null;
  observacao: string | null;
};
type Linha = Registro & { linha: number; base: string | null; decisao: Decisao | null };
export type Relatorio = {
  linhas: number;
  documentosCriados: number;
  documentosDoProjeto: number;
  documentosDaRevisao: number;
  decisoes: { selecionados: number; excluidos: number; semDecisao: number };
  selecionadosEmEtapasAnteriores: number;
  avisos: { linha: number; mensagem: string }[];
};

const semAcento = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const EXTRAS = {
  decisao: ['decisao', 'decision', 'situacao', 'status', 'resultado'],
  motivo: ['motivo', 'motivo da exclusao', 'reason', 'exclusion reason'],
  criterio: ['criterio', 'criterio de exclusao', 'criterion'],
  observacao: ['observacao', 'observacoes', 'obs', 'notes', 'comentario', 'comentarios'],
  base: ['base', 'base de dados', 'database', 'fonte', 'source'],
};
const SIM = [
  'selecionado',
  'selecionada',
  'incluido',
  'incluida',
  'included',
  'include',
  'selected',
  'sim',
  's',
  'yes',
  'y',
  'aceito',
  'mantido',
];
const NAO = [
  'excluido',
  'excluida',
  'excluded',
  'exclude',
  'rejected',
  'nao',
  'n',
  'no',
  'rejeitado',
  'removido',
];
const MOTIVOS: Record<string, Decisao['motivo']> = {
  criterio: 'CRITERIO',
  'criterio de exclusao': 'CRITERIO',
  criteria: 'CRITERIO',
  duplicado: 'DUPLICADO',
  duplicate: 'DUPLICADO',
  duplicata: 'DUPLICADO',
  'sem acesso': 'SEM_ACESSO',
  sem_acesso: 'SEM_ACESSO',
  'no access': 'SEM_ACESSO',
  'sem texto completo': 'SEM_ACESSO',
  outro: 'OUTRO',
  other: 'OUTRO',
};

/** Lê o CSV: campos do documento (mesmos cabeçalhos da importação de buscas) + decisão, motivo, critério, observação e base */
export function lerCsvDaEtapa(texto: string): { linhas: Linha[]; avisos: Relatorio['avisos'] } {
  const tabela = lerCsv(texto);
  if (tabela.length < 2) throw AppError.unprocessable('O CSV está vazio ou só tem o cabeçalho');
  if (tabela.length - 1 > MAX_LINHAS)
    throw AppError.unprocessable(`O CSV passa de ${MAX_LINHAS} linhas; divida o arquivo`);
  const { registros, erros } = tabelaParaRegistros(tabela);
  if (!registros.length && erros[0]?.linha === 1)
    throw AppError.unprocessable(
      'Coluna de título não encontrada no cabeçalho (use "titulo" ou "title")',
    );
  const cab = tabela[0].map((h) => semAcento(h));
  const col = (k: keyof typeof EXTRAS) => cab.findIndex((h) => EXTRAS[k].includes(h));
  const idx = {
    decisao: col('decisao'),
    motivo: col('motivo'),
    criterio: col('criterio'),
    observacao: col('observacao'),
    base: col('base'),
  };
  const avisos = [...erros];
  // tabelaParaRegistros pula linhas sem título: refaz o mapeamento linha → registro pela ordem
  const linhasComTitulo = tabela
    .slice(1)
    .map((l, i) => ({ l, n: i + 2 }))
    .filter(({ n }) => !erros.some((e) => e.linha === n));
  const linhas: Linha[] = registros.map((r, i) => {
    const { l, n } = linhasComTitulo[i];
    const v = (j: number) => (j >= 0 ? String(l[j] ?? '').trim() || null : null);
    const d = v(idx.decisao);
    let decisao: Decisao | null = null;
    if (d) {
      const s = semAcento(d);
      const motivoTxt = v(idx.motivo);
      const criterio = v(idx.criterio);
      const observacao = v(idx.observacao);
      if (SIM.includes(s))
        decisao = { decisao: 'SELECIONADO', motivo: null, criterio: null, observacao };
      else if (NAO.includes(s)) {
        let motivo = motivoTxt ? (MOTIVOS[semAcento(motivoTxt)] ?? null) : null;
        if (motivoTxt && !motivo)
          avisos.push({
            linha: n,
            mensagem: `motivo "${motivoTxt}" não reconhecido; registrado como OUTRO`,
          });
        motivo ??= criterio ? 'CRITERIO' : 'OUTRO';
        decisao = {
          decisao: 'EXCLUIDO',
          motivo,
          criterio,
          observacao: observacao ?? (motivo === 'OUTRO' ? (motivoTxt ?? 'Importado de CSV') : null),
        };
      } else
        avisos.push({
          linha: n,
          mensagem: `decisão "${d}" não reconhecida (use SELECIONADO ou EXCLUIDO); linha importada sem decisão`,
        });
    }
    return { ...r, linha: n, base: v(idx.base), decisao };
  });
  return { linhas, avisos };
}

/** Documentos por DOI (sem diferenciar maiúsculas) e por título normalizado (RN11) */
class Indice {
  private porDoi = new Map<string, any>();
  private porTitulo = new Map<string, any>();
  constructor(lista: any[]) {
    lista.forEach((x) => this.adicionar(x));
  }
  adicionar(x: { doi?: string | null; tituloNormalizado?: string | null; [k: string]: unknown }) {
    if (x.doi && !this.porDoi.has(x.doi.toLowerCase())) this.porDoi.set(x.doi.toLowerCase(), x);
    if (x.tituloNormalizado && !this.porTitulo.has(x.tituloNormalizado))
      this.porTitulo.set(x.tituloNormalizado, x);
  }
  buscar(doi: string | null, titulo: string) {
    return (
      (doi && this.porDoi.get(doi.toLowerCase())) ||
      (titulo ? this.porTitulo.get(titulo) : undefined)
    );
  }
}

/** Etapa em que a decisão é gravada: a própria; na inclusão, a última triagem antes dela; na busca, nenhuma */
function etapaDaDecisao(etapa: any, etapas: any[]) {
  if (etapa.exigeTriagem || etapa.permiteExclusao) return etapa;
  if (etapa.categoria === 'INCLUSAO')
    return etapas.filter((e) => e.exigeTriagem && e.ordem < etapa.ordem).at(-1) ?? null;
  return null;
}

export async function importarCsvDaEtapa(o: {
  revisaoId: string;
  projetoId: string;
  etapaId: string;
  usuarioId: string;
  nomeArquivo: string;
  texto: string;
  substituir: boolean;
  /** só calcula o relatório e desfaz tudo (pré-visualização) */
  simular?: boolean;
}): Promise<Relatorio & { simulado: boolean }> {
  const { linhas, avisos } = lerCsvDaEtapa(o.texto);
  let simulado: Relatorio | undefined;
  try {
    return await db.transaction(async (trx) => {
      const rel = await importar(trx as Trx, o, linhas, avisos);
      if (o.simular) {
        simulado = rel;
        throw new Error('simulação'); // rollback
      }
      return { ...rel, simulado: false };
    });
  } catch (err) {
    if (simulado) return { ...simulado, simulado: true };
    throw err;
  }
}

async function importar(
  trx: Trx,
  o: Parameters<typeof importarCsvDaEtapa>[0],
  linhas: Linha[],
  avisos: Relatorio['avisos'],
): Promise<Relatorio> {
  {
    const etapas = await trx('revisaoEtapa')
      .where({ revisaoId: o.revisaoId })
      .orderBy('ordem')
      .forUpdate();
    const etapa = etapas.find((e: any) => e.id === o.etapaId);
    if (!etapa) throw AppError.notFound('Etapa');
    if (
      !CATEGORIAS_IMPORTAVEIS.includes(etapa.categoria) ||
      (etapa.categoria === 'LIVRE' && !etapa.exigeTriagem && !etapa.permiteExclusao)
    ) {
      throw AppError.unprocessable(
        'Esta etapa não recebe documentos; importe na busca, deduplicação, triagem ou inclusão',
      );
    }
    if (etapa.status !== 'EM_ANDAMENTO' && etapa.status !== 'CONCLUIDA')
      throw AppError.conflict('Inicie a etapa antes de importar');
    const alvo = etapaDaDecisao(etapa, etapas);
    if (etapa.categoria === 'INCLUSAO' && !alvo)
      avisos.push({
        linha: 1,
        mensagem: 'não há triagem antes da inclusão; as decisões foram ignoradas',
      });
    if (!alvo && etapa.categoria === 'BUSCA' && linhas.some((l) => l.decisao))
      avisos.push({
        linha: 1,
        mensagem:
          'na etapa de busca a coluna de decisão é ignorada; importe as decisões na triagem',
      });
    const anteriores = etapas.filter((e: any) => e.exigeTriagem && alvo && e.ordem < alvo.ordem);

    // ---- documentos: casa por DOI / título com a revisão e o projeto
    const daRevisao = await trx('revisaoDocumento as rd')
      .join('documento as d', 'd.id', 'rd.documentoId')
      .where('rd.revisaoId', o.revisaoId)
      .select('rd.id as rdId', 'd.id', 'd.doi', 'd.tituloNormalizado');
    const doProjeto = await trx('documento')
      .where({ projetoId: o.projetoId })
      .select('id', 'doi', 'tituloNormalizado');
    const naRevisao = new Indice(daRevisao);
    const noProjeto = new Indice(doProjeto);

    const bases = await trx('baseDados').select('id', 'nome', 'sigla');
    const baseDe = (nome: string | null) => {
      const s = nome ? semAcento(nome) : '';
      return (
        bases.find((b: any) => s && (semAcento(b.nome) === s || semAcento(b.sigla ?? '') === s)) ??
        bases.find((b: any) => b.sigla === 'OUTRA') ??
        bases[0]
      );
    };
    const etapaBusca = etapas.find((e: any) => e.categoria === 'BUSCA');
    const buscas = new Map<string, { id: string; novos: number; total: number }>();
    const buscaDa = async (base: any) => {
      let b = buscas.get(base.id);
      if (!b) {
        b = { id: uuid(), novos: 0, total: 0 };
        buscas.set(base.id, b);
        await trx('busca').insert({
          id: b.id,
          revisaoId: o.revisaoId,
          revisaoEtapaId: etapaBusca?.id ?? null,
          baseDadosId: base.id,
          expressaoUsada: `Importação CSV na etapa "${etapa.nome}" (${o.nomeArquivo})`.slice(
            0,
            10_000,
          ),
          dataBusca: new Date().toISOString().slice(0, 10),
          statusImportacao: 'CONCLUIDA',
          criadoPor: o.usuarioId,
        });
      }
      return b;
    };

    const tipos = Object.fromEntries(
      (await trx('tipoDocumento').select('id', 'nome')).map((x: any) => [x.nome, x.id]),
    );
    const rel: Relatorio = {
      linhas: linhas.length,
      documentosCriados: 0,
      documentosDoProjeto: 0,
      documentosDaRevisao: 0,
      decisoes: { selecionados: 0, excluidos: 0, semDecisao: 0 },
      selecionadosEmEtapasAnteriores: 0,
      avisos,
    };
    const porRd = new Map<string, Linha>(); // última linha de cada documento (linhas repetidas: vale a última)
    const novosDocs: Record<string, unknown>[] = [];
    const novosRds: Record<string, unknown>[] = [];
    for (const l of linhas) {
      const doi = limparDoi(l.doi);
      const tituloNormalizado = normalizarTitulo(l.titulo);
      let rdId: string | undefined = naRevisao.buscar(doi, tituloNormalizado)?.rdId;
      if (rdId) rel.documentosDaRevisao++;
      else {
        const base = baseDe(l.base);
        const busca = await buscaDa(base);
        let documentoId = noProjeto.buscar(doi, tituloNormalizado)?.id as string | undefined;
        if (documentoId) rel.documentosDoProjeto++;
        else {
          documentoId = uuid();
          const campos = {
            titulo: l.titulo.slice(0, 5000),
            autores: l.autores,
            ano: l.ano,
            periodico: l.periodico?.slice(0, 300) ?? null,
            doi: doi && doi.length <= 255 ? doi : null,
            link: l.link && l.link.length <= 1000 ? l.link : null,
          };
          novosDocs.push({
            id: documentoId,
            projetoId: o.projetoId,
            ...campos,
            tituloNormalizado,
            resumo: l.resumo,
            palavrasChave: l.palavrasChave,
            citacoes: l.citacoes ?? null,
            tipoDocumentoId: (l.tipo && tipos[l.tipo]) || null,
            baseDadosId: base.id,
            refNbr: referenciaNbr(campos),
            refApa: referenciaApa(campos),
            dadosOriginais: json(l.bruto),
            criadoPor: o.usuarioId,
          });
          rel.documentosCriados++;
          busca.novos++;
        }
        rdId = uuid();
        novosRds.push({
          id: rdId,
          revisaoId: o.revisaoId,
          documentoId,
          buscaId: busca.id,
          origem: 'BUSCA',
          situacao: 'EM_TRIAGEM',
        });
        busca.total++;
        // linhas seguintes com o mesmo documento caem no mesmo registro
        naRevisao.adicionar({ rdId, id: documentoId, doi, tituloNormalizado });
        noProjeto.adicionar({ id: documentoId, doi, tituloNormalizado });
      }
      porRd.set(rdId!, l);
    }
    for (const lote of emLotes(novosDocs)) await trx('documento').insert(lote);
    for (const lote of emLotes(novosRds)) await trx('revisaoDocumento').insert(lote);
    for (const [baseId, b] of buscas) {
      await trx('busca')
        .where({ id: b.id })
        .update({
          qtdRetornada: b.total,
          qtdImportada: b.novos,
          logImportacao: json({ origem: 'csv-etapa', etapaId: etapa.id, baseId }),
        });
    }

    // ---- decisões
    const rdIds = [...porRd.keys()];
    if (alvo) {
      if (o.substituir) {
        await trx('triagemDecisao').where({ revisaoEtapaId: alvo.id }).del();
        const antigos = (
          await trx('triagemResultado')
            .where({ revisaoEtapaId: alvo.id })
            .select('revisaoDocumentoId')
        ).map((r: any) => r.revisaoDocumentoId);
        await trx('triagemResultado').where({ revisaoEtapaId: alvo.id }).del();
        rdIds.push(...antigos.filter((id: string) => !porRd.has(id)));
      }
      const criterios = await trx('criterio as c')
        .join('protocolo as p', 'p.id', 'c.protocoloId')
        .where({ 'p.projetoId': o.projetoId, 'c.tipo': 'EXCLUSAO' })
        .select('c.id', 'c.nome');
      const criterioId = (nome: string | null) =>
        nome
          ? (criterios.find((c: any) => semAcento(c.nome) === semAcento(nome))?.id ?? null)
          : null;
      // resultados já gravados nas etapas anteriores (RN09 e triagens que faltam completar)
      const existentes = new Map<string, Map<string, string | null>>(); // rdId → etapaId → decisão
      for (const lote of emLotes([...porRd.keys()])) {
        const rs = await trx('triagemResultado as tr')
          .join('revisaoEtapa as e', 'e.id', 'tr.revisaoEtapaId')
          .where('e.revisaoId', o.revisaoId)
          .where('e.ordem', '<', alvo.ordem)
          .whereIn('tr.revisaoDocumentoId', lote)
          .select('tr.revisaoDocumentoId', 'tr.revisaoEtapaId', 'tr.decisaoFinal');
        for (const r of rs) {
          if (!existentes.has(r.revisaoDocumentoId))
            existentes.set(r.revisaoDocumentoId, new Map());
          existentes.get(r.revisaoDocumentoId)!.set(r.revisaoEtapaId, r.decisaoFinal);
        }
      }
      const selecionarAntes: Record<string, unknown>[] = [];
      const decisoes: Record<string, unknown>[] = [];
      const resultados: Record<string, unknown>[] = [];
      const desfazer: string[] = [];
      const agora = new Date();
      for (const [rdId, l] of porRd) {
        const antes = existentes.get(rdId);
        if (antes && [...antes.values()].includes('EXCLUIDO')) {
          avisos.push({
            linha: l.linha,
            mensagem:
              'documento excluído numa etapa anterior; decisão ignorada (corrija a etapa anterior)',
          });
          continue;
        }
        // passou pelas triagens anteriores
        for (const e of anteriores) {
          if (!antes?.has(e.id))
            selecionarAntes.push({
              revisaoDocumentoId: rdId,
              revisaoEtapaId: e.id,
              decisaoFinal: 'SELECIONADO',
              conflito: false,
            });
        }
        // na inclusão, a linha sem decisão significa "incluído"
        const d =
          l.decisao ??
          (etapa.categoria === 'INCLUSAO'
            ? { decisao: 'SELECIONADO' as const, motivo: null, criterio: null, observacao: null }
            : null);
        if (!d) {
          rel.decisoes.semDecisao++;
          continue;
        }
        if (d.decisao === 'SELECIONADO') rel.decisoes.selecionados++;
        else rel.decisoes.excluidos++;
        if (!alvo.exigeTriagem && d.decisao === 'SELECIONADO') {
          desfazer.push(rdId); // etapa que só exclui (ex.: duplicados): selecionado = sem exclusão
          continue;
        }
        const cId = d.motivo === 'CRITERIO' ? criterioId(d.criterio) : null;
        if (d.motivo === 'CRITERIO' && d.criterio && !cId)
          avisos.push({
            linha: l.linha,
            mensagem: `critério "${d.criterio}" não está entre os critérios de exclusão do protocolo`,
          });
        decisoes.push({
          id: uuid(),
          revisaoDocumentoId: rdId,
          revisaoEtapaId: alvo.id,
          revisorId: o.usuarioId,
          decisao: d.decisao,
          motivo: d.motivo,
          criterioId: cId,
          observacao: d.observacao,
          decididoEm: agora,
        });
        // a importação vale como decisão final (sem conflito entre revisores)
        resultados.push({
          revisaoDocumentoId: rdId,
          revisaoEtapaId: alvo.id,
          decisaoFinal: d.decisao,
          motivo: d.motivo,
          criterioId: cId,
          conflito: false,
          resolvidoPor: null,
          resolvidoEm: null,
        });
      }
      for (const lote of emLotes(selecionarAntes)) await trx('triagemResultado').insert(lote);
      rel.selecionadosEmEtapasAnteriores = selecionarAntes.length;
      for (const lote of emLotes(desfazer)) {
        await trx('triagemDecisao')
          .where({ revisaoEtapaId: alvo.id })
          .whereIn('revisaoDocumentoId', lote)
          .del();
        await trx('triagemResultado')
          .where({ revisaoEtapaId: alvo.id })
          .whereIn('revisaoDocumentoId', lote)
          .del();
      }
      for (const lote of emLotes(decisoes))
        await trx('triagemDecisao')
          .insert(lote)
          .onConflict()
          .merge(['decisao', 'motivo', 'criterioId', 'observacao', 'decididoEm']);
      for (const lote of emLotes(resultados))
        await trx('triagemResultado')
          .insert(lote)
          .onConflict()
          .merge([
            'decisaoFinal',
            'motivo',
            'criterioId',
            'conflito',
            'resolvidoPor',
            'resolvidoEm',
          ]);
    } else rel.decisoes.semDecisao = porRd.size;

    await recalcularSituacao(trx, o.revisaoId, [...new Set(rdIds)]);
    return rel;
  }
}
