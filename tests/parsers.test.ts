import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerCsv, parseBibtex, parseRis, tabelaParaRegistros } from '../src/jobs/parsers.ts';

test('lê RIS com várias entradas e linhas de continuação', () => {
  const ris = `TY  - JOUR
TI  - Primeiro artigo
AU  - Silva, A.
AU  - Costa, B.
PY  - 2023
JO  - Revista X
DO  - 10.5555/a
AB  - Resumo que continua
  na linha seguinte
KW  - ontologia
KW  - água
ER  - 

TY  - CONF
T1  - Segundo
PY  - 2021///
ER  - 
TY  - JOUR
AU  - Sem Titulo
ER  - `;
  const r = parseRis(ris);
  assert.equal(r.registros.length, 2);
  assert.equal(r.registros[0].autores, 'Silva, A.; Costa, B.');
  assert.equal(r.registros[0].resumo, 'Resumo que continua na linha seguinte');
  assert.equal(r.registros[0].palavrasChave, 'ontologia; água');
  assert.equal(r.registros[1].tipo, 'Artigo de conferência');
  assert.equal(r.registros[1].ano, 2021);
  assert.equal(r.erros.length, 1);
});

test('lê BibTeX com chaves aninhadas', () => {
  const bib = `@article{silva2023,
  title = {Uma {Ontologia} de domínio},
  author = {Silva, Ana and Costa, Bruno},
  year = 2023,
  journal = "Revista X",
  doi = {10.5555/b}
}
@comment{ignorar}
@inproceedings{x, author={Y}}`;
  const r = parseBibtex(bib);
  assert.equal(r.registros.length, 1);
  assert.equal(r.registros[0].titulo, 'Uma Ontologia de domínio');
  assert.equal(r.registros[0].autores, 'Silva, Ana; Costa, Bruno');
  assert.equal(r.registros[0].ano, 2023);
  assert.equal(r.erros.length, 1);
});

test('lê CSV com ponto e vírgula, aspas e cabeçalhos do Scopus', () => {
  const csv = '﻿Authors;Title;Year;Source title;DOI;Cited by\n"Silva, A.";"Título; com ponto e vírgula";2022;Revista;10.1/x;7\n;;2020;;;\n';
  const linhas = lerCsv(csv);
  assert.equal(linhas.length, 3);
  const r = tabelaParaRegistros(linhas);
  assert.equal(r.registros.length, 1);
  assert.equal(r.registros[0].titulo, 'Título; com ponto e vírgula');
  assert.equal(r.registros[0].citacoes, 7);
  assert.equal(r.erros.length, 1);
});

test('ignora o BOM do UTF-8 no início de RIS e BibTeX', () => {
  const ris = parseRis('﻿TY  - JOUR\nTI  - Com BOM\nER  - \n');
  assert.equal(ris.registros[0]?.titulo, 'Com BOM');
  const bib = parseBibtex('﻿@article{a1, title={Com BOM}}');
  assert.equal(bib.registros[0]?.titulo, 'Com BOM');
});
