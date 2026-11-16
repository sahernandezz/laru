/** Long names in a big workspace: cut so what tells two apart still shows. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inTree, midCut } from '../src/lib/es.ts';

test('a long name is cut in its middle, by words, keeping its start and its end', () => {
  const a = midCut('servicio-de-consulta-de-conciliacion-bancaria-interbancaria', 24);
  const b = midCut('servicio-de-consulta-de-prevencion-de-fraude-en-tiempo-real', 24);
  assert.match(a, /^servicio-.*….*interbancaria$/);
  assert.match(b, /^servicio-.*….*tiempo-real$/);
  assert.notEqual(a, b, 'two services that share a start still read apart');
  assert.ok(a.length <= 26 && b.length <= 26);
  assert.equal(midCut('postgres', 10), 'postgres', 'a short name comes back whole');
  assert.equal(midCut('abcdefghijklmnopqrstuvwxyz', 9).length, 9, 'one long word is cut by its letters');
});

test('in the tree a piece leaves out what its title repeats of its parent', () => {
  assert.equal(inTree('Conciliacion bancaria interbancaria: subproceso 0 de validación', 'Conciliación bancaria interbancaria'), 'Subproceso 0 de validación');
  assert.equal(inTree('Pagos', 'Pagos'), 'Pagos', 'a title that only repeats it stays whole');
  assert.equal(inTree('Cobros en línea', 'Pagos'), 'Cobros en línea');
  assert.equal(inTree('Pagos', ''), 'Pagos');
});

test('when even its first and last words do not fit, the name is cut by its letters, never to a stub', () => {
  const cut = midCut('procesador-de-eventos-de-liquidacion-a-comercios-y-adquirentes', 18);
  assert.equal(cut.length, 18);
  assert.match(cut, /^procesad.*….*rentes$/);
});
