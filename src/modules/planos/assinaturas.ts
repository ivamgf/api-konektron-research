import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '#config/env.ts';
import { db, json } from '#database/connection.ts';
import { validate } from '#middlewares/validate.ts';
import { AppError } from '#utils/AppError.ts';
import { logger } from '#utils/logger.ts';
import { uuid } from '#utils/tokens.ts';
import { enfileirar } from '#services/fila.ts';
import { enviarEmail } from '#services/mailer.ts';
import { notificar } from '#services/notificacoes.ts';
import {
  asaas,
  asaasLigado,
  cpfCnpjValido,
  erroParaApp,
  hojeAsaas,
  type PagamentoAsaas,
} from '#services/asaas.ts';
import {
  CICLOS,
  mudarPlano,
  PRECOS,
  somarMeses,
  valorDoPlano,
  type Ciclo,
  type PlanoPago,
} from './planos.service.ts';

/**
 * Assinaturas dos planos Standard e Master pelo Asaas.
 *
 * 1. POST /planos/assinar cria (ou reaproveita) o cliente no Asaas e a assinatura com forma de pagamento livre
 *    (Pix, boleto ou cartão, à escolha do cliente na fatura) e devolve o link da fatura.
 * 2. O Asaas avisa o pagamento no webhook (POST /webhooks/asaas). O evento é gravado (idempotência pelo id)
 *    e processado no worker: pagamento confirmado libera o plano até o fim do período pago.
 * 3. Atraso além da tolerância (ASAAS_TOLERANCIA_DIAS) ou assinatura cancelada com o período vencido voltam
 *    a conta para o Free (tarefa periódica do worker). Contas "vitalício" nunca são rebaixadas.
 */

const NOME: Record<PlanoPago, string> = { STANDARD: 'Standard', MASTER: 'Master' };
const CICLO_ASAAS: Record<Ciclo, 'MONTHLY' | 'YEARLY'> = { MENSAL: 'MONTHLY', ANUAL: 'YEARLY' };
const STATUS_ABERTOS = ['PENDENTE', 'ATIVA', 'ATRASADA'];
const PAGO = ['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'];

const descricao = (plano: PlanoPago, ciclo: Ciclo) =>
  `Konektron Research: plano ${NOME[plano]} (${ciclo === 'MENSAL' ? 'mensal' : 'anual'})`;

/** Fim do período pago por uma cobrança que vence em `vencimento` */
export const fimDoPeriodo = (vencimento: string, ciclo: Ciclo) =>
  somarMeses(new Date(`${vencimento}T23:59:59-03:00`), ciclo === 'MENSAL' ? 1 : 12);

const assinaturaAberta = (usuarioId: string) =>
  db('assinatura')
    .where({ usuarioId })
    .whereIn('status', STATUS_ABERTOS)
    .orderBy('criadoEm', 'desc')
    .first();

/** Espelha a cobrança do Asaas na tabela pagamento */
async function salvarPagamento(p: PagamentoAsaas, assinaturaId: string | null) {
  const pagoEm = p.clientPaymentDate ?? p.paymentDate ?? p.confirmedDate ?? null;
  const dados = {
    assinaturaId,
    valor: p.value,
    status: p.status,
    forma: p.billingType ?? null,
    vencimento: p.dueDate,
    pagoEm: pagoEm ? new Date(`${pagoEm}T12:00:00-03:00`) : null,
    linkFatura: p.invoiceUrl ?? null,
  };
  const atual = await db('pagamento').where({ asaasPagamentoId: p.id }).first('id');
  if (atual) await db('pagamento').where({ id: atual.id }).update(dados);
  else await db('pagamento').insert({ id: uuid(), asaasPagamentoId: p.id, ...dados });
}

async function sincronizarPagamentos(assinatura: { id: string; asaasAssinaturaId: string }) {
  for (const p of await asaas.pagamentosDaAssinatura(assinatura.asaasAssinaturaId)) {
    await salvarPagamento(p, assinatura.id);
  }
}

const faturaEmAberto = (assinaturaId: string) =>
  db('pagamento')
    .where({ assinaturaId })
    .whereIn('status', ['PENDING', 'OVERDUE', 'AWAITING_RISK_ANALYSIS'])
    .orderBy('vencimento')
    .first('linkFatura', 'vencimento', 'valor');

