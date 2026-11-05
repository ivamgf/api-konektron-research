import type { Request } from 'express';
import { db, type Trx } from '#database/connection.ts';
import { AppError } from '#utils/AppError.ts';

// RN06: sistemático se ele ou algum ancestral tiver a marca
export async function eSistematico(tipoId: string, trx?: Trx): Promise<boolean> {
  let id: string | null = tipoId;
  for (let i = 0; id && i < 50; i++) {
    const t: any = await (trx ?? db)('tipoRevisao').where({ id }).first('tipoPaiId', 'sistematica');
    if (!t) return false;
    if (t.sistematica) return true;
    id = t.tipoPaiId;
  }
  return false;
}

// Impede ciclos na hierarquia (o novo pai não pode descender do próprio tipo)
export async function conferirCiclo(tipoId: string, novoPaiId: string | null | undefined, trx?: Trx) {
  let id: string | null | undefined = novoPaiId;
  for (let i = 0; id && i < 50; i++) {
    if (id === tipoId) throw AppError.unprocessable('A hierarquia de tipos de revisão ficaria com ciclo');
    const t: any = await (trx ?? db)('tipoRevisao').where({ id }).first('tipoPaiId');
    id = t?.tipoPaiId;
  }
}

// Global: só o administrador. Do projeto: responsável ou colaborador do projeto.
export async function conferirEscrita(req: Request, projetoId: string | null | undefined) {
  if (req.user?.perfil === 'ADMIN') return;
  if (!projetoId) throw AppError.forbidden('Só o administrador altera tipos de revisão globais');
  const m = await db('projetoMembro')
    .where({ projetoId, usuarioId: req.user!.id })
    .whereIn('papel', ['RESPONSAVEL', 'COLABORADOR'])
    .whereNotNull('aceitoEm')
    .first('papel');
  if (!m) throw AppError.forbidden('Seu papel no projeto não permite esta ação');
}

export async function conferirLeitura(req: Request, projetoId: string | null | undefined) {
  if (!projetoId || req.user?.perfil === 'ADMIN') return;
  const m = await db('projetoMembro').where({ projetoId, usuarioId: req.user!.id }).whereNotNull('aceitoEm').first('papel');
  if (!m) throw AppError.notFound('Tipo de revisão');
}

/** Copia as etapas de um tipo para outro (RN07: a cópia é feita no momento da criação) */
export async function copiarEtapas(trx: Trx, deTipoId: string, paraTipoId: string, novoId: () => string) {
  const etapas = await trx('etapaModelo').where({ tipoRevisaoId: deTipoId }).orderBy('ordem');
  if (!etapas.length) return;
  await trx('etapaModelo').insert(
    etapas.map((e: any) => ({
      id: novoId(),
      tipoRevisaoId: paraTipoId,
      ordem: e.ordem,
      nome: e.nome,
      descricao: e.descricao,
      categoria: e.categoria,
      exigeTriagem: e.exigeTriagem,
      permiteExclusao: e.permiteExclusao,
      motivosSugeridos: JSON.stringify(e.motivosSugeridos ?? []),
    })),
  );
}
