import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '#utils/AppError.ts';

export type Schemas = { params?: z.ZodType; query?: z.ZodType; body?: z.ZodType };

// Uso: validate({ body, params, query }). Resultado em req.validated.
// (Express 5 deixa req.query somente leitura, por isso não sobrescrevemos req.*)
// Os schemas ficam expostos no middleware para o gerador do OpenAPI (src/docs/openapi.ts).
export const validate = (schemas: Schemas) =>
  Object.assign(
    (req: Request, _res: Response, next: NextFunction) => {
      req.validated ??= {};
      for (const key of ['params', 'query', 'body'] as const) {
        const schema = schemas[key];
        if (!schema) continue;
        const result = schema.safeParse(req[key] ?? {});
        if (!result.success) {
          return next(
            new AppError(
              'Dados inválidos',
              422,
              z.flattenError(result.error).fieldErrors,
              'DADOS_INVALIDOS',
            ),
          );
        }
        req.validated[key] = result.data;
      }
      next();
    },
    { schemas },
  );
