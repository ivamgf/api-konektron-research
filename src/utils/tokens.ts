import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '#config/env.ts';

export type PerfilGlobal = 'ADMIN' | 'USUARIO';

export const signAccessToken = (u: { id: string; perfilGlobal: PerfilGlobal }) =>
  jwt.sign({ sub: u.id, perfil: u.perfilGlobal }, env.JWT_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES as jwt.SignOptions['expiresIn'],
  });

export const verifyAccessToken = (token: string) =>
  jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload & { sub: string; perfil: PerfilGlobal };

// Tokens de e-mail (confirmação e redefinição de senha), sem tabela própria.
// O "selo" amarra o token ao estado do usuário: trocar a senha invalida tokens antigos.
export const seal = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);

export const signEmailToken = (sub: string, finalidade: 'confirmar' | 'redefinir', selo: string, expiresIn = '2h') =>
  jwt.sign({ sub, fin: finalidade, selo }, env.emailSecret, {
    expiresIn: expiresIn as jwt.SignOptions['expiresIn'],
  });

export const verifyEmailToken = (token: string, finalidade: 'confirmar' | 'redefinir') => {
  const p = jwt.verify(token, env.emailSecret) as jwt.JwtPayload & { sub: string; fin: string; selo: string };
  if (p.fin !== finalidade) throw new Error('finalidade inválida');
  return p;
};

// Tokens opacos (refresh, convite): só o hash vai para o banco
export const generateOpaqueToken = () => crypto.randomBytes(48).toString('base64url');
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
export const uuid = () => crypto.randomUUID();