/** Volta a conta para o Free (fim do período pago ou atraso além da tolerância) */
async function rebaixar(usuarioId: string, motivo: string) {
  const u = await db('usuario')
    .where({ id: usuarioId })
    .first('id', 'nome', 'email', 'plano', 'planoVitalicio');
  if (!u || u.planoVitalicio || u.plano === 'FREE') return false;
  const outraAtiva = await db('assinatura')
    .where({ usuarioId, status: 'ATIVA' })
    .where('pagoAte', '>', new Date())
    .first('id');
  if (outraAtiva) return false;
  await mudarPlano(usuarioId, { plano: 'FREE' });
  await notificar([usuarioId], 'PLANO_REBAIXADO', `Sua conta voltou ao plano Free: ${motivo}`);
  await enviarEmail(
    u.email,
    'Konektron Research: sua conta voltou ao plano Free',
    `Olá, ${u.nome}.\n\nSua conta voltou ao plano Free (${motivo}). Para voltar ao seu plano, acesse ${env.APP_URL}/planos`,
  );
  logger.info({ usuarioId, motivo }, 'assinatura: conta rebaixada para o Free');
  return true;
}

// ------------------------------------------------ rotas do usuário (/planos)

export const planosRoutes = Router();

// Assinatura atual, faturas e preços (com o desconto estudantil, se houver)
/** Admin e contas vitalícias nunca são cobradas */
export const isentoDeCobranca = (
  u: { perfilGlobal?: string; planoVitalicio?: boolean } | undefined,
) => !!u && (u.perfilGlobal === 'ADMIN' || !!u.planoVitalicio);

planosRoutes.get('/assinatura', async (req, res) => {
  const u = await db('usuario')
    .where({ id: req.user!.id })
    .first('cpfCnpj', 'descontoEstudante', 'perfilGlobal', 'planoVitalicio');
  const assinatura =
    (await assinaturaAberta(req.user!.id)) ??
    (await db('assinatura').where({ usuarioId: req.user!.id }).orderBy('criadoEm', 'desc').first());
  const pagamentos = assinatura
    ? await db('pagamento')
        .where({ assinaturaId: assinatura.id })
        .orderBy('vencimento', 'desc')
        .limit(12)
        .select('id', 'valor', 'status', 'forma', 'vencimento', 'pagoEm', 'linkFatura')
    : [];
  const precos = Object.fromEntries(
    (Object.keys(PRECOS) as PlanoPago[]).map((p) => [
      p,
      Object.fromEntries(CICLOS.map((c) => [c, valorDoPlano(p, c, !!u?.descontoEstudante)])),
    ]),
  );
  res.json({
    cobrancaAtiva: asaasLigado(),
    isento: isentoDeCobranca(u),
    sandbox: env.ASAAS_API_URL.includes('sandbox'),
    cpfCnpj: u?.cpfCnpj ?? null,
    descontoEstudante: !!u?.descontoEstudante,
    precos,
    assinatura: assinatura ? { ...assinatura, valor: Number(assinatura.valor) } : null,
    pagamentos: pagamentos.map((p: any) => ({ ...p, valor: Number(p.valor) })),
  });
});

