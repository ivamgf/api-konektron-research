import { abrirNavegador } from './render.ts';

/**
 * Word (.docx) a partir do mesmo HTML dos PDFs (protocolo, projeto, relatório da revisão, análise):
 * - diagramas em SVG viram PNG (o Word não recebe SVG por essa conversão), renderizados no Chrome;
 * - quebras de página (.quebra), marca d'água de rascunho e bordas de tabela ajustadas ao Word.
 */

const CM = 567; // twips por centímetro

/** Converte cada <svg>…</svg> do HTML numa <img> PNG (data URI), com o tamanho original */
export async function svgsParaPng(html: string): Promise<string> {
  const svgs = html.match(/<svg[\s\S]*?<\/svg>/g);
  if (!svgs?.length) return html;
  const browser = await abrirNavegador();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
    const pngs: string[] = [];
    for (const svg of svgs) {
      await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${svg.replace(/style="max-width:100%;height:auto"\s*/, '')}</body></html>`, { waitUntil: 'load' });
      const el = await page.$('svg');
      const caixa = await el!.boundingBox();
      const png = await el!.screenshot({ type: 'png', omitBackground: false });
      // largura no Word: até 16 cm (A4 com margens de 2,5 cm)
      const largura = Math.min(Math.round(caixa?.width ?? 600), 605);
      const altura = Math.round(((caixa?.height ?? 400) * largura) / (caixa?.width ?? 600));
      pngs.push(`<img src="data:image/png;base64,${Buffer.from(png).toString('base64')}" width="${largura}" height="${altura}" alt="Diagrama"/>`);
    }
    let i = 0;
    return html.replace(/<svg[\s\S]*?<\/svg>/g, () => pngs[i++]);
  } finally {
    await browser.close();
  }
}

/** Ajustes de HTML para a conversão: tira o CSS da página, marca d'água e quebras de página */
export function prepararHtmlParaWord(html: string): string {
  const borda = 'border:1px solid #9AA5A8;padding:4px 6px;vertical-align:top';
  return (
    html
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<div class="marca">RASCUNHO<\/div>/g, '<p style="color:#DC3545;font-weight:bold;text-align:center">RASCUNHO</p>')
      // elementos que começam página nova no PDF
      .replace(/<(h1|div|section)([^>]*)class="([^"]*\b(?:quebra|capa)\b[^"]*)"/g, (m, tag, antes, classes) =>
        classes.split(/\s+/).includes('quebra')
          ? `<div class="page-break" style="page-break-after:always"></div><${tag}${antes}class="${classes}"`
          : m,
      )
      .replace(/<section class="capa">([\s\S]*?)<\/section>/, '<div style="text-align:center">$1</div><div class="page-break" style="page-break-after:always"></div>')
      .replace(/<table(?![^>]*style=)/g, '<table style="border-collapse:collapse;width:100%"')
      .replace(/<(th|td)(?![^>]*style=)([^>]*)>/g, `<$1 style="${borda}"$2>`)
      .replace(/<p class="ref">/g, '<p style="text-align:left">')
  );
}

/** Opções do Word: cabeçalho e rodapé (null = sem), fonte e tamanho em pontos */
export type OpcoesDocx = { cabecalho?: string | null; rodape?: string | null; fonte?: string; tamanho?: number };

export async function htmlParaDocx(html: string, titulo: string, opcoes: OpcoesDocx = {}): Promise<Buffer> {
  const HTMLtoDOCX = (await import('@turbodocx/html-to-docx')).default as unknown as (
    html: string,
    header?: string | null,
    opcoes?: Record<string, unknown>,
    footer?: string | null,
  ) => Promise<ArrayBuffer | Blob | Buffer>;
  const corpo = prepararHtmlParaWord(await svgsParaPng(html));
  const saida = await HTMLtoDOCX(
    corpo,
    opcoes.cabecalho === undefined ? '<p style="color:#007A4F;font-size:8pt">Konektron Research</p>' : opcoes.cabecalho,
    {
      title: titulo,
      creator: 'Konektron Research',
      orientation: 'portrait',
      margins: { top: Math.round(2.5 * CM), bottom: Math.round(2.5 * CM), left: Math.round(2.5 * CM), right: Math.round(2.5 * CM), header: 400, footer: 400 },
      font: opcoes.fonte ?? 'Calibri',
      fontSize: Math.round((opcoes.tamanho ?? 11) * 2), // meios-pontos
      header: opcoes.cabecalho !== null,
      footer: true,
      pageNumber: true,
      lang: 'pt-BR',
      table: { row: { cantSplit: true } },
    },
    opcoes.rodape === undefined ? `<p style="font-size:8pt;color:#454D50">${titulo} · página </p>` : (opcoes.rodape ?? ''),
  );
  if (Buffer.isBuffer(saida)) return saida;
  if (saida instanceof ArrayBuffer) return Buffer.from(saida);
  return Buffer.from(await (saida as Blob).arrayBuffer());
}

export const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
