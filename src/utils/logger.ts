import pino from 'pino';
import { env } from '#config/env.ts';

// pino-pretty é devDependency: no Heroku (sem devDependencies) o log sai em JSON
function hasPretty() {
  try {
    import.meta.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export const logger = pino({
  level: env.LOG_LEVEL ?? (env.isProd ? 'info' : 'debug'),
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.senha', '*.password', '*.refreshToken', '*.token'],
  transport: !env.isProd && hasPretty() ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});
