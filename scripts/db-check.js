// Testa a conexão com o MySQL e mostra versão, charset e quantidade de tabelas.
import mysql from 'mysql2/promise';
import config from '../knexfile.js';

const c = config[process.env.NODE_ENV || 'development'].connection;
const inicio = Date.now();
try {
  const conn = await mysql.createConnection({ ...c, connectTimeout: 10_000 });
  const [[info]] = await conn.query(
    `SELECT VERSION() AS versao, @@character_set_database AS charset, @@collation_database AS collation,
            (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()) AS tabelas`,
  );
  console.log(`conectado em ${c.host}:${c.port}/${c.database} em ${Date.now() - inicio} ms`, info);
  await conn.end();
} catch (err) {
  console.error(`falha ao conectar em ${c.host}:${c.port}: ${err.code ?? ''} ${err.message}`);
  console.error('verifique se o IP desta máquina está em cPanel › Acesso remoto ao banco de dados');
  process.exitCode = 1;
}
