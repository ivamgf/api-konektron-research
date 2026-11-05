// Dados para teste (seção 7 do script). Nunca roda em produção nem em banco que já tem projetos.
import { executar, lerTrecho, MARCAS } from '../../../scripts/sql.js';

export async function seed(knex) {
  if (process.env.NODE_ENV === 'production') {
    console.log('seed de teste ignorado em produção');
    return;
  }
  const [{ n }] = await knex('projeto').count({ n: '*' });
  if (Number(n) > 0) {
    console.log('seed de teste ignorado: o banco já tem projetos');
    return;
  }
  await executar(knex.client.config.connection, lerTrecho(MARCAS.teste, MARCAS.verificacao));
  console.log('dados de teste inseridos (senha dos usuários de teste: Teste@2026)');
}
