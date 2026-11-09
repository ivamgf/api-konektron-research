import { db, type Trx } from '#database/connection.ts';
import { AppError } from '#utils/AppError.ts';

export async function protocoloDoProjeto(projetoId: string, trx?: Trx) {
  const p = await (trx ?? db)('protocolo').where({ projetoId }).first();
  if (!p) throw AppError.notFound('Protocolo');
  return p;
}

// Protocolo completo (aba Definições + estratégia de busca + questões + critérios)
export async function protocoloCompleto(protocoloId: string, trx?: Trx) {
  const q = trx ?? db;
  const [protocolo, outrasQuestoes, objetivos, palavrasChave, descritores, strings, questoes, criterios] = await Promise.all([
    q('protocolo').where({ id: protocoloId }).first(),
    q('protocoloOutraQuestao').where({ protocoloId }).orderBy('ordem'),
    q('objetivoEspecifico').where({ protocoloId }).orderBy('ordem'),
    q('palavraChave as pc').leftJoin('idioma as i', 'i.id', 'pc.idiomaId').where('pc.protocoloId', protocoloId).orderBy('pc.ordem').select('pc.*', 'i.codigo as idiomaCodigo'),
    q('descritor').where({ protocoloId }).orderBy('ordem'),
    q('stringBusca as s').leftJoin('baseDados as b', 'b.id', 's.baseDadosId').where('s.protocoloId', protocoloId).orderBy('s.ordem').select('s.*', 'b.nome as baseNome'),
    q('questaoAnalise').where({ protocoloId }).orderBy('ordem'),
    q('criterio').where({ protocoloId }).orderBy(['tipo', 'ordem']),
  ]);
  return { ...protocolo, outrasQuestoes, objetivos, palavrasChave, descritores, strings, questoes, criterios };
}

// RN02: campos obrigatórios para concluir
export function pendencias(p: Awaited<ReturnType<typeof protocoloCompleto>>) {
  const faltas: { campo: string; passo: number; mensagem: string }[] = [];
  const vazio = (v: unknown) => !String(v ?? '').trim();
  if (vazio(p.tema)) faltas.push({ campo: 'tema', passo: 1, mensagem: 'Informe o tema' });
  if (vazio(p.questaoPesquisa)) faltas.push({ campo: 'questaoPesquisa', passo: 1, mensagem: 'Informe a questão de pesquisa' });
  if (vazio(p.objetivoGeral)) faltas.push({ campo: 'objetivoGeral', passo: 4, mensagem: 'Informe o objetivo geral' });
  if (p.objetivos.length < 1) faltas.push({ campo: 'objetivos', passo: 4, mensagem: 'Cadastre ao menos 1 objetivo específico' });
  if (p.palavrasChave.length < 3) faltas.push({ campo: 'palavrasChave', passo: 6, mensagem: 'Cadastre ao menos 3 palavras-chave' });
  if (p.strings.length < 1) faltas.push({ campo: 'strings', passo: 7, mensagem: 'Cadastre ao menos 1 string de busca' });
  if (!p.criterios.some((c: any) => c.tipo === 'INCLUSAO')) {
    faltas.push({ campo: 'criterios', passo: 8, mensagem: 'Cadastre ao menos 1 critério de inclusão' });
  }
  if (p.metodologiaTipo === 'OUTRA' && vazio(p.metodologiaOutro)) faltas.push({ campo: 'metodologiaOutro', passo: 9, mensagem: 'Informe qual é a metodologia' });
  if (vazio(p.resultadosEsperados)) faltas.push({ campo: 'resultadosEsperados', passo: 10, mensagem: 'Informe os principais resultados esperados' });
  return faltas;
}

// RN04: mexer num protocolo concluído/aprovado o devolve a rascunho; a próxima conclusão gera nova versão
export async function marcarAlterado(trx: Trx, protocoloId: string) {
  await trx('protocolo')
    .where({ id: protocoloId })
    .whereIn('status', ['CONCLUIDO', 'APROVADO', 'DEVOLVIDO'])
    .update({ status: 'RASCUNHO', aprovadoPor: null, aprovadoEm: null });
}

// Diferença campo a campo entre duas versões (RF14)
export function compararSnapshots(a: Record<string, any>, b: Record<string, any>) {
  const ignorar = new Set(['id', 'protocoloId', 'criadoEm', 'atualizadoEm', 'status', 'versaoAtual', 'concluidoEm', 'aprovadoEm', 'aprovadoPor', 'parecer', 'tcleArquivoId']);
  const chaves = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diferencas: { campo: string; antes: unknown; depois: unknown }[] = [];
  for (const k of chaves) {
    if (ignorar.has(k)) continue;
    const norm = (v: unknown) => JSON.stringify(Array.isArray(v) ? v.map((x: any) => (typeof x === 'object' && x ? { ...x, id: undefined, protocoloId: undefined } : x)) : v ?? null);
    if (norm(a[k]) !== norm(b[k])) diferencas.push({ campo: k, antes: a[k] ?? null, depois: b[k] ?? null });
  }
  return diferencas;
}
