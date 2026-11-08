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
  // só os resultados de documentos elegíveis (resultados de documentos que saíram da etapa não contam)
  const r = await db('triagemResultado as r')
    .where('r.revisaoEtapaId', etapa.id)
    .whereIn('r.revisaoDocumentoId', elegiveis(etapa).select('rd.id'))
    .select(
      db.raw("SUM(r.decisao_final = 'SELECIONADO') AS selecionados"),
      db.raw("SUM(r.decisao_final = 'EXCLUIDO') AS excluidos"),
      db.raw('SUM(r.conflito = 1) AS conflitos'),
      db.raw('SUM(r.decisao_final IS NULL AND r.conflito = 0) AS aguardando'),
    )
    .first();
  const selecionados = Number(r?.selecionados ?? 0);
  const excluidos = Number(r?.excluidos ?? 0);
  return {
    total,
    selecionados,
    excluidos,
    conflitos: Number(r?.conflitos ?? 0),
    /** com decisão de um revisor, esperando a do segundo (revisão com dois revisores) */
    aguardandoRevisor: Number(r?.aguardando ?? 0),
    semDecisao: Math.max(0, total - selecionados - excluidos),
  };
}

/**
 * RN12: a revisão com dois revisores só exige a segunda decisão quando o projeto tem ao menos
 * dois membros que decidem (responsável/colaborador); com um só, a decisão dele é a final.
 */
export async function exigeDoisRevisores(trx: Trx | typeof db, etapa: { doisRevisores?: boolean; exigeTriagem?: boolean; projetoId: string }) {
  if (!etapa.doisRevisores || !etapa.exigeTriagem) return false;
  const r = await trx('projetoMembro')
    .where({ projetoId: etapa.projetoId })
    .whereNotNull('aceitoEm')
    .whereIn('papel', ['RESPONSAVEL', 'COLABORADOR'])
    .count({ n: '*' })
    .first();
  return Number(r?.n ?? 0) >= 2;
}

/**
 * Consolida as decisões dos revisores no resultado da etapa (RN12), em lote. Documentos sem
 * decisão ficam como estão (ex.: "selecionado" implícito de importação); desempates do
 * orientador prevalecem. Devolve os documentos que passaram a ter conflito.
 */
export async function consolidarDecisoes(
  trx: Trx,
  etapa: { id: string; revisaoId: string; projetoId: string; doisRevisores?: boolean; exigeTriagem?: boolean },
  rdIds: string[],
) {
  const dois = await exigeDoisRevisores(trx, etapa);
  const novosConflitos: string[] = [];
  for (let i = 0; i < rdIds.length; i += 500) {
    const lote = rdIds.slice(i, i + 500);
    const decisoes = await trx('triagemDecisao').where({ revisaoEtapaId: etapa.id }).whereIn('revisaoDocumentoId', lote).orderBy('decididoEm');
    const atuais = new Map(
      (await trx('triagemResultado').where({ revisaoEtapaId: etapa.id }).whereIn('revisaoDocumentoId', lote)).map((r: any) => [r.revisaoDocumentoId, r]),
    );
    const porRd = new Map<string, any[]>();
    for (const d of decisoes) porRd.set(d.revisaoDocumentoId, [...(porRd.get(d.revisaoDocumentoId) ?? []), d]);
    const gravar: Record<string, unknown>[] = [];
    for (const id of lote) {
      const ds = porRd.get(id);
      const atual = atuais.get(id);
      if (!ds?.length || atual?.resolvidoPor) continue;
      let r: { decisaoFinal: string | null; motivo: string | null; criterioId: string | null; conflito: boolean };
      if (dois && ds.length < 2) r = { decisaoFinal: null, motivo: null, criterioId: null, conflito: false };
      else if (dois) {
        const [a, b] = ds.slice(-2);
        r = a.decisao === b.decisao
          ? { decisaoFinal: b.decisao, motivo: b.motivo, criterioId: b.criterioId, conflito: false }
          : { decisaoFinal: null, motivo: null, criterioId: null, conflito: true };
      } else {
        const u = ds.at(-1);
        r = { decisaoFinal: u.decisao, motivo: u.motivo, criterioId: u.criterioId, conflito: false };
      }
      if (r.conflito && !atual?.conflito) novosConflitos.push(id);
      gravar.push({ revisaoDocumentoId: id, revisaoEtapaId: etapa.id, ...r });
    }
    if (gravar.length) await trx('triagemResultado').insert(gravar).onConflict().merge(['decisaoFinal', 'motivo', 'criterioId', 'conflito']);
  }
  await recalcularSituacao(trx, etapa.revisaoId, rdIds);
  return { novosConflitos };
}

