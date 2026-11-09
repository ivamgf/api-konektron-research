import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dividirTexto } from '#services/traducao.ts';
import { secoesProtocolo } from '#pdf/protocolo.ts';

test('dividirTexto respeita o limite em bytes, não corta frases e mantém os parágrafos', () => {
  const frase = 'Esta pesquisa analisa ontologias e dados abertos conectados em ciência de dados. ';
  const texto = `${frase.repeat(12).trim()}\n\nSegundo parágrafo curto.`;
  const partes = dividirTexto(texto, 200);
  assert.equal(partes.length, 2, 'dois parágrafos');
  assert.ok(partes[0].length > 1, 'parágrafo longo dividido');
  assert.ok(partes.flat().every((p) => Buffer.byteLength(p, 'utf8') <= 200));
  assert.ok(partes[0].every((p) => p.endsWith('.')), 'cada pedaço termina numa frase');
  assert.deepEqual(partes[1], ['Segundo parágrafo curto.']);
  assert.equal(partes[0].join(' '), frase.repeat(12).trim());
});

test('frase maior que o limite é cortada por palavras', () => {
  const longa = 'palavra '.repeat(60).trim() + '.';
  const partes = dividirTexto(longa, 100).flat();
  assert.ok(partes.length > 1 && partes.every((p) => Buffer.byteLength(p) <= 100));
  assert.equal(partes.join(' '), longa);
});

test('PDF do protocolo traz os resumos com o título no próprio idioma', () => {
  const html = secoesProtocolo({
    projeto: { titulo: 'P' },
    equipe: [],
    p: { resumos: [{ idiomaCodigo: 'pt', texto: 'Resumo em português.' }, { idiomaCodigo: 'en', texto: 'English abstract.' }, { idiomaCodigo: 'it', idiomaNome: 'Italiano', texto: 'Riassunto.' }] },
    versao: 1,
    status: 'CONCLUIDO',
    revisoes: [],
    versoes: [],
    secoes: ['definicoes'],
  });
  assert.match(html, /<h3>Resumo<\/h3><p>Resumo em português\.<\/p>/);
  assert.match(html, /<h3>Abstract<\/h3>/);
  assert.match(html, /<h3>Riassunto<\/h3>/);
});
