import { env } from '#config/env.ts';
import type { StorageProvider } from './index.ts';
import { disposicao } from './disposicao.ts';

// Google Cloud Storage: obrigatório no Heroku. O cliente é carregado sob demanda.
export class GcsStorageProvider implements StorageProvider {
  readonly provedor = 'GCS' as const;
  private bucketPromise?: Promise<any>;

  private bucket() {
    this.bucketPromise ??= import('@google-cloud/storage').then(({ Storage }) => {
      const credentials = env.GCS_CREDENTIALS_JSON ? JSON.parse(env.GCS_CREDENTIALS_JSON) : undefined;
      return new Storage({ projectId: env.GCS_PROJECT_ID, credentials }).bucket(env.GCS_BUCKET!);
    });
    return this.bucketPromise;
  }

  async put(chave: string, dados: Buffer, mimeType: string) {
    await (await this.bucket()).file(chave).save(dados, { contentType: mimeType, resumable: false });
  }

  async get(chave: string) {
    const [buf] = await (await this.bucket()).file(chave).download();
    return buf as Buffer;
  }

  async remove(chave: string) {
    await (await this.bucket()).file(chave).delete({ ignoreNotFound: true });
  }

  async urlAssinada(chave: string, minutos = 15, nomeArquivo?: string, mimeType?: string) {
    const [url] = await (await this.bucket()).file(chave).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + minutos * 60_000,
      ...(nomeArquivo ? { responseDisposition: disposicao(nomeArquivo, mimeType) } : {}),
    });
    return url as string;
  }
}
