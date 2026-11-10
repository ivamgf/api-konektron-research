import { db } from '#database/connection.ts';
import { esc } from '#pdf/render.ts';
import { protocoloCompleto } from '#modules/protocolo/protocolo.service.ts';
import { referenciasDoProjeto } from '#modules/referencias/referencias.routes.ts';
import { dadosDiagrama } from '#modules/revisoes/diagrama.ts';

/**
 * Gerador de artigo: reúne do projeto o que alimenta cada seção (o app monta o texto e o autor
 * edita) e converte o documento final em HTML para o Word.
 */

const ORDEM_PAPEL: Record<string, number> = {
  RESPONSAVEL: 0,
  ORIENTADOR: 1,
  COLABORADOR: 2,
  LEITOR: 3,
};
const json = (v: unknown) => {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  try {
    return JSON.parse(String(v ?? 'null')) as Record<string, unknown> | null;
  } catch {
    return null;
  }
};

export async function fontesDoArtigo(projetoId: string) {
  const projeto = await db('projeto').where({ id: projetoId }).first();

  // autores: o responsável (quem criou o projeto) primeiro, depois os membros
  const membros = await db('projetoMembro as m')
    .join('usuario as u', 'u.id', 'm.usuarioId')
    .where('m.projetoId', projetoId)
    .where((q) =>
      q
        .whereNotNull('m.aceitoEm')
        .orWhere('m.papel', 'RESPONSAVEL')
        .orWhere('m.usuarioId', projeto.criadoPor),
    )
    .select('u.id as usuarioId', 'u.nome', 'u.email', 'u.orcid', 'u.instituicao', 'm.papel');
  const autores = membros
    .map((m: any) => ({ ...m, principal: m.usuarioId === projeto.criadoPor }))
    .sort(
      (a: any, b: any) =>
        Number(b.principal) - Number(a.principal) ||
        (ORDEM_PAPEL[a.papel] ?? 9) - (ORDEM_PAPEL[b.papel] ?? 9) ||
        a.nome.localeCompare(b.nome, 'pt-BR'),
    );

  const p = await db('protocolo').where({ projetoId }).first('id');
  const protocolo = p ? await protocoloCompleto(p.id) : null;

  // revisões: tipo, registro, critérios e contagens do diagrama de fluxo
  const revisoesBase = await db('revisao as r')
    .join('tipoRevisao as t', 't.id', 'r.tipoRevisaoId')
    .leftJoin('diretrizRelato as d', 'd.id', 'r.diretrizRelatoId')
    .where('r.projetoId', projetoId)
    .orderBy('r.criadoEm')
    .select(
      'r.id',
      'r.titulo',
      'r.status',
      'r.registroUrl',
      'r.registroIdentificador',
      't.nome as tipoNome',
      'd.sigla as diretrizSigla',
      'd.versao as diretrizVersao',
    );
  const revisoes = [];
  for (const r of revisoesBase) revisoes.push({ ...r, diagrama: await dadosDiagrama(r.id) });

  // documentos de revisão anterior / referencial teórico (para a fundamentação)
  const anteriores = new Set(
    (
      await db('revisaoDocumento as rd')
        .join('revisao as r', 'r.id', 'rd.revisaoId')
        .where('r.projetoId', projetoId)
        .where('rd.origem', 'REVISAO_ANTERIOR')
        .select('rd.documentoId')
    ).map((x: any) => x.documentoId),
  );
  const analisados = (
    await db('analiseDocumento as ad')
      .join('analise as a', 'a.id', 'ad.analiseId')
      .join('documento as d', 'd.id', 'ad.documentoId')
      .where('a.projetoId', projetoId)
      .whereNotNull('ad.resumoAssunto')
      .whereRaw("TRIM(ad.resumo_assunto) <> ''")
      .orderBy(['a.nome', 'd.titulo'])
      .select(
        'ad.id',
        'a.id as analiseId',
        'a.nome as analiseNome',
        'a.fonte as analiseFonte',
        'd.id as documentoId',
        'd.titulo',
        'd.autores',
        'd.ano',
        'ad.resumoAssunto',
      )
  ).map((x: any) => ({
    ...x,
    teorico: anteriores.has(x.documentoId) || x.analiseFonte === 'REFERENCIAL_TEORICO',
  }));

  const discussoes = await db('discussaoItem as di')
    .join('analiseDocumento as ad', 'ad.id', 'di.analiseDocumentoId')
    .join('analise as a', 'a.id', 'ad.analiseId')
    .join('documento as d', 'd.id', 'ad.documentoId')
    .where('a.projetoId', projetoId)
    .where((q) =>
      q
        .whereRaw("TRIM(COALESCE(di.discussao, '')) <> ''")
        .orWhereRaw("TRIM(COALESCE(di.ponto_principal, '')) <> ''"),
    )
    .orderBy(['a.nome', 'd.titulo', 'di.ordem'])
    .select(
      'di.id',
      'di.pontoPrincipal',
      'di.discussao',
      'a.nome as analiseNome',
      'd.titulo',
      'd.autores',
      'd.ano',
    );

  const referencias = (await referenciasDoProjeto(projetoId)).map((r: any) => ({
    id: r.id,
    abnt: r.abnt,
    apa: r.apa,
  }));

  // usos de IA registrados no projeto (ferramenta e finalidade, para a declaração)
  const usos = await db('auditoria')
    .where({ projetoId, acao: 'USAR_IA' })
    .orderBy('criadoEm')
    .select('dadosDepois', 'criadoEm');
  const porFerramenta = new Map<
    string,
    {
      provedor: string | null;
      modelo: string | null;
      modo: string | null;
      recursos: Set<string>;
      vezes: number;
      primeiro: string;
      ultimo: string;
    }
  >();
  for (const u of usos as any[]) {
    const d = json(u.dadosDepois) ?? {};
    const provedor = (d.provedor as string) || null;
    const modelo = (d.modelo as string) || null;
    const chave = `${provedor ?? ''}|${modelo ?? ''}|${d.modo ?? ''}`;
    const quando = new Date(u.criadoEm).toISOString();
    const f = porFerramenta.get(chave) ?? {
      provedor,
      modelo,
      modo: (d.modo as string) || null,
      recursos: new Set<string>(),
      vezes: 0,
      primeiro: quando,
      ultimo: quando,
    };
    if (d.recurso) f.recursos.add(String(d.recurso).trim());
    f.vezes++;
    f.ultimo = quando;
    porFerramenta.set(chave, f);
  }
  const usosIa = [...porFerramenta.values()].map((f) => ({ ...f, recursos: [...f.recursos] }));

  return {
    projeto: {
      titulo: projeto.titulo,
      subtitulo: projeto.subtitulo ?? null,
      instituicao: projeto.instituicao ?? null,
    },
    autores,
    protocolo,
    revisoes,
    analisados,
    discussoes,
    referencias,
    usosIa,
  };
}

