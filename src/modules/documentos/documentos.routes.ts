import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { db } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { EDITA, projectAccess, requirePapel } from '#middlewares/projectAccess.ts';
import { AppError } from '#utils/AppError.ts';
import { uuid } from '#utils/tokens.ts';
import { limparDoi, normalizarTitulo } from '#utils/normalize.ts';
import { referenciaApa, referenciaNbr } from '#utils/referencias.ts';
import { longText, optText, paginar, pagination, sortBy } from '#shared/schemas.ts';
import { salvarArquivo, urlDoArquivo } from '#services/arquivos.ts';
import { auditar } from '#services/audit.ts';

export const documentoSchema = z.object({
  titulo: z.string().trim().min(1).max(5000),
  autores: longText(10_000),
  resumo: longText(),
  palavrasChave: longText(5000),
  ano: z.number().int().min(1500).max(2100).nullable().optional(),
  periodico: optText(300),
  fatorImpacto: z.number().min(0).max(9999).nullable().optional(),
  idiomaId: z.number().int().positive().nullable().optional(),
  tipoDocumentoId: z.number().int().positive().nullable().optional(),
  baseDadosId: z.uuid().nullable().optional(),
  link: z.url().max(1000).nullable().optional(),
  doi: optText(255),
  citacoes: z.number().int().min(0).nullable().optional(),
  refNbr: longText(5000),
  refApa: longText(5000),
  refApa2: longText(5000),
  temaIds: z.array(z.uuid()).max(50).optional(),
});

// RN11 + RF27: normaliza e completa as referências que vierem vazias
export function prepararDocumento(d: Record<string, any>, atual?: Record<string, any>) {
  const out: Record<string, any> = { ...d };
  if ('titulo' in d) out.tituloNormalizado = normalizarTitulo(d.titulo);
  if ('doi' in d) out.doi = limparDoi(d.doi);
  const base = { ...atual, ...out };
  if (!atual || 'titulo' in d || 'autores' in d || 'ano' in d || 'periodico' in d || 'doi' in d) {
    // referência ajustada à mão vem no corpo e é mantida; senão é gerada de novo
    if (!d.refNbr) out.refNbr = referenciaNbr(base as any);
    if (!d.refApa) out.refApa = referenciaApa(base as any);
  }
  return out;
}

async function gravarTemas(trx: any, documentoId: string, projetoId: string, temaIds?: string[]) {
  if (!temaIds) return;
  const validos = temaIds.length ? await trx('tema').where({ projetoId }).whereIn('id', temaIds).select('id') : [];
  await trx('documentoTema').where({ documentoId }).del();
  if (validos.length) await trx('documentoTema').insert(validos.map((t: any) => ({ documentoId, temaId: t.id })));
}

async function detalhe(id: string) {
  const d = await db('documento as d')
    .leftJoin('idioma as i', 'i.id', 'd.idiomaId')
    .leftJoin('tipoDocumento as td', 'td.id', 'd.tipoDocumentoId')
    .leftJoin('baseDados as b', 'b.id', 'd.baseDadosId')
    .where('d.id', id)
    .first('d.*', 'i.nome as idiomaNome', 'td.nome as tipoDocumentoNome', 'b.nome as baseNome');
  if (!d) throw AppError.notFound('Documento');
  const temas = await db('documentoTema as dt').join('tema as t', 't.id', 'dt.temaId').where('dt.documentoId', id).select('t.id', 't.nome');
  const revisoes = await db('revisaoDocumento as rd').join('revisao as r', 'r.id', 'rd.revisaoId').where('rd.documentoId', id).select('rd.id', 'rd.revisaoId', 'r.titulo as revisaoTitulo', 'rd.situacao', 'rd.origem');
  const { dadosOriginais: _o, ...resto } = d;
  return { ...resto, temas, revisoes };
}

// ------------------------------------------------ /projetos/:id/documentos (RF26)
export const documentosDoProjeto = Router({ mergeParams: true });

