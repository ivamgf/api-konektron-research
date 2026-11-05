// RN11 — mesmas regras de fn_normalizar_titulo e fn_limpar_doi do script SQL

export function normalizarTitulo(titulo: string | null | undefined): string {
  return (titulo ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, 1000);
}

export function limparDoi(doi: string | null | undefined): string | null {
  if (!doi?.trim()) return null;
  return doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '')
    .trim();
}

// Similaridade por bigramas (coeficiente de Dice), 0..1
export function similaridade(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const pares = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const p = s.slice(i, i + 2);
      m.set(p, (m.get(p) ?? 0) + 1);
    }
    return m;
  };
  const pa = pares(a);
  const pb = pares(b);
  let inter = 0;
  for (const [p, n] of pa) inter += Math.min(n, pb.get(p) ?? 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

export const LIMIAR_DUPLICADO = 0.95;
