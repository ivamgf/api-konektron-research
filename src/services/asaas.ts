import https from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { env } from '#config/env.ts';
import { AppError } from '#utils/AppError.ts';
import { logger } from '#utils/logger.ts';

/**
 * Cliente da API v3 do Asaas (assinaturas dos planos). A chave vai no header access_token e nunca sai da API.
 * Com a lista de IPs autorizados ligada no Asaas, defina ASAAS_PROXY (SOCKS de IP fixo, ex.: Fixie Socks).
 */

export const asaasLigado = () => !!env.ASAAS_API_KEY;

let agente: https.Agent | undefined;
const agenteDoProxy = () => {
  // sem ASAAS_PROXY, no Heroku usa o Fixie Socks (o mesmo IP fixo do túnel do banco)
  const proxy = env.ASAAS_PROXY ?? (process.env.DYNO ? process.env.FIXIE_SOCKS_HOST : undefined);
  if (!proxy) return undefined;
  agente ??= new SocksProxyAgent(proxy.includes('://') ? proxy : `socks5://${proxy}`);
  return agente;
};

export class ErroAsaas extends Error {
  status: number;
  erros: { code?: string; description?: string }[];
  constructor(status: number, erros: { code?: string; description?: string }[]) {
    super(
      erros
        .map((e) => e.description)
        .filter(Boolean)
        .join(' ') || `Asaas respondeu ${status}`,
    );
    this.status = status;
    this.erros = erros;
  }
}

type Metodo = 'GET' | 'POST' | 'DELETE';

/**
 * Chamada ao Asaas: devolve o JSON ou lança ErroAsaas. O sandbox às vezes responde 500 por instantes;
 * leituras, cancelamentos e atualizações de um registro (POST /recurso/{id}) são repetidos uma vez.
 * Criações (POST /customers, POST /subscriptions) nunca são repetidas, para não duplicar cobrança.
 */
export async function chamarAsaas<T = any>(
  metodo: Metodo,
  caminho: string,
  corpo?: unknown,
): Promise<T> {
  const repetivel = metodo !== 'POST' || /^\/(customers|subscriptions)\/[^/]+$/.test(caminho);
  try {
    return await chamarUmaVez<T>(metodo, caminho, corpo);
  } catch (err) {
    const instavel = err instanceof ErroAsaas ? err.status >= 500 : !(err instanceof AppError);
    if (!repetivel || !instavel) throw err;
    await new Promise((r) => setTimeout(r, env.isTest ? 0 : 1_500));
    return chamarUmaVez<T>(metodo, caminho, corpo);
  }
}

