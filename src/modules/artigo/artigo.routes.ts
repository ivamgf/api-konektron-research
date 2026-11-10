import { Router } from 'express';
import { z } from 'zod';
import { db } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { EDITA, requirePapel } from '#middlewares/projectAccess.ts';
import { auditar } from '#services/audit.ts';
import { htmlParaDocx, MIME_DOCX } from '#pdf/docx.ts';
import { fontesDoArtigo, htmlDoArtigo } from './artigo.service.ts';

// /projetos/:id/artigo — gerador de artigo a partir do projeto
const router = Router({ mergeParams: true });

const LIMITE_RASCUNHO = 2_000_000; // caracteres do JSON do rascunho

// Rascunho salvo (ou null) e os dados do projeto que alimentam cada seção
router.get('/', async (req, res) => {
  const [salvo, fontes] = await Promise.all([
    db('artigo').where({ projetoId: req.projeto!.id }).first(),
    fontesDoArtigo(req.projeto!.id),
  ]);
  const dados = salvo
    ? typeof salvo.dados === 'string'
      ? JSON.parse(salvo.dados)
      : salvo.dados
    : null;
  res.json({ dados, atualizadoEm: salvo?.atualizadoEm ?? null, fontes });
});

router.put(
  '/',
  requirePapel(...EDITA),
  validate({ body: z.object({ dados: z.record(z.string(), z.unknown()) }) }),
  async (req, res) => {
    const dados = JSON.stringify(req.validated.body.dados);
    if (dados.length > LIMITE_RASCUNHO)
      return res.status(413).json({ message: 'O rascunho do artigo passou do limite de tamanho' });
    const linha = { dados, atualizadoPor: req.user!.id, atualizadoEm: new Date() };
    const existe = await db('artigo').where({ projetoId: req.projeto!.id }).first('projetoId');
    if (existe) await db('artigo').where({ projetoId: req.projeto!.id }).update(linha);
    else await db('artigo').insert({ ...linha, projetoId: req.projeto!.id });
    res.json({ atualizadoEm: linha.atualizadoEm });
  },
);

const bloco = z.object({
  tipo: z.enum(['p', 'h3', 'lista', 'citacao', 'ref', 'nota', 'tabela']),
  texto: z.string().max(200_000).optional(),
  itens: z.array(z.string().max(20_000)).max(500).optional(),
  cabecalho: z.array(z.string().max(200)).max(12).optional(),
  linhas: z
    .array(z.array(z.string().max(5_000)).max(12))
    .max(2_000)
    .optional(),
  fonte: z.string().max(500).optional(),
  gerado: z.boolean().optional(),
});
const documento = z.object({
  titulo: z.string().trim().min(1).max(500),
  subtitulo: z.string().trim().max(500).nullable().optional(),
  autores: z
    .array(
      z.object({
        nome: z.string().trim().min(1).max(200),
        detalhes: z.array(z.string().max(500)).max(10),
      }),
    )
    .max(50),
  secoes: z
    .array(
      z.object({ titulo: z.string().trim().min(1).max(200), blocos: z.array(bloco).max(2000) }),
    )
    .max(40),
});

// Word (.docx) do artigo montado no app: Times New Roman 12, sem a marca no cabeçalho
router.post('/docx', validate({ body: documento }), async (req, res) => {
  const d = req.validated.body;
  const arquivo = await htmlParaDocx(htmlDoArtigo(d), d.titulo, {
    cabecalho: null,
    rodape: '<p style="font-size:9pt;text-align:right">Página </p>',
    fonte: 'Times New Roman',
    tamanho: 12,
  });
  auditar({
    req,
    entidade: 'artigo',
    entidadeId: req.projeto!.id,
    acao: 'IMPRIMIR',
    depois: { secoes: d.secoes.map((s: any) => s.titulo) },
  });
  const nome = `artigo-${
    d.titulo
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)
      .toLowerCase() || 'projeto'
  }.docx`;
  res.setHeader('Content-Type', MIME_DOCX);
  res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
  res.send(arquivo);
});

export default router;
