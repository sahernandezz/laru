/** A flow's `timeout` and `screen`: what flow.md writes, and what is refused. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLimit, parseScreen } from '../src/index.ts';

test('a limit is a duration between 1 second and 2 hours', () => {
  assert.equal(parseLimit('30s'), 30_000);
  assert.equal(parseLimit('2m'), 120_000);
  assert.equal(parseLimit('1h'), 3_600_000);
  assert.equal(parseLimit('1500ms'), 1500);
  assert.equal(parseLimit(' 1.5m '), 90_000);
  assert.equal(parseLimit('2H'), 7_200_000);
  for (const bad of ['', 'soon', '0s', '500ms', '3h', '-5s', '30', 30, null, undefined, '5 minutos', '1e3s']) assert.equal(parseLimit(bad), null, String(bad));
});

test('a screen is width x height, each side between 240 and 3840 pixels', () => {
  assert.deepEqual(parseScreen('1920x1080'), { width: 1920, height: 1080 });
  assert.deepEqual(parseScreen(' 390 X 844 '), { width: 390, height: 844 });
  assert.deepEqual(parseScreen('1366×768'), { width: 1366, height: 768 });
  for (const bad of ['', 'phone', '1920', '1920x', '100x800', '5000x1000', '1920*1080', null, undefined, 1920]) assert.equal(parseScreen(bad), null, String(bad));
});
