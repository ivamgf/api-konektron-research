import bcrypt from 'bcryptjs';
import { env } from '#config/env.ts';
import { db, json } from '#database/connection.ts';
import { AppError } from '#utils/AppError.ts';
import {
  generateOpaqueToken,
  hashToken,
  seal,
  signAccessToken,
  signEmailToken,
  uuid,
  verifyEmailToken,
} from '#utils/tokens.ts';
import { enviarEmail } from '#services/mailer.ts';

export const BCRYPT_CUSTO = 12; // RNF04

export const usuarioPublico = (u: any) => {
  const { senhaHash: _s, ...resto } = u;
  return resto;
};

async function emitirTokens(u: any, dispositivo?: string) {
  const refreshToken = generateOpaqueToken();
  await db('refreshToken').insert({
    id: uuid(),
    usuarioId: u.id,
    tokenHash: hashToken(refreshToken),
    dispositivo: dispositivo?.slice(0, 120) ?? null,
    expiraEm: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 86_400_000),
  });
  return { accessToken: signAccessToken(u), refreshToken, usuario: usuarioPublico(u) };
}

export async function registrar(d: {
  nome: string;
  email: string;
  senha: string;
  instituicao?: string;
  orcid?: string;
}) {
  if (await db('usuario').where({ email: d.email }).first('id')) {
    throw AppError.conflict('Já existe uma conta com este e-mail');
  }
  const id = uuid();
  await db('usuario').insert({
    id,
    nome: d.nome,
    email: d.email,
    senhaHash: await bcrypt.hash(d.senha, BCRYPT_CUSTO),
    instituicao: d.instituicao ?? null,
    orcid: d.orcid ?? null,
    preferencias: json({ tema: 'claro', idiomaReferencias: 'NBR' }),
    consentimentoLgpdEm: new Date(),
  });
  await enviarConfirmacao(id);
  return usuarioPublico(await db('usuario').where({ id }).first());
}

export async function enviarConfirmacao(usuarioId: string) {
  const u = await db('usuario').where({ id: usuarioId }).first();
  if (!u || u.emailVerificadoEm) return;
  const token = signEmailToken(u.id, 'confirmar', seal(u.email), '2d');
  await enviarEmail(
    u.email,
    'Confirme seu e-mail — Konektron Research',
    `Olá, ${u.nome}.\n\nConfirme seu cadastro em: ${env.APP_URL}/confirmar-email?token=${token}\n\nO link vale por 2 dias.`,
  );
}

export async function confirmarEmail(token: string) {
  let p;
  try {
    p = verifyEmailToken(token, 'confirmar');
  } catch {
    throw AppError.unprocessable('Link de confirmação inválido ou expirado', undefined, 'TOKEN_INVALIDO');
  }
  const u = await db('usuario').where({ id: p.sub }).first();
  if (!u || seal(u.email) !== p.selo) throw AppError.unprocessable('Link de confirmação inválido', undefined, 'TOKEN_INVALIDO');
  if (!u.emailVerificadoEm) await db('usuario').where({ id: u.id }).update({ emailVerificadoEm: new Date() });
}

export async function login(email: string, senha: string, dispositivo?: string) {
  const u = await db('usuario').where({ email }).first();
  // compara mesmo sem usuário, para não revelar quais e-mails existem pelo tempo de resposta
  const ok = await bcrypt.compare(senha, u?.senhaHash ?? '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
  if (!u || !ok) throw new AppError('E-mail ou senha incorretos', 401, undefined, 'CREDENCIAIS_INVALIDAS');
  if (!u.ativo) throw new AppError('Conta bloqueada. Fale com o administrador.', 403, undefined, 'CONTA_BLOQUEADA');
  return emitirTokens(u, dispositivo);
}

// Refresh rotativo: o token usado é revogado e um novo é emitido (RNF04)
export async function renovar(refreshToken: string) {
  const row = await db('refreshToken').where({ tokenHash: hashToken(refreshToken) }).first();
  if (!row || row.revogadoEm || new Date(row.expiraEm) < new Date()) {
    // reuso de token revogado: possível roubo — revoga todas as sessões do usuário
    if (row?.revogadoEm) await db('refreshToken').where({ usuarioId: row.usuarioId }).whereNull('revogadoEm').update({ revogadoEm: new Date() });
    throw new AppError('Sessão expirada. Entre novamente.', 401, undefined, 'SESSAO_EXPIRADA');
  }
  const u = await db('usuario').where({ id: row.usuarioId, ativo: true }).first();
  if (!u) throw new AppError('Sessão expirada. Entre novamente.', 401, undefined, 'SESSAO_EXPIRADA');
  await db('refreshToken').where({ id: row.id }).update({ revogadoEm: new Date() });
  return emitirTokens(u, row.dispositivo);
}

export async function sair(refreshToken?: string) {
  if (refreshToken) await db('refreshToken').where({ tokenHash: hashToken(refreshToken) }).update({ revogadoEm: new Date() });
}

export async function esqueciSenha(email: string) {
  const u = await db('usuario').where({ email, ativo: true }).first();
  if (!u) return; // resposta igual para e-mail existente ou não
  const token = signEmailToken(u.id, 'redefinir', seal(u.senhaHash), '1h');
  await enviarEmail(
    u.email,
    'Redefinição de senha — Konektron Research',
    `Olá, ${u.nome}.\n\nPara criar uma nova senha, acesse: ${env.APP_URL}/redefinir-senha?token=${token}\n\nO link vale por 1 hora. Se não foi você, ignore este e-mail.`,
  );
}

export async function redefinirSenha(token: string, senha: string) {
  let p;
  try {
    p = verifyEmailToken(token, 'redefinir');
  } catch {
    throw AppError.unprocessable('Link inválido ou expirado', undefined, 'TOKEN_INVALIDO');
  }
  const u = await db('usuario').where({ id: p.sub }).first();
  // o selo muda quando a senha muda: o link só funciona uma vez
  if (!u || seal(u.senhaHash) !== p.selo) throw AppError.unprocessable('Link inválido ou já usado', undefined, 'TOKEN_INVALIDO');
  await db.transaction(async (trx) => {
    await trx('usuario').where({ id: u.id }).update({ senhaHash: await bcrypt.hash(senha, BCRYPT_CUSTO) });
    await trx('refreshToken').where({ usuarioId: u.id }).whereNull('revogadoEm').update({ revogadoEm: new Date() });
  });
}
