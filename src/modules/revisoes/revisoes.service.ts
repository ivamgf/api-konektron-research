import { db, type Trx } from '#database/connection.ts';
import { AppError } from '#utils/AppError.ts';
import { uuid } from '#utils/tokens.ts';

export async function revisaoDoProjeto(revisaoId: string, projetoId: string, trx?: Trx) {
  const r = await (trx ?? db)('revisao').where({ id: revisaoId, projetoId }).first();
  if (!r) throw AppError.notFound('Revisão');
  return r;
}

export async function etapaComRevisao(etapaId: string, trx?: Trx) {
  const e = await (trx ?? db)('revisaoEtapa as e')
    .join('revisao as r', 'r.id', 'e.revisaoId')
    .where('e.id', etapaId)
    .first('e.*', 'r.projetoId', 'r.doisRevisores', 'r.status as revisaoStatus');
  if (!e) throw AppError.notFound('Etapa');
  return e;
}

/** RN08: copia as etapas do tipo (ou as ajustadas pelo usuário) para a revisão */
export async function instanciarEtapas(
  trx: Trx,
  revisaoId: string,
  tipoRevisaoId: string,
  ajustadas?: { etapaModeloId?: string | null; nome: string; categoria: string; exigeTriagem?: boolean; permiteExclusao?: boolean }[],
) {
  await trx('revisaoEtapa').where({ revisaoId }).del();
  const fonte =
    ajustadas ??
    (await trx('etapaModelo').where({ tipoRevisaoId }).orderBy('ordem')).map((e: any) => ({
      etapaModeloId: e.id,
      nome: e.nome,
      categoria: e.categoria,
      exigeTriagem: e.exigeTriagem,
      permiteExclusao: e.permiteExclusao,
    }));
  if (!fonte.length) throw AppError.unprocessable('O tipo de revisão não tem etapas');
  const linhas = fonte.map((e, i) => ({
    id: uuid(),
    revisaoId,
    etapaModeloId: e.etapaModeloId ?? null,
    ordem: i + 1,
    nome: e.nome,
    categoria: e.categoria,
    exigeTriagem: !!e.exigeTriagem,
    permiteExclusao: !!e.permiteExclusao,
  }));
  await trx('revisaoEtapa').insert(linhas);
  return linhas;
}

/** Copia os itens do checklist genérico para a revisão (UC06 passo 5) */
export async function copiarChecklist(trx: Trx, revisaoId: string, checklistModeloId: string | null) {
  await trx('revisaoChecklistItem').where({ revisaoId }).del();
  if (!checklistModeloId) return;
  const itens = await trx('checklistItemModelo').where({ checklistModeloId }).orderBy('ordem');
  if (itens.length) {
    await trx('revisaoChecklistItem').insert(
      itens.map((i: any) => ({ id: uuid(), revisaoId, checklistItemModeloId: i.id, codigo: i.codigo, secao: i.secao, ordem: i.ordem, descricao: i.descricao })),
    );
  }
}

/**
 * RN09: documentos que podem ser decididos numa etapa — vindos de busca ou cadastro manual,
 * sem exclusão em etapa anterior e selecionados na etapa de triagem imediatamente anterior.
 */
export function elegiveis(etapa: { id: string; revisaoId: string; ordem: number }, q: Trx | typeof db = db) {
  const anterior = q('revisaoEtapa')
    .where({ revisaoId: etapa.revisaoId, exigeTriagem: true })
    .where('ordem', '<', etapa.ordem)
    .max({ m: 'ordem' });
  return q('revisaoDocumento as rd')
    .where('rd.revisaoId', etapa.revisaoId)
    .whereIn('rd.origem', ['BUSCA', 'MANUAL'])
    .whereNotExists(
      q('triagemResultado as tr')
        .join('revisaoEtapa as e2', 'e2.id', 'tr.revisaoEtapaId')
        .whereRaw('tr.revisao_documento_id = rd.id')
        .where('e2.ordem', '<', etapa.ordem)
        .where('tr.decisaoFinal', 'EXCLUIDO'),
    )
    .where((w: any) =>
      w.whereRaw('(?) IS NULL', [anterior]).orWhereExists(
        q('triagemResultado as tp')
          .join('revisaoEtapa as ep', 'ep.id', 'tp.revisaoEtapaId')
          .whereRaw('tp.revisao_documento_id = rd.id')
          .where('ep.revisaoId', etapa.revisaoId)
          .whereRaw('ep.ordem = (?)', [anterior])
          .where('tp.decisaoFinal', 'SELECIONADO'),
      ),
    );
}

