import { z } from 'zod';
import { esc } from '#pdf/render.ts';

/**
 * Cronograma do projeto: etapas (linhas) x períodos (colunas) agrupados por ano.
 * As marcações ficam guardadas por mês ("AAAA-MM"): trocar a granularidade (mensal, bimestral,
 * trimestral...) não perde nada — um período aparece marcado quando algum mês dele está marcado.
 */

export const GRANULARIDADES = {
  MENSAL: { porAno: 12, rotulo: 'Mensal', plural: 'mensais', curto: '' },
  BIMESTRAL: { porAno: 6, rotulo: 'Bimestral', plural: 'bimestrais', curto: 'Bim' },
  TRIMESTRAL: { porAno: 4, rotulo: 'Trimestral', plural: 'trimestrais', curto: 'Trim' },
  QUADRIMESTRAL: { porAno: 3, rotulo: 'Quadrimestral', plural: 'quadrimestrais', curto: 'Quad' },
  SEMESTRAL: { porAno: 2, rotulo: 'Semestral', plural: 'semestrais', curto: 'Sem' },
  ANUAL: { porAno: 1, rotulo: 'Anual', plural: 'anuais', curto: '' },
} as const;
export type Granularidade = keyof typeof GRANULARIDADES;

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

export type EtapaCronograma = {
  id: string;
  nome: string;
  /** REVISAO: veio das etapas de uma revisão; PESQUISA: etapa típica de pesquisa; LIVRE: digitada */
  origem: 'REVISAO' | 'PESQUISA' | 'LIVRE';
  revisaoEtapaId?: string | null;
  meses: string[];
};
export type DadosCronograma = {
  granularidade: Granularidade;
  anoInicio: number;
  anoFim: number;
  etapas: EtapaCronograma[];
  /** na impressão, esconde a etapa no bloco de anos em que ela não tem nenhum período marcado */
  ocultarVazias?: boolean;
};
export type Periodo = { chave: string; ano: number; rotulo: string; meses: string[] };

const MES = /^\d{4}-(0[1-9]|1[0-2])$/;
export const MAX_ANOS = 21;

export const esquemaCronograma = z
  .object({
    granularidade: z.enum(Object.keys(GRANULARIDADES) as [Granularidade, ...Granularidade[]]),
    anoInicio: z.number().int().min(1950).max(2200),
    anoFim: z.number().int().min(1950).max(2200),
    ocultarVazias: z.boolean().optional(),
    etapas: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(64),
          nome: z.string().trim().min(1).max(200),
          origem: z.enum(['REVISAO', 'PESQUISA', 'LIVRE']),
          revisaoEtapaId: z.string().max(36).nullable().optional(),
          meses: z.array(z.string().regex(MES)).max(12 * MAX_ANOS),
        }),
      )
      .max(100),
  })
  .refine((d) => d.anoFim >= d.anoInicio, {
    message: 'O ano final não pode ser anterior ao inicial',
    path: ['anoFim'],
  })
  .refine((d) => d.anoFim - d.anoInicio < MAX_ANOS, {
    message: `O cronograma cobre no máximo ${MAX_ANOS} anos`,
    path: ['anoFim'],
  });

const mes = (ano: number, m: number) => `${ano}-${String(m).padStart(2, '0')}`;

/** Períodos de um ano na granularidade escolhida, com os meses de cada um */
export function periodosDoAno(g: Granularidade, ano: number): Periodo[] {
  const { porAno, curto } = GRANULARIDADES[g];
  const tamanho = 12 / porAno;
  return Array.from({ length: porAno }, (_, i) => {
    const meses = Array.from({ length: tamanho }, (_, k) => mes(ano, i * tamanho + k + 1));
    const rotulo = g === 'MENSAL' ? MESES[i] : g === 'ANUAL' ? String(ano) : `${curto} ${i + 1}`;
    return { chave: `${ano}-${g[0]}${i + 1}`, ano, rotulo, meses };
  });
}

export const anosDe = (d: Pick<DadosCronograma, 'anoInicio' | 'anoFim'>) =>
  Array.from({ length: Math.max(0, d.anoFim - d.anoInicio + 1) }, (_, i) => d.anoInicio + i);

/** Anos lado a lado em cada bloco, para a tabela caber na página (até 12 colunas de período) */
export const anosPorBloco = (g: Granularidade) =>
  g === 'ANUAL' ? 12 : Math.max(1, Math.floor(12 / GRANULARIDADES[g].porAno));

