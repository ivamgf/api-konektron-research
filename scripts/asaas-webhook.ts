// Cadastra (ou recria) o webhook do Konektron no Asaas, apontando para API_URL/api/v1/webhooks/asaas.
//   npm run asaas:webhook            (use no Heroku: heroku run npm run asaas:webhook)
// E-mail dos avisos de falha: ASAAS_WEBHOOK_EMAIL (padrão: o endereço de MAIL_FROM).
// Requer ASAAS_API_KEY, ASAAS_WEBHOOK_TOKEN e API_URL públicos (HTTPS). O token vai no header
// asaas-access-token de cada aviso e é conferido pela API.
import { env } from '#config/env.ts';
import { chamarAsaas } from '#services/asaas.ts';

const EVENTOS = [
  'PAYMENT_CREATED',
  'PAYMENT_UPDATED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_OVERDUE',
  'PAYMENT_DELETED',
  'PAYMENT_REFUNDED',
  'PAYMENT_CHARGEBACK_REQUESTED',
  'SUBSCRIPTION_DELETED',
  'SUBSCRIPTION_INACTIVATED',
];

// o Asaas exige um e-mail para avisar quando o webhook falhar ou for interrompido
const email =
  process.env.ASAAS_WEBHOOK_EMAIL || (env.MAIL_FROM.match(/<([^>]+)>/)?.[1] ?? env.MAIL_FROM).trim();

const url = `${env.API_URL.replace(/\/$/, '')}/api/v1/webhooks/asaas`;
if (!env.ASAAS_WEBHOOK_TOKEN) throw new Error('Defina ASAAS_WEBHOOK_TOKEN');
if (!url.startsWith('https://'))
  throw new Error(`O Asaas exige HTTPS público; API_URL atual: ${env.API_URL}`);

const existentes = await chamarAsaas<{ data: { id: string; url: string }[] }>('GET', '/webhooks');
for (const w of existentes.data ?? []) {
  if (w.url === url) await chamarAsaas('DELETE', `/webhooks/${w.id}`);
}
const novo = await chamarAsaas<{ id: string }>('POST', '/webhooks', {
  name: 'Konektron Research',
  url,
  email,
  enabled: true,
  interrupted: false,
  apiVersion: 3,
  authToken: env.ASAAS_WEBHOOK_TOKEN,
  sendType: 'SEQUENTIALLY',
  events: EVENTOS,
});
console.log(`Webhook ${novo.id} cadastrado em ${url} (${env.ASAAS_API_URL})`);
process.exit(0);
