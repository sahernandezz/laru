import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'ks-reporter-'));
process.env.KS_EVENTS = join(dir, 'events.jsonl');
const { default: Reporter } = await import('../src/reporter.ts');
after(() => rmSync(dir, { recursive: true, force: true }));

const step = (title: string, extra: Record<string, unknown> = {}) => ({ category: 'pw:api', title, startTime: new Date(1_800_000_000_000), duration: 12, steps: [], titlePath: () => [title], ...extra });
const tc = { id: 't1' } as never;

test('an action is a mark: its kind and target, a named key, a path without query; never the title or the typed value', () => {
  const r = new Reporter();
  r.onStepEnd(tc, {} as never, step('Fill "Passw0rd!x"', { subtitle: "getByPlaceholder('Ingresa tu contraseña')", params: { locator: "getByPlaceholder('Ingresa tu contraseña')", value: 'Passw0rd!x' } }) as never);
  r.onStepEnd(tc, {} as never, step('Press "Enter"', { subtitle: "getByRole('textbox')", params: { key: 'Enter' } }) as never);
  r.onStepEnd(tc, {} as never, step('Press "a"', { subtitle: "getByRole('textbox')", params: { key: 'a' } }) as never);
  r.onStepEnd(tc, {} as never, step('Navigate', { subtitle: 'http://frontend/login?next=%2Ffiles#x' }) as never);
  r.onStepEnd(tc, {} as never, step('Click', {}) as never);
  r.onStepEnd(tc, {} as never, step('Evaluate', { subtitle: "getByRole('main')" }) as never);
  r.onStepEnd(tc, {} as never, step('Screenshot') as never);
  r.onStepEnd(tc, {} as never, step('Click', { category: 'expect', subtitle: 'x' }) as never);
  const text = readFileSync(process.env.KS_EVENTS!, 'utf8');
  assert.ok(!text.includes('Passw0rd!x'), 'the typed value is nowhere in the file');
  const marks = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(marks.map(({ t: _t, ...m }) => m), [
    { e: 'action', test: 't1', t0: 1_800_000_000_000, ms: 12, kind: 'fill', target: "getByPlaceholder('Ingresa tu contraseña')" },
    { e: 'action', test: 't1', t0: 1_800_000_000_000, ms: 12, kind: 'press', target: "getByRole('textbox')", key: 'Enter' },
    { e: 'action', test: 't1', t0: 1_800_000_000_000, ms: 12, kind: 'press', target: "getByRole('textbox')" },
    { e: 'action', test: 't1', t0: 1_800_000_000_000, ms: 12, kind: 'navigate', path: '/login' },
    { e: 'action', test: 't1', t0: 1_800_000_000_000, ms: 12, kind: 'click' },
  ]);
});
