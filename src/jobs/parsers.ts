// Leitura dos arquivos exportados pelas bases (RF25): RIS, BibTeX, CSV e XLSX (layout das abas RIL)

export type Registro = {
  titulo: string;
  autores?: string | null;
  resumo?: string | null;
  palavrasChave?: string | null;
  ano?: number | null;
  periodico?: string | null;
  doi?: string | null;
  link?: string | null;
  citacoes?: number | null;
  tipo?: string | null;
  idioma?: string | null;
  bruto: Record<string, unknown>;
};

export type Resultado = { registros: Registro[]; erros: { linha: number; mensagem: string }[] };

const ano = (v: unknown) => {
  const m = /(1[5-9]\d\d|20\d\d|2100)/.exec(String(v ?? ''));
  return m ? Number(m[1]) : null;
};

const TIPOS_RIS: Record<string, string> = { JOUR: 'Artigo', BOOK: 'Livro', CHAP: 'Capítulo de livro', CONF: 'Artigo de conferência', CPAPER: 'Artigo de conferência', THES: 'Tese', RPRT: 'Relatório', ELEC: 'Página Web', ABST: 'Resumo' };

export function parseRis(texto: string): Resultado {
  const registros: Registro[] = [];
  const erros: Resultado['erros'] = [];
  let atual: Record<string, string[]> = {};
  let inicio = 1;
  let ultimaTag = '';
  const fechar = (linha: number) => {
    const g = (t: string) => atual[t]?.[0]?.trim();
    const titulo = g('TI') ?? g('T1') ?? g('CT') ?? g('BT');
    if (!titulo) erros.push({ linha: inicio, mensagem: 'registro sem título' });
    else {
      registros.push({
        titulo,
        autores: [...(atual.AU ?? []), ...(atual.A1 ?? [])].map((a) => a.trim()).join('; ') || null,
        resumo: g('AB') ?? g('N2') ?? null,
        palavrasChave: (atual.KW ?? []).map((k) => k.trim()).join('; ') || null,
        ano: ano(g('PY') ?? g('Y1') ?? g('DA')),
        periodico: g('JO') ?? g('T2') ?? g('JF') ?? g('SO') ?? null,
        doi: g('DO') ?? null,
        link: g('UR') ?? g('L1') ?? null,
        tipo: TIPOS_RIS[g('TY') ?? ''] ?? null,
        idioma: g('LA') ?? null,
        bruto: atual,
      });
    }
    atual = {};
    inicio = linha + 1;
  };
  texto.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((l, i) => {
    const m = /^([A-Z][A-Z0-9]) {2}- ?(.*)$/.exec(l);
    if (m) {
      const [, tag, valor] = m;
      ultimaTag = tag;
      if (tag === 'ER') return fechar(i + 1);
      (atual[tag] ??= []).push(valor);
    } else if (l.trim() && ultimaTag && atual[ultimaTag]) {
      // continuação de linha (resumos longos)
      const arr = atual[ultimaTag];
      arr[arr.length - 1] += ` ${l.trim()}`;
    }
  });
  if (Object.keys(atual).length) fechar(0);
  return { registros, erros };
}

