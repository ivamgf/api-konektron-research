import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limparDoi, normalizarTitulo, similaridade, LIMIAR_DUPLICADO } from '../src/utils/normalize.ts';

test('normaliza títulos como o fn_normalizar_titulo do banco (RN11)', () => {
  assert.equal(normalizarTitulo('Uma Ontologia de Domínio — Integração!'), 'uma ontologia de dominio integracao');
  assert.equal(normalizarTitulo('Ontology-based  metadata'), 'ontology based metadata');
  assert.equal(normalizarTitulo(null), '');
});

test('limpa DOI', () => {
  assert.equal(limparDoi('https://doi.org/10.5555/EXEMPLO.1'), '10.5555/exemplo.1');
  assert.equal(limparDoi('http://dx.doi.org/10.1/x'), '10.1/x');
  assert.equal(limparDoi('doi: 10.1/Y'), '10.1/y');
  assert.equal(limparDoi('  '), null);
});

test('similaridade de títulos', () => {
  const a = normalizarTitulo('Uma ontologia de domínio para integração de dados hidrológicos');
  const b = normalizarTitulo('Uma Ontologia de Domínio para Integração de Dados Hidrológicos.');
  assert.equal(similaridade(a, b), 1);
  assert.ok(similaridade(a, normalizarTitulo('Uma ontologia de dominio para integracao de dados hidrologico')) >= LIMIAR_DUPLICADO);
  assert.ok(similaridade(a, normalizarTitulo('Deep learning for urban traffic prediction')) < 0.5);
});
