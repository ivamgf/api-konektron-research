import { env } from '#config/env.ts';
import { db } from '#database/connection.ts';
import { logger } from '#utils/logger.ts';
import { concluir, devolver, enfileirar, falhar, reservar, type Tarefa } from '#services/fila.ts';
import { handlers } from '#jobs/handlers.ts';

// Worker: processa a tabela fila_tarefa (importação, PDF, exportações, limpeza)
let parar = false;
let emAndamento: Tarefa | undefined;
let ultimaLimpeza = 0;

async function ciclo() {
  // limpeza da lixeira uma vez a cada 6 h (RN17)
  if (Date.now() - ultimaLimpeza > 6 * 3_600_000) {
    ultimaLimpeza = Date.now();
    await enfileirar('limpar-lixeira', {});
  }
  const t = await reservar();
  if (!t) return false;
  emAndamento = t;
  const log = logger.child({ tarefa: t.id, fila: t.fila });
  const inicio = Date.now();
  try {
    const h = handlers[t.fila];
    if (!h) throw new Error(`fila desconhecida: ${t.fila}`);
    await h(t);
    await concluir(t.id);
    log.info({ ms: Date.now() - inicio }, 'tarefa concluída');
  } catch (err) {
    const definitiva = await falhar(t, err);
    log.error({ err, definitiva }, 'tarefa falhou');
  } finally {
    emAndamento = undefined;
  }
  return true;
}

async function main() {
  logger.info(`worker iniciado (${env.NODE_ENV}), consulta a cada ${env.WORKER_POLL_MS} ms`);
  while (!parar) {
    try {
      const trabalhou = await ciclo();
      if (!trabalhou) await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS));
    } catch (err) {
      logger.error({ err }, 'erro no ciclo do worker');
      await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS * 5));
    }
  }
}

// Heroku envia SIGTERM no reinício diário e nos deploys: devolve a tarefa e sai em até 30 s
async function desligar(sinal: string) {
  if (parar) return;
  parar = true;
  logger.info(`${sinal} recebido, encerrando o worker`);
  const limite = setTimeout(async () => {
    if (emAndamento) await devolver(emAndamento.id).catch(() => {});
    process.exit(0);
  }, 25_000);
  limite.unref();
  while (emAndamento) await new Promise((r) => setTimeout(r, 250));
  await db.destroy();
  process.exit(0);
}

process.on('SIGTERM', () => desligar('SIGTERM'));
process.on('SIGINT', () => desligar('SIGINT'));
main();
