import { test } from 'node:test';
import assert from 'node:assert/strict';

// arquivo próprio: a chave precisa existir antes de o env (congelado) ser carregado
process.env.ASAAS_API_KEY = 'chave-de-teste';
process.env.ASAAS_API_URL = 'https://api-sandbox.asaas.com/v3';

test('Asaas instável (500): atualização é repetida uma vez; criação nunca é repetida', async (t) => {
  const { default: https } = await import('node:https');
  const { EventEmitter } = await import('node:events');
  const { chamarAsaas } = await import('../src/services/asaas.ts');
  let respostas: number[] = [];
  const chamadas: string[] = [];
  t.mock.method(
    https,
    'request',
    (url: URL, opts: { method: string }, cb: (res: unknown) => void) => {
      chamadas.push(`${opts.method} ${url.pathname}`);
      const status = respostas.shift() ?? 200;
      const req = Object.assign(new EventEmitter(), {
        write() {},
        destroy() {},
        end() {
          const res = Object.assign(new EventEmitter(), { statusCode: status });
          cb(res);
          res.emit(
            'data',
            Buffer.from(
              JSON.stringify(
                status === 200 ? { id: 'sub_1' } : { errors: [{ code: 'unknow.error' }] },
              ),
            ),
          );
          res.emit('end');
        },
      });
      return req;
    },
  );

  respostas = [500, 200];
  assert.deepEqual(await chamarAsaas('POST', '/subscriptions/sub_1', { value: 49.9 }), {
    id: 'sub_1',
  });
  assert.equal(chamadas.length, 2);

  chamadas.length = 0;
  respostas = [500, 200];
  await assert.rejects(chamarAsaas('POST', '/subscriptions', { value: 49.9 }), { status: 500 });
  assert.equal(chamadas.length, 1);

  chamadas.length = 0;
  respostas = [400];
  await assert.rejects(chamarAsaas('DELETE', '/subscriptions/sub_1'), { status: 400 });
  assert.equal(chamadas.length, 1);
});