function chamarUmaVez<T>(metodo: Metodo, caminho: string, corpo?: unknown): Promise<T> {
  if (!env.ASAAS_API_KEY) {
    return Promise.reject(
      new AppError('A cobrança on-line ainda não está ativa.', 503, undefined, 'ASAAS_DESLIGADO'),
    );
  }
  const url = new URL(env.ASAAS_API_URL.replace(/\/$/, '') + caminho);
  const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: metodo,
        agent: agenteDoProxy(),
        timeout: 20_000,
        headers: {
          access_token: env.ASAAS_API_KEY!,
          'User-Agent': 'konektron-research',
          Accept: 'application/json',
          ...(dados
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) }
            : {}),
        },
      },
      (res) => {
        const partes: Buffer[] = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => {
          const texto = Buffer.concat(partes).toString('utf8');
          let json: any = null;
          try {
            json = texto ? JSON.parse(texto) : null;
          } catch {
            json = null;
          }
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) return resolve(json as T);
          logger.warn({ status, caminho, erros: json?.errors }, 'Asaas recusou a chamada');
          reject(new ErroAsaas(status, json?.errors ?? [{ description: texto.slice(0, 200) }]));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Asaas não respondeu a tempo')));
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

/** Converte a falha do Asaas num erro amigável para o app */
export function erroParaApp(err: unknown): never {
  if (err instanceof AppError) throw err;
  if (err instanceof ErroAsaas) {
    if (err.erros.some((e) => e.code === 'not_allowed_ip')) {
      throw new AppError(
        'O servidor de pagamentos recusou a conexão (IP não autorizado no Asaas).',
        502,
        undefined,
        'ASAAS_IP',
      );
    }
    if (err.status === 400)
      throw AppError.unprocessable(
        err.message || 'Dados recusados pelo Asaas',
        err.erros,
        'ASAAS_DADOS',
      );
  }
  logger.error({ err }, 'falha na chamada ao Asaas');
  throw new AppError(
    'Não foi possível falar com o servidor de pagamentos. Tente de novo em instantes.',
    502,
    undefined,
    'ASAAS_INDISPONIVEL',
  );
}

export type ClienteAsaas = { id: string; name: string; email: string; cpfCnpj: string };
export type AssinaturaAsaas = {
  id: string;
  status: string;
  nextDueDate: string;
  value: number;
  cycle: string;
};
export type PagamentoAsaas = {
  id: string;
  subscription?: string | null;
  customer: string;
  value: number;
  status: string;
  billingType: string;
  dueDate: string;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  confirmedDate?: string | null;
  invoiceUrl?: string | null;
  externalReference?: string | null;
};

export const asaas = {
  criarCliente: (d: { name: string; email: string; cpfCnpj: string; externalReference: string }) =>
    chamarAsaas<ClienteAsaas>('POST', '/customers', { ...d, notificationDisabled: false }),
  atualizarCliente: (id: string, d: Partial<{ name: string; email: string; cpfCnpj: string }>) =>
    chamarAsaas<ClienteAsaas>('POST', `/customers/${id}`, d),
  criarAssinatura: (d: {
    customer: string;
    value: number;
    nextDueDate: string;
    cycle: 'MONTHLY' | 'YEARLY';
    description: string;
    externalReference: string;
  }) => chamarAsaas<AssinaturaAsaas>('POST', '/subscriptions', { billingType: 'UNDEFINED', ...d }),
  atualizarAssinatura: (
    id: string,
    d: { value: number; cycle: 'MONTHLY' | 'YEARLY'; description: string },
  ) =>
    chamarAsaas<AssinaturaAsaas>('POST', `/subscriptions/${id}`, {
      ...d,
      updatePendingPayments: true,
    }),
  cancelarAssinatura: (id: string) =>
    chamarAsaas<{ deleted: boolean }>('DELETE', `/subscriptions/${id}`),
  pagamentosDaAssinatura: (id: string) =>
    chamarAsaas<{ data: PagamentoAsaas[] }>('GET', `/subscriptions/${id}/payments`).then(
      (r) => r.data ?? [],
    ),
};

/** Data de hoje no fuso de Brasília, no formato do Asaas (AAAA-MM-DD) */
export const hojeAsaas = (agora = new Date()) =>
  agora.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

/** CPF (11 dígitos) ou CNPJ (14 dígitos) com os dígitos verificadores corretos */
export function cpfCnpjValido(v: string) {
  const d = v.replace(/\D/g, '');
  if (!/^\d{11}$|^\d{14}$/.test(d) || /^(\d)\1+$/.test(d)) return false;
  const dv = (base: string, pesos: number[]) => {
    const s = pesos.reduce((acc, p, i) => acc + Number(base[i]) * p, 0) % 11;
    return s < 2 ? 0 : 11 - s;
  };
  if (d.length === 11) {
    const p1 = [10, 9, 8, 7, 6, 5, 4, 3, 2];
    const p2 = [11, ...p1];
    return dv(d, p1) === Number(d[9]) && dv(d, p2) === Number(d[10]);
  }
  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const p2 = [6, ...p1];
  return dv(d, p1) === Number(d[12]) && dv(d, p2) === Number(d[13]);
}
