import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  corrigirOrdemDasFases,
  erroOrdemDasFases,
  numeroDaFase,
} from '../src/shared/fasesTriagem.ts';

const e = (nome: string) => ({ nome });

test('lê o número da fase no nome da etapa', () => {
  assert.equal(numeroDaFase('Triagem F1 (título e resumo)'), 1);
  assert.equal(numeroDaFase('Triagem F2/F3 (acesso e texto completo)'), 2);
  assert.equal(numeroDaFase('Elegibilidade F3 (texto completo)'), 3);
  assert.equal(numeroDaFase('Fase 2 da triagem'), 2);
  assert.equal(numeroDaFase('Remoção de duplicados'), null);
  assert.equal(numeroDaFase('Framework'), null);
});

test('põe F1 antes de F2 e F2 antes de F3 sem mexer nas outras etapas', () => {
  const etapas = [
    'Protocolo',
    'Remoção de duplicados',
    'Triagem F2',
    'Triagem F1',
    'Elegibilidade F3',
    'Inclusão',
  ].map(e);
  assert.deepEqual(
    corrigirOrdemDasFases(etapas).map((x) => x.nome),
    [
      'Protocolo',
      'Remoção de duplicados',
      'Triagem F1',
      'Triagem F2',
      'Elegibilidade F3',
      'Inclusão',
    ],
  );
  const f3primeiro = ['Busca', 'Elegibilidade F3', 'Inclusão', 'Triagem F1', 'Triagem F2'].map(e);
  assert.deepEqual(
    corrigirOrdemDasFases(f3primeiro).map((x) => x.nome),
    ['Busca', 'Triagem F1', 'Inclusão', 'Triagem F2', 'Elegibilidade F3'],
  );
});

test('aponta a ordem errada das fases', () => {
  assert.equal(erroOrdemDasFases(['Triagem F1', 'Triagem F2', 'F3'].map(e)), null);
  assert.match(
    erroOrdemDasFases(['Triagem F2', 'Triagem F1'].map(e))!,
    /"Triagem F1" deve vir antes de "Triagem F2"/,
  );
});