// Assina (ou troca de plano/ciclo) e devolve o link da fatura no Asaas
planosRoutes.post(
  '/assinar',
  validate({
    body: z.object({
      plano: z.enum(['STANDARD', 'MASTER']),
      ciclo: z.enum(CICLOS),
      cpfCnpj: z.string().trim().max(20),
    }),
  }),
  async (req, res) => {
    const { plano, ciclo } = req.validated.body as { plano: PlanoPago; ciclo: Ciclo };
    const cpfCnpj = req.validated.body.cpfCnpj.replace(/\D/g, '');
    if (!cpfCnpjValido(cpfCnpj))
      throw AppError.unprocessable('CPF ou CNPJ inválido', undefined, 'CPF_CNPJ_INVALIDO');
    if (!asaasLigado())
      throw new AppError(
        'A cobrança on-line ainda não está ativa.',
        503,
        undefined,
        'ASAAS_DESLIGADO',
      );
    const u = await db('usuario').where({ id: req.user!.id }).first();
    if (isentoDeCobranca(u))
      throw new AppError(
        'Sua conta já tem o plano Master sem cobrança e não pode ser assinada.',
        409,
        undefined,
        'PLANO_ISENTO',
      );
    const valor = valorDoPlano(plano, ciclo, !!u.descontoEstudante);

    try {
      let clienteId: string = u.asaasClienteId;
      if (!clienteId) {
        const c = await asaas.criarCliente({
          name: u.nome,
          email: u.email,
          cpfCnpj,
          externalReference: u.id,
        });
        clienteId = c.id;
      } else if (u.cpfCnpj !== cpfCnpj) {
        await asaas.atualizarCliente(clienteId, { cpfCnpj });
      }
      await db('usuario').where({ id: u.id }).update({ asaasClienteId: clienteId, cpfCnpj });

      let atual = await assinaturaAberta(u.id);
      if (atual?.asaasAssinaturaId) {
        if (atual.plano !== plano || atual.ciclo !== ciclo || Number(atual.valor) !== valor) {
          // troca de plano ou ciclo: o novo valor vale para as próximas cobranças e o plano muda já
          // se a assinatura estiver em dia
          await asaas.atualizarAssinatura(atual.asaasAssinaturaId, {
            value: valor,
            cycle: CICLO_ASAAS[ciclo],
            description: descricao(plano, ciclo),
          });
          await db('assinatura').where({ id: atual.id }).update({ plano, ciclo, valor });
          if (atual.status === 'ATIVA') await mudarPlano(u.id, { plano });
        }
      } else {
        const id = uuid();
        await db('assinatura').insert({
          id,
          usuarioId: u.id,
          plano,
          ciclo,
          valor,
          status: 'PENDENTE',
        });
        try {
          const a = await asaas.criarAssinatura({
            customer: clienteId,
            value: valor,
            nextDueDate: hojeAsaas(),
            cycle: CICLO_ASAAS[ciclo],
            description: descricao(plano, ciclo),
            externalReference: id,
          });
          await db('assinatura').where({ id }).update({ asaasAssinaturaId: a.id });
        } catch (err) {
          await db('assinatura').where({ id }).del();
          throw err;
        }
      }
      atual = await db('assinatura')
        .where({ usuarioId: u.id })
        .whereIn('status', STATUS_ABERTOS)
        .orderBy('criadoEm', 'desc')
        .first();
      await sincronizarPagamentos(atual);
      const fatura = await faturaEmAberto(atual.id);
      res.status(201).json({
        assinatura: { ...atual, valor: Number(atual.valor) },
        linkFatura: fatura?.linkFatura ?? null,
      });
    } catch (err) {
      erroParaApp(err);
    }
  },
);

// Cancela a renovação: o plano continua até o fim do período já pago
planosRoutes.post('/cancelar', async (req, res) => {
  const atual = await assinaturaAberta(req.user!.id);
  if (!atual) throw AppError.notFound('Assinatura');
  if (atual.asaasAssinaturaId) {
    try {
      await asaas.cancelarAssinatura(atual.asaasAssinaturaId);
    } catch (err) {
      erroParaApp(err);
    }
  }
  await db('assinatura')
    .where({ id: atual.id })
    .update({ status: 'CANCELADA', canceladaEm: new Date() });
  res.json(await db('assinatura').where({ id: atual.id }).first());
});

// ------------------------------------------------ webhook (público, autenticado pelo token do Asaas)

export const webhookRoutes = Router();

