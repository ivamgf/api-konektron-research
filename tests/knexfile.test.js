import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../knexfile.js';

// O knex repete connection.charset no CREATE TABLE knex_migrations; um collation ali
// ("utf8mb4_unicode_ci") faz o MySQL falhar com "Unknown character set".
test('knexfile usa charset (não collation) e fixa o collation na sessão', () => {
  for (const [ambiente, c] of Object.entries(config)) {
    assert.equal(c.connection.charset, 'utf8mb4', ambiente);
    assert.equal(typeof c.pool.afterCreate, 'function', ambiente);
  }
  const executadas = [];
  config.development.pool.afterCreate({ query: (sql, cb) => (executadas.push(sql), cb(null)) }, () => {});
  assert.match(executadas[0], /SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci/);
  assert.match(executadas[0], /time_zone = '\+00:00'/);
});
