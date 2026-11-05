import nodemailer from 'nodemailer';
import { env } from '#config/env.ts';
import { logger } from '#utils/logger.ts';

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: env.SMTP_SECURE === 'true',
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null;

// Sem SMTP configurado (desenvolvimento), o e-mail só aparece no log
export async function enviarEmail(para: string, assunto: string, texto: string) {
  if (!transport) {
    logger.info({ para, assunto, texto }, 'e-mail (SMTP não configurado)');
    return;
  }
  try {
    await transport.sendMail({ from: env.MAIL_FROM, to: para, subject: assunto, text: texto });
  } catch (err) {
    logger.error({ err, para, assunto }, 'Falha ao enviar e-mail');
  }
}
