import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lerCsvDaEtapa } from '#modules/revisoes/importarEtapa.ts';

// Os modelos de planilha baixados no app (AcoesEtapa.tsx) precisam ser lidos pela importação.
// Só roda com o app ao lado da API (workspace local).
function fonteDoApp() {
  try {
    return readFileSync(new URL('../../app-konektron-research/src/pages/revisao/AcoesEtapa.tsx', import.meta.url), 'utf8');
  } catch {
    return null;
  }
}

/** Trechos `texto: '...' + '...',` do objeto MODELOS_ORIGEM, avaliados como expressão JS */
function modelos(fonte: string) {
  const textos: string[] = [];
  const inicio = fonte.indexOf('export const MODELOS_ORIGEM');
  const bloco = fonte.slice(inicio, fonte.indexOf('} as const', inicio));
  let i = 0;
  for (;;) {
    i = bloco.indexOf('texto:', i);
    if (i < 0) break;
    const fim = bloco.indexOf('\n  }', i);
    const expr = bloco.slice(i + 'texto:'.length, fim).trim().replace(/,$/, '');
    textos.push(new Function(`return ${expr}`)() as string);
    i = fim;
  }
  return textos;
}

const fonte = fonteDoApp();

test('modelos de integrados e revisão anterior do app são reconhecidos', { skip: !fonte }, () => {
  const textos = modelos(fonte!);
  assert.equal(textos.length, 2);
  const [integ, anterior] = textos.map((t) => lerCsvDaEtapa(t));
  assert.equal(integ.origemDoArquivo, 'INTEGRADO');
  assert.equal(integ.linhas[0].citacoes, 170);
  assert.equal(integ.linhas[0].doi, '10.1371/journal.pbio.2001414');
  assert.equal(anterior.origemDoArquivo, 'REVISAO_ANTERIOR');
  assert.equal(anterior.linhas[0].tipo, 'Artigo');
  assert.match(anterior.linhas[0].refNbr!, /^KELLER, Sallie Ann/);
});
