/** A flow's `timeout`: the units flow.md writes, and what is refused. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLimit } from '../src/index.ts';

test('a limit is a duration between 1 second and 2 hours', () => {
  assert.equal(parseLimit('30s'), 30_000);
  assert.equal(parseLimit('2m'), 120_000);
  assert.equal(parseLimit('1h'), 3_600_000);
  assert.equal(parseLimit('1500ms'), 1500);
  assert.equal(parseLimit(' 1.5m '), 90_000);
  assert.equal(parseLimit('2H'), 7_200_000);
  for (const bad of ['', 'soon', '0s', '500ms', '3h', '-5s', '30', 30, null, undefined, '5 minutos', '1e3s']) assert.equal(parseLimit(bad), null, String(bad));
});
