import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fluxogramaSvg } from '../src/modules/revisoes/fluxograma.ts';

test('gera SVG do fluxo de seleção com as contagens (RF33)', () => {
  const svg = fluxogramaSvg({
    totais: { consultados: 245, importados: 8, selecionadosUltimaTriagem: 3, revisaoAnterior: 0, integrados: 1, incluidos: 4 },
    excluidosPorEtapa: [
      { etapaId: 'a', ordem: 4, nome: 'Triagem F1 <título>', motivo: 'CRITERIO', n: 1 },
      { etapaId: 'a', ordem: 4, nome: 'Triagem F1 <título>', motivo: 'OUTRO', n: 1 },
    ],
  });
  assert.match(svg, /^<svg/);
  assert.match(svg, /Registros consultados nas bases: 245/);
  assert.match(svg, /Excluídos: 2/);
  assert.match(svg, /Total incluídos: 4/);
  assert.match(svg, /Triagem F1 &lt;título&gt;/);
});
