import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '#config/env.ts';
import { db } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { auditar } from '#services/audit.ts';
import * as s from './auth.service.ts';
import {
  emailSchema,
  loginSchema,
  redefinirSchema,
  refreshSchema,
  registrarSchema,
  tokenSchema,
} from './auth.schemas.ts';

const router = Router();

// RNF05: 100 requisições/min por IP no login
const limiteLogin = rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: 'draft-8', legacyHeaders: false });
const limiteEmail = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });

const COOKIE = 'kr_rt';
const cookieOpts = {
  httpOnly: true,
  secure: env.isProd || env.NODE_ENV === 'homologation',
  sameSite: 'strict' as const,
  path: '/api/v1/auth',
  maxAge: env.REFRESH_TOKEN_DAYS * 86_400_000,
};

// Web guarda o refresh token em cookie httpOnly; o mobile manda no corpo (SecureStore)
const lerCookie = (req: Request) =>
  (req.headers.cookie ?? '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === COOKIE)?.[1];

const responderTokens = (res: Response, t: Awaited<ReturnType<typeof s.login>>) => {
  res.cookie(COOKIE, t.refreshToken, cookieOpts);
  return res.json(t);
};

router.post('/registrar', limiteEmail, validate({ body: registrarSchema }), async (req, res) => {
  res.status(201).json(await s.registrar(req.validated.body));
});

router.post('/confirmar-email', validate({ body: tokenSchema }), async (req, res) => {
  await s.confirmarEmail(req.validated.body.token);
  res.status(204).end();
});

router.post('/reenviar-confirmacao', limiteEmail, validate({ body: emailSchema }), async (req, res) => {
  const u = await db('usuario').where({ email: req.validated.body.email }).first('id');
  if (u) await s.enviarConfirmacao(u.id);
  res.status(204).end();
});

router.post('/login', limiteLogin, validate({ body: loginSchema }), async (req, res) => {
  const { email, senha, dispositivo } = req.validated.body;
  const t = await s.login(email, senha, dispositivo ?? req.get('user-agent'));
  req.user = { id: t.usuario.id, perfil: t.usuario.perfilGlobal };
  auditar({ req, entidade: 'usuario', entidadeId: t.usuario.id, acao: 'LOGIN', projetoId: null });
  responderTokens(res, t);
});

router.post('/refresh', limiteLogin, validate({ body: refreshSchema }), async (req, res) => {
  const token = req.validated.body.refreshToken ?? lerCookie(req);
  if (!token) return res.status(401).json({ erro: { codigo: 'SESSAO_EXPIRADA', mensagem: 'Refresh token ausente' } });
  responderTokens(res, await s.renovar(token));
});

router.post('/logout', validate({ body: refreshSchema }), async (req, res) => {
  await s.sair(req.validated.body.refreshToken ?? lerCookie(req));
  res.clearCookie(COOKIE, { path: cookieOpts.path });
  res.status(204).end();
});

router.post('/esqueci-senha', limiteEmail, validate({ body: emailSchema }), async (req, res) => {
  await s.esqueciSenha(req.validated.body.email);
  res.status(202).json({ mensagem: 'Se o e-mail estiver cadastrado, enviaremos as instruções.' });
});

router.post('/redefinir-senha', limiteEmail, validate({ body: redefinirSchema }), async (req, res) => {
  await s.redefinirSenha(req.validated.body.token, req.validated.body.senha);
  res.status(204).end();
});

export default router;
