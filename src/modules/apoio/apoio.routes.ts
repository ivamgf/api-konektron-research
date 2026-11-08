import { Router } from 'express';
import { z } from 'zod';
import { env } from '#config/env.ts';
import { db } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { EDITA, requirePapel } from '#middlewares/projectAccess.ts';
import { AppError } from '#utils/AppError.ts';
import { uuid } from '#utils/tokens.ts';
import { crudRouter } from '#shared/crud.ts';
import { urlDoArquivo } from '#services/arquivos.ts';
import { LocalStorageProvider } from '#services/storage/local.ts';
import { storage } from '#services/storage/index.ts';
import { membrosDoProjeto, notificar } from '#services/notificacoes.ts';
import { enfileirar } from '#services/fila.ts';

// ------------------------------------------------ /projetos/:id/... (projectAccess no pai)
export const apoioDoProjeto = Router({ mergeParams: true });

apoioDoProjeto.use(
  '/temas',
  crudRouter({ table: 'tema', scope: (req) => ({ projetoId: req.projeto!.id }), write: [requirePapel(...EDITA)], orderBy: [{ column: 'nome' }], label: 'Tema', createSchema: z.object({ nome: z.string().trim().min(1).max(120) }) }),
);
apoioDoProjeto.use(
  '/categorias',
  crudRouter({ table: 'categoria', scope: (req) => ({ projetoId: req.projeto!.id }), write: [requirePapel(...EDITA)], orderBy: [{ column: 'nome' }], label: 'Categoria', createSchema: z.object({ nome: z.string().trim().min(1).max(120) }) }),
);

// RF45: comentários em itens do protocolo, documentos e respostas
const ENTIDADES = ['protocolo', 'questao_analise', 'criterio', 'documento', 'revisao', 'resposta', 'analise', 'matriz_sintese_item', 'discussao_item'] as const;

apoioDoProjeto.get('/comentarios', validate({ query: z.object({ entidade: z.enum(ENTIDADES).optional(), entidadeId: z.guid().optional() }) }), async (req, res) => {
  const q = db('comentario as c').join('usuario as u', 'u.id', 'c.autorId').where('c.projetoId', req.projeto!.id).select('c.*', 'u.nome as autorNome').orderBy('c.criadoEm');
  if (req.validated.query.entidade) q.where('c.entidade', req.validated.query.entidade);
  if (req.validated.query.entidadeId) q.where('c.entidadeId', req.validated.query.entidadeId);
  res.json(await q);
});

apoioDoProjeto.post(
  '/comentarios',
  validate({ body: z.object({ entidade: z.enum(ENTIDADES), entidadeId: z.guid(), texto: z.string().trim().min(1).max(10_000), paiId: z.guid().nullable().optional() }) }),
  async (req, res) => {
    if (req.papel === 'LEITOR') throw AppError.forbidden('Leitores não comentam');
    const d = req.validated.body;
    if (d.paiId && !(await db('comentario').where({ id: d.paiId, projetoId: req.projeto!.id }).first('id'))) throw AppError.notFound('Comentário');
    const id = uuid();
    await db.transaction(async (trx) => {
      await trx('comentario').insert({ ...d, id, projetoId: req.projeto!.id, autorId: req.user!.id });
      const membros = (await membrosDoProjeto(req.projeto!.id, undefined, trx)).filter((m) => m !== req.user!.id);
      await notificar(membros, 'COMENTARIO', `Novo comentário em ${d.entidade.replace(/_/g, ' ')}`, { projetoId: req.projeto!.id, comentarioId: id, entidade: d.entidade, entidadeId: d.entidadeId }, trx);
    });
    res.status(201).json(await db('comentario').where({ id }).first());
  },
);

