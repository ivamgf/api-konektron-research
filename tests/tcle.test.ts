import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODIGOS_METODOLOGIA, METODOLOGIAS, modeloTcle, nomeMetodologia } from '#modules/protocolo/tcle.ts';

const dados = {
  projeto: { titulo: 'Acessibilidade em ambientes imersivos <3D>', instituicao: 'UFSC', programa: 'PPGEGC' },
  equipe: [
    { nome: 'Ana Pesquisadora', email: 'ana@exemplo.org', papel: 'RESPONSAVEL' },
    { nome: 'Bruno Orientador', email: null, papel: 'ORIENTADOR' },
    { nome: 'Leitor', email: 'l@x.org', papel: 'LEITOR' },
  ],
  protocolo: {
    objetivoGeral: 'Desenvolver um framework.',
    justificativa: 'Ambientes imersivos ainda têm barreiras.\n\nSegundo parágrafo.',
    metodologiaTipo: 'DSR',
    metodologia: 'Testes em laboratório com questionário.',
    riscos: 'Tontura e cansaço visual.',
    beneficios: null,
  },
};

test('modelo de TCLE traz os dados do protocolo e marca o que falta preencher', () => {
  const html = modeloTcle(dados);
  assert.ok(html.includes('Acessibilidade em ambientes imersivos &lt;3D&gt;'), 'título escapado');
  assert.ok(html.includes('PPGEGC — UFSC'));
  assert.ok(html.includes('Ana Pesquisadora / ana@exemplo.org'));
  assert.ok(html.includes('Ana Pesquisadora / Bruno Orientador'), 'equipe sem leitores');
  assert.ok(!html.includes('Leitor /'));
  assert.ok(html.includes('Design Science Research (DSR)'));
  assert.ok(html.includes('Tontura e cansaço visual.'));
  assert.ok(html.includes('<p>Segundo parágrafo.</p>'));
  assert.match(html, /preencher">\[benefícios diretos/, 'benefício vazio vira campo a preencher');
  assert.match(html, /TERMO DE ACEITE/);
  assert.match(html, /xmlns:w="urn:schemas-microsoft-com:office:word"/, 'abre no Word');
});

test('metodologias: códigos e nome de "Outra"', () => {
  assert.ok(CODIGOS_METODOLOGIA.includes('DSR') && CODIGOS_METODOLOGIA.includes('MISTA') && CODIGOS_METODOLOGIA.includes('OUTRA'));
  assert.equal(nomeMetodologia({ metodologiaTipo: 'QUALITATIVA' }), METODOLOGIAS.QUALITATIVA);
  assert.equal(nomeMetodologia({ metodologiaTipo: 'OUTRA', metodologiaOutro: 'Netnografia' }), 'Netnografia');
  assert.equal(nomeMetodologia({ metodologiaTipo: null }), null);
});
