// Configuração do Knex para a CLI (migrações e seeds). A API usa src/database/connection.ts.
try {
  process.loadEnvFile();
} catch {
  // sem .env: usa as variáveis do ambiente (Heroku Config Vars)
}

const connection = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  // migrações rodam com o usuário de migração quando ele existe (ERS 11.2)
  user: process.env.DB_MIGRATION_USER || process.env.DB_USER,
  password: process.env.DB_MIGRATION_USER ? process.env.DB_MIGRATION_PASSWORD : process.env.DB_PASSWORD,
  // charset (não collation): o knex repete este valor no CREATE TABLE knex_migrations;
  // o collation da sessão é fixado no afterCreate do pool
  charset: 'utf8mb4',
  timezone: 'Z',
  dateStrings: ['DATE'],
  decimalNumbers: true,
  supportBigNumbers: true,
};

const base = {
  client: 'mysql2',
  connection,
  pool: {
    min: 0,
    max: 2,
    afterCreate: (conn, done) => {
      conn.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci, time_zone = '+00:00'", (err) => done(err, conn));
    },
  },
  migrations: {
    directory: './src/database/migrations',
    tableName: 'knex_migrations',
    loadExtensions: ['.js'],
  },
  seeds: { directory: './src/database/seeds', loadExtensions: ['.js'] },
};

export default {
  development: base,
  test: base,
  homologation: base,
  production: base,
};