// ------------------------------------------------------------------ documento final → HTML

export type Bloco = {
  tipo: 'p' | 'h3' | 'lista' | 'citacao' | 'ref' | 'nota';
  texto?: string;
  itens?: string[];
};
export type DocumentoArtigo = {
  titulo: string;
  subtitulo?: string | null;
  autores: { nome: string; detalhes: string[] }[];
  secoes: { titulo: string; blocos: Bloco[] }[];
};

const texto = (t?: string) => esc(t ?? '').replace(/\n/g, '<br>');

function bloco(b: Bloco): string {
  switch (b.tipo) {
    case 'h3':
      return `<h3>${texto(b.texto)}</h3>`;
    case 'lista':
      return `<ul>${(b.itens ?? []).map((i) => `<li>${texto(i)}</li>`).join('')}</ul>`;
    case 'citacao':
      return `<p style="margin-left:4cm;font-size:10pt;text-align:justify">${texto(b.texto)}</p>`;
    case 'ref':
      return `<p style="text-align:left;margin-bottom:12pt">${texto(b.texto)}</p>`;
    case 'nota':
      return `<p style="font-size:10pt;text-align:justify">${texto(b.texto)}</p>`;
    default:
      return `<p style="text-align:justify;line-height:1.5">${texto(b.texto)}</p>`;
  }
}

export function htmlDoArtigo(d: DocumentoArtigo): string {
  const autores = d.autores
    .map(
      (a) =>
        `<p style="text-align:center;margin-bottom:0"><b>${esc(a.nome)}</b></p>` +
        a.detalhes
          .map((x) => `<p style="text-align:center;font-size:10pt;margin:0">${esc(x)}</p>`)
          .join(''),
    )
    .join('<p style="margin:0"></p>');
  const secoes = d.secoes
    .filter((s) => s.blocos.length)
    .map((s) => `<h2>${esc(s.titulo)}</h2>${s.blocos.map(bloco).join('')}`)
    .join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(d.titulo)}</title></head><body>
<h1 style="text-align:center">${esc(d.titulo)}</h1>
${d.subtitulo ? `<p style="text-align:center;font-size:13pt"><i>${esc(d.subtitulo)}</i></p>` : ''}
${autores}
${secoes}
</body></html>`;
}
