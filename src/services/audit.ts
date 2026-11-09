import type { Request } from 'express';
import { db, json, type Trx } from '#database/connection.ts';
import { logger } from '#utils/logger.ts';

type Acao = 'CRIAR' | 'ALTERAR' | 'EXCLUIR' | 'DECIDIR' | 'CONCLUIR' | 'IMPRIMIR' | 'APROVAR' | 'DEVOLVER' | 'LOGIN' | 'USAR_IA';

// RF44: trilha de auditoria. Dentro de uma transação, grava junto; fora dela, nunca derruba a requisição.
export async function auditar(
  a: {
    req?: Request;
    projetoId?: string | null;
    entidade: string;
    entidadeId?: string | null;
    acao: Acao;
    antes?: unknown;
    depois?: unknown;
  },
  trx?: Trx,
) {
  const row = {
    projetoId: a.projetoId ?? (a.req?.projeto?.id as string | undefined) ?? null,
    usuarioId: a.req?.user?.id ?? null,
    entidade: a.entidade,
    entidadeId: a.entidadeId ?? null,
    acao: a.acao,
    dadosAntes: json(a.antes ?? null),
    dadosDepois: json(a.depois ?? null),
    ip: a.req?.ip?.slice(0, 45) ?? null,
  };
  if (trx) return trx('auditoria').insert(row);
  try {
    await db('auditoria').insert(row);
  } catch (err) {
    logger.error({ err }, 'Falha ao gravar auditoria');
  }
}
