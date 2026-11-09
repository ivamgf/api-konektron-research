import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '#config/env.ts';
import type { StorageProvider } from './index.ts';
import { lerTokenDeDownload, urlDeDownload } from './assinatura.ts';

// Disco local: só para desenvolvimento (no Heroku o disco do dyno é efêmero)
export class LocalStorageProvider implements StorageProvider {
  readonly provedor = 'LOCAL' as const;
  private raiz = path.resolve(env.STORAGE_LOCAL_PATH);

  private caminho(chave: string) {
    const p = path.resolve(this.raiz, chave);
    if (!p.startsWith(this.raiz + path.sep)) throw new Error('chave de storage inválida');
    return p;
  }

  async put(chave: string, dados: Buffer) {
    const p = this.caminho(chave);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, dados);
  }

  get(chave: string) {
    return readFile(this.caminho(chave));
  }

  async remove(chave: string) {
    await rm(this.caminho(chave), { force: true });
  }

  // Rota da API com token de 15 min (GET /arquivos/download?token=...)
  async urlAssinada(chave: string, minutos = 15, nomeArquivo?: string) {
    return urlDeDownload(chave, minutos, nomeArquivo);
  }

  static lerToken(token: string) {
    return lerTokenDeDownload(token);
  }
}
