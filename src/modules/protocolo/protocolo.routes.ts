import { Router, type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { db, json } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { EDITA, requirePapel } from '#middlewares/projectAccess.ts';
import { AppError } from '#utils/AppError.ts';
import { uuid } from '#utils/tokens.ts';
import { crudRouter } from '#shared/crud.ts';
import { longText, optText } from '#shared/schemas.ts';
import { auditar } from '#services/audit.ts';
import { enfileirar } from '#services/fila.ts';
import { membrosDoProjeto, notificar } from '#services/notificacoes.ts';
import { salvarArquivo, urlDoArquivo } from '#services/arquivos.ts';
import { compararSnapshots, marcarAlterado, pendencias, protocoloCompleto, protocoloDoProjeto } from './protocolo.service.ts';
import { CODIGOS_METODOLOGIA, modeloTcle } from './tcle.ts';

// Montado em /projetos/:id (projectAccess já aplicado no roteador pai)
const router = Router({ mergeParams: true });
const edita = [requirePapel(...EDITA)];

const protocoloId = async (req: Request) => (await protocoloDoProjeto(req.projeto!.id)).id as string;
const scopeProtocolo = async (req: Request) => ({ protocoloId: await protocoloId(req) });
const aposAlterar = async (trx: any, _req: Request, row: Record<string, any>) => marcarAlterado(trx, row.protocoloId);

// ---------------------------------------------------------------- protocolo

router.get('/protocolo', async (req, res) => {
  const p = await protocoloDoProjeto(req.projeto!.id);
  const completo = await protocoloCompleto(p.id);
  res.json({ ...completo, pendencias: pendencias(completo) });
});

// RF07/RF08: salva o passo do assistente (rascunho). Listas enviadas substituem as atuais.
const item = z.object({ texto: z.string().trim().min(1).max(5000) });
const passoSchema = z.object({
  passoAtual: z.number().int().min(1).max(10).optional(),
  tema: longText(),
  questaoPesquisa: longText(),
  hipotese: longText(),
  objetivoGeral: longText(),
  justificativa: longText(),
  // passo 9: metodologia; passo 10: riscos e benefícios (opcionais) e resultados esperados
  metodologiaTipo: z.enum(CODIGOS_METODOLOGIA).nullable().optional(),
  metodologiaOutro: optText(200),
  metodologia: longText(),
  riscos: longText(),
  beneficios: longText(),
  resultadosEsperados: longText(),
  outrasQuestoes: z.array(item).max(50).optional(),
  objetivos: z.array(item).max(50).optional(),
  palavrasChave: z
    .array(z.object({ termo: z.string().trim().min(1).max(150), idiomaId: z.number().int().positive().nullable().optional() }))
    .max(100)
    .optional(),
  descritores: z
    .array(
      z.object({
        termo: z.string().trim().min(1).max(200),
        vocabulario: z.enum(['DECS', 'MESH', 'LIVRE']).optional(),
        codigo: optText(50),
      }),
    )
    .max(100)
    .optional(),
  strings: z
    .array(
      z.object({
        baseDadosId: z.guid().nullable().optional(),
        campo: z.enum(['TITULO', 'RESUMO', 'PALAVRAS_CHAVE', 'TODOS']).optional(),
        expressao: z.string().trim().min(1).max(10_000),
      }),
    )
    .max(50)
    .optional(),
});

router.put('/protocolo', ...edita, validate({ body: passoSchema }), async (req, res) => {
  const p = await protocoloDoProjeto(req.projeto!.id);
  const { outrasQuestoes, objetivos, palavrasChave, descritores, strings, ...campos } = req.validated.body;
  await db.transaction(async (trx) => {
    if (Object.keys(campos).length) await trx('protocolo').where({ id: p.id }).update(campos);
    const substituir = async (table: string, itens: Record<string, unknown>[] | undefined) => {
      if (!itens) return;
      await trx(table).where({ protocoloId: p.id }).del();
      if (itens.length) await trx(table).insert(itens.map((it, i) => ({ ...it, id: uuid(), protocoloId: p.id, ordem: i + 1 })));
    };
    await substituir('protocoloOutraQuestao', outrasQuestoes);
    await substituir('objetivoEspecifico', objetivos);
    // palavras repetidas no mesmo idioma ferem a chave única: remove duplicatas mantendo a ordem
    await substituir(
      'palavraChave',
      palavrasChave?.filter((pc: any, i: number, arr: any[]) => arr.findIndex((x) => x.termo.toLowerCase() === pc.termo.toLowerCase() && (x.idiomaId ?? null) === (pc.idiomaId ?? null)) === i),
    );
    await substituir('descritor', descritores);
    await substituir('stringBusca', strings);
    await marcarAlterado(trx, p.id);
  });
  const completo = await protocoloCompleto(p.id);
  res.json({ ...completo, pendencias: pendencias(completo) });
});

// RF12/RN02/RN04: valida, gera a versão numerada e muda o status para Concluído
router.post(
  '/protocolo/concluir',
  ...edita,
  validate({ body: z.object({ justificativa: z.string().trim().min(3).max(5000).optional() }) }),
  async (req, res) => {
    const p = await protocoloDoProjeto(req.projeto!.id);
    const completo = await protocoloCompleto(p.id);
    const faltas = pendencias(completo);
    if (faltas.length) throw AppError.unprocessable('Protocolo incompleto', faltas, 'PROTOCOLO_INCOMPLETO');
    if (p.status === 'CONCLUIDO' || p.status === 'APROVADO') throw AppError.conflict('O protocolo já está concluído nesta versão');
    const versao = p.versaoAtual + 1;
    if (versao > 1 && !req.validated.body.justificativa) {
      throw AppError.unprocessable('Informe a justificativa da alteração (RN04)', { campo: 'justificativa' }, 'JUSTIFICATIVA_OBRIGATORIA');
    }
    const snapshot = completo;
    await db.transaction(async (trx) => {
      await trx('protocoloVersao').insert({
        id: uuid(),
        protocoloId: p.id,
        versao,
        snapshot: json(snapshot),
        justificativa: req.validated.body.justificativa ?? null,
        criadoPor: req.user!.id,
      });
      await trx('protocolo').where({ id: p.id }).update({ status: 'CONCLUIDO', versaoAtual: versao, concluidoEm: new Date(), parecer: null });
      await auditar({ req, entidade: 'protocolo', entidadeId: p.id, acao: 'CONCLUIR', antes: { status: p.status }, depois: { status: 'CONCLUIDO', versao } }, trx);
      const orientadores = await membrosDoProjeto(req.projeto!.id, ['ORIENTADOR'], trx);
      await notificar(orientadores, 'PROTOCOLO_CONCLUIDO', `Protocolo v${versao} concluído: ${req.projeto!.titulo}`, { projetoId: req.projeto!.id, versao }, trx);
    });
    res.json(await protocoloCompleto(p.id));
  },
);

// RF13/RN03: PDF do protocolo (gerado no worker). Rascunho sai com marca d'água.
router.post(
  '/protocolo/pdf',
  validate({
    body: z.object({
      versao: z.number().int().positive().optional(),
      secoes: z.array(z.enum(['identificacao', 'definicoes', 'estrategia', 'questoes', 'criterios', 'revisoes', 'historico'])).optional(),
    }),
  }),
  async (req, res) => {
    const p = await protocoloDoProjeto(req.projeto!.id);
    const { versao, secoes } = req.validated.body;
    if (versao && !(await db('protocoloVersao').where({ protocoloId: p.id, versao }).first('id'))) throw AppError.notFound('Versão');
    const tarefaId = await enfileirar('gerar-pdf-protocolo', { protocoloId: p.id, projetoId: req.projeto!.id, versao: versao ?? null, secoes: secoes ?? null, usuarioId: req.user!.id });
    auditar({ req, entidade: 'protocolo', entidadeId: p.id, acao: 'IMPRIMIR', depois: { versao: versao ?? 'atual' } });
    res.status(202).json({ tarefaId, status: 'PENDENTE', acompanhar: `/api/v1/tarefas/${tarefaId}` });
  },
);

// ---------------------------------------------------------------- TCLE (opcional)

// Modelo do TCLE para baixar e preencher (.doc que abre editável no Word/LibreOffice), já com os dados do protocolo
router.get('/protocolo/tcle/modelo', async (req, res) => {
  const p = await protocoloDoProjeto(req.projeto!.id);
  const equipe = await db('projetoMembro as pm')
    .join('usuario as u', 'u.id', 'pm.usuarioId')
    .where('pm.projetoId', req.projeto!.id)
    .whereNotNull('pm.aceitoEm')
    .orderByRaw("FIELD(pm.papel, 'RESPONSAVEL', 'ORIENTADOR', 'COLABORADOR', 'LEITOR')")
    .select('u.nome', 'u.email', 'pm.papel');
  const html = modeloTcle({ projeto: req.projeto!, equipe, protocolo: p });
  const nome = `TCLE - ${req.projeto!.titulo}`.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 100).trim();
  const ascii = nome.normalize('NFD').replace(/[^\x20-\x7e]/g, '') || 'TCLE';
  res
    .type('application/msword')
    .set('Content-Disposition', `attachment; filename="${ascii}.doc"; filename*=UTF-8''${encodeURIComponent(nome)}.doc`)
    .send('\ufeff' + html);
});

