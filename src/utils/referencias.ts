// RF27 — referências ABNT NBR 6023 e APA 7 a partir dos metadados (ajustáveis manualmente)

type Doc = {
  titulo: string;
  autores?: string | null;
  ano?: number | null;
  periodico?: string | null;
  doi?: string | null;
  link?: string | null;
};

const listaAutores = (autores?: string | null) =>
  (autores ?? '')
    .split(/;|\band\b|\n/)
    .map((a) => a.trim())
    .filter(Boolean);

// "Silva, Ana Maria" ou "Ana Maria Silva" -> { sobrenome: 'Silva', prenomes: ['Ana','Maria'] }
function partes(nome: string) {
  if (nome.includes(',')) {
    const [sobrenome, resto = ''] = nome.split(',').map((s) => s.trim());
    return { sobrenome, prenomes: resto.split(/\s+/).filter(Boolean) };
  }
  const p = nome.split(/\s+/);
  return { sobrenome: p.pop() ?? nome, prenomes: p };
}

const iniciais = (prenomes: string[]) => prenomes.map((p) => `${p.replace(/\./g, '')[0]?.toUpperCase()}.`).join(' ');

export function referenciaNbr(d: Doc): string {
  const autores = listaAutores(d.autores).map((a) => {
    const { sobrenome, prenomes } = partes(a);
    return `${sobrenome.toUpperCase()}, ${iniciais(prenomes)}`.trim().replace(/,\s*$/, '');
  });
  const autoria = autores.length > 3 ? `${autores[0]} et al.` : autores.join('; ');
  const partesRef = [autoria ? `${autoria.replace(/\.$/, '')}.` : '', `${d.titulo.replace(/\.$/, '')}.`];
  if (d.periodico) partesRef.push(`${d.periodico},`);
  if (d.ano) partesRef.push(`${d.ano}.`);
  if (d.doi) partesRef.push(`DOI: https://doi.org/${d.doi}.`);
  else if (d.link) partesRef.push(`Disponível em: ${d.link}.`);
  return partesRef.filter(Boolean).join(' ').replace(/,\.$/, '.').trim();
}

export function referenciaApa(d: Doc): string {
  const autores = listaAutores(d.autores).map((a) => {
    const { sobrenome, prenomes } = partes(a);
    return `${sobrenome}, ${iniciais(prenomes)}`.trim().replace(/,\s*$/, '');
  });
  let autoria = '';
  if (autores.length === 1) autoria = autores[0];
  else if (autores.length > 1 && autores.length <= 20)
    autoria = `${autores.slice(0, -1).join(', ')}, & ${autores.at(-1)}`;
  else if (autores.length > 20) autoria = `${autores.slice(0, 19).join(', ')}, ... ${autores.at(-1)}`;
  const partesRef = [autoria, `(${d.ano ?? 's.d.'}).`, `${d.titulo.replace(/\.$/, '')}.`];
  if (d.periodico) partesRef.push(`${d.periodico}.`);
  if (d.doi) partesRef.push(`https://doi.org/${d.doi}`);
  else if (d.link) partesRef.push(d.link);
  return partesRef.filter(Boolean).join(' ').trim();
}

// Demais normas (MLA 9, Chicago 17 autor-data, Vancouver/ICMJE e IEEE), no mesmo espírito: artigo de periódico
// montado só com os metadados que o documento tem.

const nomeDireto = (a: string) => {
  const { sobrenome, prenomes } = partes(a);
  return [...prenomes, sobrenome].join(' ');
};
const nomeInvertido = (a: string) => {
  const { sobrenome, prenomes } = partes(a);
  return prenomes.length ? `${sobrenome}, ${prenomes.join(' ')}` : sobrenome;
};
const semPonto = (s: string) => s.replace(/[.\s]+$/, '');
const juntarComE = (nomes: string[]) =>
  nomes.length <= 1 ? (nomes[0] ?? '') : nomes.length === 2 ? `${nomes[0]} and ${nomes[1]}` : `${nomes.slice(0, -1).join(', ')}, and ${nomes.at(-1)}`;