export async function contagensEtapa(etapa: { id: string; revisaoId: string; ordem: number }) {
  const total = Number((await elegiveis(etapa).count({ n: '*' }).first())?.n ?? 0);
  const r = await db('triagemResultado')
    .where({ revisaoEtapaId: etapa.id })
    .select(
      db.raw("SUM(decisao_final = 'SELECIONADO') AS selecionados"),
      db.raw("SUM(decisao_final = 'EXCLUIDO') AS excluidos"),
      db.raw('SUM(conflito = 1) AS conflitos'),
    )
    .first();
  const selecionados = Number(r?.selecionados ?? 0);
  const excluidos = Number(r?.excluidos ?? 0);
  return { total, selecionados, excluidos, conflitos: Number(r?.conflitos ?? 0), semDecisao: Math.max(0, total - selecionados - excluidos) };
}

// RN13: totais do painel
export async function painel(revisaoId: string) {
  const [porEtapa] = (await db.raw('SELECT * FROM vw_painel_etapas WHERE revisao_id = ? ORDER BY etapa_ordem, base', [revisaoId])) as any;
  const [porBase] = (await db.raw('SELECT * FROM vw_consultados_por_base WHERE revisao_id = ? ORDER BY base', [revisaoId])) as any;
  const triagens = await db('revisaoEtapa').where({ revisaoId, exigeTriagem: true }).orderBy('ordem');
  const ultima = triagens.at(-1);
  const excluidosPorEtapa = await db('triagemResultado as tr')
    .join('revisaoEtapa as e', 'e.id', 'tr.revisaoEtapaId')
    .where('e.revisaoId', revisaoId)
    .where('tr.decisaoFinal', 'EXCLUIDO')
    .groupBy('e.id', 'e.ordem', 'e.nome', 'tr.motivo')
    .orderBy('e.ordem')
    .select('e.id as etapaId', 'e.ordem', 'e.nome', 'tr.motivo')
    .count({ n: '*' });
  const selecionadosUltima = ultima
    ? Number((await db('triagemResultado').where({ revisaoEtapaId: ultima.id, decisaoFinal: 'SELECIONADO' }).count({ n: '*' }).first())?.n ?? 0)
    : 0;
  const outrasOrigens = await db('revisaoDocumento').where({ revisaoId }).whereIn('origem', ['REVISAO_ANTERIOR', 'INTEGRADO']).groupBy('origem').select('origem').count({ n: '*' });
  const porOrigem = Object.fromEntries(outrasOrigens.map((o: any) => [o.origem, Number(o.n)]));
  const totalExcluidosTriagem = excluidosPorEtapa
    .filter((x: any) => triagens.some((t: any) => t.id === x.etapaId))
    .reduce((s: number, x: any) => s + Number(x.n), 0);
  return {
    porEtapa,
    porBase,
    excluidosPorEtapa: excluidosPorEtapa.map((x: any) => ({ ...x, n: Number(x.n) })),
    totais: {
      consultados: porBase.reduce((s: number, b: any) => s + Number(b.artigos_consultados ?? b.artigosConsultados ?? 0), 0),
      importados: porBase.reduce((s: number, b: any) => s + Number(b.importados ?? 0), 0),
      duplicados: Number(
        (await db('revisaoDocumento').where({ revisaoId }).whereNotNull('duplicadoDeId').count({ n: '*' }).first())?.n ?? 0,
      ),
      excluidos: totalExcluidosTriagem,
      selecionadosUltimaTriagem: selecionadosUltima,
      revisaoAnterior: porOrigem.REVISAO_ANTERIOR ?? 0,
      integrados: porOrigem.INTEGRADO ?? 0,
      incluidos: selecionadosUltima + (porOrigem.REVISAO_ANTERIOR ?? 0) + (porOrigem.INTEGRADO ?? 0),
    },
  };
}
