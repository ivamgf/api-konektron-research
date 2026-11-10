// Planos de uso (FREE, STANDARD, MASTER) no usuário, com a opção interna "vitalício" (sem cobrança e sem
// prazo) e as datas do ciclo do plano gratuito. Idempotente: o script SQL de instalação nova já traz as colunas.
//
// Quem já tinha conta antes dos planos vira MASTER vitalício, para ninguém perder acesso nem projetos;
// o administrador ajusta depois em Administração › Usuários.

export const config = { transaction: false }; // DDL no MySQL faz commit implícito

export async function up(knex) {
  const novas = !(await knex.schema.hasColumn('usuario', 'plano'));
  if (novas) {
    await knex.schema.alterTable('usuario', (t) => {
      t.enu('plano', ['FREE', 'STANDARD', 'MASTER']).notNullable().defaultTo('FREE').after('perfil_global');
      t.boolean('plano_vitalicio').notNullable().defaultTo(false).comment('opção interna: sem cobrança e sem prazo').after('plano');
      t.specificType('plano_limite_em', 'DATETIME(3)').nullable().comment('FREE: quando chegou ao limite de projetos (início dos 3 meses)').after('plano_vitalicio');
      t.specificType('plano_bloqueado_em', 'DATETIME(3)').nullable().comment('FREE: fim dos 3 meses; projetos removidos e acesso só ao upgrade').after('plano_limite_em');
      t.tinyint('plano_aviso_dias').nullable().comment('último aviso de expiração enviado (30 ou 7 dias antes)').after('plano_bloqueado_em');
    });
    await knex('usuario').update({ plano: 'MASTER', plano_vitalicio: true });
  }
}

export async function down(knex) {
  if (await knex.schema.hasColumn('usuario', 'plano')) {
    await knex.schema.alterTable('usuario', (t) => {
      t.dropColumn('plano_aviso_dias');
      t.dropColumn('plano_bloqueado_em');
      t.dropColumn('plano_limite_em');
      t.dropColumn('plano_vitalicio');
      t.dropColumn('plano');
    });
  }
}
