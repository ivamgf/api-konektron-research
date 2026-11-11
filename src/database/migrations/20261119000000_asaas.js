// Cobrança dos planos pelo Asaas: dados de cobrança no usuário, assinaturas, pagamentos e os eventos
// recebidos pelo webhook (idempotência pelo id do evento). Também o desconto estudantil (opção interna).
// Idempotente: o script SQL de instalação nova já traz as colunas e as tabelas.

export const config = { transaction: false }; // DDL no MySQL faz commit implícito

const tabela = (t) => {
  t.engine('InnoDB');
  t.charset('utf8mb4');
  t.collate('utf8mb4_unicode_ci');
};
const datas = (knex, t) => {
  t.specificType('criado_em', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
  t.specificType('atualizado_em', 'DATETIME(3)')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
};

export async function up(knex) {
  if (!(await knex.schema.hasColumn('usuario', 'cpf_cnpj'))) {
    await knex.schema.alterTable('usuario', (t) => {
      t.string('cpf_cnpj', 14).nullable().comment('só dígitos; exigido pelo Asaas para cobrar').after('plano_aviso_dias');
      t.string('asaas_cliente_id', 40).nullable().after('cpf_cnpj');
      t.boolean('desconto_estudante')
        .notNullable()
        .defaultTo(false)
        .comment('opção interna: 20% no Standard')
        .after('asaas_cliente_id');
    });
  }
  if (!(await knex.schema.hasTable('assinatura'))) {
    await knex.schema.createTable('assinatura', (t) => {
      tabela(t);
      t.specificType('id', 'CHAR(36)').notNullable().primary();
      t.specificType('usuario_id', 'CHAR(36)').notNullable();
      t.enu('plano', ['STANDARD', 'MASTER']).notNullable();
      t.enu('ciclo', ['MENSAL', 'ANUAL']).notNullable();
      t.decimal('valor', 10, 2).notNullable();
      t.string('asaas_assinatura_id', 40).nullable();
      t.enu('status', ['PENDENTE', 'ATIVA', 'ATRASADA', 'CANCELADA']).notNullable().defaultTo('PENDENTE');
      t.specificType('pago_ate', 'DATETIME(3)').nullable().comment('fim do período já pago');
      t.specificType('cancelada_em', 'DATETIME(3)').nullable();
      datas(knex, t);
      t.unique(['asaas_assinatura_id'], { indexName: 'uq_assinatura_asaas' });
      t.index(['usuario_id', 'status'], 'ix_assinatura_usuario');
      t.foreign('usuario_id', 'fk_assinatura_usuario').references('usuario.id').onDelete('CASCADE');
    });
  }
  if (!(await knex.schema.hasTable('pagamento'))) {
    await knex.schema.createTable('pagamento', (t) => {
      tabela(t);
      t.specificType('id', 'CHAR(36)').notNullable().primary();
      t.specificType('assinatura_id', 'CHAR(36)').nullable();
      t.string('asaas_pagamento_id', 40).notNullable();
      t.decimal('valor', 10, 2).notNullable();
      t.string('status', 40).notNullable().comment('status do Asaas: PENDING, CONFIRMED, RECEIVED, OVERDUE...');
      t.string('forma', 20).nullable().comment('BOLETO, PIX, CREDIT_CARD, UNDEFINED');
      t.date('vencimento').notNullable();
      t.specificType('pago_em', 'DATETIME(3)').nullable();
      t.string('link_fatura', 500).nullable();
      datas(knex, t);
      t.unique(['asaas_pagamento_id'], { indexName: 'uq_pagamento_asaas' });
      t.foreign('assinatura_id', 'fk_pagamento_assinatura').references('assinatura.id').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasTable('webhook_evento'))) {
    await knex.schema.createTable('webhook_evento', (t) => {
      tabela(t);
      t.string('id', 60).notNullable().primary().comment('id do evento no Asaas');
      t.string('tipo', 60).notNullable();
      t.json('payload').notNullable();
      t.specificType('recebido_em', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
      t.specificType('processado_em', 'DATETIME(3)').nullable();
      t.string('erro', 500).nullable();
    });
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('webhook_evento');
  await knex.schema.dropTableIfExists('pagamento');
  await knex.schema.dropTableIfExists('assinatura');
  if (await knex.schema.hasColumn('usuario', 'cpf_cnpj')) {
    await knex.schema.alterTable('usuario', (t) => {
      t.dropColumn('desconto_estudante');
      t.dropColumn('asaas_cliente_id');
      t.dropColumn('cpf_cnpj');
    });
  }
}
