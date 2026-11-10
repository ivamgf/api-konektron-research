// Fases da triagem em ordem: F1 antes de F2 e F2 antes de F3 (etapas da revisão e dos tipos).
// Revisões criadas com as etapas ajustadas fora de ordem (ex.: F2 na posição 4 e F1 na 5) têm as
// fases trocadas entre as posições que ocupam; cada etapa leva junto o nome e as decisões.
// As outras etapas não se mexem. Idempotente: sem fases fora de ordem, não faz nada.

const DESLOCAMENTO = 10000;

const numeroDaFase = (nome) => {
  const m = String(nome ?? '').match(/\bF(?:ase)?\s*(\d+)/i);
  return m ? Number(m[1]) : null;
};

function corrigir(etapas) {
  const pos = etapas.map((e, i) => ({ e, i, f: numeroDaFase(e.nome) })).filter((x) => x.f !== null);
  const ordenadas = [...pos].sort((a, b) => a.f - b.f || a.i - b.i);
  const out = [...etapas];
  pos.forEach((p, k) => (out[p.i] = ordenadas[k].e));
  return out;
}

async function corrigirTabela(knex, tabela, chave) {
  const linhas = await knex(tabela).select('id', chave, 'ordem', 'nome').orderBy([chave, 'ordem']);
  const grupos = new Map();
  for (const l of linhas) grupos.set(l[chave], [...(grupos.get(l[chave]) ?? []), l]);
  let corrigidos = 0;
  for (const [valor, etapas] of grupos) {
    const certa = corrigir(etapas);
    if (certa.every((e, i) => e.id === etapas[i].id)) continue;
    const ordens = etapas.map((e) => e.ordem);
    await knex.transaction(async (trx) => {
      // a ordem tem UNIQUE: desloca e depois grava a final
      await trx(tabela)
        .where(chave, valor)
        .update({ ordem: trx.raw('ordem + ?', [DESLOCAMENTO]) });
      for (const [i, e] of certa.entries())
        await trx(tabela).where({ id: e.id }).update({ ordem: ordens[i] });
    });
    corrigidos++;
  }
  return corrigidos;
}

export async function up(knex) {
  await corrigirTabela(knex, 'revisao_etapa', 'revisao_id');
  await corrigirTabela(knex, 'etapa_modelo', 'tipo_revisao_id');
}

export async function down() {
  // a ordem antiga estava errada: não há o que desfazer
}
