import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dividir, lerTrecho, MARCAS } from '../scripts/sql.js';

test('divide o script do banco respeitando DELIMITER e aspas', () => {
  const base = dividir(lerTrecho(MARCAS.inicio, MARCAS.teste));
  assert.ok(base.some((s) => s.startsWith('CREATE TABLE usuario')));
  assert.ok(base.some((s) => s.startsWith('CREATE OR REPLACE SQL SECURITY INVOKER VIEW vw_painel_etapas')));
  assert.ok(!base.some((s) => s.includes('START TRANSACTION')), 'dados de teste não entram na migração base');
  assert.equal(base.filter((s) => s.startsWith('CREATE TABLE')).length, 47);

  const teste = dividir(lerTrecho(MARCAS.teste, MARCAS.verificacao));
  assert.equal(teste[0], 'START TRANSACTION');
  assert.equal(teste.at(-1), 'COMMIT');

  const rotinas = dividir(lerTrecho(MARCAS.rotinas));
  const funcoes = rotinas.filter((s) => s.startsWith('CREATE FUNCTION'));
  const gatilhos = rotinas.filter((s) => s.startsWith('CREATE TRIGGER'));
  assert.equal(funcoes.length, 3);
  assert.equal(gatilhos.length, 17);
  assert.ok(funcoes[0].trim().endsWith('END'), 'corpo da função inteiro, sem cortar no ; interno');
});

test('ponto e vírgula dentro de texto não quebra o comando', () => {
  const r = dividir("INSERT INTO t VALUES ('a; b', 'c''d;'); SELECT 1;");
  assert.deepEqual(r, ["INSERT INTO t VALUES ('a; b', 'c''d;')", 'SELECT 1']);
});
