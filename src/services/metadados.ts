import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { env } from '#config/env.ts';
import { limparDoi, normalizarTitulo } from '#utils/normalize.ts';

/**
 * Completa metadados de documentos importados (resumo, palavras-chave, DOI, ano, autores, periódico)
 * a partir de fontes abertas, sem chave: OpenAlex, Crossref, Semantic Scholar e as metatags
 * acadêmicas (citation_*, Dublin Core) da página do link do documento.
 * Só preenche o que está em branco; nada do que o usuário digitou é sobrescrito.
 */

export type Metadados = {
  resumo?: string;
  palavrasChave?: string;
  doi?: string;
  ano?: number;
  autores?: string;
  periodico?: string;
};
export type DocumentoParaCompletar = Partial<Record<keyof Metadados, unknown>> & { titulo: string; link?: string | null };
export type ResultadoCompletar = { campos: Metadados; fontes: string[] };

const TIMEOUT = 15_000;
const LIMITE_PAGINA = 2 * 1024 * 1024; // lê no máximo 2 MB do HTML
const AGENTE = 'KonektronResearch/1.0 (+https://konektron.com.br; metadados de artigos científicos)';

const vazio = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && !v.trim());

// ------------------------------------------------------------------ texto

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Remove marcação (JATS do Crossref, HTML), decodifica entidades e junta espaços */
export function limparTexto(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/<jats:title>[^<]*<\/jats:title>/gi, ' ') // "Abstract" como título dentro do resumo
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (e, c: string) => {
      if (c[0] === '#') {
        const n = c[1].toLowerCase() === 'x' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : e;
      }
      return ENTIDADES[c.toLowerCase()] ?? e;
    })
    .replace(/^\s*(abstract|resumo|resumen)\s*[:.]?\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** OpenAlex guarda o resumo como índice invertido: { palavra: [posições] } */
export function resumoDeIndiceInvertido(indice: Record<string, number[]> | null | undefined): string {
  if (!indice) return '';
  const palavras: string[] = [];
  for (const [p, posicoes] of Object.entries(indice)) for (const i of posicoes) palavras[i] = p;
  return palavras.filter(Boolean).join(' ').trim();
}

/** Acha um DOI dentro de um texto ou URL (doi.org/10..., /doi/10..., ?doi=10...) */
export function extrairDoi(texto: string | null | undefined): string | undefined {
  if (!texto) return undefined;
  const m = /\b(10\.\d{4,9}\/[^\s"'<>?#&]+)/i.exec(decodeURIComponent(texto));
  return m ? limparDoi(m[1].replace(/[.,;)\]]+$/, '').replace(/\/(full|abstract|pdf|epdf|html)$/i, '')) ?? undefined : undefined;
}

const juntarTermos = (termos: unknown[]) =>
  [...new Set(termos.map((t) => limparTexto(String(t ?? ''))).filter((t) => t && t.length <= 120))].slice(0, 30).join('; ');

// ------------------------------------------------------------------ metatags da página

type Meta = { nome: string; conteudo: string };
/** Lê <meta name|property="..." content="..."> em qualquer ordem de atributos */
export function lerMetatags(html: string): Meta[] {
  const metas: Meta[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
    const nome = attr('name') ?? attr('property');
    const conteudo = attr('content');
    if (nome && conteudo) metas.push({ nome: (nome[2] ?? nome[3]).toLowerCase(), conteudo: conteudo[2] ?? conteudo[3] });
  }
  return metas;
}

export function metadadosDaPagina(html: string): Metadados {
  const metas = lerMetatags(html);
  const um = (...nomes: string[]) => {
    for (const n of nomes) {
      const v = metas.find((m) => m.nome === n && m.conteudo.trim());
      if (v) return limparTexto(v.conteudo);
    }
    return '';
  };
  const todos = (...nomes: string[]) => metas.filter((m) => nomes.includes(m.nome)).flatMap((m) => m.conteudo.split(/\s*[;,]\s*/));
  const out: Metadados = {};
  // resumo acadêmico primeiro; descrições genéricas só se forem longas o bastante para ser um resumo
  let resumo = um('citation_abstract', 'dcterms.abstract', 'dc.description.abstract', 'prism.teaser', 'eprints.abstract');
  if (!resumo) {
    const generico = um('dc.description', 'og:description', 'description', 'twitter:description');
    if (generico.length >= 200) resumo = generico;
  }
  if (resumo) out.resumo = resumo;
  const palavras = juntarTermos(todos('citation_keywords', 'keywords', 'dc.subject', 'dcterms.subject', 'prism.keyword', 'article:tag'));
  if (palavras) out.palavrasChave = palavras;
  const doi = extrairDoi(um('citation_doi', 'dc.identifier', 'prism.doi', 'bepress_citation_doi'));
  if (doi) out.doi = doi;
  const ano = Number(/\b(1[5-9]\d{2}|20\d{2})\b/.exec(um('citation_publication_date', 'citation_date', 'dc.date', 'citation_online_date'))?.[1]);
  if (ano) out.ano = ano;
  const autores = metas.filter((m) => m.nome === 'citation_author').map((m) => limparTexto(m.conteudo)).filter(Boolean);
  if (autores.length) out.autores = autores.join('; ').slice(0, 10_000);
  const periodico = um('citation_journal_title', 'citation_conference_title', 'prism.publicationname');
  if (periodico) out.periodico = periodico.slice(0, 300);
  return out;
}

// ------------------------------------------------------------------ busca segura de páginas (SSRF)

/** Endereços que o servidor nunca deve acessar a pedido do usuário (rede interna, nuvem, loopback) */
export function ipBloqueado(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapeado = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapeado) return ipBloqueado(mapeado[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;
}

async function conferirHost(url: URL) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocolo não permitido');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('porta não permitida');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!ips.length || ips.some((i) => ipBloqueado(i.address))) throw new Error('endereço não permitido');
}

/** GET de uma página externa: só http(s) público, até 3 redirecionamentos conferidos, 2 MB */
export async function buscarPagina(endereco: string): Promise<{ html: string; url: string }> {
  let url = new URL(endereco);
  for (let saltos = 0; saltos <= 3; saltos++) {
    await conferirHost(url);
    const r = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': AGENTE, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      url = new URL(r.headers.get('location')!, url);
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!/html|xml/i.test(r.headers.get('content-type') ?? '')) throw new Error('não é uma página HTML');
    const leitor = r.body?.getReader();
    let html = '';
    let lidos = 0;
    const dec = new TextDecoder();
    while (leitor) {
      const { done, value } = await leitor.read();
      if (done) break;
      lidos += value.length;
      html += dec.decode(value, { stream: true });
      // as metatags ficam no <head>: para ao fim dele ou no limite de tamanho
      if (lidos > LIMITE_PAGINA || /<\/head>/i.test(html)) {
        await leitor.cancel().catch(() => {});
        break;
      }
    }
    return { html, url: url.toString() };
  }
  throw new Error('redirecionamentos demais');
}

