import { z } from 'zod';

try {
  process.loadEnvFile(); // Node 24: lê o .env sem o pacote dotenv
} catch {
  // sem .env: usa as variáveis do ambiente (Heroku Config Vars, CI)
}

const flag = z.enum(['true', 'false']).default('false');
const optional = z.preprocess((v) => (typeof v === 'string' && !v.trim() ? undefined : v), z.string().optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'homologation', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(3333),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),
  APP_URL: z.url().default('http://localhost:5173'),
  API_URL: z.url().default('http://localhost:3333'),

  // MySQL 5.7 (Percona) da hospedagem — ver ERS seção 11.3
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_MIGRATION_USER: optional,
  DB_MIGRATION_PASSWORD: optional,
  DB_POOL_MAX: z.coerce.number().int().min(1).default(5),
  DB_SSL: flag,

  JWT_SECRET: z.string().min(32, { error: 'precisa ter ao menos 32 caracteres' }),
  JWT_REFRESH_SECRET: optional,
  JWT_ACCESS_EXPIRES: z.string().default('15m'),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(7),

  CORS_ORIGINS: z.string().default(''),

  STORAGE_DRIVER: z.enum(['local', 'gcs']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./storage'),
  GCS_BUCKET: optional,
  GCS_PROJECT_ID: optional,
  GCS_CREDENTIALS_JSON: optional,

  SMTP_HOST: optional,
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_SECURE: flag,
  SMTP_USER: optional,
  SMTP_PASS: optional,
  MAIL_FROM: z.string().default('Konektron Research <nao-responda@konektron.com.br>'),

  CHROME_PATH: optional,
  WORKER_POLL_MS: z.coerce.number().int().min(250).default(2000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Variáveis de ambiente inválidas:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

const data = parsed.data;
if (data.STORAGE_DRIVER === 'gcs' && !data.GCS_BUCKET) {
  console.error('STORAGE_DRIVER=gcs exige GCS_BUCKET');
  process.exit(1);
}

export const env = Object.freeze({
  ...data,
  isProd: data.NODE_ENV === 'production',
  isTest: data.NODE_ENV === 'test',
  corsOrigins: data.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  emailSecret: data.JWT_REFRESH_SECRET ?? data.JWT_SECRET,
});
