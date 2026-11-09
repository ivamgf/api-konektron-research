import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secoesProtocolo } from '#pdf/protocolo.ts';

const base = { projeto: { titulo: 'P' }, equipe: [], p: {}, versao: 1, status: 'CONCLUIDO', revisoes: [], versoes: [] };

test('PDF do protocolo traz as referências em ABNT e em APA (APA em ordem alfabética)', () => {
  const html = secoesProtocolo({
    ...base,
    secoes: ['referencias'],
    referencias: [
      { abnt: 'SILVA, A. Título. 2020.', apa: 'Silva, A. (2020). Título.' },
      { abnt: null, apa: 'Almeida, B. (2019). Outro & mais.' },
    ],
  });
  assert.match(html, /8\. Referências/);
  assert.match(html, /ABNT \(NBR 6023\)[\s\S]*SILVA, A\. Título\. 2020\./);
  assert.ok(html.indexOf('Almeida, B.') < html.indexOf('Silva, A. (2020)'), 'APA em ordem alfabética');
  assert.ok(html.includes('Outro &amp; mais'), 'texto escapado');
});

test('sem referências, a seção não aparece', () => {
  assert.ok(!secoesProtocolo({ ...base, secoes: ['referencias'], referencias: [] }).includes('Referências'));
});
