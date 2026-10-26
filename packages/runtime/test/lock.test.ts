import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withLock } from '../src/docker.ts';

test('the machine lock: re-entered by the operation that holds it, waited for by any other', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ks-lock-')), 'runtime.lock');
  const order: string[] = [];
  // A run that starts its env: the nested lock of the same operation enters at once (it used to wait for itself).
  const nested = await withLock('run', () => withLock('up', async () => 'inner', undefined, file), undefined, file);
  assert.equal(nested, 'inner');
  // Two operations of one process (the daemon): the second waits for the first.
  let release!: () => void;
  const first = withLock('a', () => new Promise<void>((r) => { order.push('a:start'); release = () => { order.push('a:end'); r(); }; }), undefined, file);
  await new Promise((r) => setTimeout(r, 50));
  const second = withLock('b', async () => { order.push('b'); }, undefined, file);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(order, ['a:start'], 'b waits while a holds the lock');
  release();
  await first;
  await second;
  assert.deepEqual(order, ['a:start', 'a:end', 'b']);
});
