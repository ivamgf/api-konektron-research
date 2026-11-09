// Testa o storage configurado (STORAGE_DRIVER): grava, lê e apaga um arquivo de teste.
// Uso: npm run storage:check   (no Heroku: heroku run npm run storage:check -a api-konektron-research)
try {
  process.loadEnvFile();
} catch {
  // sem .env: usa as variáveis do ambiente
}
const { env } = await import('../src/config/env.ts');
const { storage } = await import('../src/services/storage/index.ts');

const st = storage();
const chave = `_verificacao/teste-${Date.now()}.txt`;
const conteudo = Buffer.from(`Konektron Research ${new Date().toISOString()}`);
console.log(`driver: ${env.STORAGE_DRIVER} (${st.provedor})`);
if (env.STORAGE_DRIVER === 'ftp') console.log(`servidor: ${env.FTP_HOST}:${env.FTP_PORT} · pasta: ${env.FTP_BASE_PATH} · TLS: ${env.FTP_SECURE}`);
try {
  await st.put(chave, conteudo, 'text/plain');
  const lido = await st.get(chave);
  if (!lido.equals(conteudo)) throw new Error('o conteúdo lido é diferente do gravado');
  await st.remove(chave);
  console.log('ok: gravou, leu e apagou o arquivo de teste');
} catch (e) {
  console.error('falhou:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