// TCLE preenchido: PDF, Word ou ODT até 20 MB (substitui o anterior)
const uploadTcle = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const EXT_TCLE = ['pdf', 'doc', 'docx', 'odt'];

router.get('/protocolo/tcle', async (req, res) => {
  const p = await protocoloDoProjeto(req.projeto!.id);
  if (!p.tcleArquivoId) return res.json(null);
  const r = await urlDoArquivo(p.tcleArquivoId);
  res.json(r ? { url: r.url, arquivo: { id: r.arquivo.id, nomeOriginal: r.arquivo.nomeOriginal, mimeType: r.arquivo.mimeType, criadoEm: r.arquivo.criadoEm } } : null);
});

router.post('/protocolo/tcle', ...edita, uploadTcle.single('arquivo'), async (req, res) => {
  if (!req.file) throw AppError.unprocessable('Envie o TCLE no campo "arquivo"');
  const ext = (req.file.originalname.split('.').pop() ?? '').toLowerCase();
  if (!EXT_TCLE.includes(ext)) throw AppError.unprocessable('Envie o TCLE em PDF, DOC, DOCX ou ODT');
  const p = await protocoloDoProjeto(req.projeto!.id);
  const arquivoId = await salvarArquivo({
    projetoId: req.projeto!.id,
    chave: `projetos/${req.projeto!.id}/protocolo/tcle-${uuid()}.${ext}`,
    nomeOriginal: req.file.originalname,
    mimeType: req.file.mimetype || 'application/octet-stream',
    dados: req.file.buffer,
    criadoPor: req.user!.id,
  });
  await db('protocolo').where({ id: p.id }).update({ tcleArquivoId: arquivoId });
  auditar({ req, entidade: 'protocolo', entidadeId: p.id, acao: 'ALTERAR', depois: { tcle: req.file.originalname } });
  const r = await urlDoArquivo(arquivoId);
  res.status(201).json({ url: r?.url, arquivo: { id: arquivoId, nomeOriginal: req.file.originalname, mimeType: req.file.mimetype } });
});

