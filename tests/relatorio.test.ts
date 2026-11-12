import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anosPorBloco,
  blocosDeAnos,
  esquemaCronograma,
  htmlCronograma,
  intervaloDaEtapa,
  normalizarCronograma,
  periodoMarcado,
  periodosDoAno,
  type DadosCronograma,
} from '#modules/relatorio/cronograma.ts';
import { htmlRelatorio, opcoesCompletas } from '#modules/relatorio/relatorio.html.ts';
import { secoesPadrao, type DadosRelatorio } from '#modules/relatorio/relatorio.service.ts';
import { prepararHtmlParaWord } from '#pdf/docx.ts';
import type { DadosDiagrama } from '#modules/revisoes/diagrama.ts';

const diagrama: DadosDiagrama = {
  revisaoAnterior: 0,
  bases: [{ rotulo: 'Scopus', n: 51 }],
  identificados: 51,
  removidosAntes: [{ rotulo: 'Registros duplicados', n: 2 }],
  fases: [
    {
      etapaId: 'f1',
      ordem: 2,
      nome: 'Triagem F1',
      status: 'CONCLUIDA',
      avaliados: 49,
      selecionados: 10,
      excluidos: 39,
      semDecisao: 0,
      motivos: [{ rotulo: 'Critério de exclusão', n: 30 }],
    },
  ],
  outrasFontes: [{ rotulo: 'Integrados', n: 3 }],
  totalOutrasFontes: 3,
  incluidos: { novos: 1, revisaoAnterior: 0, integrados: 1, total: 2 },
};

const texto = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// cronograma do projeto Attila (2023–2027), como no projeto de pesquisa
const cronograma: DadosCronograma = {
  granularidade: 'TRIMESTRAL',
  anoInicio: 2023,
  anoFim: 2027,
  etapas: [
    {
      id: 'e1',
      nome: 'Disciplinas',
      origem: 'PESQUISA',
      meses: [
        '2023-01',
        '2023-02',
        '2023-03',
        '2023-04',
        '2023-05',
        '2023-06',
        '2023-07',
        '2023-08',
        '2023-09',
      ],
    },
    {
      id: 'e2',
      nome: 'Revisão integrativa',
      origem: 'REVISAO',
      revisaoEtapaId: 'x',
      meses: ['2024-10', '2024-11', '2024-12'],
    },
    { id: 'e3', nome: 'Defesa', origem: 'PESQUISA', meses: ['2026-11'] },
    { id: 'e4', nome: 'Entrega da versão final', origem: 'PESQUISA', meses: ['2027-02'] },
  ],
};

