// Resumo do protocolo em vários idiomas (português, inglês, espanhol e outros do catálogo).
// Idempotente: o script SQL de instalação nova já traz a tabela.

export const config = { transaction: false };

export async function up(knex) {
  if (await knex.schema.hasTable('protocolo_resumo')) return;
  await knex.schema.createTable('protocolo_resumo', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('id', 'CHAR(36)').notNullable().primary();
    t.specificType('protocolo_id', 'CHAR(36)').notNullable();
    t.specificType('idioma_id', 'SMALLINT UNSIGNED').notNullable();
    t.text('texto').notNullable();
    t.specificType('ordem', 'INT UNSIGNED').notNullable().defaultTo(1);
    t.unique(['protocolo_id', 'idioma_id'], { indexName: 'uq_protocolo_resumo_idioma' });
    t.foreign('protocolo_id', 'fk_protocolo_resumo_protocolo').references('protocolo.id').onDelete('CASCADE');
    t.foreign('idioma_id', 'fk_protocolo_resumo_idioma').references('idioma.id');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('protocolo_resumo');
}
