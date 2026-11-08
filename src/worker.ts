import { db } from '#database/connection.ts';
import { logger } from '#utils/logger.ts';
import { iniciarWorker, pararWorker } from '#jobs/runner.ts';

// Worker: processa a tabela fila_tarefa (importação, PDF, exportações, limpeza)
iniciarWorker('dyno worker');

// Heroku envia SIGTERM no reinício diário e nos deploys: devolve a tarefa e sai em até 30 s
let encerrando = false;
async function desligar(sinal: string) {
  if (encerrando) return;
  encerrando = true;
  logger.info(`${sinal} recebido, encerrando o worker`);
  await pararWorker(25_000);
  await db.destroy();
  process.exit(0);
}

process.on('SIGTERM', () => desligar('SIGTERM'));
process.on('SIGINT', () => desligar('SIGINT'));