export function parseBibtex(texto: string): Resultado {
  const registros: Registro[] = [];
  const erros: Resultado['erros'] = [];
  const re = /@(\w+)\s*\{\s*([^,\s{}]*)\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    const tipo = m[1].toLowerCase();
    if (['comment', 'string', 'preamble'].includes(tipo)) continue;
    // corpo até a chave que fecha a entrada (respeitando chaves aninhadas)
    let i = re.lastIndex;
    let nivel = 1;
    while (i < texto.length && nivel > 0) {
      if (texto[i] === '{') nivel++;
      else if (texto[i] === '}') nivel--;
      i++;
    }
    const corpo = texto.slice(re.lastIndex, i - 1);
    re.lastIndex = i;
    const campos: Record<string, string> = {};
    const rc = /(\w+)\s*=\s*(\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|(\d+))/g;
    let c: RegExpExecArray | null;
    while ((c = rc.exec(corpo))) campos[c[1].toLowerCase()] = (c[3] ?? c[4] ?? c[5] ?? '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    const linha = texto.slice(0, m.index).split('\n').length;
    if (!campos.title) {
      erros.push({ linha, mensagem: 'entrada sem título' });
      continue;
    }
    registros.push({
      titulo: campos.title,
      autores: campos.author ? campos.author.split(/\s+and\s+/i).join('; ') : null,
      resumo: campos.abstract ?? null,
      palavrasChave: campos.keywords ?? null,
      ano: ano(campos.year),
      periodico: campos.journal ?? campos.booktitle ?? null,
      doi: campos.doi ?? null,
      link: campos.url ?? null,
      tipo: { article: 'Artigo', book: 'Livro', incollection: 'Capítulo de livro', inbook: 'Capítulo de livro', inproceedings: 'Artigo de conferência', phdthesis: 'Tese', mastersthesis: 'Dissertação', techreport: 'Relatório', misc: null }[tipo] ?? null,
      idioma: campos.language ?? null,
      bruto: { tipo, chave: m[2], ...campos },
    });
  }
  return { registros, erros };
}

// CSV com vírgula ou ponto e vírgula, aspas duplas e quebra de linha dentro de campos
export function lerCsv(texto: string): string[][] {
  const t = texto.replace(/^\uFEFF/, '');
  const primeira = t.slice(0, t.indexOf('\n') > 0 ? t.indexOf('\n') : t.length);
  const sep = (primeira.match(/;/g)?.length ?? 0) > (primeira.match(/,/g)?.length ?? 0) ? ';' : primeira.includes('\t') && !primeira.includes(',') ? '\t' : ',';
  const linhas: string[][] = [];
  let campo = '';
  let linha: string[] = [];
  let aspas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (aspas) {
      if (c === '"' && t[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === sep) {
      linha.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      linha.push(campo);
      if (linha.some((x) => x.trim())) linhas.push(linha);
      linha = [];
      campo = '';
    } else campo += c;
  }
  linha.push(campo);
  if (linha.some((x) => x.trim())) linhas.push(linha);
  return linhas;
}

const semAcento = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Cabeçalhos aceitos (abas RIL da planilha, Scopus, WoS, IEEE...)
const COLUNAS: Record<keyof Omit<Registro, 'bruto'>, string[]> = {
  titulo: ['titulo', 'title', 'document title', 'article title', 'ti'],
  autores: ['autores', 'autor', 'authors', 'author', 'author full names', 'au'],
  resumo: ['resumo', 'abstract', 'ab'],
  palavrasChave: ['palavras-chave', 'palavras chave', 'keywords', 'author keywords', 'author keywords', 'de'],
  ano: ['ano', 'year', 'publication year', 'py'],
  periodico: ['periodico', 'revista', 'source title', 'publication title', 'journal', 'so'],
  doi: ['doi', 'di'],
  link: ['link', 'url', 'pdf link'],
  citacoes: ['citacoes', 'cited by', 'times cited', 'article citation count', 'tc'],
  tipo: ['tipo', 'tipo de documento', 'document type', 'dt'],
  idioma: ['idioma', 'language', 'la'],
};

export function tabelaParaRegistros(linhas: unknown[][]): Resultado {
  const registros: Registro[] = [];
  const erros: Resultado['erros'] = [];
  if (!linhas.length) return { registros, erros };
  const cab = linhas[0].map((h) => semAcento(String(h ?? '')));
  const idx = Object.fromEntries(Object.entries(COLUNAS).map(([k, nomes]) => [k, cab.findIndex((h) => nomes.includes(h))])) as Record<string, number>;
  if (idx.titulo < 0) return { registros, erros: [{ linha: 1, mensagem: 'coluna de título não encontrada no cabeçalho' }] };
  linhas.slice(1).forEach((l, i) => {
    const v = (k: string) => (idx[k] >= 0 ? String(l[idx[k]] ?? '').trim() || null : null);
    const titulo = v('titulo');
    if (!titulo) return erros.push({ linha: i + 2, mensagem: 'linha sem título' });
    const cit = v('citacoes');
    registros.push({
      titulo,
      autores: v('autores'),
      resumo: v('resumo'),
      palavrasChave: v('palavrasChave'),
      ano: ano(v('ano')),
      periodico: v('periodico'),
      doi: v('doi'),
      link: v('link'),
      citacoes: cit && /^\d+$/.test(cit) ? Number(cit) : null,
      tipo: v('tipo'),
      idioma: v('idioma'),
      bruto: Object.fromEntries(cab.map((h, k) => [h || `coluna${k + 1}`, l[k] ?? null])),
    });
  });
  return { registros, erros };
}

export async function lerArquivoDeBusca(nome: string, dados: Buffer): Promise<Resultado> {
  const ext = nome.split('.').pop()?.toLowerCase();
  if (ext === 'xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(dados as any);
    const ws = wb.worksheets[0];
    const linhas: unknown[][] = [];
    ws?.eachRow((row) => {
      const vals = (row.values as unknown[]).slice(1).map((c: any) => (c && typeof c === 'object' ? (c.text ?? c.result ?? c.hyperlink ?? '') : c));
      linhas.push(vals);
    });
    return tabelaParaRegistros(linhas);
  }
  const texto = dados.toString('utf8');
  if (ext === 'bib' || ext === 'bibtex' || /^\s*@\w+\s*\{/m.test(texto.slice(0, 2000))) return parseBibtex(texto);
  if (ext === 'ris' || ext === 'nbib' || /^TY {2}- /m.test(texto.slice(0, 2000))) return parseRis(texto);
  return tabelaParaRegistros(lerCsv(texto));
}
