import type { NextFunction, Request, Response } from 'express';
import { env } from '#config/env.ts';
import { db, type Trx } from '#database/connection.ts';
import { AppError } from '#utils/AppError.ts';
import { logger } from '#utils/logger.ts';
import { enviarEmail } from '#services/mailer.ts';
import { notificar } from '#services/notificacoes.ts';

/**
 * Planos de uso do Konektron Research.
 *
 * - FREE: até 3 projetos. Ao criar o 3º, começam a contar 3 meses; no fim deles os projetos do usuário vão
 *   para a lixeira (removidos de vez 30 dias depois) e a conta fica bloqueada até o upgrade.
 * - STANDARD: projetos ilimitados, com a aba Questões e sem os demais recursos avançados.
 * - Cronograma e relatório de pesquisa: liberados em todos os planos (não são recurso de plano).
 * - Limites por plano: membros por projeto (além do responsável) e espaço para arquivos enviados.
 * - MASTER: tudo liberado. Administradores são sempre MASTER.
 * - Vitalício (opção interna, só o administrador vê): o plano escolhido não expira nem é cobrado.
 *
 * Os recursos de um projeto seguem o plano de quem o criou: o membro convidado usa o que o projeto tem.
 */

export const PLANOS = ['FREE', 'STANDARD', 'MASTER'] as const;
export type Plano = (typeof PLANOS)[number];

export const RECURSOS = [
  'QUESTOES',
  'ANALISES',
  'ARTIGO',
  'TCLE',
  'SIMILARIDADE',
  'VERIFICACAO_TERMOS',
] as const;
export type Recurso = (typeof RECURSOS)[number];

type Regra = {
  limiteProjetos: number | null;
  /** membros por projeto além do responsável (convites pendentes contam) */
  limiteMembros: number | null;
  /** espaço para os arquivos enviados nos projetos criados pelo usuário (PDFs, TCLE, buscas) */
  limiteArmazenamentoMb: number;
  recursos: readonly Recurso[];
};

export const REGRAS: Record<Plano, Regra> = {
  FREE: { limiteProjetos: 3, limiteMembros: 1, limiteArmazenamentoMb: 500, recursos: ['QUESTOES'] },
  STANDARD: {
    limiteProjetos: null,
    limiteMembros: 5,
    limiteArmazenamentoMb: 5 * 1024,
    recursos: ['QUESTOES'],
  },
  MASTER: {
    limiteProjetos: null,
    limiteMembros: null,
    limiteArmazenamentoMb: 20 * 1024,
    recursos: RECURSOS,
  },
};

export const CICLOS = ['MENSAL', 'ANUAL'] as const;
export type Ciclo = (typeof CICLOS)[number];
export type PlanoPago = Exclude<Plano, 'FREE'>;

/** Preços em reais (anual = 10 mensalidades) */
export const PRECOS: Record<PlanoPago, Record<Ciclo, number>> = {
  STANDARD: { MENSAL: 49.9, ANUAL: 499 },
  MASTER: { MENSAL: 79.9, ANUAL: 799 },
};
/** Desconto estudantil (opção interna marcada pelo administrador): só no Standard */
export const DESCONTO_ESTUDANTE = 0.2;

export function valorDoPlano(plano: PlanoPago, ciclo: Ciclo, estudante = false) {
  const base = PRECOS[plano][ciclo];
  const valor = estudante && plano === 'STANDARD' ? base * (1 - DESCONTO_ESTUDANTE) : base;
  return Math.round(valor * 100) / 100;
}

/** Meses que os projetos do plano gratuito ficam no sistema depois de atingido o limite */
export const MESES_FREE = 3;
/** Avisos antes da remoção (dias) */
export const AVISOS_DIAS = [30, 7] as const;

type UsuarioPlano = {
  id: string;
  perfilGlobal: string;
  plano: Plano;
  planoVitalicio: boolean;
  planoLimiteEm: Date | string | null;
  planoBloqueadoEm: Date | string | null;
};

export const planoEfetivo = (u: Pick<UsuarioPlano, 'perfilGlobal' | 'plano'>): Plano =>
  u.perfilGlobal === 'ADMIN' ? 'MASTER' : (u.plano ?? 'FREE');

