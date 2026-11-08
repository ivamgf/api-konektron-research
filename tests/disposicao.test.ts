import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disposicao } from '#services/storage/disposicao.ts';

test('PDF abre no navegador (inline) e mantém o nome com acentos', () => {
  const d = disposicao('relatório "final".pdf', 'application/pdf');
  assert.match(d, /^inline; /);
  assert.match(d, /filename="relatorio final\.pdf"/);
  assert.match(d, /filename\*=UTF-8''relat%C3%B3rio%20%22final%22\.pdf$/);
});

test('outros formatos continuam como download', () => {
  assert.match(disposicao('projeto.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), /^attachment; /);
  assert.match(disposicao('busca.csv'), /^attachment; /);
});
