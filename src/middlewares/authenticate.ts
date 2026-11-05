import type { NextFunction, Request, Response } from 'express';
import { AppError } from '#utils/AppError.ts';
import { verifyAccessToken } from '#utils/tokens.ts';
import { db } from '#database/connection.ts';

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) return next(new AppError('Token não informado', 401, undefined, 'NAO_AUTENTICADO'));
  try {
    const p = verifyAccessToken(token);
    req.user = { id: p.sub, perfil: p.perfil };
    next();
  } catch {
    next(new AppError('Token inválido ou expirado', 401, undefined, 'TOKEN_INVALIDO'));
  }
}

// Área administrativa: confere no banco, para que bloqueio ou rebaixamento valham na hora
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.perfil !== 'ADMIN') return next(AppError.forbidden());
  const u = await db('usuario').where({ id: req.user.id, ativo: true, perfilGlobal: 'ADMIN' }).first('id');
  return u ? next() : next(AppError.forbidden());
}
