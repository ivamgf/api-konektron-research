import { db } from '#database/connection.ts';
import { elegiveis } from './revisoes.service.ts';

/**
 * Diagrama de fluxo da seleção de estudos (RF33), montado com os dados da revisão:
 * três colunas — estudos de revisões anteriores, novos estudos das bases de dados (com uma linha
 * por fase de triagem e os motivos de exclusão) e novos estudos de outras fontes (integrados) —
 * convergindo para o total de incluídos. Layout, textos e cores próprios do Konektron.
 */

export type ItemContagem = { rotulo: string; n: number };
export type FaseDiagrama = {
  etapaId: string;
  ordem: number;
  nome: string;
  status: string;
  avaliados: number;
  selecionados: number;
  excluidos: number;
  semDecisao: number;
  motivos: ItemContagem[];
};
export type DadosDiagrama = {
  revisaoAnterior: number;
  bases: ItemContagem[];
  identificados: number;
  removidosAntes: ItemContagem[];
  fases: FaseDiagrama[];
  outrasFontes: ItemContagem[];
  totalOutrasFontes: number;
  incluidos: { novos: number; revisaoAnterior: number; integrados: number; total: number };
};

const MOTIVOS: Record<string, string> = {
  CRITERIO: 'Critério de exclusão',
  DUPLICADO: 'Duplicados',
  SEM_ACESSO: 'Sem acesso ao texto completo',
  OUTRO: 'Outros motivos',
};

