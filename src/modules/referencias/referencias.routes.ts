import { Router } from 'express';
import { z } from 'zod';
import { db } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { EDITA, requirePapel } from '#middlewares/projectAccess.ts';
import { AppError } from '#utils/AppError.ts';
import { uuid } from '#utils/tokens.ts';
import { referenciaApa, referenciaNbr } from '#utils/referencias.ts';
import { auditar } from '#services/audit.ts';

/**
 * Referências do projeto (montado em /projetos/:id/referencias): cada uma com o texto em ABNT
 * (NBR 6023) e em APA (7ª ed.), cadastrada à mão ou trazida dos documentos do projeto.
 */
const router = Router({ mergeParams: true });
const edita = requirePapel(...EDITA);

const texto = z.string().trim().max(10_000).nullable().optional();
const campos = z.object({ abnt: texto, apa: texto, observacao: z.string().trim().max(500).nullable().optional() });
const vazio = (v?: string | null) => !v?.trim();

/** Lista ordenada pela referência (ABNT; sem ela, APA), como numa lista de referências */
export function referenciasDoProjeto(projetoId: string) {
  return db('referencia as r')
    .leftJoin('documento as d', 'd.id', 'r.documentoId')
    .where('r.projetoId', projetoId)
    .orderByRaw('LOWER(COALESCE(r.abnt, r.apa))')
    .select('r.*', 'd.titulo as documentoTitulo');
}

router.get('/', async (req, res) => {
  res.json(await referenciasDoProjeto(req.projeto!.id));
});

router.post(
  '/',
  edita,
  validate({ body: campos.refine((b) => !vazio(b.abnt) || !vazio(b.apa), 'Informe a referência em ABNT, em APA ou nas duas') }),
  async (req, res) => {
    const id = uuid();
    const b = req.validated.body;
    await db('referencia').insert({
      id,
      projetoId: req.projeto!.id,
      abnt: b.abnt?.trim() || null,
      apa: b.apa?.trim() || null,
      observacao: b.observacao?.trim() || null,
      criadoPor: req.user!.id,
    });
    res.status(201).json(await db('referencia').where({ id }).first());
  },
);

// Traz as referências dos documentos do projeto (as do documento ou geradas dos metadados, RF27)
router.post(
  '/importar',
  edita,
  validate({
    body: z.object({
      fonte: z.enum(['INCLUIDOS', 'TODOS', 'SELECIONADOS']),
      documentoIds: z.array(z.guid()).max(2000).optional(),
    }),
  }),
  async (req, res) => {
    const { fonte, documentoIds } = req.validated.body;
    const q = db('documento as d').where('d.projetoId', req.projeto!.id).select('d.*');
    if (fonte === 'SELECIONADOS') {
      if (!documentoIds?.length) throw AppError.unprocessable('Escolha os documentos');
      q.whereIn('d.id', documentoIds);
    }
    if (fonte === 'INCLUIDOS') {
      q.whereExists(db('revisaoDocumento as rd').whereRaw('rd.documento_id = d.id').where('rd.situacao', 'INCLUIDO'));
    }
    const docs = await q;
    const ja = new Set(
      (await db('referencia').where({ projetoId: req.projeto!.id }).whereNotNull('documentoId').select('documentoId')).map((r: any) => r.documentoId),
    );
    const novas = docs
      .filter((d: any) => !ja.has(d.id))
      .map((d: any) => ({
        id: uuid(),
        projetoId: req.projeto!.id,
        documentoId: d.id,
        abnt: d.refNbr?.trim() || referenciaNbr(d),
        apa: d.refApa?.trim() || referenciaApa(d),
        criadoPor: req.user!.id,
      }));
    for (let i = 0; i < novas.length; i += 500) await db('referencia').insert(novas.slice(i, i + 500));
    if (novas.length) auditar({ req, entidade: 'referencia', entidadeId: req.projeto!.id, acao: 'CRIAR', depois: { fonte, importadas: novas.length } });
    res.json({ importadas: novas.length, jaExistiam: docs.length - novas.length });
  },
);

router.patch('/:refId', edita, validate({ params: z.object({ refId: z.guid() }).loose(), body: campos }), async (req, res) => {
  const { refId } = req.validated.params;
  const atual = await db('referencia').where({ id: refId, projetoId: req.projeto!.id }).first();
  if (!atual) throw AppError.notFound('Referência');
  const b = req.validated.body;
  const dados: Record<string, string | null> = {};
  for (const k of ['abnt', 'apa', 'observacao'] as const) if (b[k] !== undefined) dados[k] = b[k]?.trim() || null;
  const abnt = 'abnt' in dados ? dados.abnt : atual.abnt;
  const apa = 'apa' in dados ? dados.apa : atual.apa;
  if (vazio(abnt) && vazio(apa)) throw AppError.unprocessable('A referência precisa ter o texto em ABNT ou em APA');
  if (Object.keys(dados).length) await db('referencia').where({ id: refId }).update(dados);
  res.json(await db('referencia').where({ id: refId }).first());
});

router.delete('/:refId', edita, validate({ params: z.object({ refId: z.guid() }).loose() }), async (req, res) => {
  const n = await db('referencia').where({ id: req.validated.params.refId, projetoId: req.projeto!.id }).del();
  if (!n) throw AppError.notFound('Referência');
  res.status(204).end();
});

export default router;
