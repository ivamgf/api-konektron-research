// Storage por FTP numa pasta da hospedagem (STORAGE_DRIVER=ftp): novo valor 'FTP' em arquivo.provedor.
// Idempotente: repetir o MODIFY com a mesma definição não muda nada.

export const config = { transaction: false };

export async function up(knex) {
  await knex.raw("ALTER TABLE arquivo MODIFY provedor ENUM('LOCAL','GCS','FTP') NOT NULL DEFAULT 'LOCAL'");
}

export async function down(knex) {
  await knex.raw("UPDATE arquivo SET provedor = 'LOCAL' WHERE provedor = 'FTP'");
  await knex.raw("ALTER TABLE arquivo MODIFY provedor ENUM('LOCAL','GCS') NOT NULL DEFAULT 'LOCAL'");
}
