import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_HOST ||= 'localhost';
process.env.DB_NAME ||= 'metadados_test';
process.env.DB_USER ||= 'test';
process.env.JWT_SECRET ||= 'teste-metadados-nao-usar-em-producao-0123456789';

const { extrairDoi, ipBloqueado, limparTexto, metadadosDaPagina, precisaCompletar, resumoDeIndiceInvertido, buscarPagina } = await import(
  '../src/services/metadados.ts'
);

test('acha o DOI em links de editoras e no doi.org', () => {
  assert.equal(extrairDoi('https://doi.org/10.1016/j.ijinfomgt.2020.102185'), '10.1016/j.ijinfomgt.2020.102185');
  assert.equal(extrairDoi('https://dl.acm.org/doi/10.1145/3290605.3300233'), '10.1145/3290605.3300233');
  assert.equal(extrairDoi('https://onlinelibrary.wiley.com/doi/full/10.1002/asi.24321'), '10.1002/asi.24321');
  assert.equal(extrairDoi('https://www.scielo.br/j/abc/a/XYZ/?lang=pt'), undefined);
});

test('remonta o resumo do índice invertido do OpenAlex', () => {
  assert.equal(resumoDeIndiceInvertido({ Dados: [0], abertos: [1], 'são': [2], dados: [3, 5], bons: [4] }), 'Dados abertos são dados bons dados');
  assert.equal(resumoDeIndiceInvertido(null), '');
});

test('limpa JATS e entidades do resumo do Crossref', () => {
  const jats = '<jats:title>Abstract</jats:title><jats:p>Ontologias &amp; dados&#160;abertos.</jats:p>';
  assert.equal(limparTexto(jats), 'Ontologias & dados abertos.');
});

test('lê resumo, palavras-chave e DOI das metatags acadêmicas', () => {
  const html = `<html><head>
    <meta name="citation_title" content="Um artigo">
    <meta content="Este estudo investiga ontologias de domínio aplicadas a dados hidrológicos abertos." name="citation_abstract">
    <meta name="citation_keywords" content="ontologia">
    <meta name="citation_keywords" content="dados abertos; hidrologia">
    <meta name="citation_doi" content="10.1234/abc.2024.1">
    <meta name="citation_author" content="Silva, Ana">
    <meta name="citation_author" content="Souza, Bia">
    <meta name="citation_publication_date" content="2024/03/01">
    <meta property="og:description" content="curto">
  </head></html>`;
  const m = metadadosDaPagina(html);
  assert.equal(m.resumo, 'Este estudo investiga ontologias de domínio aplicadas a dados hidrológicos abertos.');
  assert.equal(m.palavrasChave, 'ontologia; dados abertos; hidrologia');
  assert.equal(m.doi, '10.1234/abc.2024.1');
  assert.equal(m.autores, 'Silva, Ana; Souza, Bia');
  assert.equal(m.ano, 2024);
});

test('descrição genérica curta não vira resumo', () => {
  assert.equal(metadadosDaPagina('<meta name="description" content="Revista de ciência">').resumo, undefined);
});

test('bloqueia endereços internos (SSRF)', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '192.168.1.1', '172.16.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) {
    assert.ok(ipBloqueado(ip), ip);
  }
  assert.ok(!ipBloqueado('8.8.8.8'));
  await assert.rejects(buscarPagina('http://127.0.0.1/admin'), /não permitido/);
  await assert.rejects(buscarPagina('file:///etc/passwd'), /protocolo/);
  await assert.rejects(buscarPagina('http://example.com:8080/'), /porta/);
});

test('só completa o que está em branco e quando há de onde buscar', () => {
  assert.ok(precisaCompletar({ titulo: 'T', resumo: '', palavrasChave: 'a', link: 'https://x.org' }));
  assert.ok(!precisaCompletar({ titulo: 'T', resumo: 'r', palavrasChave: 'a', link: 'https://x.org' }));
});
