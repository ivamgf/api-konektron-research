import { db, json, type Trx } from '#database/connection.ts';
import { uuid } from '#utils/tokens.ts';

export async function notificar(
  usuarioIds: string[],
  tipo: string,
  titulo: string,
  dados: Record<string, unknown> = {},
  trx?: Trx,
) {
  const ids = [...new Set(usuarioIds)].filter(Boolean);
  if (!ids.length) return;
  await (trx ?? db)('notificacao').insert(
    ids.map((usuarioId) => ({ id: uuid(), usuarioId, tipo, titulo: titulo.slice(0, 200), dados: json(dados) })),
  );
}

export async function membrosDoProjeto(projetoId: string, papeis?: string[], trx?: Trx) {
  const q = (trx ?? db)('projetoMembro').where({ projetoId }).whereNotNull('aceitoEm');
  if (papeis) q.whereIn('papel', papeis);
  return (await q.select('usuarioId')).map((r: any) => r.usuarioId as string);
}
