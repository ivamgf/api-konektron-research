import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenDoWorker } from '#services/fila.ts';

test('o token de reserva cabe em fila_tarefa.bloqueado_por (VARCHAR(64)) e é único', () => {
  const a = tokenDoWorker();
  assert.ok(a.length <= 64, `token com ${a.length} caracteres`);
  assert.notEqual(a, tokenDoWorker());
});
