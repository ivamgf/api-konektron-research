import type { Trx } from '#database/connection.ts';
import { AppError } from '#utils/AppError.ts';

// As colunas "ordem" têm UNIQUE e o MySQL confere linha a linha (RN19):
// primeiro desloca todas para uma faixa temporária, depois grava a ordem final.
const DESLOCAMENTO = 10_000;

export async function reordenar(trx: Trx, table: string, where: Record<string, unknown>, ids: string[], inicio = 1) {
  const atuais: string[] = (await trx(table).where(where).select('id')).map((r: any) => r.id);
  const faltando = atuais.filter((id) => !ids.includes(id));
  const extras = ids.filter((id) => !atuais.includes(id));
  if (faltando.length || extras.length) {
    throw AppError.unprocessable('A lista de ids deve conter exatamente os itens atuais', { faltando, extras });
  }
  await trx(table).where(where).update({ ordem: trx.raw('ordem + ?', [DESLOCAMENTO]) });
  for (const [i, id] of ids.entries()) await trx(table).where({ ...where, id }).update({ ordem: inicio + i });
}

export async function proximaOrdem(trx: Trx, table: string, where: Record<string, unknown>) {
  const row = await trx(table).where(where).max({ max: 'ordem' }).first();
  return (row?.max ?? 0) + 1;
}

/** Remove um item e fecha o buraco na sequência */
export async function compactar(trx: Trx, table: string, where: Record<string, unknown>) {
  const ids: string[] = (await trx(table).where(where).orderBy('ordem').select('id')).map((r: any) => r.id);
  await trx(table).where(where).update({ ordem: trx.raw('ordem + ?', [DESLOCAMENTO]) });
  for (const [i, id] of ids.entries()) await trx(table).where({ ...where, id }).update({ ordem: i + 1 });
}