apoioDoProjeto.patch('/comentarios/:comentarioId', validate({ body: z.object({ texto: z.string().trim().min(1).max(10_000).optional(), resolvido: z.boolean().optional() }) }), async (req, res) => {
  const c = await db('comentario').where({ id: String(req.params.comentarioId), projetoId: req.projeto!.id }).first();
  if (!c) throw AppError.notFound('Comentário');
  if (req.validated.body.texto && c.autorId !== req.user!.id) throw AppError.forbidden('Só o autor edita o comentário');
  await db('comentario').where({ id: c.id }).update(req.validated.body);
  res.json(await db('comentario').where({ id: c.id }).first());
});

apoioDoProjeto.delete('/comentarios/:comentarioId', async (req, res) => {
  const c = await db('comentario').where({ id: String(req.params.comentarioId), projetoId: req.projeto!.id }).first();
  if (!c) throw AppError.notFound('Comentário');
  if (c.autorId !== req.user!.id && req.papel !== 'RESPONSAVEL' && req.papel !== 'ADMIN') throw AppError.forbidden();
  await db('comentario').where({ id: c.id }).del();
  res.status(204).end();
});

// RF46: busca global no projeto (documentos, respostas e citações) com FULLTEXT
apoioDoProjeto.get('/busca', validate({ query: z.object({ q: z.string().trim().min(2).max(200) }) }), async (req, res) => {
  const termos = req.validated.query.q
    .split(/\s+/)
    .map((w: string) => w.replace(/[+\-<>()~*"@]/g, ''))
    .filter(Boolean)
    .map((w: string) => `${w}*`)
    .join(' ');
  const projetoId = req.projeto!.id;
  const [documentos, respostas, citacoes] = await Promise.all([
    db('documento')
      .where({ projetoId })
      .whereRaw('MATCH(titulo, resumo, palavras_chave) AGAINST (? IN BOOLEAN MODE)', [termos])
      .select('id', 'titulo', 'autores', 'ano')
      .limit(30),
    db('resposta as r')
      .join('analiseDocumento as ad', 'ad.id', 'r.analiseDocumentoId')
      .join('analise as a', 'a.id', 'ad.analiseId')
      .join('questaoAnalise as q', 'q.id', 'r.questaoAnaliseId')
      .where('a.projetoId', projetoId)
      .whereRaw('MATCH(r.texto) AGAINST (? IN BOOLEAN MODE)', [termos])
      .select('r.id', 'r.texto', 'q.codigo', 'a.id as analiseId', 'a.nome as analiseNome', 'ad.documentoId')
      .limit(30),
    db('matrizSinteseItem as m')
      .join('analiseDocumento as ad', 'ad.id', 'm.analiseDocumentoId')
      .join('analise as a', 'a.id', 'ad.analiseId')
      .where('a.projetoId', projetoId)
      .whereRaw('MATCH(m.citacao, m.texto_original, m.texto_parafraseado) AGAINST (? IN BOOLEAN MODE)', [termos])
      .select('m.id', 'm.citacao', 'm.textoParafraseado', 'a.id as analiseId', 'ad.documentoId')
      .limit(30),
  ]);
  res.json({ documentos, respostas, citacoes });
});

// RF42: exportação do projeto no layout da planilha modelo (gerada no worker)
apoioDoProjeto.post('/exportar', validate({ body: z.object({ formato: z.enum(['xlsx']).optional() }) }), async (req, res) => {
  const tarefaId = await enfileirar('exportar-projeto', { projetoId: req.projeto!.id, usuarioId: req.user!.id });
  res.status(202).json({ tarefaId, acompanhar: `/api/v1/tarefas/${tarefaId}` });
});

// ------------------------------------------------ rotas do usuário (fora do projeto)
export const apoio = Router();

apoio.get('/notificacoes', validate({ query: z.object({ naoLidas: z.coerce.boolean().optional() }) }), async (req, res) => {
  const q = db('notificacao').where({ usuarioId: req.user!.id }).orderBy('criadoEm', 'desc').limit(100);
  if (req.validated.query.naoLidas) q.whereNull('lidaEm');
  res.json(await q);
});

apoio.post('/notificacoes/lidas', validate({ body: z.object({ ids: z.array(z.guid()).optional() }) }), async (req, res) => {
  const q = db('notificacao').where({ usuarioId: req.user!.id }).whereNull('lidaEm');
  if (req.validated.body.ids) q.whereIn('id', req.validated.body.ids);
  res.json({ marcadas: await q.update({ lidaEm: new Date() }) });
});

// Acompanha tarefas da fila (PDF, importação, exportação)
apoio.get('/tarefas/:id', validate({ params: z.object({ id: z.coerce.number().int().positive() }) }), async (req, res) => {
  const t = await db('filaTarefa').where({ id: req.validated.params.id }).first();
  if (!t || (t.payload?.usuarioId !== req.user!.id && req.user!.perfil !== 'ADMIN')) throw AppError.notFound('Tarefa');
  const arquivoId = t.payload?.resultado?.arquivoId;
  res.json({
    id: t.id,
    fila: t.fila,
    status: t.status,
    tentativas: t.tentativas,
    erro: t.status === 'ERRO' ? 'A tarefa falhou. Tente de novo ou fale com o suporte.' : undefined,
    resultado: t.status === 'CONCLUIDA' ? { ...t.payload?.resultado, ...(arquivoId ? await urlDoArquivo(arquivoId) : {}) } : undefined,
  });
});

// Download do storage local (URL assinada de 15 min, só no driver local) — rota pública em routes.ts
export async function downloadLocal(token: string) {
  if (env.STORAGE_DRIVER !== 'local') throw AppError.notFound('Arquivo');
  let p: { k: string; n?: string };
  try {
    p = LocalStorageProvider.lerToken(token);
  } catch {
    throw new AppError('Link expirado', 410, undefined, 'LINK_EXPIRADO');
  }
  const a = await db('arquivo').where({ chaveStorage: p.k }).first('mimeType', 'nomeOriginal');
  return { dados: await storage().get(p.k), mimeType: a?.mimeType ?? 'application/octet-stream', nome: p.n ?? a?.nomeOriginal ?? 'arquivo' };
}

// ERS 9.4: sincronização do mobile. Cada operação é reaplicada na própria API com a
// Idempotency-Key, então repetir o envio não duplica nada.
const PREFIXOS_SYNC = ['/projetos/', '/revisoes/', '/etapas/', '/documentos/', '/analises/', '/analise-documentos/'];
apoio.post(
  '/sync',
  validate({
    body: z.object({
      operacoes: z
        .array(
          z.object({
            idempotencyKey: z.string().min(8).max(100),
            metodo: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
            rota: z.string().startsWith('/').max(300),
            corpo: z.unknown().optional(),
            atualizadoEm: z.iso.datetime().optional(),
          }),
        )
        .min(1)
        .max(200),
    }),
  }),
  async (req, res) => {
    const resultados: any[] = [];
    for (const op of req.validated.body.operacoes) {
      if (!PREFIXOS_SYNC.some((p) => op.rota.startsWith(p)) || op.rota.includes('..')) {
        resultados.push({ idempotencyKey: op.idempotencyKey, status: 400, corpo: { erro: { codigo: 'ROTA_NAO_SINCRONIZAVEL', mensagem: op.rota } } });
        continue;
      }
      const r = await fetch(`http://127.0.0.1:${env.PORT}/api/v1${op.rota}`, {
        method: op.metodo,
        headers: {
          'content-type': 'application/json',
          authorization: req.get('authorization') ?? '',
          'idempotency-key': op.idempotencyKey,
          'x-sync-atualizado-em': op.atualizadoEm ?? '',
        },
        body: op.corpo === undefined ? undefined : JSON.stringify(op.corpo),
      });
      const texto = await r.text();
      resultados.push({ idempotencyKey: op.idempotencyKey, status: r.status, corpo: texto ? JSON.parse(texto) : null });
    }
    res.json({ resultados });
  },
);

