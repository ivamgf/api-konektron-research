// Cria as rotinas e gatilhos opcionais (seção 9 do script). Na hospedagem compartilhada
// pode falhar com #1419 (sem privilégio SUPER e log binário ativo): a API cobre essas regras.
import config from '../knexfile.js';
import { executar, lerTrecho, MARCAS } from './sql.js';

const env = process.env.NODE_ENV || 'development';
try {
  await executar(config[env].connection, lerTrecho(MARCAS.rotinas));
  console.log('rotinas e gatilhos criados');
} catch (err) {
  console.error(`não foi possível criar as rotinas: ${err.message}`);
  process.exitCode = 1;
}
