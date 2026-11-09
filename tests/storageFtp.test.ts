import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarChave } from '#services/storage/ftp.ts';

test('chave de storage do FTP aceita caminhos do sistema e recusa fuga de pasta', () => {
  assert.equal(validarChave('projetos/3f2a/protocolo/tcle-9b1c.pdf'), 'projetos/3f2a/protocolo/tcle-9b1c.pdf');
  assert.equal(validarChave('projetos/p1/buscas/b1.csv'), 'projetos/p1/buscas/b1.csv');
  for (const ruim of ['../segredo', 'a/../../b', '/etc/passwd', 'a//b', 'a/./b', '', 'a/b;rm', 'a/b\nc'])
    assert.throws(() => validarChave(ruim), /chave de storage inválida/, ruim);
});
