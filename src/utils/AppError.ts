export class AppError extends Error {
  statusCode: number;
  details?: unknown;
  code?: string;

  constructor(message: string, statusCode = 400, details?: unknown, code?: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
    this.code = code;
  }

  static notFound(what = 'Registro') {
    return new AppError(`${what} não encontrado`, 404, undefined, 'NAO_ENCONTRADO');
  }

  static forbidden(message = 'Acesso negado') {
    return new AppError(message, 403, undefined, 'ACESSO_NEGADO');
  }

  static conflict(message: string, details?: unknown) {
    return new AppError(message, 409, details, 'CONFLITO');
  }

  static unprocessable(message: string, details?: unknown, code = 'REGRA_DE_NEGOCIO') {
    return new AppError(message, 422, details, code);
  }
}