// ------------------------------------------------------------------ APIs abertas

async function getJson(url: string): Promise<any | null> {
  const r = await fetch(url, { headers: { 'User-Agent': AGENTE, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) }).catch(() => null);
  if (!r?.ok) return null;
  return r.json().catch(() => null);
}

const contato = () => (env.METADADOS_EMAIL ? `mailto=${encodeURIComponent(env.METADADOS_EMAIL)}` : '');

export async function openAlex(doi: string | undefined, titulo: string): Promise<Metadados> {
  let w: any = null;
  if (doi) w = await getJson(`https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}?${contato()}`);
  if (!w && titulo.trim().length >= 15) {
    // sem DOI: busca pelo título e só aceita se o título normalizado for o mesmo
    const busca = await getJson(`https://api.openalex.org/works?filter=title.search:${encodeURIComponent(titulo.replace(/[,:|]/g, ' ').slice(0, 300))}&per-page=3&${contato()}`);
    const alvo = normalizarTitulo(titulo);
    w = busca?.results?.find((x: any) => normalizarTitulo(x.title ?? x.display_name ?? '') === alvo) ?? null;
  }
  if (!w) return {};
  const out: Metadados = {};
  const resumo = limparTexto(resumoDeIndiceInvertido(w.abstract_inverted_index));
  if (resumo.length >= 50) out.resumo = resumo;
  const palavras = juntarTermos((w.keywords ?? []).map((k: any) => k.display_name ?? k.keyword));
  if (palavras) out.palavrasChave = palavras;
  const d = extrairDoi(w.doi);
  if (d) out.doi = d;
  if (w.publication_year) out.ano = Number(w.publication_year);
  const autores = (w.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean);
  if (autores.length) out.autores = autores.join('; ').slice(0, 10_000);
  const periodico = w.primary_location?.source?.display_name;
  if (periodico) out.periodico = String(periodico).slice(0, 300);
  return out;
}

