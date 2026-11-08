import crypto from 'node:crypto';
import { db, type Trx } from '#database/connection.ts';
import { uuid } from '#utils/tokens.ts';
import { storage } from '#services/storage/index.ts';

// Grava o conteúdo no storage e os metadados na tabela arquivo (RN18)
export async function salvarArquivo(
  o: { projetoId: string | null; chave: string; nomeOriginal: string; mimeType: string; dados: Buffer; criadoPor?: string | null },
  trx?: Trx,
) {
  const st = storage();
  await st.put(o.chave, o.dados, o.mimeType);
  const id = uuid();
  await (trx ?? db)('arquivo').insert({
    id,
    projetoId: o.projetoId,
    provedor: st.provedor,
    chaveStorage: o.chave,
    nomeOriginal: o.nomeOriginal.slice(0, 255),
    mimeType: o.mimeType.slice(0, 100),
    tamanhoBytes: o.dados.length,
    hashSha256: crypto.createHash('sha256').update(o.dados).digest('hex'),
    criadoPor: o.criadoPor ?? null,
  });
  return id;
}

export async function urlDoArquivo(arquivoId: string) {
  const a = await db('arquivo').where({ id: arquivoId }).first();
  if (!a) return null;
  return { url: await storage().urlAssinada(a.chaveStorage, 15, a.nomeOriginal, a.mimeType), arquivo: a };
}

export async function lerArquivo(arquivoId: string) {
  const a = await db('arquivo').where({ id: arquivoId }).first();
  if (!a) throw new Error(`arquivo ${arquivoId} não encontrado`);
  return { dados: await storage().get(a.chaveStorage), arquivo: a };
}