export function somarMeses(d: Date, meses: number) {
  const r = new Date(d);
  r.setMonth(r.getMonth() + meses);
  return r;
}

/** Data em que os projetos do plano gratuito serão removidos (null se não se aplica) */
export function expiraEm(u: UsuarioPlano): Date | null {
  if (planoEfetivo(u) !== 'FREE' || u.planoVitalicio || !u.planoLimiteEm) return null;
  return somarMeses(new Date(u.planoLimiteEm), MESES_FREE);
}

/** Projetos já criados pelo usuário (inclusive os da lixeira: excluir não devolve a vaga) */
export async function projetosCriados(usuarioId: string, trx?: Trx) {
  const r = await (trx ?? db)('projeto').where({ criadoPor: usuarioId }).count({ n: '*' }).first();
  return Number(r?.n ?? 0);
}

const carregar = async (usuarioId: string, trx?: Trx): Promise<UsuarioPlano> => {
  const u = await (trx ?? db)('usuario')
    .where({ id: usuarioId })
    .first('id', 'perfilGlobal', 'plano', 'planoVitalicio', 'planoLimiteEm', 'planoBloqueadoEm');
  if (!u) throw AppError.notFound('Usuário');
  return u;
};

/** Resumo do plano para o app (GET /me/plano). Não expõe a opção interna "vitalício". */
export async function resumoPlano(usuarioId: string) {
  const u = await carregar(usuarioId);
  const plano = planoEfetivo(u);
  const { limiteProjetos, limiteMembros, limiteArmazenamentoMb, recursos } = REGRAS[plano];
  const [usados, armazenamento, estudante] = await Promise.all([
    projetosCriados(usuarioId),
    espacoUsado(usuarioId),
    db('usuario').where({ id: usuarioId }).first('descontoEstudante'),
  ]);
  const bloqueado = plano === 'FREE' && !!u.planoBloqueadoEm;
  return {
    plano,
    limiteProjetos,
    limiteMembros,
    limiteArmazenamentoMb,
    armazenamentoUsadoBytes: armazenamento,
    descontoEstudante: !!estudante?.descontoEstudante,
    projetosUsados: usados,
    podeCriarProjeto: !bloqueado && (limiteProjetos === null || usados < limiteProjetos),
    expiraEm: expiraEm(u),
    bloqueado,
    recursos,
  };
}

/** Bytes dos arquivos enviados nos projetos criados pelo usuário (os relatórios gerados não contam) */
export async function espacoUsado(usuarioId: string) {
  const r = await db('arquivo as a')
    .join('projeto as p', 'p.id', 'a.projetoId')
    .where('p.criadoPor', usuarioId)
    .whereNot('a.chaveStorage', 'like', '%/relatorios/%')
    .sum({ n: 'a.tamanhoBytes' })
    .first();
  return Number(r?.n ?? 0);
}

const planoDoDono = async (projeto: { criadoPor: string }) => {
  const dono = await db('usuario').where({ id: projeto.criadoPor }).first('perfilGlobal', 'plano');
  return dono ? planoEfetivo(dono) : 'FREE';
};

/** Antes de um upload: o arquivo cabe no espaço do plano do dono do projeto? */
export async function conferirEspaco(projeto: { criadoPor: string }, bytes: number) {
  const { limiteArmazenamentoMb } = REGRAS[await planoDoDono(projeto)];
  const usado = await espacoUsado(projeto.criadoPor);
  if (usado + bytes > limiteArmazenamentoMb * 1024 * 1024) {
    throw new AppError(
      `O espaço para arquivos do plano do projeto (${limiteArmazenamentoMb >= 1024 ? `${limiteArmazenamentoMb / 1024} GB` : `${limiteArmazenamentoMb} MB`}) acabou. Faça o upgrade ou remova arquivos.`,
      403,
      { limiteArmazenamentoMb, usadoBytes: usado },
      'LIMITE_ARMAZENAMENTO',
    );
  }
}

