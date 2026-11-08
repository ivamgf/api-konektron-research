import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerCsvDaEtapa, origemDoTexto } from '#modules/revisoes/importarEtapa.ts';

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

test('planilha RIL: Situação, Base, Temas, Ref-NBR/APA, Idioma, "N/D" vazio e DOI dentro do periódico', async () => {
  const { doiNoTexto } = await import('#modules/revisoes/importarEtapa.ts');
  const csv = [
    'N°,Título,Autores,Resumo,Palavras-chave,Ano,Periódico,Idioma,Link,Ref-NBR,Ref-APA,Ref-APA 2,Citações,Base,Temas,Situação',
    '1,Toward Effective Response,"G. Mudassir; E. E. Howard",Resumo,N/D,2021,IEEE Access,Inglês,https://x/1,"MUDASSIR, G. et al. Toward.","Mudassir, G. (2021).","Mudassir, G. (2021). Acesso em.",19,IEEE Xplore,"data science, natural disasters",Selecionado',
    '38,Methodological guidelines,"Haneef R,\nTijhuis M",Resumo,"Data linkage",2022,Arch Public Health. 2022;80(1):9. doi: 10.1186/s13690-021-00770-6.,Inglês,https://x/2,NBR,APA,APA2,15,PubMed,linked data,Excluído',
  ].join('\n');
  const { linhas, avisos } = lerCsvDaEtapa(csv);
  assert.equal(avisos.length, 0);
  assert.equal(linhas.length, 2);
  const [a, b] = linhas;
  assert.equal(a.decisao?.decisao, 'SELECIONADO');
  assert.equal(a.base, 'IEEE Xplore');
  assert.equal(a.idioma, 'Inglês');
  assert.equal(a.palavrasChave, null, '"N/D" vira vazio');
  assert.equal(a.citacoes, 19);
  assert.deepEqual(a.temas, ['data science', 'natural disasters']);
  assert.equal(a.refNbr, 'MUDASSIR, G. et al. Toward.');
  assert.equal(a.refApa2, 'Mudassir, G. (2021). Acesso em.');
  assert.equal(b.decisao?.decisao, 'EXCLUIDO');
  assert.equal(b.autores, 'Haneef R, Tijhuis M', 'campo com quebra de linha entre aspas vira uma linha só');
  assert.equal(b.doi, '10.1186/s13690-021-00770-6');
  assert.equal(doiNoTexto('Lancet. doi: 10.1016/S2215-0366(16)30089-X.'), '10.1016/S2215-0366(16)30089-X');
  assert.equal(doiNoTexto('sem doi', null), null);
});

test('coluna Origem marca revisão anterior e integrados (fonte secundária)', () => {
  const { linhas, avisos } = lerCsvDaEtapa(
    [
      'Título,Origem,Situação',
      'A,Revisão anterior,',
      'B,Integrados,',
      'C,fonte  secundária,',
      'D,Busca,Selecionado',
      'E,,Excluído',
      'F,outra coisa,',
    ].join('\n'),
  );
  assert.deepEqual(
    linhas.map((l) => l.origem),
    ['REVISAO_ANTERIOR', 'INTEGRADO', 'INTEGRADO', 'BUSCA', null, null],
  );
  assert.ok(avisos.some((a) => a.linha === 7 && /outra coisa/.test(a.mensagem)));
  assert.equal(origemDoTexto('INTEGRADO'), 'INTEGRADO');
  assert.equal(origemDoTexto('revisao_anterior'), 'REVISAO_ANTERIOR');
});

test('planilha Integrados: linha de título, "Como citar" como NBR, citações "~220+" e DOI do link', () => {
  const { linhas, origemDoArquivo, avisos } = lerCsvDaEtapa(
    [
      'Integrados,,,,,,,,,,,',
      'N°,Título,Autores,Resumo,Palavras-chave,Ano,Periódico,Idioma,Link,Como citar,Citações,Base',
      '1,"Cloudy, increasingly FAIR","Mons, B., Neylon, C.","Examina FAIR.","FAIR principles, Linked Data.",2017,"Information Services & Use, 37(1), 49–56",Inglês,https://doi.org/10.3233/ISU-170824,"MONS, B. et al. Cloudy, increasingly FAIR. Information Services & Use, v. 37, n. 1, p. 49–56, 2017.",~220+,',
      '4,Large-scale semantic integration of linked data: A survey,"Mountantonakis, M.",Análise.,Linked Data,2019,"ACM Computing Surveys, 52(5)",Inglês,https://dl.acm.org/doi/abs/10.1145/3345551,"MOUNTANTONAKIS, M. Large-scale. 2019.",~110+,ACM',
    ].join('\n'),
  );
  assert.equal(origemDoArquivo, 'INTEGRADO');
  assert.equal(linhas.length, 2);
  assert.equal(linhas[0].linha, 3, 'o número da linha conta a linha de título');
  assert.equal(linhas[0].citacoes, 220);
  assert.equal(linhas[0].doi, '10.3233/ISU-170824');
  assert.match(linhas[0].refNbr!, /^MONS, B\. et al\./);
  assert.equal(linhas[0].base, null);
  assert.equal(linhas[1].base, 'ACM');
  assert.equal(linhas[1].doi, '10.1145/3345551');
  assert.equal(avisos.length, 0);
});

test('planilha Referencial Teórico (revisão anterior): Tipo, Referências, citação no texto e quebras de linha', () => {
  const { linhas, origemDoArquivo } = lerCsvDaEtapa(
    [
      'Referencial Teórico,,,,,,,,,,,',
      'N°,Título,Autores,Resumo,Palavras-chave,Tipo,Ano,Link,Como citar,Referências,Citações,Base',
      '2,"Combining Data Mining and Ontology Engineering to\nenrich Ontologies","Mathieu d’Aquina, Gabriel Kronbergerb\n, and Mari",Resumo.,"data mining, ontologies",Artigo,2012,https://oa.upm.es/19551/,"(SUÁREZ-FIGUEROA; D’AQUIN; KRONBERGER, 2012)","SUÁREZ-FIGUEROA, Mari Carmen. Combining data mining. 2012.",1,N/D',
      '4,scAAGA,"Rui Meng a","Resumo","scRNA-seq\nDeep learning\nCOVID-19 \n",Artigo,2023,,"(MENG, Rui et al., 2023)",MENG ref,85,Scopus',
      '14,Linked data: Evolving the web into a global data space.,,,,,,,,"HEATH,        Tom;        BIZER,        Christian.        Linked        data.",,N/D',
    ].join('\n'),
  );
  assert.equal(origemDoArquivo, 'REVISAO_ANTERIOR');
  assert.equal(linhas[0].titulo, 'Combining Data Mining and Ontology Engineering to enrich Ontologies');
  assert.equal(linhas[0].autores, 'Mathieu d’Aquina, Gabriel Kronbergerb , and Mari');
  assert.equal(linhas[0].tipo, 'Artigo');
  assert.equal(linhas[0].refNbr, 'SUÁREZ-FIGUEROA, Mari Carmen. Combining data mining. 2012.', 'Referências vale como NBR');
  assert.equal(linhas[0].base, null, 'N/D é sem base');
  assert.equal(linhas[1].palavrasChave, 'scRNA-seq; Deep learning; COVID-19');
  assert.equal(linhas[2].refNbr, 'HEATH, Tom; BIZER, Christian. Linked data.');
  assert.equal(linhas[2].ano, null);
});
