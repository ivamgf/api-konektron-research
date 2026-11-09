// Protocolo: metodologia (tipo + descrição), riscos, benefícios, resultados esperados e o TCLE
// preenchido (arquivo opcional). Revisão: onde a revisão foi registrada (URL e identificador).
// Idempotente: o script SQL de instalação nova já traz as colunas.

export const config = { transaction: false }; // DDL no MySQL faz commit implícito

const colunasProtocolo = {
  metodologia_tipo: (t) => t.string('metodologia_tipo', 40).nullable().comment('DSR, QUANTITATIVA, QUALITATIVA, MISTA...'),
  metodologia_outro: (t) => t.string('metodologia_outro', 200).nullable().comment('nome do tipo quando OUTRA'),
  metodologia: (t) => t.text('metodologia').nullable().comment('descrição da abordagem e dos procedimentos'),
  riscos: (t) => t.text('riscos').nullable().comment('opcional'),
  beneficios: (t) => t.text('beneficios').nullable().comment('opcional'),
  resultados_esperados: (t) => t.text('resultados_esperados').nullable(),
  tcle_arquivo_id: (t) => t.specificType('tcle_arquivo_id', 'CHAR(36)').nullable().comment('TCLE preenchido (opcional)'),
};
const colunasRevisao = {
  registro_url: (t) => t.string('registro_url', 1000).nullable().comment('onde a revisão foi registrada (PROSPERO, OSF...)'),
  registro_identificador: (t) => t.string('registro_identificador', 120).nullable(),
};

async function adicionar(knex, tabela, colunas) {
  const faltam = [];
  for (const nome of Object.keys(colunas)) if (!(await knex.schema.hasColumn(tabela, nome))) faltam.push(nome);
  if (faltam.length) await knex.schema.alterTable(tabela, (t) => faltam.forEach((n) => colunas[n](t)));
  return faltam;
}

export async function up(knex) {
  const novas = await adicionar(knex, 'protocolo', colunasProtocolo);
  if (novas.includes('tcle_arquivo_id')) {
    await knex.schema.alterTable('protocolo', (t) => {
      t.foreign('tcle_arquivo_id', 'fk_protocolo_tcle').references('arquivo.id').onDelete('SET NULL');
    });
  }
  await adicionar(knex, 'revisao', colunasRevisao);
}

export async function down(knex) {
  if (await knex.schema.hasColumn('protocolo', 'tcle_arquivo_id')) {
    await knex.schema.alterTable('protocolo', (t) => t.dropForeign('tcle_arquivo_id', 'fk_protocolo_tcle'));
  }
  for (const [tabela, colunas] of [
    ['protocolo', colunasProtocolo],
    ['revisao', colunasRevisao],
  ]) {
    const existem = [];
    for (const nome of Object.keys(colunas)) if (await knex.schema.hasColumn(tabela, nome)) existem.push(nome);
    if (existem.length) await knex.schema.alterTable(tabela, (t) => t.dropColumns(...existem));
  }
}
