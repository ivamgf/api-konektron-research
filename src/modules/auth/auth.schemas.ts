import { z } from 'zod';

const senha = z
  .string()
  .min(8, { error: 'mínimo de 8 caracteres' })
  .max(72)
  .regex(/[A-Za-z]/, { error: 'inclua letras' })
  .regex(/\d/, { error: 'inclua números' });

export const registrarSchema = z.object({
  nome: z.string().trim().min(2).max(150),
  email: z.email().max(255).transform((e) => e.toLowerCase()),
  senha,
  instituicao: z.string().trim().max(200).optional(),
  orcid: z
    .string()
    .regex(/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/, { error: 'formato 0000-0000-0000-000X' })
    .optional(),
  consentimentoLgpd: z.literal(true, { error: 'é preciso aceitar o termo de privacidade' }),
});

export const loginSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  senha: z.string().min(1).max(72),
  dispositivo: z.string().max(120).optional(),
});

export const refreshSchema = z.object({ refreshToken: z.string().min(20).optional() });
export const emailSchema = z.object({ email: z.email().transform((e) => e.toLowerCase()) });
export const tokenSchema = z.object({ token: z.string().min(20) });
export const redefinirSchema = z.object({ token: z.string().min(20), senha });
export const trocarSenhaSchema = z.object({ senhaAtual: z.string().min(1), novaSenha: senha });
export { senha as senhaSchema };
