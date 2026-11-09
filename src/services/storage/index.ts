import { env } from '#config/env.ts';
import { LocalStorageProvider } from './local.ts';
import { GcsStorageProvider } from './gcs.ts';
import { FtpStorageProvider } from './ftp.ts';

export interface StorageProvider {
  readonly provedor: 'LOCAL' | 'GCS' | 'FTP';
  put(chave: string, dados: Buffer, mimeType: string): Promise<void>;
  get(chave: string): Promise<Buffer>;
  remove(chave: string): Promise<void>;
  /** URL de download válida por `minutos` (RN18: 15 min); PDF abre no navegador (inline) */
  urlAssinada(chave: string, minutos?: number, nomeArquivo?: string, mimeType?: string): Promise<string>;
}

let instance: StorageProvider | undefined;

// STORAGE_DRIVER escolhe o provedor sem mudar código (ERS 11.5)
export function storage(): StorageProvider {
  instance ??=
    env.STORAGE_DRIVER === 'gcs'
      ? new GcsStorageProvider()
      : env.STORAGE_DRIVER === 'ftp'
        ? new FtpStorageProvider()
        : new LocalStorageProvider();
  return instance;
}
