import { env } from '#config/env.ts';
import { LocalStorageProvider } from './local.ts';
import { GcsStorageProvider } from './gcs.ts';

export interface StorageProvider {
  readonly provedor: 'LOCAL' | 'GCS';
  put(chave: string, dados: Buffer, mimeType: string): Promise<void>;
  get(chave: string): Promise<Buffer>;
  remove(chave: string): Promise<void>;
  /** URL de download válida por `minutos` (RN18: 15 min) */
  urlAssinada(chave: string, minutos?: number, nomeArquivo?: string): Promise<string>;
}

let instance: StorageProvider | undefined;

// STORAGE_DRIVER escolhe o provedor sem mudar código (ERS 11.5)
export function storage(): StorageProvider {
  instance ??= env.STORAGE_DRIVER === 'gcs' ? new GcsStorageProvider() : new LocalStorageProvider();
  return instance;
}