router.delete('/protocolo/tcle', ...edita, async (req, res) => {
  const p = await protocoloDoProjeto(req.projeto!.id);
  if (p.tcleArquivoId) {
    await db('protocolo').where({ id: p.id }).update({ tcleArquivoId: null });
    auditar({ req, entidade: 'protocolo', entidadeId: p.id, acao: 'ALTERAR', depois: { tcle: null } });
  }
  res.status(204).end();
});

// RF14: histórico e comparação de versões
router.get('/protocolo/versoes', async (req, res) => {
  const p = await protocoloDoProjeto(req.projeto!.id);
  res.json(
    await db('protocoloVersao as v')
      .leftJoin('usuario as u', 'u.id', 'v.criadoPor')
      .where('v.protocoloId', p.id)
      .orderBy('v.versao', 'desc')
      .select('v.id', 'v.versao', 'v.justificativa', 'v.pdfArquivoId', 'v.criadoEm', 'u.nome as criadoPorNome'),
  );
});

router.get(
  '/protocolo/versoes/comparar',
  validate({ query: z.object({ a: z.coerce.number().int().positive(), b: z.coerce.number().int().positive() }) }),
  async (req, res) => {
    const p = await protocoloDoProjeto(req.projeto!.id);
    const vs = await db('protocoloVersao').where({ protocoloId: p.id }).whereIn('versao', [req.validated.query.a, req.validated.query.b]);
    const a = vs.find((v: any) => v.versao === req.validated.query.a);
    const b = vs.find((v: any) => v.versao === req.validated.query.b);
    if (!a || !b) throw AppError.notFound('Versão');
    res.json({ a: a.versao, b: b.versao, diferencas: compararSnapshots(a.snapshot, b.snapshot) });
  },
);

