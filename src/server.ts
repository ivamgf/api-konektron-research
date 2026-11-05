import { app } from './app.ts';
import { env } from '#config/env.ts';
import { db } from '#database/connection.ts';
import { logger } from '#utils/logger.ts';

const server = app.listen(env.PORT, () => {
  logger.info(`Konektron Research API em ${env.API_URL}/api/v1 (${env.NODE_ENV}, Node ${process.version}, porta ${env.PORT})`);
});

// Heroku manda SIGTERM no reinício diário e nos deploys e dá 30 s para sair
let encerrando = false;
function desligar(sinal: string) {
  if (encerrando) return;
  encerrando = true;
  logger.info(`${sinal} recebido, encerrando...`);
  server.close(async () => {
    await db.destroy();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 25_000).unref();
}

process.on('SIGTERM', () => desligar('SIGTERM'));
process.on('SIGINT', () => desligar('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