export async function dadosDiagrama(revisaoId: string): Promise<DadosDiagrama> {
  // ---- identificação nas bases (buscas): registros retornados x documentos que entraram na revisão
  const porBusca = await db('busca as b')
    .join('baseDados as bd', 'bd.id', 'b.baseDadosId')
    .where('b.revisaoId', revisaoId)
    .groupBy('bd.nome')
    .select('bd.nome as base')
    .sum({ retornados: 'b.qtdRetornada' });
  const naRevisao = await db('revisaoDocumento as rd')
    .join('busca as b', 'b.id', 'rd.buscaId')
    .join('baseDados as bd', 'bd.id', 'b.baseDadosId')
    .where('rd.revisaoId', revisaoId)
    .where('rd.origem', 'BUSCA')
    .groupBy('bd.nome')
    .select('bd.nome as base')
    .count({ n: '*' });
  const nomes = new Set([...porBusca.map((x: any) => x.base), ...naRevisao.map((x: any) => x.base)]);
  const bases = [...nomes]
    .map((base) => {
      const ret = Number(porBusca.find((x: any) => x.base === base)?.retornados ?? 0);
      const rd = Number(naRevisao.find((x: any) => x.base === base)?.n ?? 0);
      return { rotulo: base as string, n: Math.max(ret, rd), naRevisao: rd };
    })
    .filter((b) => b.n > 0)
    .sort((a, b) => b.n - a.n);
  const identificados = bases.reduce((s, b) => s + b.n, 0);
  const importados = bases.reduce((s, b) => s + b.naRevisao, 0);

  // ---- removidos antes da triagem: não importados, duplicados e exclusões das etapas sem triagem
  const etapas = await db('revisaoEtapa').where({ revisaoId }).orderBy('ordem');
  const triagens = etapas.filter((e: any) => e.exigeTriagem);
  const primeiraTriagem = triagens[0]?.ordem ?? Infinity;
  const duplicados = Number(
    (await db('revisaoDocumento').where({ revisaoId, origem: 'BUSCA' }).whereNotNull('duplicadoDeId').count({ n: '*' }).first())?.n ?? 0,
  );
  const exclusoesAntes = await db('triagemResultado as tr')
    .join('revisaoEtapa as e', 'e.id', 'tr.revisaoEtapaId')
    .join('revisaoDocumento as rd', 'rd.id', 'tr.revisaoDocumentoId')
    .where('e.revisaoId', revisaoId)
    .where('e.exigeTriagem', false)
    .where('e.ordem', '<', primeiraTriagem)
    .where('tr.decisaoFinal', 'EXCLUIDO')
    .whereNull('rd.duplicadoDeId')
    .groupBy('tr.motivo')
    .select('tr.motivo')
    .count({ n: '*' });
  const removidosAntes: ItemContagem[] = [];
  if (identificados > importados) removidosAntes.push({ rotulo: 'Não importados (filtros ou limites da busca)', n: identificados - importados });
  if (duplicados) removidosAntes.push({ rotulo: 'Registros duplicados', n: duplicados });
  for (const x of exclusoesAntes as any[]) {
    if (!Number(x.n)) continue;
    const rotulo = x.motivo === 'DUPLICADO' ? 'Registros duplicados' : (MOTIVOS[x.motivo] ?? 'Outros motivos');
    const igual = removidosAntes.find((r) => r.rotulo === rotulo);
    if (igual) igual.n += Number(x.n);
    else removidosAntes.push({ rotulo, n: Number(x.n) });
  }

  // ---- fases de triagem (só documentos elegíveis em cada fase, RN09)
  const fases: FaseDiagrama[] = [];
  for (const e of triagens) {
    const base = () => elegiveis(e).join('triagemResultado as r', function () {
      this.on('r.revisaoDocumentoId', 'rd.id').andOn('r.revisaoEtapaId', db.raw('?', [e.id]));
    });
    const avaliados = Number((await elegiveis(e).count({ n: '*' }).first())?.n ?? 0);
    const decisoes = await base().groupBy('r.decisaoFinal').select('r.decisaoFinal as d').count({ n: '*' });
    const qtd = (d: string) => Number(decisoes.find((x: any) => x.d === d)?.n ?? 0);
    const motivos = await base()
      .leftJoin('criterio as c', 'c.id', 'r.criterioId')
      .where('r.decisaoFinal', 'EXCLUIDO')
      .groupBy('r.motivo', 'c.nome')
      .select('r.motivo', 'c.nome as criterio')
      .count({ n: '*' });
    fases.push({
      etapaId: e.id,
      ordem: e.ordem,
      nome: e.nome,
      status: e.status,
      avaliados,
      selecionados: qtd('SELECIONADO'),
      excluidos: qtd('EXCLUIDO'),
      semDecisao: Math.max(0, avaliados - qtd('SELECIONADO') - qtd('EXCLUIDO')),
      motivos: motivos
        .map((m: any) => ({ rotulo: m.motivo === 'CRITERIO' && m.criterio ? m.criterio : (MOTIVOS[m.motivo] ?? 'Outros motivos'), n: Number(m.n) }))
        .sort((a: ItemContagem, b: ItemContagem) => b.n - a.n),
    });
  }

  // ---- outras origens
  const especiais = await db('revisaoDocumento as rd')
    .join('documento as d', 'd.id', 'rd.documentoId')
    .leftJoin('baseDados as bd', 'bd.id', 'd.baseDadosId')
    .where('rd.revisaoId', revisaoId)
    .whereIn('rd.origem', ['REVISAO_ANTERIOR', 'INTEGRADO'])
    .groupBy('rd.origem', 'bd.nome')
    .select('rd.origem', 'bd.nome as base')
    .count({ n: '*' });
  const revisaoAnterior = especiais.filter((x: any) => x.origem === 'REVISAO_ANTERIOR').reduce((s: number, x: any) => s + Number(x.n), 0);
  const outrasFontes = especiais
    .filter((x: any) => x.origem === 'INTEGRADO')
    .map((x: any) => ({ rotulo: x.base ?? 'Fonte não informada', n: Number(x.n) }))
    .sort((a: ItemContagem, b: ItemContagem) => b.n - a.n);
  const totalOutrasFontes = outrasFontes.reduce((s: number, x: ItemContagem) => s + x.n, 0);
  const novos = fases.at(-1)?.selecionados ?? 0;

  return {
    revisaoAnterior,
    bases: bases.map(({ rotulo, n }) => ({ rotulo, n })),
    identificados,
    removidosAntes,
    fases,
    outrasFontes,
    totalOutrasFontes,
    incluidos: { novos, revisaoAnterior, integrados: totalOutrasFontes, total: novos + revisaoAnterior + totalOutrasFontes },
  };
}

// ------------------------------------------------------------------ SVG

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Quebra o texto em linhas de até `max` caracteres (aproximação para a fonte de 12–13 px) */
export function quebrar(texto: string, max: number): string[] {
  const linhas: string[] = [];
  let atual = '';
  // só espaço comum quebra a linha: o espaço fixo (U+00A0) mantém "(n = 10)" junto
  for (const p of texto.split(/[ \t\r\n]+/).filter(Boolean)) {
    if (!atual) atual = p;
    else if ((atual + ' ' + p).length <= max) atual += ' ' + p;
    else {
      linhas.push(atual);
      atual = p;
    }
    while (atual.length > max) {
      linhas.push(atual.slice(0, max - 1) + '-');
      atual = atual.slice(max - 1);
    }
  }
  if (atual) linhas.push(atual);
  return linhas.length ? linhas : [''];
}

const COR = {
  texto: '#1F2A2E',
  suave: '#4A5A60',
  seta: '#5B6B70',
  anterior: { faixa: '#0E6E8C', caixa: '#E3F3F8', borda: '#0E6E8C' },
  bases: { faixa: '#007A4F', caixa: '#E6F5EE', borda: '#007A4F' },
  outras: { faixa: '#8A5A00', caixa: '#FBF1DC', borda: '#B37700' },
  exclusao: { caixa: '#FFFFFF', borda: '#C0392B' },
  final: { caixa: '#007A4F', texto: '#FFFFFF' },
};