router.get('/protocolo/versoes/:versao', validate({ params: z.object({ versao: z.coerce.number().int().positive() }).loose() }), async (req, res) => {
  const p = await protocoloDoProjeto(req.projeto!.id);
  const v = await db('protocoloVersao').where({ protocoloId: p.id, versao: req.validated.params.versao }).first();
  if (!v) throw AppError.notFound('Versão');
  res.json(v);
});

// RF15/UC15: orientador aprova ou devolve com parecer
router.post(
  '/protocolo/aprovacao',
  requirePapel('ORIENTADOR'),
  validate({ body: z.object({ decisao: z.enum(['APROVAR', 'DEVOLVER']), parecer: z.string().trim().max(10_000).optional() }) }),
  async (req, res) => {
    const p = await protocoloDoProjeto(req.projeto!.id);
    if (p.status !== 'CONCLUIDO') throw AppError.conflict('Só um protocolo concluído pode ser aprovado ou devolvido');
    const { decisao, parecer } = req.validated.body;
    if (decisao === 'DEVOLVER' && !parecer) throw AppError.unprocessable('Explique no parecer o que deve ser ajustado');
    const aprovar = decisao === 'APROVAR';
    await db.transaction(async (trx) => {
      await trx('protocolo')
        .where({ id: p.id })
        .update({ status: aprovar ? 'APROVADO' : 'DEVOLVIDO', aprovadoPor: aprovar ? req.user!.id : null, aprovadoEm: aprovar ? new Date() : null, parecer: parecer ?? null });
      await auditar({ req, entidade: 'protocolo', entidadeId: p.id, acao: aprovar ? 'APROVAR' : 'DEVOLVER', depois: { parecer } }, trx);
      const responsaveis = await membrosDoProjeto(req.projeto!.id, ['RESPONSAVEL', 'COLABORADOR'], trx);
      await notificar(responsaveis, aprovar ? 'PROTOCOLO_APROVADO' : 'PROTOCOLO_DEVOLVIDO', aprovar ? 'Protocolo aprovado' : 'Protocolo devolvido com parecer', { projetoId: req.projeto!.id, versao: p.versaoAtual }, trx);
    });
    res.json(await db('protocolo').where({ id: p.id }).first());
  },
);

// ---------------------------------------------------------------- itens do protocolo (CRUD)

const itemTexto = z.object({ texto: z.string().trim().min(1).max(5000), ordem: z.number().int().positive().optional() });

