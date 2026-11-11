// Referências do projeto em mais normas: MLA (9ª ed.), Chicago (17ª ed., autor-data), Vancouver e IEEE,
// além de ABNT NBR 6023 e APA. Idempotente: o script SQL de instalação nova já traz as colunas.

export const config = { transaction: false }; // DDL no MySQL faz commit implícito

const COLUNAS = [
  ['mla', 'MLA 9ª ed.', 'apa'],
  ['chicago', 'Chicago 17ª ed. (autor-data)', 'mla'],
  ['vancouver', 'Vancouver (ICMJE)', 'chicago'],
  ['ieee', 'IEEE', 'vancouver'],
];

export async function up(knex) {
  for (const [coluna, comentario, depois] of COLUNAS) {
    if (await knex.schema.hasColumn('referencia', coluna)) continue;
    await knex.schema.alterTable('referencia', (t) => {
      t.text(coluna).nullable().comment(comentario).after(depois);
    });
  }
}

export async function down(knex) {
  for (const [coluna] of [...COLUNAS].reverse()) {
    if (await knex.schema.hasColumn('referencia', coluna)) {
      await knex.schema.alterTable('referencia', (t) => t.dropColumn(coluna));
    }
  }
}
