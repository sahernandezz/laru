/** The short loop: which flows «repetir fallidos» picks (unexpected failures in that env, never known deviations), and how runners are split. */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initWorkspace, knowledgeWrite, loadKnowledge } from '@laru/core';
import type { Trace } from '@laru/trace';
import { failedFlows, fixedOf, runsDir, splitFlows, workersFor, type FlowSpec } from '../src/index.ts';

function fixture(slugs: string[]) {
  const ws = initWorkspace(join(mkdtempSync(join(tmpdir(), 'ks-loop-')), 'ws'), { app: 'shop', title: 'Shop', docsLanguage: 'es' });
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Shop', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pedidos'], team: [{ part: 'Todo', team: 'Equipo' }] } }).ok);
  assert.ok(knowledgeWrite(ws, { type: 'module', in: 'app:shop', title: 'Pedidos', kind: 'feature', status: 'active', summary: 'Pedidos.', fields: { purpose: 'Pedir.' } }).ok);
  for (const title of slugs) {
    const w = knowledgeWrite(ws, { type: 'flow', in: 'mod:pedidos', title, status: 'active', summary: 'Un flujo.', fields: { goal: 'Algo.', actors: ['Cliente'], steps: [{ step: 'Hacer', actor: 'Cliente', expected: 'Hecho' }] } });
    assert.ok(w.ok, JSON.stringify(w.issues));
  }
  for (const p of loadKnowledge(ws).pieces.filter((x) => x.type === 'flow')) writeFileSync(join(ws.root, p.dir, `${p.id.replace(/^flow:/, '')}.spec.ts`), '// spec');
  mkdirSync(runsDir(ws), { recursive: true });
  const row = (r: object) => appendFileSync(join(runsDir(ws), 'index.jsonl'), JSON.stringify(r) + '\n');
  return { ws, row };
}

test('«repetir fallidos»: the flows whose newest result in that env failed or errored; a green run with known deviations, a cached one and another env\'s are not', () => {
  const { ws, row } = fixture(['alfa', 'beta', 'gamma', 'delta', 'epsilon']);
  row({ run: '1', flow: 'alfa', status: 'failed', env: 'local' });
  row({ run: '1', flow: 'beta', status: 'failed', env: 'local' });
  row({ run: '2', flow: 'beta', status: 'passed', env: 'local', known: 2 });   // beta was fixed to green, with its two known deviations
  row({ run: '1', flow: 'gamma', status: 'error', env: 'local' });
  row({ run: '1', flow: 'delta', status: 'failed', env: 'otro' });
  row({ run: '3', flow: 'epsilon', status: 'failed', env: 'local' });
  row({ run: '4', flow: 'epsilon', status: 'cached', env: 'local' });          // reused a passing result
  row({ run: '5', flow: 'sin-spec', status: 'failed', env: 'local' });          // no such flow any more
  assert.deepEqual(failedFlows(ws, 'local'), ['alfa', 'gamma']);
  assert.deepEqual(failedFlows(ws, 'otro'), ['delta']);
  assert.deepEqual(failedFlows(ws), ['alfa', 'delta', 'gamma'], 'without an env, the newest result wherever it ran');
});

test('runners: as many as asked, at least one; the flows split by how long each took, longest first', async () => {
  assert.equal(await workersFor(2), 2);
  assert.equal(await workersFor(0.4), 1, 'less than one is one');
  const { ws, row } = fixture(['lento', 'medio', 'rapido', 'otro']);
  row({ run: '1', flow: 'lento', status: 'passed', ms: 100_000 });
  row({ run: '1', flow: 'medio', status: 'passed', ms: 60_000 });
  row({ run: '1', flow: 'rapido', status: 'passed', ms: 10_000 });
  row({ run: '1', flow: 'otro', status: 'passed', ms: 50_000 });
  const flows = loadKnowledge(ws).pieces.filter((p) => p.type === 'flow').map((p) => ({ slug: p.id.replace(/^flow:/, '') }) as FlowSpec);
  const split = splitFlows(ws, flows, 2).map((s) => s.map((f) => f.slug).sort());
  assert.deepEqual(split.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0])), [['lento', 'rapido'], ['medio', 'otro']].map((x) => x).sort((a, b) => b.length - a.length || a[0].localeCompare(b[0])), '100+10 against 60+50');
  assert.deepEqual(splitFlows(ws, flows, 9).length, 4, 'never more runners than flows');
  assert.deepEqual(splitFlows(ws, [], 3), []);
});

test('a known deviation that stops failing is named: a step of a green story, or a case; one still failing, or one that was never a deviation, is not', () => {
  const t = (o: Partial<Trace>) => ({ v: 1, test: 'Historia', story: true, status: 'failed', stepsTotal: 2, failure: { step: 1, message: 'x', known: 1, unexpected: 0 }, steps: [], exchanges: [], logs: [], participants: [], ...o }) as unknown as Trace;
  const steps = (...st: Array<[string, string]>) => st.map(([title, status], i) => ({ n: i + 1, title, status })) as unknown as Trace['steps'];
  const before = [t({ steps: steps(['Subir', 'failed'], ['Bajar', 'passed']) }), t({ test: '100 MB', story: false, steps: [] })];
  assert.deepEqual(fixedOf(before, [t({ status: 'passed', failure: undefined, steps: steps(['Subir', 'passed'], ['Bajar', 'passed']) }), t({ test: '100 MB', story: false, status: 'passed', failure: undefined })]), ['Subir', '100 MB']);
  assert.deepEqual(fixedOf(before, [t({ steps: steps(['Subir', 'failed'], ['Bajar', 'passed']) }), t({ test: '100 MB', story: false })]), [], 'still failing');
  const red = [t({ failure: { step: 1, message: 'x', known: 1, unexpected: 1 }, steps: steps(['Subir', 'failed']) })];
  assert.deepEqual(fixedOf(red, [t({ status: 'passed', steps: steps(['Subir', 'passed']) })]), [], 'it was red, not a known deviation: nothing to update');
});
