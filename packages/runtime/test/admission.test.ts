import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { decide, type Held } from '../src/admission.ts';

const GiB = 2 ** 30;
const held = (env: string, gib: number, extra: Partial<Held> = {}): Held => ({ key: 'k1', app: 'vaultflow', env, run: '', memBytes: gib * GiB, ...extra });

test('foreign containers hold memory too: what is not Laru\'s is counted', () => {
  // 8 GiB, a Laru env at 2, the supabase stack and friends at 4 more: a 3 GiB start does not fit (6 + 3 > 7.2)
  const d = decide({ total: 8 * GiB, need: 3 * GiB, laru: [held('local', 2)], allBytes: 6 * GiB, settled: () => undefined, mine: { key: 'k1' } });
  assert.equal(d.fits, false);
  assert.equal(d.foreignBytes, 4 * GiB);
  assert.deepEqual(d.offer && d.offer.env, 'local', 'stopping local (2 GiB) makes 4 + 3 fit');
});

test('an instance that has just started is counted at what it will settle at, not at its first reading', () => {
  const now = Date.parse('2026-10-26T10:00:00Z');
  const young = held('local', 0.4, { run: 'f-compartir', startedAt: new Date(now - 30_000).toISOString() });
  const settledAt = (h: Held) => (h.env === 'local' ? 2.5 * GiB : undefined);
  const early = decide({ total: 8 * GiB, need: 5 * GiB, laru: [young], allBytes: 0.4 * GiB, settled: settledAt, mine: { key: 'k1' }, now });
  assert.equal(early.fits, false, '0.4 + 5 would fit, 2.5 + 5 does not');
  const later = decide({ total: 8 * GiB, need: 5 * GiB, laru: [{ ...young, startedAt: new Date(now - 20 * 60_000).toISOString() }], allBytes: 0.4 * GiB, settled: settledAt, mine: { key: 'k1' }, now });
  assert.equal(later.fits, true, 'once settled, its reading is what counts');
});

test('only an env of this workspace is offered, and only when its stop is enough', () => {
  const other = held('local', 5, { key: 'k2', app: 'otra' });
  const d = decide({ total: 8 * GiB, need: 3 * GiB, laru: [other], allBytes: 5 * GiB, settled: () => undefined, mine: { key: 'k1' } });
  assert.equal(d.fits, false);
  assert.equal(d.offer, undefined, 'another workspace\'s env is named, never stopped for you');
  const own = decide({ total: 8 * GiB, need: 3.5 * GiB, laru: [held('fast', 1), held('local', 5)], allBytes: 6 * GiB, settled: () => undefined, mine: { key: 'k1' } });
  assert.equal(own.offer?.env, 'local', 'fast alone would not be enough; local is');
});
