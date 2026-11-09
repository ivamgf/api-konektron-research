// Referências do projeto em ABNT (NBR 6023) e APA (7ª ed.): cadastradas à mão ou trazidas dos
// documentos do projeto. Idempotente: o script SQL de instalação nova já traz a tabela.

export const config = { transaction: false };

export async function up(knex) {
  if (await knex.schema.hasTable('referencia')) return;
  await knex.schema.createTable('referencia', (t) => {
    // mesmo charset/collation das outras tabelas (as FKs CHAR(36) exigem)
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('id', 'CHAR(36)').notNullable().primary();
    t.specificType('projeto_id', 'CHAR(36)').notNullable();
    t.specificType('documento_id', 'CHAR(36)').nullable().comment('documento de origem, quando importada');
    t.text('abnt').nullable();
    t.text('apa').nullable();
    t.string('observacao', 500).nullable();
    t.specificType('criado_por', 'CHAR(36)').nullable();
    t.specificType('criado_em', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.specificType('atualizado_em', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
    t.unique(['projeto_id', 'documento_id'], { indexName: 'uq_referencia_documento' });
    t.foreign('projeto_id', 'fk_referencia_projeto').references('projeto.id').onDelete('CASCADE');
    t.foreign('documento_id', 'fk_referencia_documento').references('documento.id').onDelete('SET NULL');
    t.foreign('criado_por', 'fk_referencia_criado_por').references('usuario.id').onDelete('SET NULL');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('referencia');
}
