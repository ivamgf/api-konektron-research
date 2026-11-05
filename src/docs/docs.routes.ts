// Documentação pública: GET /api/v1/openapi.json e Swagger UI em /api/v1/docs.
// O JSON é gerado por "npm run docs:openapi" (src/docs/openapi.ts) e versionado em docs/.
import { readFileSync } from 'node:fs';
import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { logger } from '#utils/logger.ts';

const router = Router();

let spec: Record<string, unknown> | undefined;
try {
  spec = JSON.parse(readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8'));
} catch (err) {
  logger.warn(
    { err },
    'docs/openapi.json ausente ou inválido: /api/v1/docs desativado (rode npm run docs:openapi)',
  );
}

if (spec) {
  router.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });

  router.use(
    '/docs',
    // a CSP padrão do Helmet força HTTPS nos recursos (quebra em http://localhost)
    helmet.contentSecurityPolicy({ directives: { upgradeInsecureRequests: null } }),
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Konektron Research API',
      swaggerOptions: { persistAuthorization: true, validatorUrl: null },
    }),
  );
}

export default router;
