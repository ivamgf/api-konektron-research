// Migração base: cria o banco a partir das seções 0 a 6 do script SQL (tabelas,
// índices, visões, catálogos e administrador). Se o script já foi importado pelo
// phpMyAdmin, apenas registra a migração.
import { executar, lerTrecho, MARCAS } from '../../../scripts/sql.js';

export const config = { transaction: false }; // DDL no MySQL faz commit implícito

export async function up(knex) {
  if (await knex.schema.hasTable('usuario')) return;
  await executar(knex.client.config.connection, lerTrecho(MARCAS.inicio, MARCAS.teste));
}

export async function down() {
  throw new Error('A migração base não é revertida: recrie o banco pelo script SQL.');
}
