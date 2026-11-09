// O protocolo passou de 8 para 11 passos (metodologia; riscos, benefícios e resultados; resumo):
// os gatilhos que recusavam passo_atual acima de 8 são recriados com folga (1 a 20).
// O limite exato é validado pela API (PUT /protocolo). Na hospedagem compartilhada, criar
// gatilho pode exigir privilégio (#1419): se falhar, a regra continua garantida pela API.

export const config = { transaction: false };

const gatilho = (nome, evento, max) => `CREATE TRIGGER ${nome} BEFORE ${evento} ON protocolo FOR EACH ROW
BEGIN
  IF NEW.passo_atual NOT BETWEEN 1 AND ${max} THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'passo_atual deve ficar entre 1 e ${max}.';
  END IF;
END`;

async function recriar(knex, max) {
  await knex.raw('DROP TRIGGER IF EXISTS trg_protocolo_bi');
  await knex.raw('DROP TRIGGER IF EXISTS trg_protocolo_bu');
  try {
    await knex.raw(gatilho('trg_protocolo_bi', 'INSERT', max));
    await knex.raw(gatilho('trg_protocolo_bu', 'UPDATE', max));
  } catch (err) {
    console.warn(`gatilhos do protocolo não recriados (${err.message}); a API valida o passo`);
  }
}

export const up = (knex) => recriar(knex, 20);
export const down = (knex) => recriar(knex, 8);
