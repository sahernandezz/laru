/** A piece named in a text of the documentation reads as its title: its id, bare or as [[id]], becomes Laru's own link; anything else stays as written. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowPieces, refLinks } from '../src/lib/titles.ts';

test('a known piece id, bare or between [[ ]], becomes a link of Laru; a word with a colon, a path, a URL or an unknown id does not', () => {
  knowPieces([{ id: 'flow:registro-e-inicio', title: 'Registro e inicio de sesión' }, { id: 'mod:carpetas', title: 'Carpetas' }]);
  assert.equal(refLinks('Lo prueba flow:registro-e-inicio.'), 'Lo prueba [flow:registro-e-inicio](laru:flow%3Aregistro-e-inicio).');
  assert.equal(refLinks('| flow:registro-e-inicio | mod:carpetas y mod:otro |'), '| [flow:registro-e-inicio](laru:flow%3Aregistro-e-inicio) | [mod:carpetas](laru:mod%3Acarpetas) y mod:otro |', 'an id no piece has stays');
  assert.equal(refLinks('[[mod:otro]]'), '[mod:otro](laru:mod%3Aotro)', 'what someone linked on purpose stays a link');
  for (const t of ['https://x.test/flow:registro-e-inicio', 'ruta /api/flow:registro-e-inicio', 'nota:importante', 'a.flow:registro-e-inicio', '[flow:registro-e-inicio](laru:flow%3Aregistro-e-inicio)']) assert.equal(refLinks(t), t, t);
});