export async function crossref(doi: string): Promise<Metadados> {
  const j = await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}${contato() ? `?${contato()}` : ''}`);
  const m = j?.message;
  if (!m) return {};
  const out: Metadados = {};
  const resumo = limparTexto(m.abstract);
  if (resumo.length >= 50) out.resumo = resumo;
  const ano = m.issued?.['date-parts']?.[0]?.[0] ?? m.published?.['date-parts']?.[0]?.[0];
  if (ano) out.ano = Number(ano);
  const autores = (m.author ?? []).map((a: any) => [a.family, a.given].filter(Boolean).join(', ')).filter(Boolean);
  if (autores.length) out.autores = autores.join('; ').slice(0, 10_000);
  if (m['container-title']?.[0]) out.periodico = String(m['container-title'][0]).slice(0, 300);
  return out;
}

export async function semanticScholar(doi: string): Promise<Metadados> {
  const j = await getJson(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=abstract,year`);
  const out: Metadados = {};
  const resumo = limparTexto(j?.abstract);
  if (resumo.length >= 50) out.resumo = resumo;
  if (j?.year) out.ano = Number(j.year);
  return out;
}

// ------------------------------------------------------------------ orquestração

const CAMPOS: (keyof Metadados)[] = ['resumo', 'palavrasChave', 'doi', 'ano', 'autores', 'periodico'];

/** O documento tem algo a completar e de onde buscar? */
export const precisaCompletar = (d: DocumentoParaCompletar) =>
  (vazio(d.resumo) || vazio(d.palavrasChave)) && (!vazio(d.link) || !vazio(d.doi) || !vazio(d.titulo));

/**
 * Procura os campos em branco do documento. Ordem: página do link (palavras-chave dos autores),
 * OpenAlex, Crossref e Semantic Scholar; para assim que resumo e palavras-chave estiverem completos.
 */
export async function completarMetadados(d: DocumentoParaCompletar): Promise<ResultadoCompletar> {
  const faltam = new Set(CAMPOS.filter((c) => vazio(d[c])));
  const campos: Metadados = {};
  const fontes: string[] = [];
  const aplicar = (fonte: string, m: Metadados) => {
    let usou = false;
    for (const c of CAMPOS) {
      if (faltam.has(c) && m[c] !== undefined && !vazio(m[c])) {
        (campos as any)[c] = m[c];
        faltam.delete(c);
        usou = true;
      }
    }
    if (usou) fontes.push(fonte);
  };
  let doi = (vazio(d.doi) ? extrairDoi(d.link as string) : limparDoi(String(d.doi))) ?? undefined;

  if (!vazio(d.link)) {
    try {
      const { html } = await buscarPagina(String(d.link));
      const m = metadadosDaPagina(html);
      aplicar('página do documento', m);
      doi ??= m.doi;
    } catch {
      // site bloqueou, fora do ar ou link inválido: segue para as outras fontes
    }
  }
  if (doi && faltam.has('doi')) aplicar('DOI no link', { doi });
  if (faltam.size) {
    const m = await openAlex(doi, d.titulo).catch(() => ({}) as Metadados);
    aplicar('OpenAlex', m);
    doi ??= m.doi;
  }
  if (doi && (faltam.has('resumo') || faltam.has('ano') || faltam.has('autores') || faltam.has('periodico'))) {
    aplicar('Crossref', await crossref(doi).catch(() => ({})));
  }
  if (doi && faltam.has('resumo')) aplicar('Semantic Scholar', await semanticScholar(doi).catch(() => ({})));
  return { campos, fontes };
}
