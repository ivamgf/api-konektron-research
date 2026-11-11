import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referenciaApa, referenciaChicago, referenciaIeee, referenciaMla, referenciaNbr, referenciaVancouver } from '../src/utils/referencias.ts';

const doc = { titulo: 'Uma ontologia de domínio', autores: 'Silva, Ana Maria; Costa, Bruno', ano: 2023, periodico: 'Revista Exemplo', doi: '10.5555/x.1' };

test('referência ABNT NBR 6023', () => {
  assert.equal(referenciaNbr(doc), 'SILVA, A. M.; COSTA, B. Uma ontologia de domínio. Revista Exemplo, 2023. DOI: https://doi.org/10.5555/x.1.');
});

test('referência APA 7', () => {
  assert.equal(referenciaApa(doc), 'Silva, A. M., & Costa, B. (2023). Uma ontologia de domínio. Revista Exemplo. https://doi.org/10.5555/x.1');
});

test('mais de 3 autores na NBR vira et al.', () => {
  assert.match(referenciaNbr({ ...doc, autores: 'A, B; C, D; E, F; G, H' }), /^A, B\. et al\./);
});

test('referência MLA 9', () => {
  assert.equal(referenciaMla(doc), 'Silva, Ana Maria, and Bruno Costa. “Uma ontologia de domínio.” Revista Exemplo, 2023, https://doi.org/10.5555/x.1.');
  assert.match(referenciaMla({ ...doc, autores: 'A, B; C, D; E, F' }), /^A, B, et al\. “/);
});

test('referência Chicago 17 (autor-data)', () => {
  assert.equal(referenciaChicago(doc), 'Silva, Ana Maria, and Bruno Costa. 2023. “Uma ontologia de domínio.” Revista Exemplo. https://doi.org/10.5555/x.1.');
});

test('referência Vancouver', () => {
  assert.equal(referenciaVancouver(doc), 'Silva AM, Costa B. Uma ontologia de domínio. Revista Exemplo. 2023. doi:10.5555/x.1');
});

test('referência IEEE', () => {
  assert.equal(referenciaIeee(doc), 'A. M. Silva and B. Costa, “Uma ontologia de domínio,” Revista Exemplo, 2023, doi: 10.5555/x.1.');
  assert.equal(
    referenciaIeee({ titulo: 'Sem DOI', link: 'https://exemplo.org/a' }),
    '“Sem DOI,” [Online]. Available: https://exemplo.org/a',
  );
});
