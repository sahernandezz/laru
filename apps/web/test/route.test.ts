import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { href, idOf, keyAddress, keyMasked, keyOf, moved, partsOf, splitStop, stopIn, testIn, whereFailed, withStop } from '../src/lib/route.ts';

test('old addresses land on their new home; the rest stay', () => {
  assert.equal(moved(['services']), '#/map');
  assert.equal(moved(['services', 'file-service']), '#/map/svc%3Afile-service');
  assert.equal(moved(['flows']), null, 'the flows have their own screen');
  assert.equal(moved(['flows', 'x']), '#/docs');
  assert.equal(moved(['docs', 'svc:x']), '#/map/svc%3Ax');
  assert.equal(moved(['docs', 'ds:postgres']), '#/map/ds%3Apostgres');
  assert.equal(moved(['docs', 'svc:x', 'edit']), null, 'the edit form stays in docs');
  assert.equal(moved(['docs', 'new', 'service', 'app:a', 'svc:x']), null);
  assert.equal(moved(['docs', 'mod:a']), null);
  assert.equal(moved(['map', 'svc:x']), null);
  assert.equal(moved([]), null);
});

test('a flow’s evidence opens on the story, even when a case failed; only an address that names a test opens it', () => {
  const tests = [{ test: 'Mandar a la papelera y restaurar', status: 'passed' }, { test: 'Borrar un fichero pendiente de escaneo', status: 'failed' }];
  assert.equal(testIn(tests), 0);
  assert.equal(testIn(tests, 'Borrar un fichero pendiente de escaneo'), 1);
  assert.equal(testIn(tests, 'un caso que ya no existe'), 0);
});

test('«Ver dónde falló» says in its address which test failed: the story by default, else the case', () => {
  type Last = Parameters<typeof whereFailed>[0]['last'];
  const at = (last: Last) => whereFailed({ id: 'flow:x', last });
  assert.equal(at({ status: 'failed', failure: { step: 4 }, cases: [{ test: 'Un caso', status: 'failed' }] }), '#/docs/flow%3Ax/map');
  assert.equal(at({ status: 'failed', cases: [{ test: 'Pasa', status: 'passed' }, { test: 'Borrar un fichero', status: 'failed' }] }), '#/docs/flow%3Ax/map/Borrar%20un%20fichero');
  assert.equal(at({ status: 'passed', cases: [] }), undefined);
  assert.equal(at(null), undefined);
});

test('a MongoDB _id keeps its type in its address whenever the bare form would read as another', () => {
  const hex = '507f1f77bcf86cd799439011';
  assert.deepEqual([idOf({ $oid: hex }), idOf(hex)], [hex, `"${hex}"`], 'an ObjectId and a string of its hex');
  assert.deepEqual([idOf(5), idOf('5')], ['5', '"5"'], 'a number and a string of its digits');
  assert.deepEqual([idOf('bea'), idOf('true'), idOf('{"a":1}'), idOf({ $numberLong: '9' }), idOf(undefined)], ['bea', '"true"', '"{\\"a\\":1}"', '{"$numberLong":"9"}', undefined]);
});

test('an empty name has an address that opens it: an empty part is no part of a route', () => {
  assert.equal(idOf(''), '""', 'an empty _id is quoted, and /api/mongo/doc reads "" back as the empty string');
  assert.equal(keyAddress(''), '""');
  for (const k of ['', 'user:1', '"x"', '"', '""x', 'a/b#c?d%25e', 'clé…abcd', '"a"b"']) assert.equal(keyOf(keyAddress(k)), k, JSON.stringify(k));
  assert.equal(keyAddress('user:1'), 'user:1', 'a plain name is its own address');
  assert.ok(keyAddress('').length > 0 && keyAddress('"x"') !== '"x"');
});

test('a Redis name the back end flagged as masked stays masked when another list leaves it out; a name no list has is unknown', () => {
  const seen = new Set<string>(), name = 'session:…ipmJ';
  assert.equal(keyMasked(name, [{ key: name, masked: true }, { key: 'json:1' }], seen), true);
  assert.equal(keyMasked(name, [{ key: 'json:1' }], seen), true, 'searching json:* does not make it readable by its masked name');
  assert.equal(keyMasked(name, [], seen), true, 'nor does a list that failed');
  assert.equal(keyMasked('json:1', [{ key: 'json:1' }], seen), false, 'listed and not flagged: read by its name');
  assert.equal(keyMasked('user:9', [{ key: 'json:1' }], seen), undefined, 'not listed: unknown, not readable by name for sure');
  assert.equal(keyMasked(name, [{ key: 'json:1' }], new Set()), undefined, 'past the cap on a fresh page: unknown');
});

test('«Paso a paso» writes its stop after a flow’s address, on the flow page and in Runs, and reads it back from the end', () => {
  const bases = [
    href('docs', 'flow:subir-fichero-limpio', 'seq'), href('docs', 'flow:subir-fichero-limpio', 'seq', 'Subir sin sesión'),
    href('runs', '42', 'subir-fichero-limpio'), href('runs', '42', 'subir-fichero-limpio', 'Subir sin sesión'),
  ];
  const stops = ['accion-941f3bc1', 'accion-m3', 'preparacion', 'sql:postgres:1792658483493:63', '96b4eb56.2', '96b4eb56/respuesta', 'kafka:file.clean:0:7>file-service', 'fallo'];
  for (const base of bases) {
    assert.equal(stopIn(base), undefined, base);
    for (const stop of stops) {
      const at = withStop(base, stop);
      assert.equal(stopIn(at), stop, at);
      assert.deepEqual(splitStop(partsOf(at))[0], partsOf(base), `${at}: the screen’s own parts are left as they were`);
    }
  }
  assert.equal(withStop(bases[0]), bases[0], 'no stop, no suffix');
});

test('a test titled «paso a paso» is a test, not a stop', () => {
  for (const at of [href('runs', '42', 'x', 'paso a paso'), href('runs', '42', 'x', 'Paso-a-paso de la subida'), href('docs', 'flow:x', 'seq', 'paso a paso')]) {
    assert.equal(stopIn(at), undefined, at);
    assert.deepEqual(splitStop(partsOf(at))[0], partsOf(at));
  }
  assert.equal(stopIn(withStop(href('runs', '42', 'x', 'paso a paso'), 'fallo')), 'fallo');
});
