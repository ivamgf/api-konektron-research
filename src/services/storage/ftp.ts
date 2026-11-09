import path from 'node:path/posix';
import { Readable, Writable } from 'node:stream';
import { Client, FTPError } from 'basic-ftp';
import { env } from '#config/env.ts';
import type { StorageProvider } from './index.ts';
import { urlDeDownload } from './assinatura.ts';

/**
 * Storage numa pasta da hospedagem (ex.: HostGator/cPanel) por FTP/FTPS. Os arquivos não são
 * servidos direto pelo site: a pasta recebe um .htaccess que bloqueia o acesso público e o
 * download passa pela API, com o link assinado de 15 minutos (RN18), como no driver local.
 */

const BLOQUEIO = `# Konektron Research: arquivos privados, servidos só pela API
<IfModule mod_authz_core.c>
  Require all denied
</IfModule>
<IfModule !mod_authz_core.c>
  Order allow,deny
  Deny from all
</IfModule>
Options -Indexes
`;

/** Chave de storage segura: sem "..", sem caminho absoluto, só caracteres comuns */
export function validarChave(chave: string) {
  if (!chave || chave.startsWith('/') || chave.split('/').some((p) => p === '..' || p === '.' || p === '') || !/^[\w\-./ ]+$/.test(chave)) {
    throw new Error(`chave de storage inválida: ${chave}`);
  }
  return chave;
}

/** Semáforo simples: a hospedagem limita conexões FTP simultâneas por IP */
class Fila {
  private ativos = 0;
  private espera: (() => void)[] = [];
  private limite: number;
  constructor(limite: number) {
    this.limite = limite;
  }
  async rodar<T>(f: () => Promise<T>): Promise<T> {
    if (this.ativos >= this.limite) await new Promise<void>((r) => this.espera.push(r));
    this.ativos++;
    try {
      return await f();
    } finally {
      this.ativos--;
      this.espera.shift()?.();
    }
  }
}

export class FtpStorageProvider implements StorageProvider {
  readonly provedor = 'FTP' as const;
  private base = (env.FTP_BASE_PATH ?? '').replace(/\/+$/, '');
  private fila = new Fila(env.FTP_MAX_CONEXOES);
  private protegido = false;

  private destino(chave: string) {
    return path.join(this.base, validarChave(chave));
  }

  private async conectar<T>(f: (c: Client) => Promise<T>): Promise<T> {
    return this.fila.rodar(async () => {
      const c = new Client(env.FTP_TIMEOUT_MS);
      try {
        await c.access({
          host: env.FTP_HOST,
          port: env.FTP_PORT,
          user: env.FTP_USER,
          password: env.FTP_PASSWORD,
          secure: env.FTP_SECURE === 'implicit' ? 'implicit' : env.FTP_SECURE === 'true',
          // certificados de hospedagem compartilhada costumam ser do servidor, não do domínio
          secureOptions: { rejectUnauthorized: !env.FTP_TLS_INSECURE, servername: env.FTP_TLS_SERVERNAME || env.FTP_HOST },
        });
        return await f(c);
      } finally {
        c.close();
      }
    });
  }

  /** Cria a pasta base com o .htaccess de bloqueio (uma vez por processo) */
  private async proteger(c: Client) {
    if (this.protegido) return;
    await c.ensureDir(this.base);
    await c.uploadFrom(Readable.from(Buffer.from(BLOQUEIO)), path.join(this.base, '.htaccess'));
    this.protegido = true;
  }

  async put(chave: string, dados: Buffer) {
    const destino = this.destino(chave);
    await this.conectar(async (c) => {
      await this.proteger(c);
      await c.ensureDir(path.dirname(destino));
      await c.uploadFrom(Readable.from(dados), destino);
    });
  }

  async get(chave: string) {
    const destino = this.destino(chave);
    return this.conectar(async (c) => {
      const partes: Buffer[] = [];
      const saida = new Writable({
        write(pedaco, _enc, pronto) {
          partes.push(Buffer.from(pedaco));
          pronto();
        },
      });
      await c.downloadTo(saida, destino);
      return Buffer.concat(partes);
    });
  }

  async remove(chave: string) {
    const destino = this.destino(chave);
    await this.conectar(async (c) => {
      try {
        await c.remove(destino);
      } catch (e) {
        // 550: o arquivo já não existe
        if (!(e instanceof FTPError && e.code === 550)) throw e;
      }
    });
  }

  async urlAssinada(chave: string, minutos = 15, nomeArquivo?: string) {
    validarChave(chave);
    return urlDeDownload(chave, minutos, nomeArquivo);
  }

  /** Teste de conexão e de escrita (scripts/storage-check.js) */
  async verificar() {
    return this.conectar(async (c) => {
      await this.proteger(c);
      const teste = path.join(this.base, `.teste-${Date.now()}`);
      await c.uploadFrom(Readable.from(Buffer.from('ok')), teste);
      await c.remove(teste);
      return { base: this.base, pwd: await c.pwd() };
    });
  }
}