type Caixa = { x: number; y: number; w: number; h: number };
type Bloco = { titulo: string; linhas: string[]; forte?: boolean };

const LH = 16; // altura da linha de texto
const PAD = 12;

function alturaBloco(b: Bloco, w: number) {
  const n = quebrar(b.titulo, Math.floor((w - 2 * PAD) / 7)).length + b.linhas.reduce((s, l) => s + quebrar(l, Math.floor((w - 2 * PAD) / 6.6)).length, 0);
  return 2 * PAD + n * LH + (b.linhas.length ? 4 : 0);
}

function desenharBloco(c: Caixa, b: Bloco, cor: { caixa: string; borda: string; texto?: string }) {
  const out = [`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="10" fill="${cor.caixa}" stroke="${cor.borda}" stroke-width="1.4"/>`];
  let y = c.y + PAD + 12;
  const tc = cor.texto ?? COR.texto;
  for (const l of quebrar(b.titulo, Math.floor((c.w - 2 * PAD) / 7))) {
    out.push(`<text x="${c.x + c.w / 2}" y="${y}" text-anchor="middle" font-weight="700" fill="${tc}">${esc(l)}</text>`);
    y += LH;
  }
  if (b.linhas.length) y += 4;
  for (const linha of b.linhas) {
    for (const l of quebrar(linha, Math.floor((c.w - 2 * PAD) / 6.6))) {
      out.push(`<text x="${c.x + c.w / 2}" y="${y}" text-anchor="middle" fill="${cor.texto ?? COR.suave}" font-size="12">${esc(l)}</text>`);
      y += LH;
    }
  }
  return out.join('');
}

const seta = (x1: number, y1: number, x2: number, y2: number) =>
  `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${COR.seta}" stroke-width="1.4" fill="none" marker-end="url(#ponta)"/>`;
const caminho = (pts: [number, number][]) =>
  `<path d="M${pts.map(([x, y]) => `${x} ${y}`).join(' L')}" stroke="${COR.seta}" stroke-width="1.4" fill="none" marker-end="url(#ponta)"/>`;

const n = (v: number) => `(n\u00A0=\u00A0${v.toLocaleString('pt-BR')})`;

