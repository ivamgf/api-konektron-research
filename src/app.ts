import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from '#config/env.ts';
import { logger } from '#utils/logger.ts';
import { errorHandler, notFound } from '#middlewares/errorHandler.ts';
import routes from './routes.ts';
import docs from './docs/docs.routes.ts';

const REQUEST_ID = /^[\w.:-]{1,100}$/;

export const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // roteador do Heroku (X-Forwarded-For) — RNF05
app.use(helmet());
app.use(cors({ origin: env.corsOrigins, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const recebido = req.headers['x-request-id'];
      const id = typeof recebido === 'string' && REQUEST_ID.test(recebido) ? recebido : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
  }),
);

app.get('/', (_req, res) => res.redirect('/api/v1'));
app.use('/api/v1', docs);
app.use('/api/v1', routes);
app.use(notFound);
app.use(errorHandler);