/** Antes de convidar: o projeto ainda tem vaga de membro no plano do dono? */
export async function conferirVagaDeMembro(
  projeto: { id: string; criadoPor: string },
  email: string,
) {
  const { limiteMembros } = REGRAS[await planoDoDono(projeto)];
  if (limiteMembros === null) return;
  const [membros, convites] = await Promise.all([
    db('projetoMembro')
      .where({ projetoId: projeto.id })
      .whereNot('papel', 'RESPONSAVEL')
      .count({ n: '*' })
      .first(),
    // o convite reenviado para o mesmo e-mail substitui o anterior
    db('convite')
      .where({ projetoId: projeto.id })
      .whereNull('aceitoEm')
      .whereNot({ email })
      .count({ n: '*' })
      .first(),
  ]);
  if (Number(membros?.n ?? 0) + Number(convites?.n ?? 0) >= limiteMembros) {
    throw new AppError(
      `O plano do projeto permite até ${limiteMembros} membro(s) além do responsável. Faça o upgrade para convidar mais pessoas.`,
      403,
      { limiteMembros },
      'LIMITE_MEMBROS',
    );
  }
}

/** Recursos do projeto: os do plano de quem o criou */
export async function recursosDoProjeto(projeto: {
  criadoPor: string;
}): Promise<readonly Recurso[]> {
  const dono = await db('usuario').where({ id: projeto.criadoPor }).first('perfilGlobal', 'plano');
  return dono ? REGRAS[planoEfetivo(dono)].recursos : [];
}

/** Depois do projectAccess: barra o recurso que o plano do dono do projeto não inclui */
export const exigeRecurso = (recurso: Recurso) =>
  Object.assign(
    async (req: Request, _res: Response, next: NextFunction) => {
      if (!req.projeto) return next(AppError.notFound('Projeto'));
      const recursos = await recursosDoProjeto(req.projeto);
      if (recursos.includes(recurso)) return next();
      next(
        new AppError(
          'Este recurso não está incluído no plano do projeto. Faça o upgrade para o plano Master.',
          403,
          { recurso },
          'PLANO_SEM_RECURSO',
        ),
      );
    },
    { recurso },
  );

/** Rotas que a conta bloqueada pelo plano ainda pode usar: perfil, plano e notificações */
const LIBERADAS_NO_BLOQUEIO = [/^\/me(\/|$)/, /^\/planos(\/|$)/, /^\/notificacoes(\/|$)/];

/** Conta FREE bloqueada (fim dos 3 meses): só entra no perfil e na tela de upgrade */
export async function contaLiberada(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || req.user.perfil === 'ADMIN') return next();
  if (LIBERADAS_NO_BLOQUEIO.some((r) => r.test(req.path))) return next();
  const u = await db('usuario').where({ id: req.user.id }).first('plano', 'planoBloqueadoEm');
  if (u?.plano === 'FREE' && u.planoBloqueadoEm) {
    return next(
      new AppError(
        'O período do plano gratuito terminou. Faça o upgrade para voltar a usar o Konektron.',
        403,
        undefined,
        'PLANO_BLOQUEADO',
      ),
    );
  }
  next();
}

/** Antes de criar um projeto: respeita o limite do plano e começa a contagem dos 3 meses no último */
export async function reservarVagaDeProjeto(usuarioId: string, trx: Trx) {
  const u = await carregar(usuarioId, trx);
  const plano = planoEfetivo(u);
  const { limiteProjetos } = REGRAS[plano];
  if (limiteProjetos === null) return;
  const usados = await projetosCriados(usuarioId, trx);
  if (usados >= limiteProjetos) {
    throw new AppError(
      `O plano gratuito permite até ${limiteProjetos} projetos. Faça o upgrade para criar novos projetos.`,
      403,
      { limiteProjetos, projetosUsados: usados },
      'LIMITE_PROJETOS',
    );
  }
  if (usados + 1 >= limiteProjetos && !u.planoLimiteEm) {
    await trx('usuario')
      .where({ id: usuarioId })
      .update({ planoLimiteEm: new Date(), planoAvisoDias: null });
  }
}

/**
 * Troca de plano (administração hoje; webhook do Asaas depois). Sair do FREE (ou virar vitalício) desfaz
 * o bloqueio e devolve da lixeira os projetos removidos pela expiração; voltar ao FREE com o limite já
 * atingido recomeça a contagem dos 3 meses.
 */
