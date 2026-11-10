// Gerador de artigo: subtítulo do projeto e o rascunho do artigo (um por projeto, em JSON).
// Idempotente: o script SQL de instalação nova já traz a coluna e a tabela.

export const config = { transaction: false }; // DDL no MySQL faz commit implícito

export async function up(knex) {
  if (!(await knex.schema.hasColumn('projeto', 'subtitulo'))) {
    await knex.schema.alterTable('projeto', (t) => {
      t.string('subtitulo', 300).nullable().after('titulo');
    });
  }
  if (await knex.schema.hasTable('artigo')) return;
  await knex.schema.createTable('artigo', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('projeto_id', 'CHAR(36)').notNullable().primary();
    t.json('dados').notNullable().comment('rascunho do artigo: textos e escolhas de cada seção');
    t.specificType('atualizado_por', 'CHAR(36)').nullable();
    t.specificType('atualizado_em', 'DATETIME(3)')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.foreign('projeto_id', 'fk_artigo_projeto').references('projeto.id').onDelete('CASCADE');
    t.foreign('atualizado_por', 'fk_artigo_atualizado_por')
      .references('usuario.id')
      .onDelete('SET NULL');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('artigo');
  if (await knex.schema.hasColumn('projeto', 'subtitulo')) {
    await knex.schema.alterTable('projeto', (t) => t.dropColumn('subtitulo'));
  }
}
