import { esc, ESTILO, paragrafos } from '#pdf/render.ts';
import { capa } from '#pdf/protocolo.ts';
import { nomeMetodologia } from '#modules/protocolo/tcle.ts';
import { diagramaSvg } from '#modules/revisoes/diagrama.ts';
import { GRANULARIDADES, htmlCronograma } from './cronograma.ts';
import {
  secoesPadrao,
  type DadosRelatorio,
  type OpcoesRelatorio,
  type SecaoRelatorio,
} from './relatorio.service.ts';

/**
 * HTML do relatório de pesquisa (PDF no Chrome e Word pelo html-to-docx), na ordem do template:
 * identificação, resumo, introdução, método, cronograma, resultados da seleção, caracterização,
 * análise, matriz/discussão, checklist, considerações finais, referências e apêndices A–D.
 * As seções omitidas não deixam buracos na numeração.
 */

const ROTULOS: Record<string, string> = {
  // papéis
  RESPONSAVEL: 'Pesquisador(a) responsável',
  ORIENTADOR: 'Orientador(a)',
  COLABORADOR: 'Revisor(a)',
  LEITOR: 'Leitor(a)',
  // status
  PLANEJADA: 'Planejada',
  EM_ANDAMENTO: 'Em andamento',
  CONCLUIDA: 'Concluída',
  CANCELADA: 'Cancelada',
  PENDENTE: 'Pendente',
  DISPENSADA: 'Dispensada',
  RASCUNHO: 'Rascunho',
  CONCLUIDO: 'Concluído',
  APROVADO: 'Aprovado',
  DEVOLVIDO: 'Devolvido',
  ABERTA: 'Aberta',
  NAO_INICIADO: 'Não iniciado',
  PARCIAL: 'Parcial',
  REALIZADO: 'Realizado',
  NAO_REALIZADO: 'Não realizado',
  ND: 'Sem definição',
  // categorias de etapa
  PROTOCOLO: 'Protocolo',
  BUSCA: 'Busca',
  DEDUPLICACAO: 'Deduplicação',
  TRIAGEM: 'Triagem',
  INCLUSAO: 'Inclusão',
  ANALISE: 'Análise',
  SINTESE: 'Síntese',
  DISCUSSAO: 'Discussão',
  CHECKLIST: 'Checklist',
  LIVRE: 'Livre',
  // origem e motivos
  REVISAO_ANTERIOR: 'Revisão anterior',
  INTEGRADO: 'Integrado (snowballing)',
  MANUAL: 'Inclusão manual',
  CRITERIO: 'Critério de exclusão',
  DUPLICADO: 'Duplicado',
  SEM_ACESSO: 'Sem acesso ao texto completo',
  OUTRO: 'Outro motivo',
  // campos de busca e vocabulários
  TITULO: 'Título',
  RESUMO: 'Resumo',
  PALAVRAS_CHAVE: 'Palavras-chave',
  TODOS: 'Todos os campos',
  DECS: 'DeCS',
  MESH: 'MeSH',
};
const rot = (v: unknown) => (v ? (ROTULOS[String(v)] ?? String(v)) : '—');
const IDIOMAS: Record<string, string> = {
  pt: 'Português',
  en: 'Inglês',
  es: 'Espanhol',
  fr: 'Francês',
  de: 'Alemão',
  it: 'Italiano',
};

const dataBr = (v: unknown) => {
  if (!v) return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
    return v.split('-').reverse().join('/');
  return new Date(v as string).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
};
const dataHoraUtc = (v: unknown) =>
  v ? new Date(v as string).toISOString().replace('T', ' ').slice(0, 16) : '—';
const n = (v: number) => v.toLocaleString('pt-BR');
const vazio = (v: unknown) => !String(v ?? '').trim();
const autorAno = (d: { autores?: string | null; ano?: number | null }) => {
  const primeiro = (d.autores ?? '').split(/;|\n/)[0]?.trim();
  const sobrenome = primeiro?.includes(',')
    ? primeiro.split(',')[0].trim()
    : (primeiro?.split(/\s+/).pop() ?? '');
  const varios = (d.autores ?? '').split(/;|\n/).filter((x) => x.trim()).length > 1;
  return `${sobrenome ? `${sobrenome}${varios ? ' et al.' : ''}` : 'Autoria não informada'} (${d.ano ?? 's.d.'})`;
};

