import jwt from 'jsonwebtoken';
import { env } from '#config/env.ts';

/**
 * Link de download pela própria API (GET /arquivos/download?token=...), válido por `minutos`
 * (RN18: 15 min). Usado pelos drivers que não têm URL assinada própria (local e FTP).
 */
export function urlDeDownload(chave: string, minutos = 15, nomeArquivo?: string) {
  const token = jwt.sign({ k: chave, n: nomeArquivo }, env.JWT_SECRET, { expiresIn: `${minutos}m` });
  return `${env.API_URL}/api/v1/arquivos/download?token=${encodeURIComponent(token)}`;
}

export function lerTokenDeDownload(token: string) {
  return jwt.verify(token, env.JWT_SECRET) as { k: string; n?: string };
}