router.use('/outras-questoes', crudRouter({ table: 'protocoloOutraQuestao', scope: scopeProtocolo, write: edita, ordered: true, label: 'Questão', createSchema: itemTexto, afterWrite: aposAlterar }));
router.use('/objetivos', crudRouter({ table: 'objetivoEspecifico', scope: scopeProtocolo, write: edita, ordered: true, label: 'Objetivo', createSchema: itemTexto, afterWrite: aposAlterar }));
router.use(
  '/palavras-chave',
  crudRouter({
    table: 'palavraChave',
    scope: scopeProtocolo,
    write: edita,
    ordered: true,
    label: 'Palavra-chave',
    createSchema: z.object({ termo: z.string().trim().min(1).max(150), idiomaId: z.number().int().positive().nullable().optional(), ordem: z.number().int().positive().optional() }),
    afterWrite: aposAlterar,
  }),
);
router.use(
  '/descritores',
  crudRouter({
    table: 'descritor',
    scope: scopeProtocolo,
    write: edita,
    ordered: true,
    label: 'Descritor',
    createSchema: z.object({
      termo: z.string().trim().min(1).max(200),
      vocabulario: z.enum(['DECS', 'MESH', 'LIVRE']).optional(),
      codigo: optText(50),
      ordem: z.number().int().positive().optional(),
    }),
    afterWrite: aposAlterar,
  }),
);
router.use(
  '/strings',
  crudRouter({
    table: 'stringBusca',
    scope: scopeProtocolo,
    write: edita,
    ordered: true,
    label: 'String de busca',
    createSchema: z.object({
      baseDadosId: z.guid().nullable().optional(),
      campo: z.enum(['TITULO', 'RESUMO', 'PALAVRAS_CHAVE', 'TODOS']).optional(),
      expressao: z.string().trim().min(1).max(10_000),
      ordem: z.number().int().positive().optional(),
    }),
    afterWrite: aposAlterar,
  }),
);

// RF10: critérios, com modelos pré-preenchidos
export const MODELOS_CRITERIO = ['Período', 'Bases', 'Idiomas', 'Citações', 'Publicações', 'Temas', 'Acesso', 'Relevância'];
router.get('/criterios/modelos', (_req, res) => {
  res.json(MODELOS_CRITERIO);
});
router.use(
  '/criterios',
  crudRouter({
    table: 'criterio',
    scope: scopeProtocolo,
    write: edita,
    ordered: true,
    orderBy: [{ column: 'tipo' }, { column: 'ordem' }],
    label: 'Critério',
    createSchema: z.object({
      tipo: z.enum(['INCLUSAO', 'EXCLUSAO']),
      nome: z.string().trim().min(1).max(100),
      descricao: longText(5000),
      ordem: z.number().int().positive().optional(),
    }),
    afterWrite: aposAlterar,
  }),
);

// RF09/RN05: questões de análise com código QAn gerado em sequência
async function proximoCodigo(trx: any, protocoloIdValor: string) {
  const codigos: string[] = (await trx('questaoAnalise').where({ protocoloId: protocoloIdValor }).select('codigo')).map((r: any) => r.codigo);
  const n = Math.max(0, ...codigos.map((c) => Number(/^QA(\d+)$/.exec(c)?.[1] ?? 0)));
  return `QA${n + 1}`;
}

router.post(
  '/questoes/de-outras-questoes',
  ...edita,
  validate({ body: z.object({ ids: z.array(z.guid()).optional() }) }),
  async (req, res) => {
    const pid = await protocoloId(req);
    const criadas = await db.transaction(async (trx) => {
      const q = trx('protocoloOutraQuestao').where({ protocoloId: pid }).orderBy('ordem');
      if (req.validated.body.ids) q.whereIn('id', req.validated.body.ids);
      const out: string[] = [];
      for (const oq of await q) {
        const codigo = await proximoCodigo(trx, pid);
        const ordem = ((await trx('questaoAnalise').where({ protocoloId: pid }).max({ m: 'ordem' }).first())?.m ?? 0) + 1;
        const id = uuid();
        await trx('questaoAnalise').insert({ id, protocoloId: pid, codigo, enunciado: oq.texto, ordem });
        out.push(id);
      }
      await marcarAlterado(trx, pid);
      return out;
    });
    res.status(201).json(await db('questaoAnalise').whereIn('id', criadas).orderBy('ordem'));
  },
);

router.use(
  '/questoes',
  crudRouter({
    table: 'questaoAnalise',
    scope: scopeProtocolo,
    write: edita,
    ordered: true,
    label: 'Questão de análise',
    createSchema: z.object({
      codigo: z.string().trim().regex(/^[A-Za-z]{1,4}\d{1,4}$/).optional(),
      enunciado: z.string().trim().min(1).max(5000),
      ordem: z.number().int().positive().optional(),
      ativo: z.boolean().optional(),
    }),
    beforeWrite: async (trx, req, data, id) => {
      if (!id && !data.codigo) data.codigo = await proximoCodigo(trx, await protocoloId(req));
    },
    afterWrite: aposAlterar,
  }),
);

export default router;
