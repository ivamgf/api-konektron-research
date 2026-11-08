// PDFs abrem no navegador (inline), prontos para imprimir; os demais arquivos são baixados.
// filename* (RFC 5987) preserva acentos; filename fica como alternativa em ASCII.
export function disposicao(nome: string, mimeType?: string | null) {
  const tipo = mimeType === 'application/pdf' ? 'inline' : 'attachment';
  const ascii = nome.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'arquivo';
  return `${tipo}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nome)}`;
}
