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
