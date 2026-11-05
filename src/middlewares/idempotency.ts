import type { NextFunction, Request, Response } from 'express';
import { db, json } from '#database/connection.ts';

// Gravações com Idempotency-Key (mobile, ERS 9.4): a mesma chave devolve a mesma resposta
export async function idempotency(req: Request, res: Response, next: NextFunction) {
  const key = req.get('Idempotency-Key');
  if (!key || req.method === 'GET' || !req.user) return next();
  if (key.length > 100) return next();

  const prev = await db('syncOperacao').where({ idempotencyKey: key, usuarioId: req.user.id }).first();
  if (prev) return res.status(prev.statusHttp).json(prev.resposta);

  const send = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode < 500) {
      db('syncOperacao')
        .insert({
          idempotencyKey: key,
          usuarioId: req.user!.id,
          rota: `${req.method} ${req.originalUrl}`.slice(0, 200),
          statusHttp: res.statusCode,
          resposta: json(body ?? null),
        })
        .catch(() => {}); // chave repetida em corrida: a primeira vence
    }
    return send(body);
  };
  next();
}