/** Reaplica a consolidação em todas as triagens da revisão (ex.: depois de ligar/desligar os dois revisores) */
export async function reconsolidarRevisao(trx: Trx, revisaoId: string) {
  const r = await trx('revisao').where({ id: revisaoId }).first('projetoId', 'doisRevisores');
  const etapas = await trx('revisaoEtapa').where({ revisaoId }).where((w: any) => w.where('exigeTriagem', true).orWhere('permiteExclusao', true));
  for (const e of etapas) {
    const ids = (await trx('triagemDecisao').where({ revisaoEtapaId: e.id }).distinct('revisaoDocumentoId')).map((x: any) => x.revisaoDocumentoId);
    if (ids.length) await consolidarDecisoes(trx, { ...e, projetoId: r.projetoId, doisRevisores: !!r.doisRevisores }, ids);
  }
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

/**
 * Recalcula a situação dos documentos depois de decisões (triagem, importação, edição em etapa concluída):
 * excluído em alguma etapa → EXCLUIDO; com a inclusão já concluída e selecionado na última triagem
 * antes dela → INCLUIDO; senão EM_TRIAGEM. Duplicados (duplicadoDeId) e origens que entram
 * direto como incluídas (revisão anterior, integrados) não mudam.
 */
export async function recalcularSituacao(trx: Trx, revisaoId: string, rdIds: string[]) {
  if (!rdIds.length) return;
  const inclusao = await trx('revisaoEtapa').where({ revisaoId, categoria: 'INCLUSAO' }).orderBy('ordem').first();
  const ultimaTriagem = inclusao?.status === 'CONCLUIDA'
    ? await trx('revisaoEtapa').where({ revisaoId, exigeTriagem: true }).where('ordem', '<', inclusao.ordem).orderBy('ordem', 'desc').first('id')
    : null;
  for (let i = 0; i < rdIds.length; i += 500) {
    const lote = rdIds.slice(i, i + 500);
    const rds = await trx('revisaoDocumento').where({ revisaoId }).whereIn('id', lote).whereIn('origem', ['BUSCA', 'MANUAL']).select('id', 'situacao', 'duplicadoDeId');
    const excluidos = new Set((await trx('triagemResultado').whereIn('revisaoDocumentoId', lote).where({ decisaoFinal: 'EXCLUIDO' }).select('revisaoDocumentoId')).map((r: any) => r.revisaoDocumentoId));
    const selecionados = ultimaTriagem
      ? new Set((await trx('triagemResultado').whereIn('revisaoDocumentoId', lote).where({ revisaoEtapaId: ultimaTriagem.id, decisaoFinal: 'SELECIONADO' }).select('revisaoDocumentoId')).map((r: any) => r.revisaoDocumentoId))
      : new Set<string>();
    const alvo: Record<string, string[]> = { EXCLUIDO: [], INCLUIDO: [], EM_TRIAGEM: [] };
    for (const rd of rds) {
      if (rd.duplicadoDeId && rd.situacao === 'EXCLUIDO') continue;
      const s = excluidos.has(rd.id) ? 'EXCLUIDO' : selecionados.has(rd.id) ? 'INCLUIDO' : 'EM_TRIAGEM';
      if (s !== rd.situacao) alvo[s].push(rd.id);
    }
    for (const [situacao, ids] of Object.entries(alvo)) if (ids.length) await trx('revisaoDocumento').whereIn('id', ids).update({ situacao });
  }
}

/**
 * Resultados "aguardando o 2º revisor" que não deveriam esperar (revisão passou a um revisor, ou o
 * projeto só tem um membro que decide): a decisão já registrada vira a final. Devolve se mudou algo.
 */
export async function resolverAguardando(etapa: { id: string; revisaoId: string; projetoId: string; doisRevisores?: boolean; exigeTriagem?: boolean }) {
  const ids: string[] = await db('triagemResultado').where({ revisaoEtapaId: etapa.id, conflito: false }).whereNull('decisaoFinal').pluck('revisaoDocumentoId');
  if (!ids.length || (await exigeDoisRevisores(db, etapa))) return false;
  await db.transaction((trx) => consolidarDecisoes(trx, etapa, ids));
  return true;
}
