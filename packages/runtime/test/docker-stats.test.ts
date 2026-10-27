/** A screen asking for CPU and memory gets the last sample at once; only the first ask of a set waits for Docker's. */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { recentStats } from '../src/docker.ts';
import { dockerUp } from './guard.ts';

test('recentStats answers the second ask from the last sample, without waiting on docker stats again', { skip: !dockerUp && 'Docker is not running' }, async (t) => {
  // reading what runs is all this does: nothing is started or changed
  const ids = execFileSync('docker', ['ps', '-q'], { encoding: 'utf8' }).split('\n').filter(Boolean).slice(0, 3);
  if (!ids.length) { t.skip('no container is running'); return; }
  const first = await recentStats(ids, 60_000);
  assert.equal(first.length, ids.length);
  const t0 = performance.now();
  const again = await recentStats(ids, 60_000);
  assert.ok(performance.now() - t0 < 500, 'answered from the last sample');
  assert.deepEqual(again, first);
  // older than `fresh`: still the last sample at once, a new one taken behind it
  const t1 = performance.now();
  await recentStats(ids, 0);
  assert.ok(performance.now() - t1 < 500, 'a stale sample comes back at once too');
});
