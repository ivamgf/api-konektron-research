import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expiraEm,
  MESES_FREE,
  planoEfetivo,
  REGRAS,
  RECURSOS,
} from '../src/modules/planos/planos.service.ts';

const base = {
  id: 'u1',
  perfilGlobal: 'USUARIO',
  plano: 'FREE' as const,
  planoVitalicio: false,
  planoLimiteEm: null,
  planoBloqueadoEm: null,
};

test('administrador é sempre Master', () => {
  assert.equal(planoEfetivo({ perfilGlobal: 'ADMIN', plano: 'FREE' }), 'MASTER');
  assert.equal(planoEfetivo({ perfilGlobal: 'USUARIO', plano: 'STANDARD' }), 'STANDARD');
});

test('Free: 3 projetos; Standard sem limite e só com Questões; Master com tudo', () => {
  assert.equal(REGRAS.FREE.limiteProjetos, 3);
  assert.equal(REGRAS.STANDARD.limiteProjetos, null);
  assert.deepEqual(REGRAS.STANDARD.recursos, ['QUESTOES']);
  assert.deepEqual([...REGRAS.MASTER.recursos], [...RECURSOS]);
});

test('Free expira 3 meses depois de atingir o limite; vitalício e planos pagos não expiram', () => {
  const limite = new Date('2026-01-15T12:00:00Z');
  assert.equal(MESES_FREE, 3);
  assert.equal(
    expiraEm({ ...base, planoLimiteEm: limite })?.toISOString(),
    '2026-04-15T12:00:00.000Z',
  );
  assert.equal(expiraEm(base), null);
  assert.equal(expiraEm({ ...base, planoLimiteEm: limite, planoVitalicio: true }), null);
  assert.equal(expiraEm({ ...base, plano: 'STANDARD', planoLimiteEm: limite }), null);
  assert.equal(expiraEm({ ...base, perfilGlobal: 'ADMIN', planoLimiteEm: limite }), null);
});
