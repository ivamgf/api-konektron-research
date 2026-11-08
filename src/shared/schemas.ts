import { z } from 'zod';

export const idParams = z.object({ id: z.guid() });
export const uuidSchema = z.guid();

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sort: z
    .string()
    .regex(/^-?[a-zA-Z]+$/)
    .optional(),
});

// Texto opcional e anulável (útil em PATCH)
export const optText = (max = 255) => z.string().trim().max(max).nullable().optional();
export const longText = (max = 65_000) => z.string().max(max).nullable().optional();
export const reqText = (max = 255) => z.string().trim().min(1).max(max);
export const dateStr = z.iso.date();

// Obs. Zod 4: sem .default() nos schemas de corpo, pois .partial() (PATCH)
// continuaria aplicando os defaults. Os valores padrão ficam no banco.

/** Converte "?sort=-criadoEm" em orderBy do Knex, só para colunas permitidas */
export function sortBy(sort: string | undefined, permitidas: string[], padrao: { column: string; order: 'asc' | 'desc' }) {
  if (!sort) return [padrao];
  const desc = sort.startsWith('-');
  const col = desc ? sort.slice(1) : sort;
  return permitidas.includes(col) ? [{ column: col, order: desc ? ('desc' as const) : ('asc' as const) }] : [padrao];
}

export async function paginar(q: any, page: number, pageSize: number) {
  const [{ total }] = await q.clone().clearSelect().clearOrder().count({ total: '*' });
  const itens = await q.offset((page - 1) * pageSize).limit(pageSize);
  return { itens, page, pageSize, total: Number(total) };
}
