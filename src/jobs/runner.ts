import { env } from '#config/env.ts';
import { logger } from '#utils/logger.ts';
import { concluir, devolver, enfileirar, falhar, reservar, type Tarefa } from '#services/fila.ts';
import { handlers } from '#jobs/handlers.ts';

// Laço da fila filaTarefa (importação, PDF, exportações, limpeza). Roda no dyno worker
// (src/worker.ts) ou dentro do web com WORKER_EMBUTIDO=true (src/server.ts).
let parar = false;
let emAndamento: Tarefa | undefined;
let ultimaLimpeza = 0;
let laco: Promise<void> | undefined;

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

export function iniciarWorker(origem: string) {
  if (laco) return laco;
  logger.info(`worker iniciado (${origem}, ${env.NODE_ENV}), consulta a cada ${env.WORKER_POLL_MS} ms`);
  laco = (async () => {
    while (!parar) {
      try {
        const trabalhou = await ciclo();
        if (!trabalhou) await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS));
      } catch (err) {
        logger.error({ err }, 'erro no ciclo do worker');
        await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS * 5));
      }
    }
  })();
  return laco;
}

/** Para de reservar tarefas e espera a atual; passado o limite, devolve-a à fila */
export async function pararWorker(limiteMs = 25_000) {
  parar = true;
  const fim = Date.now() + limiteMs;
  while (emAndamento && Date.now() < fim) await new Promise((r) => setTimeout(r, 250));
  if (emAndamento) await devolver(emAndamento.id).catch(() => {});
}