export function blocosDeAnos(
  d: Pick<DadosCronograma, 'anoInicio' | 'anoFim' | 'granularidade'>,
): number[][] {
  const anos = anosDe(d);
  const n = anosPorBloco(d.granularidade);
  const blocos: number[][] = [];
  for (let i = 0; i < anos.length; i += n) blocos.push(anos.slice(i, i + n));
  return blocos;
}

export const periodoMarcado = (e: Pick<EtapaCronograma, 'meses'>, p: Periodo) =>
  p.meses.some((m) => e.meses.includes(m));

/** Primeiro e último mês marcados da etapa (para o texto do relatório) */
export function intervaloDaEtapa(
  e: Pick<EtapaCronograma, 'meses'>,
): { inicio: string; fim: string } | null {
  if (!e.meses.length) return null;
  const ord = [...e.meses].sort();
  return { inicio: ord[0], fim: ord.at(-1)! };
}

export const mesPorExtenso = (m: string) => {
  const [a, n] = m.split('-');
  return `${MESES[Number(n) - 1].toLowerCase()}/${a}`;
};

/** Ordena e remove meses repetidos ou fora do intervalo de anos */
export function normalizarCronograma(d: DadosCronograma): DadosCronograma {
  return {
    ...d,
    etapas: d.etapas.map((e) => ({
      ...e,
      meses: [...new Set(e.meses)]
        .filter((m) => {
          const a = Number(m.slice(0, 4));
          return a >= d.anoInicio && a <= d.anoFim;
        })
        .sort(),
    })),
  };
}

// cores do modelo de cronograma: cabeçalho azul-acinzentado e verde para a execução da etapa
export const COR_CABECALHO = '#A2C4C9';
export const COR_SUBCABECALHO = '#D0E0E3';
export const COR_EXECUCAO = '#93C47D';

/** Quadro do cronograma em HTML (PDF e Word): um bloco de anos por tabela */
export function htmlCronograma(d: DadosCronograma, titulo = 'Cronograma'): string {
  const borda = 'border:1px solid #000;padding:3px 4px';
  const blocos = blocosDeAnos(d);
  const fim = d.anoFim;
  const tabelas = blocos.map((anos, b) => {
    const periodos = anos.map((a) => periodosDoAno(d.granularidade, a));
    const todos = periodos.flat();
    const etapas =
      d.ocultarVazias === false
        ? d.etapas
        : d.etapas.filter((e) => todos.some((p) => periodoMarcado(e, p)));
    const linhaAnos =
      d.granularidade === 'ANUAL'
        ? ''
        : `<tr><th rowspan="2" style="${borda};background-color:${COR_SUBCABECALHO};text-align:left;width:30%">Etapa</th>${anos
            .map(
              (a) =>
                `<th colspan="${GRANULARIDADES[d.granularidade].porAno}" style="${borda};background-color:${COR_SUBCABECALHO};text-align:left">${a}</th>`,
            )
            .join('')}</tr>`;
    const linhaPeriodos = `<tr>${d.granularidade === 'ANUAL' ? `<th style="${borda};background-color:${COR_SUBCABECALHO};text-align:left;width:30%">Etapa</th>` : ''}${todos
      .map(
        (p) =>
          `<th style="${borda};background-color:${COR_SUBCABECALHO};text-align:center;font-size:8pt">${esc(p.rotulo)}</th>`,
      )
      .join('')}</tr>`;
    const linhas = etapas.length
      ? etapas
          .map(
            (e) =>
              `<tr><td style="${borda}">${esc(e.nome)}</td>${todos
                .map((p) =>
                  periodoMarcado(e, p)
                    ? `<td style="${borda};background-color:${COR_EXECUCAO}" title="Em execução"></td>`
                    : `<td style="${borda}"></td>`,
                )
                .join('')}</tr>`,
          )
          .join('')
      : `<tr><td colspan="${todos.length + 1}" style="${borda};color:#8a9396;font-style:italic">Nenhuma etapa marcada em ${anos[0]}${anos.length > 1 ? `–${anos.at(-1)}` : ''}</td></tr>`;
    const cab =
      b === 0
        ? `<tr><th colspan="${todos.length + 1}" style="${borda};background-color:${COR_CABECALHO};text-align:left">${esc(titulo)} para ${d.anoInicio}${fim !== d.anoInicio ? `–${fim}` : ''}</th></tr>`
        : '';
    return `<table class="cronograma" style="border-collapse:collapse;width:100%;font-size:9pt;margin-bottom:${b === blocos.length - 1 ? 4 : 0}px"><thead>${cab}${linhaAnos}${linhaPeriodos}</thead><tbody>${linhas}</tbody></table>`;
  });
  return tabelas.join('');
}