export async function mudarPlano(
  usuarioId: string,
  novo: { plano?: Plano; planoVitalicio?: boolean },
) {
  return db.transaction(async (trx) => {
    const u = await carregar(usuarioId, trx);
    const plano = novo.plano ?? u.plano;
    const vitalicio = novo.planoVitalicio ?? u.planoVitalicio;
    const dados: Record<string, unknown> = { plano, planoVitalicio: vitalicio };
    if (plano !== 'FREE' || vitalicio) {
      if (u.planoBloqueadoEm) {
        await trx('projeto')
          .where({ criadoPor: usuarioId })
          .where('excluidoEm', '>=', new Date(u.planoBloqueadoEm))
          .update({ excluidoEm: null });
      }
      Object.assign(dados, { planoLimiteEm: null, planoBloqueadoEm: null, planoAvisoDias: null });
    } else if (
      !u.planoLimiteEm &&
      (await projetosCriados(usuarioId, trx)) >= REGRAS.FREE.limiteProjetos!
    ) {
      Object.assign(dados, { planoLimiteEm: new Date(), planoAvisoDias: null });
    }
    await trx('usuario').where({ id: usuarioId }).update(dados);
  });
}

const dataBr = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

/**
 * Tarefa periódica do worker: avisa 30 e 7 dias antes e, vencidos os 3 meses do plano gratuito, manda os
 * projetos do usuário para a lixeira (removidos de vez pela limpeza em 30 dias) e bloqueia a conta.
 */
export async function expirarPlanosFree(agora = new Date()) {
  const candidatos = await db('usuario')
    .where({ plano: 'FREE', planoVitalicio: false, perfilGlobal: 'USUARIO' })
    .whereNotNull('planoLimiteEm')
    .whereNull('planoBloqueadoEm')
    .select(
      'id',
      'nome',
      'email',
      'perfilGlobal',
      'plano',
      'planoVitalicio',
      'planoLimiteEm',
      'planoBloqueadoEm',
      'planoAvisoDias',
    );
  let avisados = 0;
  let bloqueados = 0;
  for (const u of candidatos) {
    const fim = expiraEm(u)!;
    const dias = Math.ceil((fim.getTime() - agora.getTime()) / 86_400_000);
    if (dias <= 0) {
      await db.transaction(async (trx) => {
        await trx('projeto')
          .where({ criadoPor: u.id })
          .whereNull('excluidoEm')
          .update({ excluidoEm: agora });
        await trx('usuario').where({ id: u.id }).update({ planoBloqueadoEm: agora });
        await notificar(
          [u.id],
          'PLANO_EXPIRADO',
          'O plano gratuito terminou: faça o upgrade para recuperar seus projetos',
          {},
          trx,
        );
      });
      await enviarEmail(
        u.email,
        'Konektron Research: o período do plano gratuito terminou',
        `Olá, ${u.nome}.\n\nO período de ${MESES_FREE} meses do plano gratuito terminou e seus projetos foram removidos. ` +
          `Se fizer o upgrade nos próximos 30 dias, eles são recuperados.\n\nVeja os planos: ${env.APP_URL}/planos`,
      );
      bloqueados++;
      logger.info(
        { usuarioId: u.id },
        'plano gratuito expirado: projetos na lixeira e conta bloqueada',
      );
      continue;
    }
    const aviso = AVISOS_DIAS.find(
      (a) => dias <= a && (u.planoAvisoDias === null || a < u.planoAvisoDias),
    );
    if (aviso) {
      await db('usuario').where({ id: u.id }).update({ planoAvisoDias: aviso });
      await notificar(
        [u.id],
        'PLANO_EXPIRANDO',
        `Seus projetos do plano gratuito serão removidos em ${dataBr(fim)}`,
        { expiraEm: fim },
      );
      await enviarEmail(
        u.email,
        `Konektron Research: seus projetos serão removidos em ${dias} dia(s)`,
        `Olá, ${u.nome}.\n\nNo plano gratuito, os projetos ficam ${MESES_FREE} meses no sistema depois de atingido o limite de ` +
          `${REGRAS.FREE.limiteProjetos} projetos. Os seus serão removidos em ${dataBr(fim)} e a conta ficará bloqueada.\n\n` +
          `Faça o upgrade para manter tudo: ${env.APP_URL}/planos`,
      );
      avisados++;
    }
  }
  return { avisados, bloqueados };
}