documentosDoProjeto.get(
  '/',
  validate({
    query: pagination.extend({
      q: z.string().trim().max(200).optional(),
      ano: z.coerce.number().int().optional(),
      tipoDocumentoId: z.coerce.number().int().optional(),
      temaId: z.uuid().optional(),
      semRevisao: z.coerce.boolean().optional(),
    }),
  }),
  async (req, res) => {
    const { page, pageSize, sort, q, ano, tipoDocumentoId, temaId, semRevisao } = req.validated.query;
    const query = db('documento as d')
      .where('d.projetoId', req.projeto!.id)
      .select('d.id', 'd.titulo', 'd.autores', 'd.ano', 'd.periodico', 'd.doi', 'd.citacoes', 'd.tipoDocumentoId', 'd.arquivoId', 'd.criadoEm', 'd.atualizadoEm')
      .orderBy(sortBy(sort, ['titulo', 'ano', 'criadoEm', 'citacoes'], { column: 'criadoEm', order: 'desc' }).map((s) => ({ ...s, column: `d.${s.column}` })));
    // RF46: busca no índice FULLTEXT (título, resumo e palavras-chave)
    if (q) query.whereRaw('MATCH(d.titulo, d.resumo, d.palavras_chave) AGAINST (? IN BOOLEAN MODE)', [q.split(/\s+/).map((w: string) => `${w.replace(/[+\-<>()~*"@]/g, '')}*`).join(' ')]);
    if (ano) query.where('d.ano', ano);
    if (tipoDocumentoId) query.where('d.tipoDocumentoId', tipoDocumentoId);
    if (temaId) query.whereExists(db('documentoTema').whereRaw('documento_id = d.id').where({ temaId }));
    if (semRevisao) query.whereNotExists(db('revisaoDocumento').whereRaw('documento_id = d.id'));
    res.json(await paginar(query, page, pageSize));
  },
);

documentosDoProjeto.post('/', requirePapel(...EDITA), validate({ body: documentoSchema }), async (req, res) => {
  const { temaIds, ...d } = req.validated.body;
  const id = uuid();
  await db.transaction(async (trx) => {
    await trx('documento').insert({ ...prepararDocumento(d), id, projetoId: req.projeto!.id, criadoPor: req.user!.id });
    await gravarTemas(trx, id, req.projeto!.id, temaIds);
  });
  res.status(201).json(await detalhe(id));
});

// ------------------------------------------------ /documentos/:id
export const documentos = Router();
documentos.use('/:id', projectAccess('documento'));

documentos.get('/:id', async (req, res) => {
  res.json(await detalhe(String(req.params.id)));
});

documentos.patch('/:id', requirePapel(...EDITA), validate({ body: documentoSchema.partial() }), async (req, res) => {
  const id = String(req.params.id);
  const { temaIds, ...d } = req.validated.body;
  const atual = await db('documento').where({ id }).first();
  await db.transaction(async (trx) => {
    const dados = prepararDocumento(d, atual);
    if (Object.keys(dados).length) await trx('documento').where({ id }).update(dados);
    await gravarTemas(trx, id, req.projeto!.id, temaIds);
  });
  res.json(await detalhe(id));
});

documentos.delete('/:id', requirePapel(...EDITA), async (req, res) => {
  const id = String(req.params.id);
  const decidido = await db('triagemDecisao as td').join('revisaoDocumento as rd', 'rd.id', 'td.revisaoDocumentoId').where('rd.documentoId', id).first('td.id');
  if (decidido) throw AppError.conflict('O documento já tem decisões de triagem e não pode ser excluído');
  await db('documento').where({ id }).del();
  auditar({ req, entidade: 'documento', entidadeId: id, acao: 'EXCLUIR' });
  res.status(204).end();
});

// RF27: gera de novo as referências a partir dos metadados
documentos.post('/:id/referencias', requirePapel(...EDITA), async (req, res) => {
  const id = String(req.params.id);
  const d = await db('documento').where({ id }).first();
  await db('documento').where({ id }).update({ refNbr: referenciaNbr(d), refApa: referenciaApa(d) });
  res.json(await detalhe(id));
});

// RF34/RN18: PDF anexado (até 50 MB) e URL assinada de 15 min
const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
});

documentos.post('/:id/arquivo', requirePapel(...EDITA), uploadPdf.single('arquivo'), async (req, res) => {
  if (!req.file) throw AppError.unprocessable('Envie um arquivo PDF no campo "arquivo"');
  const id = String(req.params.id);
  const arquivoId = await salvarArquivo({
    projetoId: req.projeto!.id,
    chave: `projetos/${req.projeto!.id}/documentos/${id}/${uuid()}.pdf`,
    nomeOriginal: req.file.originalname,
    mimeType: 'application/pdf',
    dados: req.file.buffer,
    criadoPor: req.user!.id,
  });
  await db('documento').where({ id }).update({ arquivoId });
  res.status(201).json(await urlDoArquivo(arquivoId));
});

documentos.get('/:id/arquivo', async (req, res) => {
  const d = await db('documento').where({ id: String(req.params.id) }).first('arquivoId');
  if (!d?.arquivoId) throw AppError.notFound('Arquivo do documento');
  res.json(await urlDoArquivo(d.arquivoId));
});

