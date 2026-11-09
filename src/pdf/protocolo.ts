import { esc, ESTILO, paragrafos } from './render.ts';
import { nomeMetodologia } from '#modules/protocolo/tcle.ts';

const lista = (itens: string[]) => (itens.length ? `<ol>${itens.map((i) => `<li>${esc(i)}</li>`).join('')}</ol>` : '<p class="vazio">Não informado</p>');
const dataBr = (d: unknown) => (d ? new Date(d as string).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—');

export type DadosProtocolo = {
  projeto: any;
  equipe: any[];
  p: any; // protocolo completo (ou snapshot da versão)
  versao: number | null;
  status: string;
  revisoes: any[];
  versoes: any[];
  secoes?: string[] | null;
};

export const autoresDaEquipe = (equipe: any[]) => equipe.filter((m) => m.papel !== 'LEITOR').map((m) => m.nome).join(', ');

/** Capa no layout Konektron (protocolo e projeto inteiro) */
export function capa(o: { rotulo: string; projeto: any; equipe: any[]; linha: string }) {
  return `<section class="capa">
  <p>${esc(o.rotulo)}</p>
  <h1>${esc(o.projeto.titulo)}</h1>
  <p>${esc(autoresDaEquipe(o.equipe))}</p>
  <p>${esc(o.projeto.instituicao ?? '')}${o.projeto.programa ? ` · ${esc(o.projeto.programa)}` : ''}</p>
  <p>${o.linha} · ${dataBr(new Date())}</p>
</section>`;
}

// ERS 8.5: layout do PDF do protocolo de pesquisa
export function htmlProtocolo(o: DadosProtocolo) {
  const rascunho = o.status === 'RASCUNHO' || o.status === 'DEVOLVIDO';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>${ESTILO}</style></head><body>
${rascunho ? '<div class="marca">RASCUNHO</div>' : ''}
${capa({ rotulo: 'PROTOCOLO DE PESQUISA', projeto: o.projeto, equipe: o.equipe, linha: `Versão ${o.versao ?? 'em edição'} · ${esc(o.status)}` })}
${secoesProtocolo(o)}
</body></html>`;
}

/** Seções 1 a 7 do protocolo, sem capa nem documento HTML em volta */
export function secoesProtocolo(o: DadosProtocolo) {
  const { projeto, equipe, p, revisoes, versoes } = o;
  const mostra = (s: string) => !o.secoes || o.secoes.includes(s);
  return `
${mostra('identificacao') ? `<h2>1. Identificação</h2>
<table><tr><th>Projeto</th><td>${esc(projeto.titulo)}</td></tr>
<tr><th>Área</th><td>${esc(projeto.area ?? '—')}</td></tr>
<tr><th>Instituição / programa</th><td>${esc(projeto.instituicao ?? '—')} ${projeto.programa ? `· ${esc(projeto.programa)}` : ''}</td></tr>
<tr><th>Período</th><td>${dataBr(projeto.dataInicio)} a ${dataBr(projeto.dataFim)}</td></tr></table>
<table><tr><th>Membro</th><th>Papel</th><th>ORCID</th></tr>${equipe.map((m) => `<tr><td>${esc(m.nome)}</td><td>${esc(m.papel)}</td><td class="mono">${esc(m.orcid ?? '')}</td></tr>`).join('')}</table>` : ''}
${mostra('definicoes') ? `<h2>2. Definições</h2>
<h3>Tema</h3>${paragrafos(p.tema)}
<h3>Questão de pesquisa</h3>${paragrafos(p.questaoPesquisa)}
<h3>Outras questões</h3>${lista((p.outrasQuestoes ?? []).map((x: any) => x.texto))}
<h3>Hipótese</h3>${paragrafos(p.hipotese)}
<h3>Objetivo geral</h3>${paragrafos(p.objetivoGeral)}
<h3>Objetivos específicos</h3>${lista((p.objetivos ?? []).map((x: any) => x.texto))}
<h3>Justificativa</h3>${paragrafos(p.justificativa)}
<h3>Metodologia</h3><p><b>${esc(nomeMetodologia(p) ?? 'Não informada')}</b></p>${p.metodologia ? paragrafos(p.metodologia) : ''}
${p.riscos ? `<h3>Riscos</h3>${paragrafos(p.riscos)}` : ''}
${p.beneficios ? `<h3>Benefícios</h3>${paragrafos(p.beneficios)}` : ''}
<h3>Principais resultados esperados</h3>${paragrafos(p.resultadosEsperados)}` : ''}
${mostra('estrategia') ? `<h2>3. Estratégia de busca</h2>
<h3>Palavras-chave</h3><p>${(p.palavrasChave ?? []).map((x: any) => `${esc(x.termo)}${x.idiomaCodigo ? ` <small>(${esc(x.idiomaCodigo)})</small>` : ''}`).join('; ') || '<span class="vazio">Não informado</span>'}</p>
<h3>Descritores</h3><table><tr><th>Termo</th><th>Vocabulário</th><th>Código</th></tr>${(p.descritores ?? []).map((d: any) => `<tr><td>${esc(d.termo)}</td><td>${esc(d.vocabulario)}</td><td class="mono">${esc(d.codigo ?? '')}</td></tr>`).join('') || '<tr><td colspan="3" class="vazio">Não informado</td></tr>'}</table>
<h3>Strings de busca</h3><table><tr><th>Base</th><th>Campo</th><th>Expressão</th></tr>${(p.strings ?? []).map((s: any) => `<tr><td>${esc(s.baseNome ?? 'Genérica')}</td><td>${esc(s.campo)}</td><td class="mono">${esc(s.expressao)}</td></tr>`).join('')}</table>` : ''}
${mostra('questoes') ? `<h2>4. Questões de análise</h2><table><tr><th>Código</th><th>Enunciado</th></tr>${(p.questoes ?? []).map((q: any) => `<tr><td class="mono">${esc(q.codigo)}</td><td>${esc(q.enunciado)}</td></tr>`).join('') || '<tr><td colspan="2" class="vazio">Nenhuma questão</td></tr>'}</table>` : ''}
${mostra('criterios') ? `<h2>5. Critérios de inclusão e exclusão</h2>
${['INCLUSAO', 'EXCLUSAO'].map((t) => `<h3>${t === 'INCLUSAO' ? 'Inclusão' : 'Exclusão'}</h3><table><tr><th>Critério</th><th>Descrição</th></tr>${(p.criterios ?? []).filter((c: any) => c.tipo === t).map((c: any) => `<tr><td>${esc(c.nome)}</td><td>${esc(c.descricao ?? '')}</td></tr>`).join('') || '<tr><td colspan="2" class="vazio">Nenhum</td></tr>'}</table>`).join('')}` : ''}
${mostra('revisoes') ? `<h2>6. Revisões previstas</h2>${revisoes.length ? revisoes.map((r) => `<h3>${esc(r.titulo)}</h3><p>Tipo: ${esc(r.tipoNome)} · Diretriz de relato: ${r.diretrizSigla ? `${esc(r.diretrizSigla)} ${esc(r.diretrizVersao ?? '')} — ${esc(r.diretrizUrl ?? '')}` : 'nenhuma'}</p>${lista(r.etapas.map((e: any) => e.nome))}`).join('') : '<p class="vazio">Nenhuma revisão cadastrada</p>'}` : ''}
${mostra('historico') ? `<h2>7. Histórico de versões e aprovação</h2><table><tr><th>Versão</th><th>Data</th><th>Autor</th><th>Justificativa</th></tr>${versoes.map((v) => `<tr><td>${v.versao}</td><td>${dataBr(v.criadoEm)}</td><td>${esc(v.criadoPorNome ?? '')}</td><td>${esc(v.justificativa ?? '—')}</td></tr>`).join('') || '<tr><td colspan="4" class="vazio">Sem versões concluídas</td></tr>'}</table>
${p.aprovadoEm ? `<p>Aprovado por ${esc(p.aprovadoPorNome ?? 'orientador(a)')} em ${dataBr(p.aprovadoEm)}.</p>` : ''}${p.parecer ? `<h3>Parecer</h3>${paragrafos(p.parecer)}` : ''}` : ''}`;
}
