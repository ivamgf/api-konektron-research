// Análise: "resumo do assunto" de cada documento, escrito (ou gerado com IA) antes de responder às
// questões de pesquisa. Idempotente: o script SQL de instalação nova já traz a coluna.

export const config = { transaction: false }; // DDL no MySQL faz commit implícito

export async function up(knex) {
  if (await knex.schema.hasColumn('analise_documento', 'resumo_assunto')) return;
  await knex.schema.alterTable('analise_documento', (t) => {
    t.text('resumo_assunto').nullable().comment('resumo do assunto do documento, base para as respostas');
  });
}

export async function down(knex) {
  if (await knex.schema.hasColumn('analise_documento', 'resumo_assunto')) {
    await knex.schema.alterTable('analise_documento', (t) => t.dropColumn('resumo_assunto'));
  }
}
