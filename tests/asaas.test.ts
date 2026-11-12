import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpfCnpjValido, hojeAsaas } from '../src/services/asaas.ts';
import { assinaturaDoEvento, fimDoPeriodo, isentoDeCobranca } from '../src/modules/planos/assinaturas.ts';
import { REGRAS, valorDoPlano } from '../src/modules/planos/planos.service.ts';

test('CPF e CNPJ com dígitos verificadores', () => {
  assert.equal(cpfCnpjValido('529.982.247-25'), true);
  assert.equal(cpfCnpjValido('52998224724'), false);
  assert.equal(cpfCnpjValido('111.111.111-11'), false);
  assert.equal(cpfCnpjValido('11.222.333/0001-81'), true);
  assert.equal(cpfCnpjValido('11222333000180'), false);
  assert.equal(cpfCnpjValido('123'), false);
});

test('preços: anual = 10 mensalidades; desconto estudantil de 20% só no Standard', () => {
  assert.equal(valorDoPlano('STANDARD', 'MENSAL'), 49.9);
  assert.equal(valorDoPlano('MASTER', 'ANUAL'), 799);
  assert.equal(valorDoPlano('STANDARD', 'MENSAL', true), 39.92);
  assert.equal(valorDoPlano('STANDARD', 'ANUAL', true), 399.2);
  assert.equal(valorDoPlano('MASTER', 'MENSAL', true), 79.9);
});

test('limites: membros e espaço por plano; Questões no Free e no Standard', () => {
  assert.deepEqual(
    [REGRAS.FREE.limiteMembros, REGRAS.STANDARD.limiteMembros, REGRAS.MASTER.limiteMembros],
    [1, 5, null],
  );
  assert.deepEqual(
    [
      REGRAS.FREE.limiteArmazenamentoMb,
      REGRAS.STANDARD.limiteArmazenamentoMb,
      REGRAS.MASTER.limiteArmazenamentoMb,
    ],
    [500, 5120, 20480],
  );
  assert.ok(REGRAS.STANDARD.recursos.includes('QUESTOES'));
  assert.ok(REGRAS.FREE.recursos.includes('QUESTOES'));
  assert.ok(!REGRAS.STANDARD.recursos.includes('ANALISES'));
});

test('período pago: mensal e anual contados do vencimento (horário de Brasília)', () => {
  assert.equal(fimDoPeriodo('2026-11-10', 'MENSAL').toISOString(), '2026-12-11T02:59:59.000Z');
  assert.equal(fimDoPeriodo('2026-11-10', 'ANUAL').toISOString(), '2027-11-11T02:59:59.000Z');
  assert.equal(hojeAsaas(new Date('2026-11-11T01:00:00Z')), '2026-11-10');
});

test('admin e contas vitalícias nunca são cobradas', () => {
  assert.equal(isentoDeCobranca({ perfilGlobal: 'ADMIN', planoVitalicio: false }), true);
  assert.equal(isentoDeCobranca({ perfilGlobal: 'USUARIO', planoVitalicio: true }), true);
  assert.equal(isentoDeCobranca({ perfilGlobal: 'USUARIO', planoVitalicio: false }), false);
  assert.equal(isentoDeCobranca(undefined), false);
});

test('webhook: identifica a assinatura do aviso (avisos sem assinatura são de outros usos da conta)', () => {
  assert.equal(assinaturaDoEvento({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', subscription: 'sub_1' } }), 'sub_1');
  assert.equal(assinaturaDoEvento({ event: 'SUBSCRIPTION_DELETED', subscription: { id: 'sub_2' } }), 'sub_2');
  assert.equal(assinaturaDoEvento({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_avulso' } }), null);
  assert.equal(assinaturaDoEvento({}), null);
});
