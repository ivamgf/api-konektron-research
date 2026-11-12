import { Router } from 'express';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { db } from '#database/connection.ts';
import { authenticate, requireAdmin } from '#middlewares/authenticate.ts';
import { idempotency } from '#middlewares/idempotency.ts';
import { projectAccess } from '#middlewares/projectAccess.ts';
import { validate } from '#middlewares/validate.ts';
import authRoutes from '#modules/auth/auth.routes.ts';
import meRoutes from '#modules/me/me.routes.ts';
import usuariosRoutes from '#modules/usuarios/usuarios.routes.ts';
import catalogosRoutes from '#modules/catalogos/catalogos.routes.ts';
import projetosRoutes from '#modules/projetos/projetos.routes.ts';
import protocoloRoutes from '#modules/protocolo/protocolo.routes.ts';
import referenciasRoutes from '#modules/referencias/referencias.routes.ts';
import tiposRevisaoRoutes from '#modules/tipos-revisao/tiposRevisao.routes.ts';
import { buscas, revisoes, revisoesDoProjeto } from '#modules/revisoes/revisoes.routes.ts';
import { documentos, documentosDoProjeto } from '#modules/documentos/documentos.routes.ts';
import triagemRoutes from '#modules/triagem/triagem.routes.ts';
import { analiseDocumentos, analises, analisesDoProjeto } from '#modules/analises/analises.routes.ts';
import { apoio, apoioDoProjeto, downloadLocal } from '#modules/apoio/apoio.routes.ts';
import artigoRoutes from '#modules/artigo/artigo.routes.ts';
import { cronogramaRoutes, relatorioRoutes } from '#modules/relatorio/relatorio.routes.ts';
import { contaLiberada, exigeRecurso } from '#modules/planos/planos.service.ts';
import { planosRoutes, webhookRoutes } from '#modules/planos/assinaturas.ts';
import { disposicao } from '#services/storage/disposicao.ts';

const router = Router();

router.get('/', (req, res) => {
  res.json({ nome: 'Konektron Research API', versao: pkg.version, saude: `${req.baseUrl}/health` });
});

// RNF14: health check com SELECT 1 no MySQL
router.get('/health', async (_req, res) => {
  const base = { versao: pkg.version, uptime: Math.round(process.uptime()), node: process.version };
  try {
    await db.raw('SELECT 1');
    res.json({ status: 'ok', db: 'up', ...base });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'down', ...base });
  }
});

// públicas
router.use('/auth', authRoutes);
router.get('/arquivos/download', validate({ query: z.object({ token: z.string().min(10), download: z.enum(['1', 'true']).optional() }) }), async (req, res) => {
  const a = await downloadLocal(req.validated.query.token);
  // ?download=1 força salvar o arquivo; sem ele, PDF abre no navegador
  res.setHeader('Content-Disposition', disposicao(a.nome, req.validated.query.download ? null : a.mimeType));
  // o CSP do helmet (object-src 'none') impede o leitor de PDF do navegador de exibir o arquivo
  if (a.mimeType === 'application/pdf') res.removeHeader('Content-Security-Policy');
  res.type(a.mimeType).send(a.dados);
});

// webhook do Asaas (autenticado pelo token no header asaas-access-token)
router.use('/webhooks', webhookRoutes);

// autenticadas
router.use(authenticate, contaLiberada, idempotency);
router.use('/me', meRoutes);
router.use('/planos', planosRoutes); // assinatura dos planos pelo Asaas
router.use('/admin/usuarios', requireAdmin, usuariosRoutes);
router.use('/', catalogosRoutes); // /bases-dados, /idiomas, /tipos-documento, /diretrizes, /checklists
router.use('/tipos-revisao', tiposRevisaoRoutes);

router.use('/projetos', projetosRoutes);
const doProjeto = Router({ mergeParams: true });
// recursos que dependem do plano do dono do projeto (Master)
doProjeto.use('/questoes', exigeRecurso('QUESTOES'));
doProjeto.use('/protocolo/tcle', exigeRecurso('TCLE'));
doProjeto.use(protocoloRoutes); // /protocolo, /questoes, /criterios, /strings, /palavras-chave, /descritores...
doProjeto.use('/revisoes', revisoesDoProjeto);
doProjeto.use('/documentos', documentosDoProjeto);
doProjeto.use('/referencias', referenciasRoutes); // referências do projeto em ABNT e APA
doProjeto.use('/analises', exigeRecurso('ANALISES'), analisesDoProjeto);
doProjeto.use('/artigo', exigeRecurso('ARTIGO'), artigoRoutes); // gerador de artigo (rascunho e Word)
doProjeto.use('/cronograma', cronogramaRoutes); // cronograma das etapas (mensal a anual)
doProjeto.use('/relatorio', relatorioRoutes); // relatório de pesquisa (prévia, PDF e Word)
doProjeto.use(apoioDoProjeto); // /temas, /categorias, /comentarios, /busca, /exportar
router.use('/projetos/:id', projectAccess('projeto'), doProjeto);

router.use('/revisoes', revisoes);
router.use('/buscas', buscas);
router.use('/documentos', documentos);
router.use('/etapas', triagemRoutes);
router.use('/analises', analises);
router.use('/analise-documentos', analiseDocumentos);
router.use(apoio); // /notificacoes, /tarefas/:id, /sync

export default router;
