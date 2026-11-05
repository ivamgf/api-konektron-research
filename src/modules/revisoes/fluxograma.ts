// RF33: diagrama de fluxo de seleção genérico (identificação → triagem → elegibilidade → inclusão)
type Painel = {
  totais: Record<string, number>;
  excluidosPorEtapa: { etapaId: string; ordem: number; nome: string; motivo: string | null; n: number }[];
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const MOTIVO: Record<string, string> = { CRITERIO: 'critério de exclusão', DUPLICADO: 'duplicados', SEM_ACESSO: 'sem acesso', OUTRO: 'outros motivos' };

export function fluxogramaSvg(p: Painel): string {
  const t = p.totais;
  const etapas = new Map<string, { nome: string; ordem: number; motivos: [string, number][] }>();
  for (const x of p.excluidosPorEtapa) {
    const e = etapas.get(x.etapaId) ?? { nome: x.nome, ordem: x.ordem, motivos: [] };
    e.motivos.push([MOTIVO[x.motivo ?? 'OUTRO'] ?? 'outros', x.n]);
    etapas.set(x.etapaId, e);
  }
  const caixas: { titulo: string; linhas: string[]; lado?: string[] }[] = [
    { titulo: 'Identificação', linhas: [`Registros consultados nas bases: ${t.consultados}`, `Registros importados: ${t.importados}`] },
    ...[...etapas.values()]
      .sort((a, b) => a.ordem - b.ordem)
      .map((e) => ({
        titulo: e.nome,
        linhas: [`Excluídos: ${e.motivos.reduce((s, [, n]) => s + n, 0)}`],
        lado: e.motivos.map(([m, n]) => `${m}: ${n}`),
      })),
    {
      titulo: 'Inclusão',
      linhas: [
        `Selecionados na última triagem: ${t.selecionadosUltimaTriagem}`,
        `Revisão anterior: ${t.revisaoAnterior} · Integrados: ${t.integrados}`,
        `Total incluídos: ${t.incluidos}`,
      ],
    },
  ];
  const W = 760, bw = 420, x = 40, gap = 36;
  let y = 60;
  const partes: string[] = [];
  for (const [i, c] of caixas.entries()) {
    const h = 34 + c.linhas.length * 18;
    const destaque = i === caixas.length - 1;
    partes.push(
      `<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="8" fill="${destaque ? '#CCF5E6' : '#ffffff'}" stroke="#007A4F" stroke-width="${destaque ? 2 : 1.25}"/>`,
      `<text x="${x + 16}" y="${y + 22}" font-weight="700" fill="#212529">${esc(c.titulo)}</text>`,
      ...c.linhas.map((l, k) => `<text x="${x + 16}" y="${y + 42 + k * 18}" fill="#454D50">${esc(l)}</text>`),
    );
    if (c.lado?.length) {
      const lh = 16 + c.lado.length * 18;
      partes.push(
        `<line x1="${x + bw}" y1="${y + h / 2}" x2="${x + bw + 28}" y2="${y + h / 2}" stroke="#454D50" marker-end="url(#seta)"/>`,
        `<rect x="${x + bw + 30}" y="${y + h / 2 - lh / 2}" width="230" height="${lh}" rx="8" fill="#ffffff" stroke="#DC3545"/>`,
        ...c.lado.map((l, k) => `<text x="${x + bw + 44}" y="${y + h / 2 - lh / 2 + 22 + k * 18}" fill="#454D50">${esc(l)}</text>`),
      );
    }
    if (i < caixas.length - 1) partes.push(`<line x1="${x + bw / 2}" y1="${y + h}" x2="${x + bw / 2}" y2="${y + h + gap - 4}" stroke="#454D50" marker-end="url(#seta)"/>`);
    y += h + gap;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" font-family="Roboto, Arial, sans-serif" font-size="13">
<defs><marker id="seta" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#454D50"/></marker></defs>
<rect width="100%" height="100%" fill="#ffffff"/>
<text x="${x}" y="34" font-size="17" font-weight="700" fill="#003D27">Fluxo de seleção dos estudos</text>
${partes.join('\n')}
</svg>`;
}
