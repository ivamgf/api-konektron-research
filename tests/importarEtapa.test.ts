import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerCsvDaEtapa } from '#modules/revisoes/importarEtapa.ts';

test('lê documentos com decisão, motivo, critério e base (ponto e vírgula, acentos no cabeçalho)', () => {
  const { linhas, avisos } = lerCsvDaEtapa(
    [
      'Título;Autores;Ano;DOI;Base;Decisão;Motivo;Critério;Observação',
      'Agile in research teams;Silva, A.;2023;10.1/X;Scopus;Selecionado;;;',
      'Scrum for labs;Lee, K.;2021;;IEEE;excluído;critério;Idioma;fora do escopo',
      'Kanban;Ana;2020;;;EXCLUIDO;duplicado;;',
      'Sem acesso;Bia;2019;;;no;sem acesso;;',
      'Lean;Caio;2018;;;talvez;;;',
      ';sem título;2017;;;sim;;;',
    ].join('\n'),
  );
  assert.equal(linhas.length, 5);
  assert.deepEqual(linhas[0].decisao, { decisao: 'SELECIONADO', motivo: null, criterio: null, observacao: null });
  assert.equal(linhas[0].base, 'Scopus');
  assert.equal(linhas[0].doi, '10.1/X');
  assert.deepEqual(linhas[1].decisao, { decisao: 'EXCLUIDO', motivo: 'CRITERIO', criterio: 'Idioma', observacao: 'fora do escopo' });
  assert.equal(linhas[2].decisao?.motivo, 'DUPLICADO');
  assert.equal(linhas[3].decisao?.motivo, 'SEM_ACESSO');
  assert.equal(linhas[4].decisao, null, 'decisão desconhecida entra sem decisão');
  assert.equal(linhas[4].linha, 6, 'o número da linha segue o arquivo, mesmo com a linha sem título pulada');
  assert.ok(avisos.some((a) => a.linha === 6 && /talvez/.test(a.mensagem)));
  assert.ok(avisos.some((a) => a.linha === 7 && /sem título/.test(a.mensagem)));
});

test('exclusão sem motivo vira OUTRO com observação (RN10)', () => {
  const { linhas } = lerCsvDaEtapa('title,decision\nA paper,excluded\n');
  assert.deepEqual(linhas[0].decisao, { decisao: 'EXCLUIDO', motivo: 'OUTRO', criterio: null, observacao: 'Importado de CSV' });
});

test('motivo desconhecido é aceito como OUTRO, com aviso', () => {
  const { linhas, avisos } = lerCsvDaEtapa('titulo,decisao,motivo\nX,excluido,fora do tema\n');
  assert.equal(linhas[0].decisao?.motivo, 'OUTRO');
  assert.equal(linhas[0].decisao?.observacao, 'fora do tema');
  assert.equal(avisos.length, 1);
});

test('recusa CSV sem coluna de título ou vazio', () => {
  assert.throws(() => lerCsvDaEtapa('autor,ano\nA,2020\n'), /título/);
  assert.throws(() => lerCsvDaEtapa('titulo\n'), /vazio/);
});
