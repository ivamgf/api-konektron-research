// Envia o dump para o bucket (pasta backups/) e apaga os com mais de 30 dias (RNF09)
import { readFile } from 'node:fs/promises';
import path from 'node:path';

try {
  process.loadEnvFile();
} catch {
  // Heroku: variáveis já no ambiente
}

const arquivo = process.argv[2];
if (!arquivo) throw new Error('uso: node scripts/upload-backup.js <arquivo.sql.gz>');
if (!process.env.GCS_BUCKET) {
  console.log(`GCS_BUCKET vazio: backup mantido só em ${arquivo}`);
  process.exit(0);
}

const { Storage } = await import('@google-cloud/storage');
const credentials = process.env.GCS_CREDENTIALS_JSON ? JSON.parse(process.env.GCS_CREDENTIALS_JSON) : undefined;
const bucket = new Storage({ projectId: process.env.GCS_PROJECT_ID, credentials }).bucket(process.env.GCS_BUCKET);

await bucket.file(`backups/${path.basename(arquivo)}`).save(await readFile(arquivo), { contentType: 'application/gzip', resumable: false });
console.log(`backup enviado: backups/${path.basename(arquivo)}`);

const limite = Date.now() - 30 * 86_400_000;
const [files] = await bucket.getFiles({ prefix: 'backups/' });
for (const f of files) {
  if (new Date(f.metadata.timeCreated).getTime() < limite) {
    await f.delete();
    console.log(`removido backup antigo: ${f.name}`);
  }
}
