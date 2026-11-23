// Cortesia (opção interna): o plano escolhido vale sem cobrança até uma data; depois a conta volta ao Free
// pela tarefa periódica do worker. Também o telefone de contato do usuário.
// Idempotente: o script SQL de instalação nova já traz as colunas.

export const config = { transaction: false }; // DDL no MySQL faz commit implícito

export async function up(knex) {
  if (!(await knex.schema.hasColumn('usuario', 'plano_cortesia_ate'))) {
    await knex.schema.alterTable('usuario', (t) => {
      t.specificType('plano_cortesia_ate', 'DATETIME(3)')
        .nullable()
        .comment('opção interna: plano sem cobrança até esta data; depois volta ao Free')
        .after('plano_vitalicio');
    });
  }
  if (!(await knex.schema.hasColumn('usuario', 'telefone'))) {
    await knex.schema.alterTable('usuario', (t) => {
      t.string('telefone', 20).nullable().comment('só dígitos, com DDD').after('email');
    });
  }
}

export async function down(knex) {
  if (await knex.schema.hasColumn('usuario', 'telefone')) {
    await knex.schema.alterTable('usuario', (t) => t.dropColumn('telefone'));
  }
  if (await knex.schema.hasColumn('usuario', 'plano_cortesia_ate')) {
    await knex.schema.alterTable('usuario', (t) => t.dropColumn('plano_cortesia_ate'));
  }
}