function tabela(
  cabecalho: string[],
  linhas: string[][],
  textoVazio = 'Nenhum registro',
  classe = '',
) {
  return `<table${classe ? ` class="${classe}"` : ''}><thead><tr>${cabecalho.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
    linhas.length
      ? linhas.map((l) => `<tr>${l.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cabecalho.length}" class="vazio">${esc(textoVazio)}</td></tr>`
  }</tbody></table>`;
}

const ESTILO_RELATORIO = `${ESTILO}
  h4 { color: #212529; font-size: 11pt; margin: 12px 0 4px; }
  .orientacao { color: #6c757d; font-style: italic; }
  .quadro { text-align: center; font-size: 10pt; font-weight: bold; margin: 12px 0 4px; }
  .fonte { font-size: 9pt; margin: 2px 0 12px; }
  table.compacta { font-size: 8.5pt; }
  table.cronograma th, table.cronograma td { padding: 3px 4px; }
  .diagrama { text-align: center; margin: 8px 0; }
`;

export const opcoesCompletas = (
  o: Partial<OpcoesRelatorio> | undefined,
  sistematica: boolean,
): OpcoesRelatorio => ({
  secoes: o?.secoes?.length ? o.secoes : secoesPadrao(sistematica),
  norma: o?.norma === 'APA' ? 'APA' : 'ABNT',
  orientacoes: o?.orientacoes ?? true,
  capa: o?.capa ?? true,
});

export function htmlRelatorio(
  d: DadosRelatorio,
  opcoesParciais?: Partial<OpcoesRelatorio>,
): string {
  const o = opcoesCompletas(opcoesParciais, d.sistematica);
  const inclui = (s: SecaoRelatorio) => o.secoes.includes(s);
  const p = d.protocolo;
  const r = d.revisao;
  const rd = d.revisaoDados;
  const t = d.textos ?? {};

  // numeração: seções principais 1..n; subseções n.1, n.2...; apêndices A, B...
  let sec = 0;
  let sub = 0;
  const h2 = (titulo: string) => {
    sec++;
    sub = 0;
    return `<h2>${sec}. ${esc(titulo)}</h2>`;
  };
  const h3 = (titulo: string) => `<h3>${sec}.${++sub} ${esc(titulo)}</h3>`;
  const letras = (['apendiceA', 'apendiceB', 'apendiceC', 'apendiceD'] as const).filter(inclui);
  const letra = (s: (typeof letras)[number]) => String.fromCharCode(65 + letras.indexOf(s));
  const apendice = (s: (typeof letras)[number]) => (inclui(s) ? `Apêndice ${letra(s)}` : null);
  /** título do apêndice; o primeiro começa página nova */
  const tituloApendice = (s: (typeof letras)[number], titulo: string) =>
    `<h2${letras[0] === s ? ' class="quebra"' : ''}>Apêndice ${letra(s)} — ${esc(titulo)}</h2>`;
  let quadros = 0;
  const quadro = (
    titulo: string,
    corpo: string,
    fonte = `Fonte: Konektron Research, a partir dos dados do projeto (${new Date(d.geradoEm).getFullYear()}).`,
  ) =>
    `<p class="quadro">Quadro ${++quadros} – ${esc(titulo)}</p>${corpo}<p class="fonte">${esc(fonte)}</p>`;

  /** texto do pesquisador; vazio, a orientação do template em itálico (quando ligada) */
  const escrito = (valor: string | undefined, orientacao: string) =>
    !vazio(valor)
      ? paragrafos(valor)
      : o.orientacoes
        ? `<p class="orientacao">${esc(orientacao)}</p>`
        : '';
  const orient = (texto: string) =>
    o.orientacoes ? `<p class="orientacao">${esc(texto)}</p>` : '';
  const semRevisao = '<p class="vazio">Nenhuma revisão cadastrada no projeto.</p>';

  const partes: string[] = [];
  if (o.capa) {
    partes.push(
      capa({
        rotulo: 'RELATÓRIO DE PESQUISA',
        projeto: d.projeto,
        equipe: d.equipe,
        linha: [
          r ? esc(r.titulo) : null,
          p ? `Protocolo v${p.versaoAtual ?? 0} (${esc(rot(p.status))})` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }),
    );
  }

  // ---------------------------------------------------------------- 1. Identificação
  if (inclui('identificacao')) {
    const linhas: [string, string][] = [
      ['Área', esc(d.projeto.area ?? '—')],
      ['Instituição', esc(d.projeto.instituicao ?? '—')],
      ['Programa', esc(d.projeto.programa ?? '—')],
      ['Período', `${dataBr(d.projeto.dataInicio)} a ${dataBr(d.projeto.dataFim)}`],
    ];
    if (r) {
      linhas.push(
        ['Revisão', esc(r.titulo)],
        ['Tipo de revisão', esc(r.tipoNome)],
        ['Status da revisão', esc(rot(r.status))],
      );
      if (r.registroUrl)
        linhas.push([
          'Registro da revisão',
          `${r.registroIdentificador ? `${esc(r.registroIdentificador)} — ` : ''}${esc(r.registroUrl)}`,
        ]);
    }
    if (p) linhas.push(['Versão do protocolo', `v${p.versaoAtual ?? 0} (${esc(rot(p.status))})`]);
    linhas.push(['Data de emissão', dataBr(d.geradoEm)]);
    partes.push(`${h2('Identificação do projeto')}
<p><b>${esc(d.projeto.titulo)}</b>${d.projeto.subtitulo ? `: ${esc(d.projeto.subtitulo)}` : ''}</p>
<table>${linhas.map(([c, v]) => `<tr><th style="width:30%">${c}</th><td>${v}</td></tr>`).join('')}</table>
<h3>Equipe</h3>
${tabela(
  ['Nome', 'Papel', 'ORCID', 'Instituição'],
  d.equipe.map((m: any) => [
    esc(m.nome),
    esc(rot(m.papel)),
    `<span class="mono">${esc(m.orcid ?? '—')}</span>`,
    esc(m.instituicao ?? '—'),
  ]),
  'Nenhum membro com convite aceito',
)}`);
  }

  // dados derivados usados em várias seções
  const buscas = rd?.buscas ?? [];
  const bases = [...new Set(buscas.map((b: any) => b.baseNome as string))];
  const datas = buscas.map((b: any) => String(b.dataBusca)).sort();
  const retornados = buscas.reduce((s: number, b: any) => s + Number(b.qtdRetornada ?? 0), 0);
  const importados = buscas.reduce((s: number, b: any) => s + Number(b.qtdImportada ?? 0), 0);
  const incluidos = rd?.incluidos ?? [];
  const palavrasPt = (() => {
    const todas = p?.palavrasChave ?? [];
    const pt = todas.filter((k: any) => k.idiomaCodigo === 'pt');
    return (pt.length ? pt : todas).map((k: any) => k.termo as string);
  })();
  const listaBases = (xs: string[]) =>
    xs.length > 1 ? `${xs.slice(0, -1).join(', ')} e ${xs.at(-1)}` : (xs[0] ?? '');

  // ---------------------------------------------------------------- 2. Resumo
  if (inclui('resumo')) {
    const metodo = r
      ? `revisão ${esc(r.tipoNome.toLowerCase())}${bases.length ? ` conduzida nas bases ${esc(listaBases(bases))}` : ''}${datas.length ? `, com buscas entre ${dataBr(datas[0])} e ${dataBr(datas.at(-1))}` : ''}.`
      : esc(p ? (nomeMetodologia(p) ?? 'Não informado') : 'Não informado');
    partes.push(`${h2('Resumo')}
${vazio(t.resumoAchados) ? orient('Redija por último, em até 250 palavras, com objetivo, método, fontes, número de estudos incluídos e principais achados (item CG02 do checklist).') : ''}
<p><b>Objetivo:</b> ${esc(p?.objetivoGeral ?? '—')}</p>
<p><b>Método:</b> ${metodo}</p>
${r ? `<p><b>Resultados:</b> ${n(retornados)} registros identificados, ${n(incluidos.length)} estudos incluídos. ${vazio(t.resumoAchados) ? (o.orientacoes ? '<span class="orientacao">Principais achados.</span>' : '') : esc(t.resumoAchados)}</p>` : ''}
<p><b>Conclusão:</b> ${vazio(t.resumoConclusao) ? (o.orientacoes ? '<span class="orientacao">Síntese da resposta à questão de pesquisa.</span>' : '—') : esc(t.resumoConclusao)}</p>
<p><b>Palavras-chave:</b> ${esc(palavrasPt.join('; ') || '—')}</p>`);
  }

  // ---------------------------------------------------------------- 3. Introdução
  if (inclui('introducao')) {
    partes.push(`${h2('Introdução')}
${h3('Tema')}${paragrafos(p?.tema)}
${h3('Justificativa')}${paragrafos(p?.justificativa)}
${escrito(t.introducao, 'Complete com o estado atual do conhecimento e a lacuna que a revisão cobre (CG03).')}
${h3('Questão de pesquisa')}<p><b>QP:</b> ${esc(p?.questaoPesquisa ?? '—')}</p>
${(p?.outrasQuestoes ?? []).length ? `<ul>${p!.outrasQuestoes.map((q: any, i: number) => `<li><b>QS${q.ordem ?? i + 1}:</b> ${esc(q.texto)}</li>`).join('')}</ul>` : ''}
${!vazio(p?.hipotese) ? `${h3('Hipótese')}${paragrafos(p!.hipotese)}` : ''}
${h3('Objetivos')}<p><b>Objetivo geral:</b> ${esc(p?.objetivoGeral ?? '—')}</p>
<p><b>Objetivos específicos</b></p>${(p?.objetivos ?? []).length ? `<ol>${p!.objetivos.map((x: any) => `<li>${esc(x.texto)}</li>`).join('')}</ol>` : '<p class="vazio">Não informado</p>'}`);
  }

  // ---------------------------------------------------------------- 4. Método
  if (inclui('metodo')) {
    const metodologia = p ? nomeMetodologia(p) : null;
    const etapas = rd?.etapas ?? [];
    const dispensadas = etapas.filter((e: any) => e.status === 'DISPENSADA');
    const executadas = new Set(buscas.map((b: any) => b.stringBuscaId).filter(Boolean));
    const naoExecutadas = (p?.strings ?? []).filter((s: any) => !executadas.has(s.id));
    const termos = [
      ...(p?.palavrasChave ?? []).map((k: any) => [
        esc(k.termo),
        esc(IDIOMAS[k.idiomaCodigo] ?? k.idiomaCodigo ?? '—'),
        '—',
      ]),
      ...(p?.descritores ?? []).map((x: any) => [
        esc(x.termo),
        esc(rot(x.vocabulario)),
        `<span class="mono">${esc(x.codigo ?? '—')}</span>`,
      ]),
    ];
    const criterios = (tipo: string) =>
      (p?.criterios ?? [])
        .filter((c: any) => c.tipo === tipo)
        .sort((a: any, b: any) => a.ordem - b.ordem)
        .map((c: any) => [esc(c.nome), esc(c.descricao ?? '')]);
    partes.push(`${h2('Método')}
${metodologia || !vazio(p?.metodologia) ? `${h3('Abordagem metodológica')}${metodologia ? `<p><b>${esc(metodologia)}</b></p>` : ''}${vazio(p?.metodologia) ? '' : paragrafos(p!.metodologia)}` : ''}
${
  r
    ? `${h3('Tipo de revisão e diretriz')}
<p>Trata-se de uma revisão ${esc(r.tipoNome.toLowerCase())}${r.tipoDescricao ? ` — ${esc(r.tipoDescricao)}` : ''}.${r.diretrizSigla ? ` O relato segue ${esc(r.diretrizNome)} (${esc(r.diretrizSigla)}${r.diretrizVersao ? ` ${esc(r.diretrizVersao)}` : ''})${r.diretrizUrl ? `, disponível em ${esc(r.diretrizUrl)}` : ''}.` : ''} A triagem foi feita por ${r.doisRevisores ? 'dois revisores independentes' : 'um revisor'}.</p>
${h3('Etapas da revisão')}
${tabela(
  ['Ordem', 'Etapa', 'Categoria', 'Status', 'Início', 'Conclusão'],
  etapas.map((e: any) => [
    String(e.ordem),
    esc(e.nome),
    esc(rot(e.categoria)),
    esc(rot(e.status)),
    dataBr(e.iniciadaEm),
    dataBr(e.concluidaEm),
  ]),
  'Sem etapas',
)}
${dispensadas.map((e: any) => `<p><b>Etapa dispensada — ${esc(e.nome)}:</b> ${esc(e.justificativaDispensa ?? 'sem justificativa registrada')}</p>`).join('')}`
    : semRevisao
}
${h3('Palavras-chave e descritores')}
${tabela(['Termo', 'Idioma / vocabulário', 'Código'], termos, 'Nenhum termo cadastrado')}
${
  r
    ? `${h3('Fontes e estratégias de busca')}
${tabela(
  ['Base', 'Data', 'Campo', 'Expressão usada', 'Filtros', 'Retornados'],
  buscas.map((b: any) => [
    esc(b.baseNome),
    dataBr(b.dataBusca),
    esc(rot(b.campo)),
    `<span class="mono">${esc(b.expressaoUsada)}</span>`,
    esc(b.filtros ?? '—'),
    n(Number(b.qtdRetornada ?? 0)),
  ]),
  'Nenhuma busca registrada',
  'compacta',
)}
${naoExecutadas.length && apendice('apendiceA') ? `<p>${naoExecutadas.length === 1 ? 'Uma string planejada não foi executada' : `${naoExecutadas.length} strings planejadas não foram executadas`} nesta revisão (${apendice('apendiceA')}).</p>` : ''}`
    : ''
}
${h3('Critérios de elegibilidade')}
<p><b>Inclusão</b></p>${tabela(['Critério', 'Descrição'], criterios('INCLUSAO'), 'Nenhum critério de inclusão')}
<p><b>Exclusão</b></p>${tabela(['Critério', 'Descrição'], criterios('EXCLUSAO'), 'Nenhum critério de exclusão')}
${h3('Extração e análise dos dados')}
${d.analises.length ? d.analises.map((a) => `<p>Os dados foram extraídos com as questões de análise do protocolo, registradas na análise <b>${esc(a.nome)}</b>.</p>${a.questoes.length ? `<ul>${a.questoes.map((q) => `<li><b>${esc(q.codigo)}:</b> ${esc(q.enunciado)}</li>`).join('')}</ul>` : ''}`).join('') : (p?.questoes ?? []).length ? `<p>Questões de análise do protocolo:</p><ul>${p!.questoes.map((q: any) => `<li><b>${esc(q.codigo)}:</b> ${esc(q.enunciado)}</li>`).join('')}</ul>` : '<p class="vazio">Nenhuma questão de análise cadastrada.</p>'}
${escrito(t.metodoSintese, 'Descreva o método de síntese (narrativa, temática, estatística) e, se houver, a avaliação de qualidade dos estudos (CG11–CG12).')}`);
  }

  // ---------------------------------------------------------------- Cronograma
  if (inclui('cronograma')) {
    const c = d.cronograma;
    partes.push(
      `${h2('Cronograma')}${
        c && c.etapas.length
          ? `<p>O quadro a seguir apresenta o cronograma de execução das etapas da pesquisa, em períodos ${GRANULARIDADES[c.granularidade].plural}, de ${c.anoInicio} a ${c.anoFim}. As células em verde indicam os períodos de execução de cada etapa.</p>${quadro('Cronograma', htmlCronograma(c, 'Cronograma'), `Fonte: elaborado pelos autores (${new Date(d.geradoEm).getFullYear()}).`)}`
          : orient(
              'Monte o cronograma na aba Cronograma do projeto: escolha as etapas, o período e marque em verde quando cada etapa será executada.',
            ) || '<p class="vazio">Cronograma não preenchido.</p>'
      }`,
    );
  }

  // ---------------------------------------------------------------- 5. Resultados da identificação e seleção
  if (inclui('resultados')) {
    if (!r || !rd) partes.push(`${h2('Resultados da identificação e seleção')}${semRevisao}`);
    else {
      const tot = rd.porBase.reduce(
        (s, b) => ({ c: s.c + b.consultados, i: s.i + b.importados, d: s.d + b.duplicados }),
        { c: 0, i: 0, d: 0 },
      );
      const o2 = rd.porOrigem;
      const fluxo = diagramaSvg(rd.diagrama).replace(
        '<svg ',
        '<svg style="max-width:100%;height:auto" ',
      );
      partes.push(`${h2('Resultados da identificação e seleção')}
<p>As buscas retornaram ${n(retornados)} registros; ${n(importados)} foram importados e ${n(incluidos.length)} estudos foram incluídos na síntese.</p>
${h3('Registros por base')}
${tabela(['Base', 'Consultados', 'Importados', 'Duplicados'], [...rd.porBase.map((b) => [esc(b.base), n(b.consultados), n(b.importados), n(b.duplicados)]), ...(rd.porBase.length ? [['<b>Total</b>', `<b>${n(tot.c)}</b>`, `<b>${n(tot.i)}</b>`, `<b>${n(tot.d)}</b>`]] : [])], 'Nenhuma busca registrada')}
<p>Outras origens: revisão anterior ${n(o2.REVISAO_ANTERIOR ?? 0)}, integrados/snowballing ${n(o2.INTEGRADO ?? 0)}, inclusão manual ${n(o2.MANUAL ?? 0)}.</p>
${h3('Seleção por etapa de triagem')}
${tabela(
  [
    'Etapa',
    'Avaliados',
    'Selecionados',
    'Excl. critério',
    'Excl. duplicado',
    'Excl. sem acesso',
    'Excl. outro',
    'Conflitos',
    'Sem decisão',
  ],
  rd.porEtapa.map((e) => [
    `${e.ordem}. ${esc(e.nome)}`,
    n(e.avaliados),
    n(e.selecionados),
    n(e.criterio),
    n(e.duplicados),
    n(e.semAcesso),
    n(e.outro),
    n(e.conflitos),
    n(e.semDecisao),
  ]),
  'Nenhuma etapa de triagem com documentos',
  'compacta',
)}
${h3('Exclusões por critério')}
${tabela(
  ['Critério de exclusão', 'Etapa', 'Documentos'],
  rd.exclCriterio.map((x: any) => [esc(x.criterio), esc(x.etapa), n(x.n)]),
  'Nenhuma exclusão por critério',
)}
${h3('Fluxograma de seleção')}
<div class="diagrama">${fluxo}</div>
${apendice('apendiceC') ? `<p>Os motivos de exclusão na leitura completa estão no ${apendice('apendiceC')}.</p>` : ''}`);
    }
  }

  // ---------------------------------------------------------------- 6. Caracterização dos estudos incluídos
  if (inclui('caracterizacao')) {
    if (!r || !rd) partes.push(`${h2('Caracterização dos estudos incluídos')}${semRevisao}`);
    else {
      const anos = incluidos.map((x: any) => x.ano).filter((a: any) => a) as number[];
      const conta = (chave: (x: any) => string | null | undefined) => {
        const m = new Map<string, number>();
        for (const x of incluidos) {
          const k = chave(x) || 'Não informado';
          m.set(k, (m.get(k) ?? 0) + 1);
        }
        return [...m.entries()];
      };
      const porAno = conta((x) => (x.ano ? String(x.ano) : null)).sort((a, b) =>
        a[0].localeCompare(b[0]),
      );
      const porCategoria = conta((x) => x.categoria).sort((a, b) => b[1] - a[1]);
      const porBase = conta((x) => x.base ?? rot(x.origem)).sort((a, b) => b[1] - a[1]);
      const pct = (v: number) => `${Math.round((v * 100) / Math.max(1, incluidos.length))}%`;
      const dist = (titulo: string, xs: [string, number][]) =>
        `<h4>${esc(titulo)}</h4>${tabela(
          [titulo.replace(/^Por /, '').replace(/^./, (c) => c.toUpperCase()), 'Estudos', '%'],
          xs.map(([k, v]) => [esc(k), n(v), pct(v)]),
          'Sem dados',
        )}`;
      partes.push(`${h2('Caracterização dos estudos incluídos')}
<p>Foram incluídos ${n(incluidos.length)} estudos${anos.length ? `, publicados entre ${Math.min(...anos)} e ${Math.max(...anos)}` : ''}.</p>
${tabela(
  ['#', 'Autores (ano)', 'Título', 'Periódico / evento', 'Tipo', 'Idioma', 'Categoria', 'Origem'],
  incluidos.map((x: any, i: number) => [
    String(i + 1),
    esc(autorAno(x)),
    esc(x.titulo),
    esc(x.periodico ?? '—'),
    esc(x.tipo ?? '—'),
    esc(x.idioma ?? '—'),
    esc(x.categoria ?? '—'),
    esc(x.base ?? rot(x.origem)),
  ]),
  'Nenhum estudo incluído',
  'compacta',
)}
${
  incluidos.length
    ? `${h3('Distribuição')}
${dist('Por ano', porAno)}
${dist('Por categoria', porCategoria)}
${
  rd.temas.length
    ? `<h4>Por tema</h4>${tabela(
        ['Tema', 'Estudos'],
        rd.temas.map((x) => [esc(x.nome), n(x.n)]),
      )}`
    : ''
}
${dist('Por base', porBase)}
${escrito(t.distribuicao, 'Comente o perfil dos estudos (concentração temporal, idiomas, tipos de publicação) em até três frases (CG16).')}`
    : ''
}`);
    }
  }

  // ---------------------------------------------------------------- 7. Análise dos estudos
  if (inclui('analise')) {
    if (!d.analises.length) {
      partes.push(
        `${h2('Análise dos estudos')}<p class="vazio">Nenhuma análise ligada a esta revisão.</p>`,
      );
    } else {
      const varias = d.analises.length > 1;
      const intro = d.analises
        .map((a) => {
          const c = (s: string) => a.documentos.filter((x) => x.progresso === s).length;
          return `<p>A análise <b>${esc(a.nome)}</b> (${esc(rot(a.status).toLowerCase())}) cobre ${n(a.documentos.length)} documentos; ${n(c('CONCLUIDO'))} concluídos, ${n(c('PARCIAL'))} parciais e ${n(c('NAO_INICIADO'))} não iniciados.</p>`;
        })
        .join('');
      const respostas = d.analises
        .map((a) => {
          const titulo = varias ? `<h4>${esc(a.nome)}</h4>` : '';
          if (!a.documentos.length)
            return `${titulo}<p class="vazio">Nenhum documento na análise.</p>`;
          // até 4 questões cabem numa tabela pivô; acima disso, um quadro por estudo
          if (a.questoes.length <= 4)
            return `${titulo}${tabela(
              ['Estudo', ...a.questoes.map((q) => esc(q.codigo))],
              a.documentos.map((x) => [
                esc(autorAno(x)),
                ...a.questoes.map((q) => esc(x.respostas[q.codigo]?.trim() || '—')),
              ]),
              'Sem respostas',
              'compacta',
            )}${a.questoes.length ? `<p class="fonte">${a.questoes.map((q) => `${esc(q.codigo)}: ${esc(q.enunciado)}`).join(' · ')}</p>` : ''}`;
          return `${titulo}${a.documentos
            .map(
              (x) =>
                `<p><b>${esc(autorAno(x))}</b> — ${esc(x.titulo)}</p><table class="compacta">${a.questoes.map((q) => `<tr><th style="width:35%">${esc(q.codigo)} – ${esc(q.enunciado)}</th><td>${esc(x.respostas[q.codigo]?.trim() || '—')}</td></tr>`).join('')}</table>`,
            )
            .join('')}`;
        })
        .join('');
      const consideracoes = d.analises.flatMap((a) =>
        a.documentos.filter((x) => !vazio(x.consideracoes)),
      );
      const questoes = [
        ...new Map(d.analises.flatMap((a) => a.questoes).map((q) => [q.codigo, q])).values(),
      ];
      partes.push(`${h2('Análise dos estudos')}
${intro}
${h3('Respostas por questão')}
${respostas}
${orient('Respostas vazias aparecem como “—” e indicam lacuna de extração; revise antes de concluir a análise.')}
${consideracoes.length ? `${h3('Considerações por estudo')}${consideracoes.map((x) => `<p><b>${esc(autorAno(x))}.</b> ${esc(x.consideracoes)}</p>`).join('')}` : ''}
${questoes.length ? `${h3('Síntese por questão')}${questoes.map((q) => `<h4>${esc(q.codigo)} — ${esc(q.enunciado)}</h4>${escrito(t.sintese?.[q.codigo], 'Sintetize as respostas dos estudos, apontando convergências, divergências e frequência dos achados.')}`).join('')}` : ''}`);
    }
  }

  // ---------------------------------------------------------------- 8. Matriz de síntese e discussão
  if (inclui('sintese')) {
    const matriz = d.analises.flatMap((a) => a.matriz);
    const grupos = new Map<string, { ponto: string; textos: string[]; estudos: Set<string> }>();
    for (const x of d.analises.flatMap((a) => a.discussao)) {
      const ponto = (x.pontoPrincipal ?? '').trim() || 'Outros pontos';
      const chave = ponto.toLocaleLowerCase('pt-BR');
      const g = grupos.get(chave) ?? { ponto, textos: [], estudos: new Set<string>() };
      if (!vazio(x.discussao)) g.textos.push(x.discussao!.trim());
      g.estudos.add(autorAno(x));
      grupos.set(chave, g);
    }
    partes.push(`${h2('Matriz de síntese e discussão')}
${h3('Matriz de síntese')}
${tabela(
  ['Citação', 'Trecho original', 'Paráfrase', 'Página'],
  matriz.map((m) => [
    esc(m.citacao?.trim() || autorAno(m)),
    esc(m.textoOriginal ?? '—'),
    esc(m.textoParafraseado ?? '—'),
    esc(m.pagina ?? '—'),
  ]),
  'Nenhum item na matriz de síntese',
  'compacta',
)}
${orient('Use a coluna Paráfrase no texto corrido; o trecho original só entra como citação direta curta, com página.')}
${h3('Discussão')}
${grupos.size ? [...grupos.values()].map((g) => `<h4>${esc(g.ponto)}</h4>${g.textos.map((x) => paragrafos(x)).join('')}<p>(estudos relacionados: ${esc([...g.estudos].join('; '))})</p>`).join('') : '<p class="vazio">Nenhum ponto de discussão registrado.</p>'}
${escrito(t.discussaoFechamento, 'Feche a discussão com: interpretação frente a outras evidências (CG19), limitações das evidências e do processo (CG20) e implicações para prática e pesquisa (CG21).')}`);
  }

  // ---------------------------------------------------------------- 9. Checklist de relato
  if (inclui('checklist')) {
    if (!r || !rd) partes.push(`${h2('Checklist de relato')}${semRevisao}`);
    else {
      const c = (s: string) => rd.checklist.filter((x: any) => x.situacao === s).length;
      partes.push(`${h2('Checklist de relato')}
<p>Dos ${n(rd.checklist.length)} itens, ${n(c('REALIZADO'))} estão realizados, ${n(c('PENDENTE'))} pendentes, ${n(c('NAO_REALIZADO'))} não realizados e ${n(c('ND'))} sem definição.${r.checklistNome ? ` Modelo: ${esc(r.checklistNome)}.` : ''}</p>
${tabela(
  ['Código', 'Seção', 'Item', 'Situação', 'Onde está relatado'],
  rd.checklist.map((x: any) => [
    esc(x.codigo),
    esc(x.secao),
    esc(x.descricao),
    esc(rot(x.situacao)),
    esc(x.localRelato ?? '—'),
  ]),
  'Sem checklist',
  'compacta',
)}
${orient(`Antes de submeter, todo item deve estar REALIZADO ou ter justificativa para NAO_REALIZADO.${r.diretrizSigla ? ` O texto oficial da diretriz (${r.diretrizSigla}) não é reproduzido aqui${r.diretrizUrl ? `; consulte ${r.diretrizUrl}` : ''}.` : ''}`)}`);
    }
  }

  // ---------------------------------------------------------------- 10. Considerações finais
  if (inclui('consideracoes')) {
    const periodo = (p?.criterios ?? []).find((c: any) => /per[ií]odo/i.test(c.nome));
    const semAcesso = (rd?.porEtapa ?? []).reduce((s, e) => s + e.semAcesso, 0);
    const conflitos = (rd?.porEtapa ?? []).reduce((s, e) => s + e.conflitos, 0);
    const limites = r
      ? [
          `<b>Da busca:</b> ${bases.length ? `bases consultadas: ${esc(listaBases(bases))}` : 'nenhuma busca registrada'}${periodo ? `; período coberto: ${esc(periodo.descricao ?? periodo.nome)}` : ''}.`,
          `<b>Do acesso:</b> ${n(semAcesso)} estudo(s) excluído(s) por falta de texto completo.`,
          `<b>Da seleção:</b> ${r.doisRevisores ? `triagem por dois revisores independentes; ${n(conflitos)} conflito(s) pendente(s) de resolução` : 'triagem por um único revisor'}.`,
          `<b>Do protocolo:</b> ${d.versoes.length > 1 ? `${d.versoes.length} versões, com alterações registradas` : d.versoes.length === 1 ? 'uma versão concluída, sem alterações posteriores' : 'nenhuma versão concluída'}${apendice('apendiceB') ? ` (${apendice('apendiceB')}, CG23)` : ''}.`,
        ]
      : [];
    partes.push(`${h2('Considerações finais')}
${escrito(t.consideracoes, `Responda diretamente à questão de pesquisa (${p?.questaoPesquisa ?? '—'}) e diga se a hipótese foi sustentada.`)}
${h3('Limitações')}
${limites.length ? `<ul>${limites.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}
${escrito(t.limitacoes, 'Acrescente outras limitações das evidências e do processo.')}
${h3('Trabalhos futuros')}
${escrito(t.trabalhosFuturos, 'Liste lacunas identificadas na síntese que justificam novas pesquisas.')}`);
  }

  // ---------------------------------------------------------------- 11. Referências
  if (inclui('referencias')) {
    const refs = d.referencias
      .map((x) => (o.norma === 'APA' ? x.apa : x.abnt))
      .filter((x) => !vazio(x))
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    partes.push(
      `${h2('Referências')}${refs.length ? refs.map((x) => `<p class="ref">${esc(x)}</p>`).join('') : '<p class="vazio">Nenhum estudo incluído ou citado na matriz de síntese.</p>'}`,
    );
  }

  // ---------------------------------------------------------------- Apêndices
  if (inclui('apendiceA')) {
    const executadas = new Set(buscas.map((b: any) => b.stringBuscaId).filter(Boolean));
    const planejadas = (p?.strings ?? []).filter((s: any) => !r || !executadas.has(s.id));
    partes.push(`${tituloApendice('apendiceA', 'Strings de busca planejadas')}
${r ? '<p>Strings do protocolo sem busca vinculada nesta revisão.</p>' : ''}
${tabela(
  ['Base', 'Campo', 'Expressão'],
  planejadas.map((s: any) => [
    esc(s.baseNome ?? 'Genérica'),
    esc(rot(s.campo)),
    `<span class="mono">${esc(s.expressao)}</span>`,
  ]),
  r ? 'Todas as strings planejadas foram executadas.' : 'Nenhuma string de busca cadastrada.',
)}`);
  }
  if (inclui('apendiceB')) {
    partes.push(`${tituloApendice('apendiceB', 'Histórico do protocolo')}
${tabela(
  ['Versão', 'Data', 'Autor', 'Justificativa', 'PDF'],
  d.versoes.map((v: any) => [
    `v${v.versao}`,
    dataBr(v.criadoEm),
    esc(v.autor ?? '—'),
    esc(v.justificativa ?? '—'),
    esc(v.arquivo ?? '—'),
  ]),
  'Nenhuma versão concluída',
)}
${p?.aprovadoEm ? `<p>Aprovado por ${esc(p.aprovadoPorNome ?? 'orientador(a)')} em ${dataBr(p.aprovadoEm)}.</p>` : ''}${!vazio(p?.parecer) ? `<p><b>Parecer:</b> ${esc(p!.parecer)}</p>` : ''}`);
  }
  if (inclui('apendiceC')) {
    partes.push(`${tituloApendice('apendiceC', 'Estudos excluídos na leitura completa')}
${
  r && rd
    ? tabela(
        ['Estudo', 'Motivo', 'Critério / observação'],
        rd.excluidosLeitura.map((x: any) => [
          `${esc(autorAno(x))}<br><small>${esc(x.titulo)}</small>`,
          esc(rot(x.motivo)),
          esc(x.criterio ?? x.observacao ?? '—'),
        ]),
        'Nenhum estudo excluído na última etapa de triagem',
      )
    : semRevisao
}`);
  }
  if (inclui('apendiceD')) {
    partes.push(`${tituloApendice('apendiceD', 'Trilha de auditoria')}
${tabela(
  ['Data (UTC)', 'Usuário', 'Entidade', 'Ação'],
  (rd?.auditoria ?? []).map((x: any) => [
    dataHoraUtc(x.criadoEm),
    esc(x.usuario ?? '—'),
    esc(x.entidade),
    esc(x.acao),
  ]),
  'Nenhum registro',
  'compacta',
)}`);
  }

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(d.projeto.titulo)}</title><style>${ESTILO_RELATORIO}</style></head><body>
${partes.join('\n')}
</body></html>`;
}
