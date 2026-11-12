// Cronograma das etapas e rascunho do relatório de pesquisa (um de cada por projeto, em JSON).
// Idempotente: o script SQL de instalação nova já traz as tabelas.

export const config = { transaction: false }; // DDL no MySQL faz commit implícito

async function criar(knex, tabela, comentario) {
  if (await knex.schema.hasTable(tabela)) return;
  await knex.schema.createTable(tabela, (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('projeto_id', 'CHAR(36)').notNullable().primary();
    t.json('dados').notNullable().comment(comentario);
    t.specificType('atualizado_por', 'CHAR(36)').nullable();
    t.specificType('atualizado_em', 'DATETIME(3)')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.foreign('projeto_id', `fk_${tabela}_projeto`).references('projeto.id').onDelete('CASCADE');
    t.foreign('atualizado_por', `fk_${tabela}_atualizado_por`)
      .references('usuario.id')
      .onDelete('SET NULL');
  });
}

export async function up(knex) {
  await criar(knex, 'cronograma', 'granularidade, anos e etapas com os meses de execução');
  await criar(knex, 'relatorio', 'revisão escolhida, opções e textos do pesquisador por revisão');
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('relatorio');
  await knex.schema.dropTableIfExists('cronograma');
}