export function diagramaSvg(d: DadosDiagrama, titulo = 'Diagrama de fluxo da seleção de estudos'): string {
  const temAnterior = d.revisaoAnterior > 0;
  const temOutras = d.totalOutrasFontes > 0;
  const M = 24;
  const GAP = 28;
  const wA = 190;
  const wB = 270;
  const wX = 250; // caixas de exclusão
  const wC = 230;
  const xA = M;
  const xB = temAnterior ? xA + wA + GAP : M;
  const xX = xB + wB + GAP;
  const xC = xX + wX + GAP;
  const W = (temOutras ? xC + wC : xX + wX) + M;
  const partes: string[] = [];

  // faixas de título das colunas
  const yFaixa = 64;
  const hFaixa = 40;
  const faixa = (x: number, w: number, texto: string, cor: string) => {
    const linhas = quebrar(texto, Math.floor(w / 7.2));
    partes.push(`<rect x="${x}" y="${yFaixa}" width="${w}" height="${hFaixa}" rx="8" fill="${cor}"/>`);
    linhas.forEach((l, i) =>
      partes.push(`<text x="${x + w / 2}" y="${yFaixa + hFaixa / 2 + 5 + (i - (linhas.length - 1) / 2) * 14}" text-anchor="middle" font-weight="700" fill="#FFFFFF" font-size="12.5">${esc(l)}</text>`),
    );
  };
  if (temAnterior) faixa(xA, wA, 'Revisões anteriores', COR.anterior.faixa);
  faixa(xB, wB + GAP + wX, 'Novos estudos: bases de dados e repositórios', COR.bases.faixa);
  if (temOutras) faixa(xC, wC, 'Novos estudos: outras fontes', COR.outras.faixa);

  let y = yFaixa + hFaixa + 24;

  // ---- linha 1: identificação
  const ident: Bloco = {
    titulo: `Registros identificados ${n(d.identificados)}`,
    linhas: d.bases.length ? d.bases.map((b) => `${b.rotulo}: ${b.n.toLocaleString('pt-BR')}`) : ['Nenhuma busca registrada'],
  };
  const totalRemovidos = d.removidosAntes.reduce((s, x) => s + x.n, 0);
  const removidos: Bloco = {
    titulo: `Removidos antes da triagem ${n(totalRemovidos)}`,
    linhas: d.removidosAntes.length ? d.removidosAntes.map((x) => `${x.rotulo}: ${x.n.toLocaleString('pt-BR')}`) : ['Nenhum'],
  };
  const anterior: Bloco = { titulo: 'Estudos incluídos em revisões anteriores', linhas: [n(d.revisaoAnterior)] };
  const outras: Bloco = {
    titulo: `Registros de outras fontes ${n(d.totalOutrasFontes)}`,
    linhas: d.outrasFontes.map((x) => `${x.rotulo}: ${x.n.toLocaleString('pt-BR')}`),
  };
  const h1 = Math.max(alturaBloco(ident, wB), alturaBloco(removidos, wX), temAnterior ? alturaBloco(anterior, wA) : 0, temOutras ? alturaBloco(outras, wC) : 0);
  const cIdent = { x: xB, y, w: wB, h: h1 };
  partes.push(desenharBloco(cIdent, ident, COR.bases));
  partes.push(desenharBloco({ x: xX, y, w: wX, h: h1 }, removidos, COR.exclusao));
  partes.push(seta(xB + wB, y + h1 / 2, xX - 2, y + h1 / 2));
  const cAnterior = { x: xA, y, w: wA, h: h1 };
  if (temAnterior) partes.push(desenharBloco(cAnterior, anterior, COR.anterior));
  const cOutras = { x: xC, y, w: wC, h: h1 };
  if (temOutras) partes.push(desenharBloco(cOutras, outras, COR.outras));
  y += h1 + GAP + 8;

  // ---- uma linha por fase de triagem
  for (const f of d.fases) {
    const principal: Bloco = {
      titulo: f.nome,
      linhas: [
        `Avaliados ${n(f.avaliados)}`,
        `Selecionados: ${f.selecionados.toLocaleString('pt-BR')}`,
        ...(f.semDecisao ? [`Sem decisão: ${f.semDecisao.toLocaleString('pt-BR')}`] : []),
        ...(f.status === 'DISPENSADA' ? ['Fase dispensada'] : f.status === 'PENDENTE' ? ['Fase não iniciada'] : []),
      ],
    };
    const exc: Bloco = {
      titulo: `Excluídos ${n(f.excluidos)}`,
      linhas: f.motivos.length ? f.motivos.map((m) => `${m.rotulo}: ${m.n.toLocaleString('pt-BR')}`) : ['Nenhuma exclusão'],
    };
    const h = Math.max(alturaBloco(principal, wB), alturaBloco(exc, wX));
    partes.push(seta(xB + wB / 2, y - GAP - 8, xB + wB / 2, y - 2));
    partes.push(desenharBloco({ x: xB, y, w: wB, h }, principal, COR.bases));
    partes.push(desenharBloco({ x: xX, y, w: wX, h }, exc, COR.exclusao));
    partes.push(seta(xB + wB, y + h / 2, xX - 2, y + h / 2));
    y += h + GAP + 8;
  }

  // ---- incluídos
  const final: Bloco = {
    titulo: `Estudos incluídos na revisão ${n(d.incluidos.total)}`,
    linhas: [
      `Novos estudos das bases: ${d.incluidos.novos.toLocaleString('pt-BR')}`,
      ...(temAnterior ? [`De revisões anteriores: ${d.incluidos.revisaoAnterior.toLocaleString('pt-BR')}`] : []),
      ...(temOutras ? [`De outras fontes: ${d.incluidos.integrados.toLocaleString('pt-BR')}`] : []),
    ],
  };
  const hF = alturaBloco(final, wB);
  partes.push(seta(xB + wB / 2, y - GAP - 8, xB + wB / 2, y - 2));
  partes.push(desenharBloco({ x: xB, y, w: wB, h: hF }, final, { caixa: COR.final.caixa, borda: COR.final.caixa, texto: COR.final.texto }));
  const meio = y + hF / 2;
  if (temAnterior) partes.push(caminho([[xA + wA / 2, cAnterior.y + cAnterior.h], [xA + wA / 2, meio], [xB - 2, meio]]));
  if (temOutras) partes.push(caminho([[xC + wC / 2, cOutras.y + cOutras.h], [xC + wC / 2, meio], [xB + wB + 2, meio]]));
  y += hF + M;

  const H = y + 18;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Roboto, 'Segoe UI', Arial, sans-serif" font-size="13">
<defs><marker id="ponta" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${COR.seta}"/></marker></defs>
<rect width="100%" height="100%" fill="#FFFFFF"/>
<text x="${M}" y="38" font-size="18" font-weight="700" fill="#003D27">${esc(titulo)}</text>
${partes.join('\n')}
<text x="${W - M}" y="${H - 10}" text-anchor="end" font-size="10" fill="${COR.suave}">Gerado pelo Konektron Research com os dados da revisão</text>
</svg>`;
}