export function referenciaMla(d: Doc): string {
  const autores = listaAutores(d.autores);
  let autoria = '';
  if (autores.length === 1) autoria = nomeInvertido(autores[0]);
  else if (autores.length === 2) autoria = `${nomeInvertido(autores[0])}, and ${nomeDireto(autores[1])}`;
  else if (autores.length > 2) autoria = `${nomeInvertido(autores[0])}, et al`;
  const fonte = [d.periodico, d.ano?.toString(), d.doi ? `https://doi.org/${d.doi}` : d.link].filter(Boolean).join(', ');
  return [autoria ? `${semPonto(autoria)}.` : '', `“${semPonto(d.titulo)}.”`, fonte ? `${fonte}.` : ''].filter(Boolean).join(' ');
}

export function referenciaChicago(d: Doc): string {
  const autores = listaAutores(d.autores);
  const nomes = autores.map((a, i) => (i === 0 ? nomeInvertido(a) : nomeDireto(a)));
  // o primeiro nome vem invertido ("Silva, Ana"), então a vírgula antes do "and" fica mesmo com dois autores
  const autoria =
    autores.length > 10 ? `${nomes.slice(0, 7).join(', ')}, et al` : nomes.length === 2 ? `${nomes[0]}, and ${nomes[1]}` : juntarComE(nomes);
  const partesRef = [autoria ? `${semPonto(autoria)}.` : '', `${d.ano ?? 's.d.'}.`, `“${semPonto(d.titulo)}.”`];
  if (d.periodico) partesRef.push(`${semPonto(d.periodico)}.`);
  if (d.doi) partesRef.push(`https://doi.org/${d.doi}.`);
  else if (d.link) partesRef.push(`${d.link}.`);
  return partesRef.filter(Boolean).join(' ');
}

export function referenciaVancouver(d: Doc): string {
  const autores = listaAutores(d.autores).map((a) => {
    const { sobrenome, prenomes } = partes(a);
    return `${sobrenome} ${prenomes.map((p) => p.replace(/\./g, '')[0]?.toUpperCase() ?? '').join('')}`.trim();
  });
  const autoria = autores.length > 6 ? `${autores.slice(0, 6).join(', ')}, et al` : autores.join(', ');
  const partesRef = [autoria ? `${semPonto(autoria)}.` : '', `${semPonto(d.titulo)}.`];
  if (d.periodico) partesRef.push(`${semPonto(d.periodico)}.`);
  if (d.ano) partesRef.push(`${d.ano}.`);
  if (d.doi) partesRef.push(`doi:${d.doi}`);
  else if (d.link) partesRef.push(`Available from: ${d.link}`);
  return partesRef.filter(Boolean).join(' ');
}

export function referenciaIeee(d: Doc): string {
  const autores = listaAutores(d.autores).map((a) => {
    const { sobrenome, prenomes } = partes(a);
    return [iniciais(prenomes), sobrenome].filter(Boolean).join(' ');
  });
  const autoria = autores.length > 6 ? `${autores[0]} et al.` : juntarComE(autores);
  const partesRef = [d.periodico, d.ano?.toString()].filter(Boolean) as string[];
  if (d.doi) partesRef.push(`doi: ${d.doi}`);
  let ref = `${autoria ? `${autoria}, ` : ''}“${semPonto(d.titulo)},”${partesRef.length ? ` ${partesRef.join(', ')}.` : ''}`;
  if (!d.doi && d.link) ref += ` [Online]. Available: ${d.link}`;
  return ref.trim();
}

/** Normas guardadas em cada referência do projeto (colunas da tabela referencia) */
export const NORMAS = ['abnt', 'apa', 'mla', 'chicago', 'vancouver', 'ieee'] as const;
export type Norma = (typeof NORMAS)[number];

/** Gera o texto da referência em cada norma a partir dos metadados do documento */
export const GERADORES: Record<Norma, (d: Doc) => string> = {
  abnt: referenciaNbr,
  apa: referenciaApa,
  mla: referenciaMla,
  chicago: referenciaChicago,
  vancouver: referenciaVancouver,
  ieee: referenciaIeee,
};