test('períodos de cada granularidade cobrem os 12 meses do ano', () => {
  for (const [g, porAno] of [
    ['MENSAL', 12],
    ['BIMESTRAL', 6],
    ['TRIMESTRAL', 4],
    ['QUADRIMESTRAL', 3],
    ['SEMESTRAL', 2],
    ['ANUAL', 1],
  ] as const) {
    const ps = periodosDoAno(g, 2025);
    assert.equal(ps.length, porAno, g);
    assert.deepEqual(
      ps.flatMap((p) => p.meses),
      Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`),
      g,
    );
  }
  assert.equal(periodosDoAno('TRIMESTRAL', 2025)[1].rotulo, 'Trim 2');
  assert.equal(periodosDoAno('MENSAL', 2025)[0].rotulo, 'Jan');
  assert.equal(periodosDoAno('ANUAL', 2025)[0].rotulo, '2025');
});

test('marcações por mês sobrevivem à troca de granularidade', () => {
  const e = { meses: ['2025-05'] };
  assert.ok(periodoMarcado(e, periodosDoAno('TRIMESTRAL', 2025)[1]), 'maio está no 2º trimestre');
  assert.ok(periodoMarcado(e, periodosDoAno('SEMESTRAL', 2025)[0]), 'maio está no 1º semestre');
  assert.ok(
    !periodoMarcado(e, periodosDoAno('BIMESTRAL', 2025)[0]),
    'maio não está no 1º bimestre',
  );
  assert.deepEqual(intervaloDaEtapa({ meses: ['2025-09', '2025-02'] }), {
    inicio: '2025-02',
    fim: '2025-09',
  });
});

test('anos agrupados em blocos de até 12 colunas', () => {
  assert.equal(anosPorBloco('TRIMESTRAL'), 3);
  assert.deepEqual(blocosDeAnos(cronograma), [
    [2023, 2024, 2025],
    [2026, 2027],
  ]);
  assert.deepEqual(blocosDeAnos({ ...cronograma, granularidade: 'MENSAL' }).length, 5);
  assert.deepEqual(blocosDeAnos({ ...cronograma, granularidade: 'ANUAL' }), [
    [2023, 2024, 2025, 2026, 2027],
  ]);
});

test('normalizar tira meses repetidos e fora dos anos', () => {
  const n = normalizarCronograma({
    ...cronograma,
    anoFim: 2026,
    etapas: [
      { id: 'a', nome: 'A', origem: 'LIVRE', meses: ['2026-03', '2026-03', '2027-01', '2023-02'] },
    ],
  });
  assert.deepEqual(n.etapas[0].meses, ['2023-02', '2026-03']);
});

test('esquema valida anos e meses', () => {
  assert.ok(esquemaCronograma.safeParse(cronograma).success);
  assert.ok(
    !esquemaCronograma.safeParse({ ...cronograma, anoFim: 2022 }).success,
    'ano final antes do inicial',
  );
  assert.ok(
    !esquemaCronograma.safeParse({ ...cronograma, anoFim: 2060 }).success,
    'mais de 21 anos',
  );
  assert.ok(
    !esquemaCronograma.safeParse({
      ...cronograma,
      etapas: [{ id: 'a', nome: 'A', origem: 'LIVRE', meses: ['2025-13'] }],
    }).success,
  );
});

test('quadro do cronograma: verde na execução e etapas vazias escondidas por bloco', () => {
  const html = htmlCronograma(cronograma);
  assert.equal((html.match(/<table/g) ?? []).length, 2, 'dois blocos de anos');
  assert.equal(
    (html.match(/background-color:#93C47D/g) ?? []).length,
    3 + 1 + 1 + 1,
    'disciplinas (3 trim.), revisão, defesa, entrega',
  );
  const [b1, b2] = html.split('</table>');
  assert.match(b1, /Disciplinas/);
  assert.doesNotMatch(b1, /Defesa/, 'defesa só no bloco 2026–2027');
  assert.match(b2, /Defesa/);
  assert.match(b1, /Cronograma para 2023–2027/);
  assert.match(
    htmlCronograma({ ...cronograma, ocultarVazias: false }).split('</table>')[0],
    /Defesa/,
  );
  // no Word, as bordas e o fundo das células continuam (prepararHtmlParaWord não troca o estilo existente)
  assert.match(
    prepararHtmlParaWord(html),
    /<td style="border:1px solid #000;padding:3px 4px;background-color:#93C47D"/,
  );
});

// ------------------------------------------------------------------ relatório

export const base = (): DadosRelatorio =>
  ({
    geradoEm: new Date('2026-11-11T12:00:00Z'),
    projeto: {
      titulo: 'Attila: Framework para Acessibilidade <3D>',
      subtitulo: null,
      area: 'Engenharia do Conhecimento',
      instituicao: 'UFSC',
      programa: 'PPGEGC',
      dataInicio: '2023-03-01',
      dataFim: '2027-03-31',
    },
    equipe: [
      {
        nome: 'Ivam Galvão Filho',
        orcid: '0000-0002-0162-3221',
        instituicao: 'UFSC',
        papel: 'RESPONSAVEL',
      },
      { nome: 'Vania Ribas Ulbricht', orcid: null, instituicao: 'UFSC', papel: 'ORIENTADOR' },
    ],
    protocolo: {
      status: 'APROVADO',
      versaoAtual: 2,
      tema: 'Acessibilidade em ambientes imersivos',
      questaoPesquisa: 'Como as abordagens assistivas no metaverso podem ser analisadas?',
      hipotese: null,
      objetivoGeral: 'Desenvolver um framework para analisar abordagens assistivas.',
      justificativa: 'Barreiras de acessibilidade no metaverso.',
      metodologiaTipo: 'DSR',
      metodologia: 'Ciclos de projeto e avaliação.',
      outrasQuestoes: [
        { ordem: 1, texto: 'Quais barreiras afetam pessoas com deficiência visual?' },
      ],
      objetivos: [{ texto: 'Identificar classes de problemas.' }],
      palavrasChave: [
        { termo: 'Metaverso', idiomaCodigo: 'pt' },
        { termo: 'Acessibilidade', idiomaCodigo: 'pt' },
        { termo: 'Metaverse', idiomaCodigo: 'en' },
      ],
      descritores: [{ termo: 'Virtual Reality', vocabulario: 'MESH', codigo: 'D000081411' }],
      strings: [
        {
          id: 's1',
          baseNome: 'Scopus',
          campo: 'TITULO',
          expressao: '(metaverse) AND (accessibility)',
        },
        {
          id: 's2',
          baseNome: null,
          campo: 'TODOS',
          expressao: '"virtual reality" AND accessibility',
        },
      ],
      questoes: [],
      criterios: [
        { tipo: 'INCLUSAO', nome: 'Período', descricao: '2016 a 2025', ordem: 1 },
        {
          tipo: 'EXCLUSAO',
          nome: 'Publicações',
          descricao: 'Resumos e artigos de conferência',
          ordem: 1,
        },
      ],
      aprovadoEm: '2025-02-10T10:00:00Z',
      aprovadoPorNome: 'Vania Ribas Ulbricht',
      parecer: 'Aprovado.',
    },
    versoes: [
      {
        versao: 1,
        criadoEm: '2024-10-01T10:00:00Z',
        autor: 'Ivam Galvão Filho',
        justificativa: null,
        arquivo: 'protocolo_v1.pdf',
      },
      {
        versao: 2,
        criadoEm: '2025-02-01T10:00:00Z',
        autor: 'Ivam Galvão Filho',
        justificativa: 'Inclusão da base ERIC',
        arquivo: null,
      },
    ],
    textos: {
      resumoAchados: 'Poucos estudos tratam de deficiência auditiva.',
      sintese: { QA1: 'Os estudos convergem em legendas.' },
    },
    cronograma,
    sistematica: true,
    revisao: {
      id: 'r1',
      titulo: 'RIL acessibilidade no metaverso',
      status: 'EM_ANDAMENTO',
      doisRevisores: true,
      tipoNome: 'Integrativa',
      tipoDescricao: 'concilia estudos experimentais e teóricos',
      diretrizNome: 'Preferred Reporting Items',
      diretrizSigla: 'PRISMA',
      diretrizVersao: '2020',
      diretrizUrl: 'https://www.prisma-statement.org',
      checklistNome: 'Checklist genérico',
    },
    revisaoDados: {
      etapas: [
        {
          ordem: 1,
          nome: 'Busca',
          categoria: 'BUSCA',
          status: 'CONCLUIDA',
          iniciadaEm: '2024-10-01T00:00:00Z',
          concluidaEm: '2024-10-20T00:00:00Z',
          exigeTriagem: false,
        },
        {
          ordem: 2,
          nome: 'Triagem F1',
          categoria: 'TRIAGEM',
          status: 'DISPENSADA',
          justificativaDispensa: 'Poucos registros',
          exigeTriagem: true,
        },
      ],
      buscas: [
        {
          baseNome: 'Scopus',
          dataBusca: '2024-10-05',
          campo: 'TITULO',
          expressaoUsada: '(metaverse) AND (accessibility)',
          filtros: '2016–2025',
          qtdRetornada: 51,
          qtdImportada: 51,
          stringBuscaId: 's1',
        },
        {
          baseNome: 'ERIC',
          dataBusca: '2024-10-02',
          campo: 'TODOS',
          expressaoUsada: 'metaverse',
          filtros: null,
          qtdRetornada: 4,
          qtdImportada: 4,
          stringBuscaId: null,
        },
      ],
      porBase: [{ base: 'Scopus', consultados: 51, importados: 51, duplicados: 2 }],
      porOrigem: { INTEGRADO: 3 },
      porEtapa: [
        {
          ordem: 2,
          nome: 'Triagem F1',
          avaliados: 49,
          selecionados: 10,
          excluidos: 39,
          criterio: 30,
          duplicados: 2,
          semAcesso: 4,
          outro: 3,
          conflitos: 0,
          semDecisao: 0,
        },
      ],
      exclCriterio: [{ criterio: 'Publicações', etapa: 'Triagem F1', n: 30 }],
      incluidos: [
        {
          id: 'd1',
          titulo: 'Inclusive AR/VR',
          autores: 'Creed, Chris; Smith, A.',
          ano: 2023,
          periodico: 'UAIS',
          origem: 'BUSCA',
          idioma: 'Inglês',
          tipo: 'Artigo',
          categoria: 'Barreiras',
          base: 'Scopus',
        },
        {
          id: 'd2',
          titulo: 'Designing the metaverse',
          autores: 'Zallio, Matteo',
          ano: 2022,
          periodico: 'Telematics',
          origem: 'INTEGRADO',
          idioma: 'Inglês',
          tipo: 'Artigo',
          categoria: null,
          base: null,
        },
      ],
      temas: [{ nome: 'Deficiência visual', n: 2 }],
      checklist: [
        {
          codigo: 'CG02',
          secao: 'Resumo',
          descricao: 'O resumo traz objetivo.',
          situacao: 'REALIZADO',
          localRelato: 'Seção 2',
        },
      ],
      excluidosLeitura: [
        {
          autores: 'Silva, Ana',
          ano: 2020,
          titulo: 'Um estudo',
          motivo: 'SEM_ACESSO',
          criterio: null,
          observacao: 'PDF indisponível',
        },
      ],
      auditoria: [
        {
          criadoEm: '2025-02-10T10:00:00Z',
          usuario: 'Ivam',
          entidade: 'protocolo',
          acao: 'CONCLUIR',
        },
      ],
      diagrama,
    },
    analises: [
      {
        id: 'a1',
        nome: 'Análise RIL',
        status: 'ABERTA',
        questoes: [{ id: 'q1', codigo: 'QA1', enunciado: 'Quais recursos assistivos?' }],
        documentos: [
          {
            id: 'ad1',
            documentoId: 'd1',
            autores: 'Creed, Chris; Smith, A.',
            ano: 2023,
            titulo: 'Inclusive AR/VR',
            progresso: 'CONCLUIDO',
            consideracoes: 'Estudo central.',
            respostas: { QA1: 'Legendas e audiodescrição' },
          },
          {
            id: 'ad2',
            documentoId: 'd2',
            autores: 'Zallio, Matteo',
            ano: 2022,
            titulo: 'Designing the metaverse',
            progresso: 'NAO_INICIADO',
            consideracoes: null,
            respostas: { QA1: '' },
          },
        ],
        matriz: [
          {
            documentoId: 'd3',
            autores: 'Biswas, P.',
            ano: 2021,
            titulo: 'Adaptive AR/VR',
            citacao: '(BISWAS et al., 2021, p. 3)',
            textoOriginal: 'Original',
            textoParafraseado: 'Paráfrase',
            pagina: '3',
          },
        ],
        discussao: [
          {
            pontoPrincipal: 'Legendas',
            discussao: 'Legendas dessincronizadas são barreira.',
            autores: 'Creed, Chris; Smith, A.',
            ano: 2023,
            titulo: 'Inclusive AR/VR',
          },
          {
            pontoPrincipal: 'legendas',
            discussao: null,
            autores: 'Zallio, Matteo',
            ano: 2022,
            titulo: 'Designing the metaverse',
          },
        ],
      },
    ],
    referencias: [
      {
        abnt: 'ZALLIO, M. Designing the metaverse. 2022.',
        apa: 'Zallio, M. (2022). Designing the metaverse.',
      },
      { abnt: 'CREED, C. Inclusive AR/VR. 2023.', apa: 'Creed, C. (2023). Inclusive AR/VR.' },
    ],
  }) as unknown as DadosRelatorio;

test('seções padrão: revisão narrativa omite a seleção em fases e o checklist', () => {
  assert.ok(secoesPadrao(true).includes('resultados'));
  assert.ok(!secoesPadrao(false).includes('resultados'));
  assert.ok(!secoesPadrao(false).includes('checklist'));
  assert.ok(!secoesPadrao(true).includes('apendiceD'), 'auditoria é opcional');
  assert.deepEqual(opcoesCompletas(undefined, true).norma, 'ABNT');
});

test('relatório segue o template: seções numeradas, dados do banco e textos do pesquisador', () => {
  const html = htmlRelatorio(base());
  const t = texto(html);
  assert.match(html, /<section class="capa">/);
  assert.match(html, /RELATÓRIO DE PESQUISA/);
  assert.match(html, /Attila: Framework para Acessibilidade &lt;3D&gt;/, 'HTML escapado');
  for (const [i, s] of [
    'Identificação do projeto',
    'Resumo',
    'Introdução',
    'Método',
    'Cronograma',
    'Resultados da identificação e seleção',
    'Caracterização dos estudos incluídos',
    'Análise dos estudos',
    'Matriz de síntese e discussão',
    'Checklist de relato',
    'Considerações finais',
    'Referências',
  ].entries())
    assert.match(html, new RegExp(`<h2>${i + 1}\\. ${s}</h2>`), s);
  // identificação e equipe
  assert.match(t, /Pesquisador\(a\) responsável/);
  assert.match(t, /Orientador\(a\)/);
  assert.match(t, /v2 \(Aprovado\)/);
  // resumo: bases, datas e números
  assert.match(
    t,
    /conduzida nas bases Scopus e ERIC, com buscas entre 02\/10\/2024 e 05\/10\/2024/,
  );
  assert.match(
    t,
    /55 registros identificados, 2 estudos incluídos\. Poucos estudos tratam de deficiência auditiva\./,
  );
  assert.match(t, /Palavras-chave: Metaverso; Acessibilidade/);
  // introdução: hipótese nula não aparece
  assert.doesNotMatch(html, /Hipótese/);
  assert.match(t, /QS1: Quais barreiras/);
  // método
  assert.match(t, /O relato segue Preferred Reporting Items \(PRISMA 2020\)/);
  assert.match(t, /dois revisores independentes/);
  assert.match(t, /Etapa dispensada — Triagem F1: Poucos registros/);
  assert.match(t, /Uma string planejada não foi executada nesta revisão \(Apêndice A\)/);
  // cronograma
  assert.match(t, /em períodos trimestrais, de 2023 a 2027/);
  assert.match(html, /Quadro 1 – Cronograma/);
  // resultados
  assert.match(t, /revisão anterior 0, integrados\/snowballing 3, inclusão manual 0/);
  assert.match(html, /<svg style="max-width:100%;height:auto"/, 'fluxograma');
  // caracterização: autor e ano, origem quando não veio de base
  assert.match(t, /Creed et al\. \(2023\)/);
  assert.match(t, /Integrado \(snowballing\)/);
  assert.match(t, /publicados entre 2022 e 2023/);
  // análise
  assert.match(t, /cobre 2 documentos; 1 concluídos, 0 parciais e 1 não iniciados/);
  assert.match(t, /Os estudos convergem em legendas\./);
  assert.match(html, /<td>—<\/td>/, 'resposta vazia vira travessão');
  // discussão agrupada pelo ponto principal (sem diferenciar maiúsculas)
  assert.equal((html.match(/<h4>Legendas<\/h4>/g) ?? []).length, 1);
  assert.match(t, /estudos relacionados: Creed et al\. \(2023\); Zallio \(2022\)/);
  // limitações automáticas
  assert.match(t, /período coberto: 2016 a 2025/);
  assert.match(t, /4 estudo\(s\) excluído\(s\) por falta de texto completo/);
  // referências em ordem alfabética
  assert.ok(html.indexOf('CREED, C.') < html.indexOf('ZALLIO, M.'));
  // apêndices: A, B, C (D é opcional)
  assert.match(html, /<h2 class="quebra">Apêndice A — Strings de busca planejadas<\/h2>/);
  assert.match(t, /Apêndice B — Histórico do protocolo .* Inclusão da base ERIC/);
  assert.match(t, /Aprovado por Vania Ribas Ulbricht em 10\/02\/2025/);
  assert.match(t, /Apêndice C — Estudos excluídos na leitura completa .* PDF indisponível/);
  assert.doesNotMatch(html, /Trilha de auditoria/);
  // orientações em itálico onde o texto ainda não foi escrito
  assert.match(html, /<p class="orientacao">Liste lacunas identificadas/);
});

test('seções escolhidas, sem orientações e referências em APA', () => {
  const html = htmlRelatorio(base(), {
    secoes: ['cronograma', 'referencias', 'apendiceD'],
    orientacoes: false,
    norma: 'APA',
    capa: false,
  });
  assert.doesNotMatch(html, /class="capa"/);
  assert.match(html, /<h2>1\. Cronograma<\/h2>/);
  assert.match(html, /<h2>2\. Referências<\/h2>/);
  assert.match(html, /Creed, C\. \(2023\)/);
  assert.match(
    html,
    /<h2 class="quebra">Apêndice A — Trilha de auditoria<\/h2>/,
    'letra do apêndice segue os incluídos',
  );
  assert.doesNotMatch(html, /class="orientacao"/);
});

test('projeto sem revisão nem cronograma não quebra o relatório', () => {
  const d = {
    ...base(),
    revisao: null,
    revisaoDados: null,
    analises: [],
    referencias: [],
    cronograma: null,
    textos: {},
  } as unknown as DadosRelatorio;
  const html = htmlRelatorio(d, { secoes: [...secoesPadrao(true), 'apendiceD'] });
  assert.match(html, /Nenhuma revisão cadastrada no projeto/);
  assert.match(html, /Monte o cronograma na aba Cronograma/);
  assert.match(html, /Nenhuma análise ligada a esta revisão/);
});
