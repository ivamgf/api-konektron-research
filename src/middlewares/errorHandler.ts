import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '#utils/AppError.ts';

// Erros do MySQL traduzidos para HTTP (ERS 10.3)
const MYSQL_ERRORS: Record<string, [number, string, string]> = {
  ER_DUP_ENTRY: [409, 'Registro já existe', 'DUPLICADO'],
  ER_NO_REFERENCED_ROW_2: [409, 'Registro relacionado não existe', 'REFERENCIA_INVALIDA'],
  ER_ROW_IS_REFERENCED_2: [409, 'Registro está em uso e não pode ser excluído', 'EM_USO'],
  ER_DATA_TOO_LONG: [422, 'Texto maior que o permitido', 'DADOS_INVALIDOS'],
  ER_TRUNCATED_WRONG_VALUE: [422, 'Formato de dado inválido', 'DADOS_INVALIDOS'],
  WARN_DATA_TRUNCATED: [422, 'Valor fora da lista permitida', 'DADOS_INVALIDOS'],
  ER_NO_SUCH_TABLE: [503, 'Banco de dados desatualizado: rode "npm run migrate"', 'BANCO_DESATUALIZADO'],
  ER_BAD_FIELD_ERROR: [503, 'Banco de dados desatualizado: rode "npm run migrate"', 'BANCO_DESATUALIZADO'],
  ECONNREFUSED: [503, 'Banco de dados indisponível', 'BANCO_INDISPONIVEL'],
  ETIMEDOUT: [503, 'Banco de dados indisponível', 'BANCO_INDISPONIVEL'],
  ER_HOST_NOT_PRIVILEGED: [503, 'IP não liberado no acesso remoto do cPanel', 'BANCO_INDISPONIVEL'],
  ER_ACCESS_DENIED_ERROR: [503, 'Acesso ao banco negado', 'BANCO_INDISPONIVEL'],
};

const corpo = (codigo: string, mensagem: string, campos?: unknown) => ({ erro: { codigo, mensagem, campos } });

export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(new AppError(`Rota não encontrada: ${req.method} ${req.originalUrl}`, 404, undefined, 'ROTA_INEXISTENTE'));
}

// Express identifica o handler de erro pelos 4 parâmetros: não remova `_next`
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(corpo(err.code ?? 'ERRO', err.message, err.details));
  }
  if (err instanceof z.ZodError) {
    return res.status(422).json(corpo('DADOS_INVALIDOS', 'Dados inválidos', z.flattenError(err).fieldErrors));
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json(corpo('JSON_INVALIDO', 'JSON inválido'));
  if (err?.type === 'entity.too.large') return res.status(413).json(corpo('MUITO_GRANDE', 'Conteúdo grande demais'));
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json(corpo('ARQUIVO_GRANDE', 'Arquivo maior que 50 MB'));
  // SIGNAL '45000' dos gatilhos opcionais (regras de negócio no banco)
  if (err?.sqlState === '45000') return res.status(422).json(corpo('REGRA_DE_NEGOCIO', err.sqlMessage));
  const m = MYSQL_ERRORS[err?.code];
  if (m) {
    if (m[0] >= 500) req.log?.error({ err }, m[1]);
    return res.status(m[0]).json(corpo(m[2], m[1]));
  }
  req.log?.error({ err }, 'Erro não tratado');
  res.status(500).json(corpo('ERRO_INTERNO', 'Erro interno do servidor', { requestId: req.id }));
}
