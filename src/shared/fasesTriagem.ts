/**
 * Fases numeradas da triagem (F1, F2, F3…): a F1 vem sempre antes da F2, e a F2 antes da F3.
 * O número sai do nome da etapa: "Triagem F1 (título e resumo)" → 1, "Triagem F2/F3" → 2, "Fase 3" → 3.
 */
export function numeroDaFase(nome: string | null | undefined): number | null {
  const m = (nome ?? '').match(/\bF(?:ase)?\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * Põe as fases numeradas em ordem crescente, trocando-as entre as posições que já ocupam;
 * as etapas sem número (busca, inclusão, análise…) não se mexem.
 */
export function corrigirOrdemDasFases<T extends { nome: string }>(etapas: T[]): T[] {
  const pos = etapas.map((e, i) => ({ e, i, f: numeroDaFase(e.nome) })).filter((x) => x.f !== null);
  const ordenadas = [...pos].sort((a, b) => a.f! - b.f! || a.i - b.i);
  const out = [...etapas];
  pos.forEach((p, k) => (out[p.i] = ordenadas[k].e));
  return out;
}

/** Mensagem quando a sequência quebra F1 → F2 → F3 (null quando está certa) */
export function erroOrdemDasFases(etapas: { nome: string }[]): string | null {
  let ant: { nome: string; f: number } | null = null;
  for (const e of etapas) {
    const f = numeroDaFase(e.nome);
    if (f === null) continue;
    if (ant && f < ant.f)
      return `A etapa "${e.nome}" deve vir antes de "${ant.nome}" (F1 → F2 → F3)`;
    ant = { nome: e.nome, f };
  }
  return null;
}
