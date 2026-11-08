import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idParams, uuidSchema } from '#shared/schemas.ts';

// IDs fixos semeados no script SQL (bases de dados, checklist) não seguem a versão/variante
// do RFC 9562; z.uuid() do Zod 4 os rejeitava ("Invalid UUID") ao salvar strings de busca.
test('aceita os IDs fixos semeados no banco', () => {
  for (const id of ['00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-000000000c01']) {
    assert.equal(uuidSchema.safeParse(id).success, true, id);
    assert.equal(idParams.safeParse({ id }).success, true, id);
  }
});

test('aceita UUID gerado e rejeita texto que não é UUID', () => {
  assert.equal(uuidSchema.safeParse(crypto.randomUUID()).success, true);
  assert.equal(uuidSchema.safeParse('nao-e-uuid').success, false);
});
