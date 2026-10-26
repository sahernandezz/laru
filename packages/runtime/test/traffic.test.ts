import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trafficSince } from '../src/runs.ts';

/** a journal of `n` exchanges, one every 10 ms, each written when it ends (so a little out of order) */
function journal(dir: string, name: string, from: number, n: number) {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(JSON.stringify({ t0: from + i * 10 - (i % 7 === 0 ? 40 : 0), ms: 12, from: 'frontend', to: 'api-gateway', method: 'GET', path: `/api/files/${i}`, status: 200, pad: 'x'.repeat(200) }));
  writeFileSync(join(dir, name), lines.join('\n') + '\n');
}

test('the recent end of a journal is read without reading the whole of it, and gives what a whole read gives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ks-traffic-'));
  const base = 1_700_000_000_000;
  journal(dir, 'traffic.jsonl.1', base, 20_000);
  journal(dir, 'traffic.jsonl', base + 20_000 * 10 + 1000, 20_000);
  const files = ['traffic.jsonl.1', 'traffic.jsonl'].map((f) => join(dir, f));
  const whole = (from: number) => files.flatMap((f) => readFileSync(f, 'utf8').split('\n')).filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.t0 >= from);
  for (const from of [base + 5 * 10_000, base + 300_000, base + 20_000 * 10 + 1000 + 150_000, base + 10_000_000]) {
    assert.deepEqual(trafficSince(files, from).map((r) => r.path), whole(from).map((r) => r.path), `from ${from - base}`);
  }
  assert.deepEqual(trafficSince([join(dir, 'missing.jsonl')], base), []);
});
