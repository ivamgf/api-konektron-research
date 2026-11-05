// Conversão automática snake_case (banco) <-> camelCase (código/API)
export const toCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
export const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !Buffer.isBuffer(v);

// Raso de propósito: o conteúdo das colunas JSON não é alterado
export const camelizeKeys = (row: unknown) =>
  isPlainObject(row) ? Object.fromEntries(Object.entries(row).map(([k, v]) => [toCamel(k), v])) : row;

export function postProcessResponse(result: any): any {
  if (Array.isArray(result)) {
    // db.raw no mysql2 devolve [linhas, campos]
    if (Array.isArray(result[0]) && Array.isArray(result[1])) return [result[0].map(camelizeKeys), result[1]];
    return result.map(camelizeKeys);
  }
  return camelizeKeys(result);
}

export const wrapIdentifier = (value: string, origImpl: (v: string) => string) =>
  origImpl(value === '*' ? value : toSnake(value));
