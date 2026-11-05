import type { Request } from 'express';
import { db } from '#database/connection.ts';
import { uuid } from '#utils/tokens.ts';
import { LIMIAR_DUPLICADO, similaridade } from '#utils/normalize.ts';
import { auditar } from '#services/audit.ts';

/**
 * RF28/RN11: duplicado = mesmo DOI, ou título normalizado com similaridade ≥ 0,95 e mesmo ano.
 * O primeiro registro importado é mantido; os demais ficam excluídos com motivo DUPLICADO
 * na etapa de remoção de duplicados (ou na primeira etapa que permite exclusão).
 */
export async function detectarDuplicados(revisaoId: string, req?: Request) {
  const docs = await db('revisaoDocumento as rd')
    .join('documento as d', 'd.id', 'rd.documentoId')
    .where('rd.revisaoId', revisaoId)
    .whereIn('rd.origem', ['BUSCA', 'MANUAL'])
    .whereNull('rd.duplicadoDeId')
    .orderBy([{ column: 'rd.criadoEm' }, { column: 'rd.id' }])
    .select('rd.id', 'rd.situacao', 'd.doi', 'd.ano', 'd.tituloNormalizado');

  const etapa =
    (await db('revisaoEtapa').where({ revisaoId, categoria: 'DEDUPLICACAO' }).orderBy('ordem').first()) ??
    (await db('revisaoEtapa').where({ revisaoId, permiteExclusao: true }).orderBy('ordem').first());

  const mantidos: typeof docs = [];
  const pares: { duplicado: string; original: string; criterio: 'DOI' | 'TITULO' }[] = [];
  const porDoi = new Map<string, string>();
  for (const d of docs) {
    let original: string | undefined;
    let criterio: 'DOI' | 'TITULO' = 'DOI';
    if (d.doi) original = porDoi.get(d.doi);
    if (!original && d.tituloNormalizado) {
      const m = mantidos.find((o: any) => o.ano === d.ano && o.tituloNormalizado && similaridade(o.tituloNormalizado, d.tituloNormalizado) >= LIMIAR_DUPLICADO);
      if (m) {
        original = m.id;
        criterio = 'TITULO';
      }
    }
    if (original) pares.push({ duplicado: d.id, original, criterio });
    else {
      mantidos.push(d);
      if (d.doi) porDoi.set(d.doi, d.id);
    }
  }

  await db.transaction(async (trx) => {
    for (const p of pares) {
      await trx('revisaoDocumento').where({ id: p.duplicado }).update({ duplicadoDeId: p.original, situacao: 'EXCLUIDO' });
      if (etapa && req?.user) {
        await trx('triagemDecisao')
          .insert({ id: uuid(), revisaoDocumentoId: p.duplicado, revisaoEtapaId: etapa.id, revisorId: req.user.id, decisao: 'EXCLUIDO', motivo: 'DUPLICADO', observacao: `Duplicado por ${p.criterio}` })
          .onConflict()
          .merge(['decisao', 'motivo', 'observacao', 'decididoEm']);
        await trx('triagemResultado')
          .insert({ revisaoDocumentoId: p.duplicado, revisaoEtapaId: etapa.id, decisaoFinal: 'EXCLUIDO', motivo: 'DUPLICADO', conflito: false })
          .onConflict()
          .merge(['decisaoFinal', 'motivo', 'conflito']);
      }
    }
    if (pares.length) await auditar({ req, entidade: 'revisao', entidadeId: revisaoId, acao: 'DECIDIR', depois: { duplicados: pares.length } }, trx);
  });

  // atualiza o contador de duplicados por busca
  await db.raw(
    `UPDATE busca b SET qtd_duplicados = (SELECT COUNT(*) FROM revisao_documento rd WHERE rd.busca_id = b.id AND rd.duplicado_de_id IS NOT NULL) WHERE b.revisao_id = ?`,
    [revisaoId],
  );
  return { analisados: docs.length, duplicados: pares.length, pares };
}
