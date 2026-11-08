import { hostname } from 'node:os';
import { db, json } from '#database/connection.ts';
import { uuid } from '#utils/tokens.ts';

// Fila de tarefas na tabela fila_tarefa (ERS 10.1). O MySQL 5.7 não tem SKIP LOCKED:
// a reserva é um UPDATE atômico que grava o token do worker.

export type Tarefa = { id: number; fila: string; payload: any; tentativas: number; maxTentativas: number };

export async function enfileirar(fila: string, payload: Record<string, unknown>, executarApos?: Date) {
  const [id] = await db('filaTarefa').insert({ fila, payload: json(payload), executarApos: executarApos ?? new Date() });
  return Number(id);
}

// O token cabe em bloqueado_por (VARCHAR(64)): o hostname do dyno do Heroku é um UUID de 36 caracteres e,
// sem o modo estrito do MySQL, um token maior era truncado sem erro — a reserva gravava e o SELECT abaixo
// nunca achava a tarefa, que ficava presa em EXECUTANDO.
export const tokenDoWorker = () => `${hostname().slice(0, 20)}:${uuid()}`.slice(0, 64);

export async function reservar(token = tokenDoWorker()): Promise<Tarefa | undefined> {
  const agora = new Date();
  // devolve à fila tarefas presas de um worker que caiu
  await db('filaTarefa')
    .where({ status: 'EXECUTANDO' })
    .where('bloqueadoAte', '<', agora)
    .update({ status: 'PENDENTE', bloqueadoPor: null, bloqueadoAte: null });

  const n = await db('filaTarefa')
    .where({ status: 'PENDENTE' })
    .where('executarApos', '<=', agora)
    .orderBy('executarApos')
    .limit(1)
    .update({
      status: 'EXECUTANDO',
      bloqueadoPor: token,
      bloqueadoAte: new Date(Date.now() + 10 * 60_000),
      tentativas: db.raw('tentativas + 1'),
    });
  if (!n) return undefined;
  return db('filaTarefa').where({ bloqueadoPor: token, status: 'EXECUTANDO' }).first();
}

export const concluir = (id: number) =>
  db('filaTarefa').where({ id }).update({ status: 'CONCLUIDA', bloqueadoPor: null, bloqueadoAte: null, ultimoErro: null });

export async function falhar(t: Tarefa, err: unknown) {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  const definitiva = t.tentativas >= t.maxTentativas;
  await db('filaTarefa')
    .where({ id: t.id })
    .update({
      status: definitiva ? 'ERRO' : 'PENDENTE',
      bloqueadoPor: null,
      bloqueadoAte: null,
      ultimoErro: msg.slice(0, 10_000),
      // nova tentativa com espera crescente: 30 s, 2 min, 8 min...
      executarApos: new Date(Date.now() + 30_000 * 4 ** (t.tentativas - 1)),
    });
  return definitiva;
}

// Devolve a tarefa à fila sem contar tentativa (desligamento do dyno — SIGTERM)
export const devolver = (id: number) =>
  db('filaTarefa')
    .where({ id, status: 'EXECUTANDO' })
    .update({ status: 'PENDENTE', bloqueadoPor: null, bloqueadoAte: null, tentativas: db.raw('GREATEST(tentativas - 1, 0)') });
