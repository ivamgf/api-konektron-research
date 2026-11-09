import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagramaSvg, quebrar, type DadosDiagrama } from '#modules/revisoes/diagrama.ts';

// texto visível do SVG (linhas quebradas juntadas)
const texto = (svg: string) => svg.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

export const exemplo: DadosDiagrama = {
  revisaoAnterior: 8,
  bases: [
    { rotulo: 'Scopus', n: 300 },
    { rotulo: 'IEEE Xplore', n: 186 },
  ],
  identificados: 486,
  removidosAntes: [
    { rotulo: 'Não importados (filtros ou limites da busca)', n: 455 },
    { rotulo: 'Registros duplicados', n: 7 },
  ],
  fases: [
    { etapaId: 'f1', ordem: 4, nome: 'Triagem F1 (título e resumo)', status: 'CONCLUIDA', avaliados: 52, selecionados: 11, excluidos: 41, semDecisao: 0, motivos: [{ rotulo: 'Fora do tema', n: 41 }] },
    { etapaId: 'f2', ordem: 5, nome: 'Triagem F2 (acesso)', status: 'CONCLUIDA', avaliados: 11, selecionados: 11, excluidos: 0, semDecisao: 0, motivos: [] },
    { etapaId: 'f3', ordem: 6, nome: 'Elegibilidade F3 (texto completo)', status: 'EM_ANDAMENTO', avaliados: 12, selecionados: 6, excluidos: 6, semDecisao: 0, motivos: [{ rotulo: 'Não relacionadas ao tema', n: 5 }, { rotulo: 'Duplicados', n: 1 }] },
  ],
  outrasFontes: [{ rotulo: 'Litmaps', n: 3 }],
  totalOutrasFontes: 3,
  incluidos: { novos: 6, revisaoAnterior: 8, integrados: 3, total: 17 },
};

test('quebrar respeita o limite e não perde palavras', () => {
  const l = quebrar('Registros removidos antes da triagem por estarem em desacordo', 20);
  assert.ok(l.every((x) => x.length <= 20));
  assert.equal(l.join(' '), 'Registros removidos antes da triagem por estarem em desacordo');
});

test('diagrama tem as três colunas, as fases, os motivos e o total de incluídos', () => {
  const svg = diagramaSvg(exemplo);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  for (const t of ['Revisões anteriores', 'Novos estudos: bases de dados', 'Novos estudos: outras fontes', 'Elegibilidade F3', 'Não relacionadas ao tema: 5', 'Litmaps: 3', 'Estudos incluídos na revisão (n = 17)'])
    assert.ok(texto(svg).includes(t), t);
  assert.ok(!/prisma/i.test(svg), 'sem a marca PRISMA');
});

test('sem revisão anterior nem outras fontes, só a coluna das bases', () => {
  const svg = diagramaSvg({ ...exemplo, revisaoAnterior: 0, outrasFontes: [], totalOutrasFontes: 0, incluidos: { novos: 6, revisaoAnterior: 0, integrados: 0, total: 6 } });
  assert.ok(!texto(svg).includes('Revisões anteriores'));
  assert.ok(!texto(svg).includes('outras fontes'));
  assert.ok(texto(svg).includes('(n = 6)'));
});

test('texto com < e & é escapado', () => {
  const svg = diagramaSvg({ ...exemplo, bases: [{ rotulo: 'A & B <x>', n: 1 }] });
  assert.ok(svg.includes('A &amp; B &lt;x&gt;'));
});
