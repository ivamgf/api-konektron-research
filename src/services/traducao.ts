import { env } from '#config/env.ts';
import { AppError } from '#utils/AppError.ts';

/**
 * Tradução automática de textos do protocolo (ex.: resumo em português → inglês, espanhol).
 * Provedor por TRADUCAO_PROVEDOR:
 *  - mymemory (padrão, sem chave; ~5 mil palavras/dia por IP, 50 mil com MYMEMORY_EMAIL)
 *  - deepl (DEEPL_API_KEY; chave gratuita termina em ":fx")
 *  - libretranslate (LIBRETRANSLATE_URL e, se exigir, LIBRETRANSLATE_API_KEY)
 *  - desligado
 * O texto é enviado ao serviço escolhido; o resultado é tradução automática e deve ser revisado.
 */

const LIMITE_MYMEMORY = 480; // bytes por requisição (o serviço aceita até 500)

/** Divide o texto em pedaços de até `limite` bytes, sem cortar frases (parágrafos preservados) */
export function dividirTexto(texto: string, limite = LIMITE_MYMEMORY): string[][] {
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
  return texto.split(/\n{2,}/).map((par) => {
    const frases = par.match(/[^.!?;\n]+[.!?;]*\s*|\n/g) ?? [par];
    const pedacos: string[] = [];
    let atual = '';
    for (const f of frases) {
      if (bytes(atual + f) <= limite) atual += f;
      else {
        if (atual.trim()) pedacos.push(atual.trim());
        // frase maior que o limite: corta por palavras
        if (bytes(f) > limite) {
          let parte = '';
          for (const w of f.split(/(\s+)/)) {
            if (bytes(parte + w) > limite) {
              if (parte.trim()) pedacos.push(parte.trim());
              parte = w;
            } else parte += w;
          }
          atual = parte;
        } else atual = f;
      }
    }
    if (atual.trim()) pedacos.push(atual.trim());
    return pedacos;
  });
}

const indisponivel = (detalhe: string) =>
  new AppError(`Tradução automática indisponível: ${detalhe}`, 503, undefined, 'TRADUCAO_INDISPONIVEL');

async function mymemory(texto: string, de: string, para: string) {
  const paragrafos = dividirTexto(texto);
  const saida: string[] = [];
  for (const pedacos of paragrafos) {
    const traduzidos: string[] = [];
    for (const q of pedacos) {
      const url = new URL('https://api.mymemory.translated.net/get');
      url.searchParams.set('q', q);
      url.searchParams.set('langpair', `${de}|${para}`);
      if (env.MYMEMORY_EMAIL) url.searchParams.set('de', env.MYMEMORY_EMAIL);
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch((e) => {
        throw indisponivel(e.message);
      });
      const j: any = await r.json().catch(() => null);
      if (!r.ok || !j || j.quotaFinished || Number(j.responseStatus) !== 200) {
        throw indisponivel(j?.responseDetails || (j?.quotaFinished ? 'cota diária do serviço esgotada' : `HTTP ${r.status}`));
      }
      traduzidos.push(String(j.responseData?.translatedText ?? ''));
    }
    saida.push(traduzidos.join(' '));
  }
  return saida.join('\n\n');
}

async function deepl(texto: string, de: string, para: string) {
  const host = env.DEEPL_API_KEY!.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  const alvo = para.toUpperCase() === 'EN' ? 'EN-US' : para.toUpperCase() === 'PT' ? 'PT-BR' : para.toUpperCase();
  const r = await fetch(`https://${host}/v2/translate`, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${env.DEEPL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: [texto], source_lang: de.toUpperCase(), target_lang: alvo, preserve_formatting: true }),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => {
    throw indisponivel(e.message);
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || !j?.translations?.[0]) throw indisponivel(j?.message ?? `HTTP ${r.status}`);
  return String(j.translations[0].text);
}

async function libretranslate(texto: string, de: string, para: string) {
  const r = await fetch(`${env.LIBRETRANSLATE_URL!.replace(/\/+$/, '')}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texto, source: de, target: para, format: 'text', api_key: env.LIBRETRANSLATE_API_KEY || undefined }),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => {
    throw indisponivel(e.message);
  });
  const j: any = await r.json().catch(() => null);
  if (!r.ok || typeof j?.translatedText !== 'string') throw indisponivel(j?.error ?? `HTTP ${r.status}`);
  return j.translatedText as string;
}

/** Traduz `texto` do idioma `de` para o idioma `para` (códigos ISO 639-1: pt, en, es…) */
export async function traduzir(texto: string, de: string, para: string): Promise<string> {
  if (!texto.trim() || de === para) return texto;
  switch (env.TRADUCAO_PROVEDOR) {
    case 'desligado':
      throw indisponivel('desligada na configuração do servidor');
    case 'deepl':
      if (!env.DEEPL_API_KEY) throw indisponivel('DEEPL_API_KEY não configurada');
      return deepl(texto, de, para);
    case 'libretranslate':
      if (!env.LIBRETRANSLATE_URL) throw indisponivel('LIBRETRANSLATE_URL não configurada');
      return libretranslate(texto, de, para);
    default:
      return mymemory(texto, de, para);
  }
}
