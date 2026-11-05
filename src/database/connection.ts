import knexFactory, { type Knex } from 'knex';
import { env } from '#config/env.ts';
import { postProcessResponse, wrapIdentifier } from '#utils/case.ts';

// TINYINT(1) vira boolean; o resto segue o padrão do mysql2
const typeCast = (field: any, next: () => unknown) => {
  if (field.type === 'TINY' && field.length === 1) {
    const v = field.string();
    return v === null ? null : v === '1';
  }
  return next();
};

export const db = knexFactory({
  client: 'mysql2',
  connection: {
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    charset: 'utf8mb4', // charset, não collation (o knex usa este valor em CREATE TABLE)
    timezone: 'Z',
    dateStrings: ['DATE'],
    decimalNumbers: true,
    supportBigNumbers: true,
    typeCast,
    ...(env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
  } as any,
  pool: {
    min: 0,
    max: env.DB_POOL_MAX,
    afterCreate: (conn: any, done: (err: Error | null, conn: unknown) => void) => {
      conn.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci, time_zone = '+00:00'", (err: Error | null) => done(err, conn));
    },
  },
  postProcessResponse,
  wrapIdentifier,
});

export type Db = typeof db;
export type Trx = Knex.Transaction;

// Colunas JSON precisam ir como texto (o mysql2 expandiria objetos em pares chave=valor)
export const json = (v: unknown) => (v === undefined ? undefined : v === null ? null : JSON.stringify(v));

export const agora = () => new Date();
