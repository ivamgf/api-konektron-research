import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { env } from '#config/env.ts';

// Chrome do buildpack Chrome for Testing (Heroku) ou CHROME_PATH (desenvolvimento)
function caminhoChrome() {
  if (env.CHROME_PATH) return env.CHROME_PATH;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const nome of ['chrome', 'google-chrome', 'chromium', 'chromium-browser']) {
      const p = path.join(dir, nome);
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch {
        // tenta o próximo
      }
    }
  }
  throw new Error('Chrome não encontrado: defina CHROME_PATH ou instale o buildpack Chrome for Testing');
}

/** Chrome sem interface (PDF e conversão de diagramas para o Word) */
export async function abrirNavegador() {
  const puppeteer = (await import('puppeteer-core')).default;
  return puppeteer.launch({
    executablePath: caminhoChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
}

export async function htmlParaPdf(html: string, rodape: string) {
  const browser = await abrirNavegador();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '25mm', bottom: '25mm', left: '25mm', right: '25mm' },
      displayHeaderFooter: true,
      headerTemplate: '<div style="font-size:8px;width:100%;padding:0 25mm;color:#007A4F;font-family:Arial">Konektron Research</div>',
      footerTemplate: `<div style="font-size:8px;width:100%;padding:0 25mm;color:#454D50;font-family:Arial;display:flex;justify-content:space-between"><span>${rodape}</span><span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

export const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const paragrafos = (v: unknown) =>
  String(v ?? '')
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('') || '<p class="vazio">Não informado</p>';

export const ESTILO = `
  @page { size: A4; }
  * { box-sizing: border-box; }
  body { font-family: Roboto, Arial, sans-serif; color: #454D50; font-size: 11pt; line-height: 1.5; margin: 0; }
  h1 { color: #003D27; font-size: 20pt; margin: 0 0 8px; }
  h2 { color: #007A4F; font-size: 14pt; border-bottom: 2px solid #4DDBA8; padding-bottom: 4px; margin: 24px 0 10px; }
  h3 { color: #212529; font-size: 12pt; margin: 16px 0 6px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 10pt; }
  th { background: #E6FAF3; color: #003D27; text-align: left; }
  th, td { border: 1px solid #DCDCDC; padding: 5px 7px; vertical-align: top; }
  .capa { height: 245mm; display: flex; flex-direction: column; justify-content: flex-end; padding: 24px;
          background: linear-gradient(160deg, #ffffff 0%, #ffffff 45%, #007A4F 45%, #003D27 100%); page-break-after: always; }
  .capa h1 { color: #fff; font-size: 26pt; }
  .capa p { color: #E6FAF3; margin: 4px 0; }
  .marca { position: fixed; top: 40%; left: 10%; font-size: 72pt; color: rgba(220,53,69,0.12); transform: rotate(-30deg); }
  .quebra { page-break-before: always; }
  p.ref { text-align: left; margin: 0 0 10px; line-height: 1.15; }
  .vazio { color: #8a9396; font-style: italic; }
  .mono { font-family: 'Roboto Mono', monospace; font-size: 9.5pt; }
`;