const tokenConfere = (recebido: string | undefined) => {
  const esperado = env.ASAAS_WEBHOOK_TOKEN;
  if (!esperado || !recebido) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

webhookRoutes.post('/asaas', async (req, res) => {
  if (!tokenConfere(req.get('asaas-access-token'))) {
    throw new AppError('Token do webhook inválido', 401, undefined, 'WEBHOOK_TOKEN');
  }
  const { id, event } = (req.body ?? {}) as { id?: string; event?: string };
  if (!id || !event) throw AppError.unprocessable('Evento sem id ou tipo');
  // entrega "pelo menos uma vez": o mesmo id não é processado duas vezes
  const ja = await db('webhookEvento')
    .where({ id: String(id).slice(0, 60) })
    .first('id');
  if (!ja) {
    try {
      await db('webhookEvento').insert({
        id: String(id).slice(0, 60),
        tipo: String(event).slice(0, 60),
        payload: json(req.body),
      });
      await enfileirar('asaas-evento', { eventoId: id });
    } catch (err: any) {
      if (err?.code !== 'ER_DUP_ENTRY') throw err; // corrida entre duas entregas do mesmo evento
    }
  }
  res.json({ recebido: true }); // responde logo; o processamento roda no worker
});

// ------------------------------------------------ worker

/** Processa um evento gravado pelo webhook (fila asaas-evento) */
export async function processarEvento(eventoId: string, agora = new Date()) {
  const ev = await db('webhookEvento').where({ id: eventoId }).first();
  if (!ev || ev.processadoEm) return { ignorado: true };
  const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
  try {
    await aplicarEvento(ev.tipo, payload, agora);
    await db('webhookEvento')
      .where({ id: eventoId })
      .update({ processadoEm: new Date(), erro: null });
  } catch (err: any) {
    await db('webhookEvento')
      .where({ id: eventoId })
      .update({ erro: String(err?.message ?? err).slice(0, 500) });
    throw err; // a fila tenta de novo
  }
  return { tipo: ev.tipo };
}

async function aplicarEvento(tipo: string, payload: any, agora: Date) {
  if (tipo.startsWith('SUBSCRIPTION_')) {
    const s = payload.subscription;
    if (s?.id && (tipo === 'SUBSCRIPTION_DELETED' || tipo === 'SUBSCRIPTION_INACTIVATED')) {
      await db('assinatura')
        .where({ asaasAssinaturaId: s.id })
        .whereNot({ status: 'CANCELADA' })
        .update({ status: 'CANCELADA', canceladaEm: agora });
    }
    return;
  }
  const p = payload.payment as PagamentoAsaas | undefined;
  if (!p?.id) return;
  const assin = p.subscription
    ? await db('assinatura').where({ asaasAssinaturaId: p.subscription }).first()
    : null;
  await salvarPagamento(p, assin?.id ?? null);
  if (!assin) return;

  if (tipo === 'PAYMENT_CONFIRMED' || tipo === 'PAYMENT_RECEIVED' || PAGO.includes(p.status)) {
    const fim = fimDoPeriodo(p.dueDate, assin.ciclo);
    const pagoAte = assin.pagoAte && new Date(assin.pagoAte) > fim ? new Date(assin.pagoAte) : fim;
    await db('assinatura')
      .where({ id: assin.id })
      .update({ pagoAte, ...(assin.status === 'CANCELADA' ? {} : { status: 'ATIVA' }) });
    if (pagoAte > agora) {
      const antes = await db('usuario').where({ id: assin.usuarioId }).first('plano');
      await mudarPlano(assin.usuarioId, { plano: assin.plano });
      if (antes?.plano !== assin.plano) {
        await notificar(
          [assin.usuarioId],
          'PLANO_ATIVADO',
          `Pagamento confirmado: plano ${NOME[assin.plano as PlanoPago]} ativo`,
        );
      }
    }
    return;
  }
  if (tipo === 'PAYMENT_OVERDUE' && assin.status === 'ATIVA') {
    await db('assinatura').where({ id: assin.id }).update({ status: 'ATRASADA' });
    await notificar(
      [assin.usuarioId],
      'PAGAMENTO_ATRASADO',
      'A fatura do seu plano venceu: pague para não perder o acesso',
    );
    return;
  }
  if (tipo === 'PAYMENT_REFUNDED' || tipo === 'PAYMENT_CHARGEBACK_REQUESTED') {
    await db('assinatura')
      .where({ id: assin.id })
      .update({ pagoAte: agora, status: assin.status === 'CANCELADA' ? 'CANCELADA' : 'ATRASADA' });
    await rebaixar(assin.usuarioId, 'pagamento estornado');
  }
}

/**
 * Tarefa periódica: atraso além da tolerância (inclusive se o aviso do Asaas se perder) e assinatura
 * cancelada com o período pago vencido voltam a conta para o Free.
 */
export async function verificarAssinaturas(agora = new Date()) {
  const tolerancia = new Date(agora.getTime() - env.ASAAS_TOLERANCIA_DIAS * 86_400_000);
  let rebaixadas = 0;
  const vencidas = await db('assinatura')
    .whereIn('status', ['ATIVA', 'ATRASADA'])
    .whereNotNull('pagoAte')
    .where('pagoAte', '<', tolerancia);
  for (const a of vencidas) {
    if (a.status === 'ATIVA')
      await db('assinatura').where({ id: a.id }).update({ status: 'ATRASADA' });
    if (
      await rebaixar(a.usuarioId, `fatura em atraso há mais de ${env.ASAAS_TOLERANCIA_DIAS} dias`)
    )
      rebaixadas++;
  }
  const canceladas = await db('assinatura')
    .where({ status: 'CANCELADA' })
    .whereNotNull('pagoAte')
    .where('pagoAte', '<', agora)
    .where('canceladaEm', '>', new Date(agora.getTime() - 60 * 86_400_000));
  for (const a of canceladas) {
    if (await rebaixar(a.usuarioId, 'assinatura cancelada e período pago encerrado')) rebaixadas++;
  }
  return { rebaixadas };
}
