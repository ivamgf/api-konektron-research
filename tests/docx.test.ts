import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepararHtmlParaWord } from '#pdf/docx.ts';

test('HTML do PDF é ajustado para o Word: sem CSS, marca de rascunho, quebras e bordas', () => {
  const html = prepararHtmlParaWord(
    '<style>body{color:red}</style><div class="marca">RASCUNHO</div><section class="capa"><h1>Título</h1></section>' +
      '<h1 class="quebra">Revisões</h1><div class="quebra"><table><tr><th>A</th><td>B</td></tr></table></div><p class="ref">SILVA, A.</p>',
  );
  assert.ok(!html.includes('<style'), 'CSS da página removido');
  assert.match(html, /<p style="[^"]*">RASCUNHO<\/p>/);
  assert.equal((html.match(/class="page-break"/g) ?? []).length, 3, 'capa + duas quebras');
  assert.match(html, /<table style="border-collapse:collapse;width:100%">/);
  assert.match(html, /<th style="border:1px solid/);
  assert.match(html, /<td style="border:1px solid/);
  assert.match(html, /<p style="text-align:left">SILVA, A\.<\/p>/);
});
