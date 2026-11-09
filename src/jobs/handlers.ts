import { db, json } from '#database/connection.ts';
import { logger } from '#utils/logger.ts';
import { uuid } from '#utils/tokens.ts';
import { limparDoi, normalizarTitulo } from '#utils/normalize.ts';
import { referenciaApa, referenciaNbr } from '#utils/referencias.ts';
import { lerArquivo, salvarArquivo } from '#services/arquivos.ts';
import { storage } from '#services/storage/index.ts';
import { notificar } from '#services/notificacoes.ts';
import { htmlParaPdf, esc, ESTILO } from '#pdf/render.ts';
import { htmlParaDocx, MIME_DOCX } from '#pdf/docx.ts';

type FormatoDocumento = 'pdf' | 'docx';
/** Mesmo HTML em PDF (padrão) ou em Word (.docx) */
async function gerarDocumento(html: string, titulo: string, formato: FormatoDocumento = 'pdf') {
  return formato === 'docx'
    ? { dados: await htmlParaDocx(html, titulo.replace(/&[a-z#0-9]+;/gi, (e) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' })[e] ?? e)), ext: 'docx', mime: MIME_DOCX }
    : { dados: await htmlParaPdf(html, titulo), ext: 'pdf', mime: 'application/pdf' };
}
import { capa, htmlProtocolo, secoesProtocolo, type DadosProtocolo } from '#pdf/protocolo.ts';
import { protocoloCompleto } from '#modules/protocolo/protocolo.service.ts';
import { painel } from '#modules/revisoes/revisoes.service.ts';
import { dadosDiagrama, diagramaSvg } from '#modules/revisoes/diagrama.ts';
import { referenciasDoProjeto } from '#modules/referencias/referencias.routes.ts';
import { detectarDuplicados } from '#modules/documentos/duplicados.ts';
import { completarDocumento } from '#modules/documentos/documentos.routes.ts';
import { lerArquivoDeBusca } from './parsers.ts';
import type { Tarefa } from '#services/fila.ts';

type Handler = (t: Tarefa) => Promise<Record<string, unknown> | void>;

const carimbo = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const salvarResultado = (t: Tarefa, resultado: Record<string, unknown>) =>
  db('filaTarefa').where({ id: t.id }).update({ payload: json({ ...t.payload, resultado }) });

// ------------------------------------------------ importar-busca (RF25, UC07)
const importarBusca: Handler = async (t) => {
  const busca = await db('busca as b').join('revisao as r', 'r.id', 'b.revisaoId').where('b.id', t.payload.buscaId).first('b.*', 'r.projetoId');
  if (!busca?.arquivoId) return;
  await db('busca').where({ id: busca.id }).update({ statusImportacao: 'PROCESSANDO' });
  try {
    const { dados, arquivo } = await lerArquivo(busca.arquivoId);
    const { registros, erros } = await lerArquivoDeBusca(arquivo.nomeOriginal, dados);
    const tipos = Object.fromEntries((await db('tipoDocumento').select('id', 'nome')).map((x: any) => [x.nome, x.id]));
    const idiomas = await db('idioma').select('id', 'codigo', 'nome');
    const idiomaId = (v?: string | null) => {
      const s = (v ?? '').toLowerCase();
      return idiomas.find((i: any) => i.codigo === s.slice(0, 2) || i.nome.toLowerCase() === s || ({ english: 'en', portuguese: 'pt', spanish: 'es', french: 'fr', german: 'de' } as any)[s] === i.codigo)?.id ?? null;
    };
    let importados = 0;
    // em lotes, para não estourar o tempo de transação na hospedagem compartilhada
    for (let i = 0; i < registros.length; i += 200) {
      const lote = registros.slice(i, i + 200);
      await db.transaction(async (trx) => {
        const docs = lote.map((r) => {
          const doi = limparDoi(r.doi);
          const base = { titulo: r.titulo.slice(0, 5000), autores: r.autores, ano: r.ano, periodico: r.periodico?.slice(0, 300) ?? null, doi, link: r.link };
          return {
            id: uuid(),
            projetoId: busca.projetoId,
            ...base,
            link: r.link && r.link.length <= 1000 ? r.link : null,
            doi: doi && doi.length <= 255 ? doi : null,
            tituloNormalizado: normalizarTitulo(r.titulo),
            resumo: r.resumo,
            palavrasChave: r.palavrasChave,
            citacoes: r.citacoes ?? null,
            tipoDocumentoId: (r.tipo && tipos[r.tipo]) || null,
            idiomaId: idiomaId(r.idioma),
            baseDadosId: busca.baseDadosId,
            refNbr: referenciaNbr(base),
            refApa: referenciaApa(base),
            dadosOriginais: json(r.bruto),
            criadoPor: t.payload.usuarioId ?? null,
          };
        });
        await trx('documento').insert(docs);
        await trx('revisaoDocumento').insert(docs.map((d) => ({ id: uuid(), revisaoId: busca.revisaoId, documentoId: d.id, buscaId: busca.id, origem: 'BUSCA', situacao: 'EM_TRIAGEM' })));
        importados += docs.length;
      });
      await db('busca').where({ id: busca.id }).update({ qtdImportada: importados });
    }
    const dup = await detectarDuplicados(busca.revisaoId, { user: { id: t.payload.usuarioId }, projeto: { id: busca.projetoId } } as any);
    const qtdDuplicados = Number((await db('revisaoDocumento').where({ buscaId: busca.id }).whereNotNull('duplicadoDeId').count({ n: '*' }).first())?.n ?? 0);
    const log = { registros: registros.length, importados, erros: erros.slice(0, 500), duplicadosNaRevisao: dup.duplicados };
    await db('busca')
      .where({ id: busca.id })
      .update({ statusImportacao: 'CONCLUIDA', qtdImportada: importados, qtdErros: erros.length, qtdDuplicados, logImportacao: json(log) });
    await notificar([t.payload.usuarioId], 'IMPORTACAO_CONCLUIDA', `Importação concluída: ${importados} documentos`, { buscaId: busca.id, ...log, erros: erros.length });
    return log;
  } catch (err) {
    await db('busca').where({ id: busca.id }).update({ statusImportacao: 'ERRO', logImportacao: json({ erro: (err as Error).message }) });
    throw err;
  }
};

// ------------------------------------------------ gerar-pdf-protocolo (RF13, S1)
async function dadosProtocolo(protocoloId: string, projetoId: string, versao: number | null, secoes: string[] | null = null) {
  const projeto = await db('projeto').where({ id: projetoId }).first();
  const equipe = await db('projetoMembro as pm').join('usuario as u', 'u.id', 'pm.usuarioId').where('pm.projetoId', projetoId).whereNotNull('pm.aceitoEm').select('u.nome', 'u.orcid', 'pm.papel').orderBy('u.nome');
  const atual = await db('protocolo as p').leftJoin('usuario as u', 'u.id', 'p.aprovadoPor').where('p.id', protocoloId).first('p.*', 'u.nome as aprovadoPorNome');
  const v = versao ? await db('protocoloVersao').where({ protocoloId, versao }).first() : null;
  const p = v ? { ...v.snapshot, aprovadoEm: atual.aprovadoEm, aprovadoPorNome: atual.aprovadoPorNome, parecer: atual.parecer } : { ...(await protocoloCompleto(protocoloId)), aprovadoPorNome: atual.aprovadoPorNome };
  const status = v ? (versao === atual.versaoAtual ? atual.status : 'CONCLUIDO') : atual.status;
  const revisoes: any[] = [];
  for (const r of await db('revisao as r').join('tipoRevisao as t', 't.id', 'r.tipoRevisaoId').leftJoin('diretrizRelato as d', 'd.id', 'r.diretrizRelatoId').where('r.projetoId', projetoId).select('r.id', 'r.titulo', 't.nome as tipoNome', 'd.sigla as diretrizSigla', 'd.versao as diretrizVersao', 'd.urlOficial as diretrizUrl')) {
    revisoes.push({ ...r, etapas: await db('revisaoEtapa').where({ revisaoId: r.id }).orderBy('ordem').select('nome') });
  }
  const versoes = await db('protocoloVersao as v').leftJoin('usuario as u', 'u.id', 'v.criadoPor').where('v.protocoloId', protocoloId).orderBy('v.versao').select('v.versao', 'v.criadoEm', 'v.justificativa', 'u.nome as criadoPorNome');
  const numero = versao ?? (atual.versaoAtual || null);
  const referencias = await referenciasDoProjeto(projetoId);
  return { v, dados: { projeto, equipe, p, versao: numero, status, revisoes, versoes, secoes, referencias } satisfies DadosProtocolo };
}

const gerarPdfProtocolo: Handler = async (t) => {
  const { protocoloId, projetoId, versao, secoes } = t.payload;
  const formato: FormatoDocumento = t.payload.formato === 'docx' ? 'docx' : 'pdf';
  const { v, dados: d } = await dadosProtocolo(protocoloId, projetoId, versao ?? null, secoes ?? null);
  const doc = await gerarDocumento(htmlProtocolo(d), `Protocolo de pesquisa · versão ${d.versao ?? 'em edição'}`, formato);
  const nome = versao ? `v${versao}` : `rascunho-${carimbo()}`;
  const arquivoId = await salvarArquivo({
    projetoId,
    chave: `projetos/${projetoId}/protocolos/${nome}${formato === 'docx' ? `-${carimbo()}` : ''}.${doc.ext}`,
    nomeOriginal: `protocolo_${versao ? `v${versao}` : 'rascunho'}.${doc.ext}`,
    mimeType: doc.mime,
    dados: doc.dados,
    criadoPor: t.payload.usuarioId ?? null,
  });
  // o PDF da versão fica guardado na versão (RF13); o Word é só para baixar
  if (v && formato === 'pdf') await db('protocoloVersao').where({ id: v.id }).update({ pdfArquivoId: arquivoId });
  await salvarResultado(t, { arquivoId });
  return { arquivoId };
};

// ------------------------------------------------ planilhas (RF41, RF42)
async function novaPlanilha() {
  const ExcelJS = (await import('exceljs')).default;
  return new ExcelJS.Workbook();
}

function aba(wb: any, nome: string, colunas: { header: string; key: string; width?: number }[], linhas: Record<string, unknown>[]) {
  const ws = wb.addWorksheet(nome);
  ws.columns = colunas.map((c) => ({ width: 24, ...c }));
  ws.getRow(1).font = { bold: true, color: { argb: 'FF003D27' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6FAF3' } };
  ws.addRows(linhas);
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}

async function linhasAnalise(analiseId: string) {
  const questoes = await db('analiseQuestao as aq').join('questaoAnalise as q', 'q.id', 'aq.questaoAnaliseId').where('aq.analiseId', analiseId).orderBy('aq.ordem').select('q.id', 'q.codigo', 'q.enunciado');
  const docs = await db('analiseDocumento as ad').join('documento as d', 'd.id', 'ad.documentoId').where('ad.analiseId', analiseId).orderBy('ad.ordem').select('ad.id', 'ad.ordem', 'ad.progresso', 'ad.resumoAssunto', 'ad.consideracoes', 'ad.observacoes', 'd.titulo', 'd.autores', 'd.ano', 'd.refApa');
  const respostas = await db('resposta').whereIn('analiseDocumentoId', docs.map((d: any) => d.id));
  const matriz = await db('matrizSinteseItem as m').join('analiseDocumento as ad', 'ad.id', 'm.analiseDocumentoId').join('documento as d', 'd.id', 'ad.documentoId').where('ad.analiseId', analiseId).orderBy(['ad.ordem', 'm.ordem']).select('d.titulo', 'm.citacao', 'm.textoOriginal', 'm.textoParafraseado', 'm.pagina');
  const discussao = await db('discussaoItem as x').join('analiseDocumento as ad', 'ad.id', 'x.analiseDocumentoId').join('documento as d', 'd.id', 'ad.documentoId').where('ad.analiseId', analiseId).orderBy(['ad.ordem', 'x.ordem']).select('d.titulo', 'x.pontoPrincipal', 'x.discussao');
  const analise = docs.map((d: any) => ({
    ordem: d.ordem,
    titulo: d.titulo,
    autores: d.autores,
    ano: d.ano,
    progresso: d.progresso,
    resumoAssunto: d.resumoAssunto,
    ...Object.fromEntries(questoes.map((q: any) => [q.codigo, respostas.find((r: any) => r.analiseDocumentoId === d.id && r.questaoAnaliseId === q.id)?.texto ?? ''])),
    consideracoes: d.consideracoes,
    observacoes: d.observacoes,
  }));
  return { questoes, analise, matriz, discussao };
}

function abasAnalise(wb: any, sufixo: string, l: Awaited<ReturnType<typeof linhasAnalise>>) {
  aba(wb, `Análise${sufixo}`.slice(0, 31), [
    { header: 'Nº', key: 'ordem', width: 6 },
    { header: 'Título', key: 'titulo', width: 50 },
    { header: 'Autores', key: 'autores', width: 30 },
    { header: 'Ano', key: 'ano', width: 8 },
    { header: 'Progresso', key: 'progresso', width: 14 },
    { header: 'Resumo do assunto', key: 'resumoAssunto', width: 60 },
    ...l.questoes.map((q: any) => ({ header: `${q.codigo} – ${q.enunciado}`.slice(0, 120), key: q.codigo, width: 40 })),
    { header: 'Considerações', key: 'consideracoes', width: 40 },
    { header: 'Observações', key: 'observacoes', width: 40 },
  ], l.analise);
  aba(wb, `Matriz-Síntese${sufixo}`.slice(0, 31), [
    { header: 'Documento', key: 'titulo', width: 50 },
    { header: 'Citação', key: 'citacao', width: 28 },
    { header: 'Texto original', key: 'textoOriginal', width: 60 },
    { header: 'Texto parafraseado', key: 'textoParafraseado', width: 60 },
    { header: 'Página', key: 'pagina', width: 10 },
  ], l.matriz);
  aba(wb, `Discussão${sufixo}`.slice(0, 31), [
    { header: 'Documento', key: 'titulo', width: 50 },
    { header: 'Ponto principal', key: 'pontoPrincipal', width: 50 },
    { header: 'Discussão', key: 'discussao', width: 80 },
  ], l.discussao);
}

const exportarProjeto: Handler = async (t) => {
  const { projetoId } = t.payload;
  const projeto = await db('projeto').where({ id: projetoId }).first();
  const pr = await db('protocolo').where({ projetoId }).first('id');
  const p = await protocoloCompleto(pr.id);
  const wb = await novaPlanilha();
  aba(wb, 'Definições', [{ header: 'Item', key: 'item', width: 28 }, { header: 'Conteúdo', key: 'conteudo', width: 100 }], [
    { item: 'Projeto', conteudo: projeto.titulo },
    { item: 'Tema', conteudo: p.tema },
    { item: 'Questão de pesquisa', conteudo: p.questaoPesquisa },
    ...p.outrasQuestoes.map((x: any, i: number) => ({ item: `Outra questão ${i + 1}`, conteudo: x.texto })),
    { item: 'Hipótese', conteudo: p.hipotese },
    { item: 'Objetivo geral', conteudo: p.objetivoGeral },
    ...p.objetivos.map((x: any, i: number) => ({ item: `Objetivo específico ${i + 1}`, conteudo: x.texto })),
    { item: 'Justificativa', conteudo: p.justificativa },
    { item: 'Palavras-chave', conteudo: p.palavrasChave.map((x: any) => x.termo).join('; ') },
    ...p.strings.map((s: any) => ({ item: `String (${s.baseNome ?? 'genérica'})`, conteudo: s.expressao })),
    ...p.descritores.map((d: any) => ({ item: `Descritor ${d.vocabulario}`, conteudo: `${d.termo}${d.codigo ? ` (${d.codigo})` : ''}` })),
  ]);
  aba(wb, 'Questões', [{ header: 'Código', key: 'codigo', width: 10 }, { header: 'Questão', key: 'enunciado', width: 100 }], p.questoes);
  aba(wb, 'Critérios', [{ header: 'Tipo', key: 'tipo', width: 12 }, { header: 'Critério', key: 'nome', width: 24 }, { header: 'Descrição', key: 'descricao', width: 90 }], p.criterios);
  for (const [i, r] of (await db('revisao').where({ projetoId }).orderBy('criadoEm')).entries()) {
    const sufixo = i ? ` ${i + 1}` : '';
    const pn = await painel(r.id);
    aba(wb, `Etapas${sufixo}`, [
      { header: 'Etapa', key: 'etapaNome', width: 34 },
      { header: 'Base', key: 'base', width: 22 },
      { header: 'Selecionados', key: 'selecionados', width: 14 },
      { header: 'Excluídos', key: 'excluidos', width: 12 },
      { header: 'Excl. critério', key: 'excluidosCriterio', width: 14 },
      { header: 'Excl. duplicados', key: 'excluidosDuplicados', width: 16 },
      { header: 'Excl. sem acesso', key: 'excluidosSemAcesso', width: 16 },
    ], pn.porEtapa);
    const selecionados = await db('revisaoDocumento as rd').join('documento as d', 'd.id', 'rd.documentoId').leftJoin('categoria as c', 'c.id', 'rd.categoriaId').where({ 'rd.revisaoId': r.id, 'rd.situacao': 'INCLUIDO' }).select('d.titulo', 'd.autores', 'd.ano', 'd.periodico', 'd.doi', 'rd.origem', 'c.nome as categoria', 'd.refNbr', 'd.refApa');
    aba(wb, `Selecionados${sufixo}`, [
      { header: 'Título', key: 'titulo', width: 50 },
      { header: 'Autores', key: 'autores', width: 30 },
      { header: 'Ano', key: 'ano', width: 8 },
      { header: 'Periódico', key: 'periodico', width: 30 },
      { header: 'DOI', key: 'doi', width: 28 },
      { header: 'Origem', key: 'origem', width: 16 },
      { header: 'Categoria', key: 'categoria', width: 20 },
      { header: 'Referência NBR', key: 'refNbr', width: 60 },
      { header: 'Referência APA', key: 'refApa', width: 60 },
    ], selecionados);
  }
  for (const [i, a] of (await db('analise').where({ projetoId }).orderBy('criadoEm')).entries()) abasAnalise(wb, i ? ` ${i + 1}` : '', await linhasAnalise(a.id));
  const dados = Buffer.from(await wb.xlsx.writeBuffer());
  const arquivoId = await salvarArquivo({ projetoId, chave: `projetos/${projetoId}/exportacoes/projeto-${carimbo()}.xlsx`, nomeOriginal: 'projeto.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dados, criadoPor: t.payload.usuarioId });
  await salvarResultado(t, { arquivoId });
};

// Níveis de título: o PDF avulso usa h1/h2; dentro do PDF do projeto inteiro, h2/h3
type Niveis = { titulo: 'h1' | 'h2'; secao: 'h2' | 'h3'; prefixo?: string };
const AVULSO: Niveis = { titulo: 'h1', secao: 'h2' };
const documentoHtml = (corpo: string) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>${ESTILO}</style></head><body>
${corpo}
</body></html>`;

async function corpoAnalise(analise: any, n: Niveis = AVULSO) {
  const l = await linhasAnalise(analise.id);
  const { titulo: T, secao: S } = n;
  return `<${T}>${n.prefixo ?? ''}${esc(analise.nome)}</${T}><p>${esc(analise.descricao ?? '')}</p>
${l.analise.map((d: any) => `<${S}>${d.ordem}. ${esc(d.titulo)}</${S}><p>${esc(d.autores ?? '')} (${d.ano ?? 's.d.'}) · ${esc(d.progresso)}</p>
${d.resumoAssunto ? `<${S === 'h2' ? 'h3' : 'h4'}>Resumo do assunto</${S === 'h2' ? 'h3' : 'h4'}><p>${esc(d.resumoAssunto)}</p>` : ''}
<table>${l.questoes.map((q: any) => `<tr><th style="width:30%">${esc(q.codigo)} – ${esc(q.enunciado)}</th><td>${esc(d[q.codigo] || '—')}</td></tr>`).join('')}</table>
${d.consideracoes ? `<${S === 'h2' ? 'h3' : 'h4'}>Considerações</${S === 'h2' ? 'h3' : 'h4'}><p>${esc(d.consideracoes)}</p>` : ''}`).join('') || '<p class="vazio">Nenhum documento na análise</p>'}
<${S}>Matriz de síntese</${S}><table><tr><th>Documento</th><th>Citação</th><th>Texto parafraseado</th></tr>${l.matriz.map((m: any) => `<tr><td>${esc(m.titulo)}</td><td>${esc(m.citacao ?? '')}</td><td>${esc(m.textoParafraseado ?? '')}</td></tr>`).join('') || '<tr><td colspan="3" class="vazio">Sem citações</td></tr>'}</table>`;
}

const exportarAnalise: Handler = async (t) => {
  const { analiseId, projetoId, formato } = t.payload;
  const analise = await db('analise').where({ id: analiseId }).first();
  let dados: Buffer;
  let ext: string;
  let mime: string;
  if (formato === 'pdf' || formato === 'docx') {
    ({ dados, ext, mime } = await gerarDocumento(documentoHtml(await corpoAnalise(analise)), `Análise: ${esc(analise.nome)}`, formato));
  } else {
    const wb = await novaPlanilha();
    abasAnalise(wb, '', await linhasAnalise(analiseId));
    dados = Buffer.from(await wb.xlsx.writeBuffer());
    ext = 'xlsx';
    mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  const arquivoId = await salvarArquivo({ projetoId, chave: `projetos/${projetoId}/exportacoes/analise-${analiseId}-${carimbo()}.${ext}`, nomeOriginal: `analise.${ext}`, mimeType: mime, dados, criadoPor: t.payload.usuarioId });
  await salvarResultado(t, { arquivoId });
};

// ------------------------------------------------ relatorio-revisao (RF43)
const consultaRevisao = () =>
  db('revisao as r')
    .join('tipoRevisao as tr', 'tr.id', 'r.tipoRevisaoId')
    .leftJoin('diretrizRelato as d', 'd.id', 'r.diretrizRelatoId')
    .select('r.*', 'tr.nome as tipoNome', 'd.sigla as diretrizSigla', 'd.versao as diretrizVersao');

/** Relatório da revisão (RF43); `resumoProtocolo` fica de fora no PDF do projeto, que já traz o protocolo */
async function corpoRevisao(r: any, n: Niveis = AVULSO, p?: any) {
  const { titulo: T, secao: S } = n;
  const pn = await painel(r.id);
  const incluidos = await db('revisaoDocumento as rd').join('documento as d', 'd.id', 'rd.documentoId').where({ 'rd.revisaoId': r.id, 'rd.situacao': 'INCLUIDO' }).orderBy('d.titulo').select('d.refNbr', 'd.titulo');
  const checklist = await db('revisaoChecklistItem').where({ revisaoId: r.id }).orderBy('ordem');
  return `<${T}>${n.prefixo ?? ''}${esc(r.titulo)}</${T}><p>Tipo: ${esc(r.tipoNome)} · Diretriz: ${esc(r.diretrizSigla ?? 'nenhuma')} ${esc(r.diretrizVersao ?? '')}</p>${r.registroUrl ? `<p>Registro da revisão: ${r.registroIdentificador ? `${esc(r.registroIdentificador)} — ` : ''}<a href="${esc(r.registroUrl)}">${esc(r.registroUrl)}</a></p>` : ''}
${p ? `<${S}>Protocolo resumido</${S}><p><b>Questão:</b> ${esc(p.questaoPesquisa)}</p><p><b>Objetivo:</b> ${esc(p.objetivoGeral)}</p>
<p><b>Palavras-chave:</b> ${esc(p.palavrasChave.map((x: any) => x.termo).join('; '))}</p>` : ''}
<${S}>Painel de etapas</${S}><table><tr><th>Etapa</th><th>Base</th><th>Selecionados</th><th>Excluídos</th></tr>${pn.porEtapa.map((e: any) => `<tr><td>${esc(e.etapaNome)}</td><td>${esc(e.base)}</td><td>${e.selecionados}</td><td>${e.excluidos}</td></tr>`).join('') || '<tr><td colspan="4" class="vazio">Sem etapas</td></tr>'}</table>
<${S}>Fluxo de seleção</${S}><div class="diagrama">${diagramaSvg(await dadosDiagrama(r.id)).replace("<svg ", "<svg style=\"max-width:100%;height:auto\" ")}</div>
<${S}>Incluídos (${incluidos.length})</${S}>${incluidos.length ? `<ol>${incluidos.map((d: any) => `<li>${esc(d.refNbr ?? d.titulo)}</li>`).join('')}</ol>` : '<p class="vazio">Nenhum documento incluído</p>'}
<${S}>Checklist de relato</${S}><table><tr><th>Cód.</th><th>Item</th><th>Situação</th><th>Local</th></tr>${checklist.map((c: any) => `<tr><td>${esc(c.codigo)}</td><td>${esc(c.descricao)}</td><td>${esc(c.situacao)}</td><td>${esc(c.localRelato ?? '')}</td></tr>`).join('') || '<tr><td colspan="4" class="vazio">Sem checklist</td></tr>'}</table>`;
}

const relatorioRevisao: Handler = async (t) => {
  const { revisaoId, projetoId } = t.payload;
  const r = await consultaRevisao().where('r.id', revisaoId).first();
  const pr = await db('protocolo').where({ projetoId }).first('id');
  const p = await protocoloCompleto(pr.id);
  const doc = await gerarDocumento(documentoHtml(await corpoRevisao(r, AVULSO, p)), `Relatório da revisão · ${esc(r.titulo).slice(0, 60)}`, t.payload.formato === 'docx' ? 'docx' : 'pdf');
  const arquivoId = await salvarArquivo({ projetoId, chave: `projetos/${projetoId}/relatorios/revisao-${revisaoId}-${carimbo()}.${doc.ext}`, nomeOriginal: `relatorio_revisao.${doc.ext}`, mimeType: doc.mime, dados: doc.dados, criadoPor: t.payload.usuarioId });
  await salvarResultado(t, { arquivoId });
};

// ------------------------------------------------ gerar-pdf-projeto: protocolo + revisões + análises
const gerarPdfProjeto: Handler = async (t) => {
  const { projetoId } = t.payload;
  const pr = await db('protocolo').where({ projetoId }).first('id');
  const { dados: d } = await dadosProtocolo(pr.id, projetoId, null);
  const revisoes = await consultaRevisao().where('r.projetoId', projetoId).orderBy('r.criadoEm');
  const analises = await db('analise').where({ projetoId }).orderBy('criadoEm');
  const sub: Niveis = { titulo: 'h2', secao: 'h3' };
  const partes = [
    capa({ rotulo: 'PROJETO DE PESQUISA', projeto: d.projeto, equipe: d.equipe, linha: `Protocolo versão ${d.versao ?? 'em edição'} · ${esc(d.status)}` }),
    `<h1>Protocolo de pesquisa</h1>${secoesProtocolo(d)}`,
    `<h1 class="quebra">Revisões</h1>${revisoes.length ? '' : '<p class="vazio">Nenhuma revisão cadastrada</p>'}`,
  ];
  for (const [i, r] of revisoes.entries()) partes.push(`<div${i ? ' class="quebra"' : ''}>${await corpoRevisao(r, { ...sub, prefixo: `R${i + 1}. ` })}</div>`);
  partes.push(`<h1 class="quebra">Análises</h1>${analises.length ? '' : '<p class="vazio">Nenhuma análise cadastrada</p>'}`);
  for (const [i, a] of analises.entries()) partes.push(`<div${i ? ' class="quebra"' : ''}>${await corpoAnalise(a, { ...sub, prefixo: `A${i + 1}. ` })}</div>`);
  const rascunho = d.status === 'RASCUNHO' || d.status === 'DEVOLVIDO';
  const doc = await gerarDocumento(
    documentoHtml((rascunho ? '<div class="marca">RASCUNHO</div>' : '') + partes.join('\n')),
    `Projeto · ${esc(d.projeto.titulo).slice(0, 60)}`,
    t.payload.formato === 'docx' ? 'docx' : 'pdf',
  );
  const arquivoId = await salvarArquivo({ projetoId, chave: `projetos/${projetoId}/exportacoes/projeto-${carimbo()}.${doc.ext}`, nomeOriginal: `projeto.${doc.ext}`, mimeType: doc.mime, dados: doc.dados, criadoPor: t.payload.usuarioId ?? null });
  await salvarResultado(t, { arquivoId });
  return { arquivoId };
};

// ------------------------------------------------ limpar-lixeira (RN17: 30 dias)
export async function limparLixeira() {
  const limite = new Date(Date.now() - 30 * 86_400_000);
  const projetos = await db('projeto').whereNotNull('excluidoEm').where('excluidoEm', '<', limite).select('id');
  for (const { id } of projetos) {
    const arquivos = await db('arquivo').where({ projetoId: id }).select('chaveStorage');
    for (const a of arquivos) {
      try {
        await storage().remove(a.chaveStorage);
      } catch (err) {
        logger.warn({ err, chave: a.chaveStorage }, 'falha ao remover arquivo do storage');
      }
    }
    await db('projeto').where({ id }).del(); // as FKs em cascata apagam o resto
    logger.info({ projetoId: id }, 'projeto removido da lixeira');
  }
  // tarefas e operações de sincronização antigas
  await db('filaTarefa').whereIn('status', ['CONCLUIDA', 'ERRO']).where('atualizadoEm', '<', new Date(Date.now() - 30 * 86_400_000)).del();
  await db('syncOperacao').where('criadoEm', '<', new Date(Date.now() - 30 * 86_400_000)).del();
  await db('refreshToken').where('expiraEm', '<', new Date()).del();
  return { removidos: projetos.length };
}

// ------------------------------------------------ completar-metadados
// Documentos (do projeto ou de uma revisão) com resumo ou palavras-chave em branco e com link, DOI
// ou título: procura em fontes abertas, um por vez, sem sobrescrever o que já foi preenchido.
const completarMetadadosDocs: Handler = async (t) => {
  const { projetoId, revisaoId, usuarioId } = t.payload;
  const vazio = (c: string) => (w: any) => w.whereNull(c).orWhere(c, '');
  const q = db('documento as d').where('d.projetoId', projetoId).where((w: any) => w.where(vazio('d.resumo')).orWhere(vazio('d.palavrasChave'))).select('d.id').limit(3000);
  if (revisaoId) q.whereExists(db('revisaoDocumento as rd').whereRaw('rd.documento_id = d.id').where('rd.revisaoId', revisaoId));
  const ids: string[] = (await q).map((r: any) => r.id);
  let completados = 0;
  let resumos = 0;
  let palavrasChave = 0;
  for (let i = 0; i < ids.length; i++) {
    try {
      const r = await completarDocumento(ids[i], usuarioId, projetoId);
      if (r.preenchidos.length) completados++;
      if (r.preenchidos.includes('resumo')) resumos++;
      if (r.preenchidos.includes('palavrasChave')) palavrasChave++;
    } catch (err) {
      logger.warn({ err, documentoId: ids[i] }, 'completar metadados: documento ignorado');
    }
    // tarefa longa: renova a reserva para outro worker não pegá-la de novo
    if (i % 20 === 19) await db('filaTarefa').where({ id: t.id }).update({ bloqueadoAte: new Date(Date.now() + 10 * 60_000) });
    await new Promise((r) => setTimeout(r, 200)); // educado com as APIs abertas
  }
  const resultado = { analisados: ids.length, completados, resumos, palavrasChave };
  await salvarResultado(t, resultado);
  if (usuarioId) {
    await notificar([usuarioId], 'METADADOS_COMPLETADOS', `Dados completados: ${resumos} resumo(s) e ${palavrasChave} lista(s) de palavras-chave em ${ids.length} documento(s)`, { revisaoId: revisaoId ?? null, ...resultado });
  }
  return resultado;
};

export const handlers: Record<string, Handler> = {
  'completar-metadados': completarMetadadosDocs,
  'importar-busca': importarBusca,
  'gerar-pdf-protocolo': gerarPdfProtocolo,
  'gerar-pdf-projeto': gerarPdfProjeto,
  'exportar-projeto': exportarProjeto,
  'exportar-analise': exportarAnalise,
  'relatorio-revisao': relatorioRevisao,
  'limpar-lixeira': async () => limparLixeira(),
};
