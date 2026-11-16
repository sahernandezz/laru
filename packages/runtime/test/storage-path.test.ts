/** An object's path in the store: a part that climbs is refused, a name with two dots in it is a name. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { storage } from '../src/index.ts';

test('a stored file named with «..» opens; a path that climbs or quotes does not', () => {
  assert.equal(storage.objectPath('files/captura 8.21.34 p.m..png'), "'ks/files/captura 8.21.34 p.m..png'");
  for (const bad of ['files/../secret', '../x', "files/it's", 'a\\b']) assert.throws(() => storage.objectPath(bad), /not a valid object path/, bad);
});
