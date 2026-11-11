import { Router } from 'express';
import { z } from 'zod';
import { db } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { EDITA, requirePapel } from '#middlewares/projectAccess.ts';
import { AppError } from '#utils/AppError.ts';
import { uuid } from '#utils/tokens.ts';
import { GERADORES, NORMAS, type Norma } from '#utils/referencias.ts';
import { auditar } from '#services/audit.ts';

/**
 * Referências do projeto (montado em /projetos/:id/referencias): cada uma com o texto em ABNT NBR 6023,
 * APA (7ª ed.), MLA (9ª ed.), Chicago (17ª ed.), Vancouver e IEEE, cadastrada à mão ou trazida dos
 * documentos do projeto.
 */
const router = Router({ mergeParams: true });
const edita = requirePapel(...EDITA);

const texto = z.string().trim().max(10_000).nullable().optional();
const campos = z.object({
  abnt: texto,
  apa: texto,
  mla: texto,
  chicago: texto,
  vancouver: texto,
  ieee: texto,
  observacao: z.string().trim().max(500).nullable().optional(),
});
const vazio = (v?: string | null) => !v?.trim();
const algumaNorma = (r: Partial<Record<Norma, string | null>>) => NORMAS.some((n) => !vazio(r[n]));
const MSG_NORMA = 'Informe a referência em pelo menos uma norma';

/** Lista ordenada pela referência (ABNT; sem ela, APA e as demais), como numa lista de referências */
export function referenciasDoProjeto(projetoId: string) {
  return db('referencia as r')
    .leftJoin('documento as d', 'd.id', 'r.documentoId')
    .where('r.projetoId', projetoId)
    .orderByRaw('LOWER(COALESCE(r.abnt, r.apa, r.mla, r.chicago, r.vancouver, r.ieee))')
    .select('r.*', 'd.titulo as documentoTitulo');
}

router.get('/', async (req, res) => {
  res.json(await referenciasDoProjeto(req.projeto!.id));
});

router.post('/', edita, validate({ body: campos.refine(algumaNorma, MSG_NORMA) }), async (req, res) => {
  const id = uuid();
  const b = req.validated.body;
  const normas = Object.fromEntries(NORMAS.map((n) => [n, b[n]?.trim() || null]));
  await db('referencia').insert({
    id,
    projetoId: req.projeto!.id,
    ...normas,
    observacao: b.observacao?.trim() || null,
    criadoPor: req.user!.id,
  });
  res.status(201).json(await db('referencia').where({ id }).first());
});

// Traz as referências dos documentos do projeto (as do documento ou geradas dos metadados, RF27).
// As que já estavam na lista ganham o texto das normas que ainda estão em branco.
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
    const existentes = new Map<string, any>(
      (await db('referencia').where({ projetoId: req.projeto!.id }).whereNotNull('documentoId')).map((r: any) => [r.documentoId, r]),
    );
    const textoDoDoc = (d: any, n: Norma) =>
      (n === 'abnt' ? d.refNbr?.trim() : n === 'apa' ? d.refApa?.trim() : '') || GERADORES[n](d);

    const novas = docs
      .filter((d: any) => !existentes.has(d.id))
      .map((d: any) => ({
        id: uuid(),
        projetoId: req.projeto!.id,
        documentoId: d.id,
        ...Object.fromEntries(NORMAS.map((n) => [n, textoDoDoc(d, n)])),
        criadoPor: req.user!.id,
      }));
    for (let i = 0; i < novas.length; i += 500) await db('referencia').insert(novas.slice(i, i + 500));

    let completadas = 0;
    for (const d of docs) {
      const ref = existentes.get(d.id);
      if (!ref) continue;
      const faltam = Object.fromEntries(NORMAS.filter((n) => vazio(ref[n])).map((n) => [n, textoDoDoc(d, n)]));
      if (!Object.keys(faltam).length) continue;
      await db('referencia').where({ id: ref.id }).update(faltam);
      completadas++;
    }

    if (novas.length || completadas)
      auditar({ req, entidade: 'referencia', entidadeId: req.projeto!.id, acao: 'CRIAR', depois: { fonte, importadas: novas.length, completadas } });
    res.json({ importadas: novas.length, jaExistiam: docs.length - novas.length, completadas });
  },
);

router.patch('/:refId', edita, validate({ params: z.object({ refId: z.guid() }).loose(), body: campos }), async (req, res) => {
  const { refId } = req.validated.params;
  const atual = await db('referencia').where({ id: refId, projetoId: req.projeto!.id }).first();
  if (!atual) throw AppError.notFound('Referência');
  const b = req.validated.body;
  const dados: Record<string, string | null> = {};
  for (const k of [...NORMAS, 'observacao'] as const) if (b[k] !== undefined) dados[k] = b[k]?.trim() || null;
  if (!algumaNorma({ ...atual, ...dados })) throw AppError.unprocessable(MSG_NORMA);
  if (Object.keys(dados).length) await db('referencia').where({ id: refId }).update(dados);
  res.json(await db('referencia').where({ id: refId }).first());
});

router.delete('/:refId', edita, validate({ params: z.object({ refId: z.guid() }).loose() }), async (req, res) => {
  const n = await db('referencia').where({ id: req.validated.params.refId, projetoId: req.projeto!.id }).del();
  if (!n) throw AppError.notFound('Referência');
  res.status(204).end();
});

export default router;
