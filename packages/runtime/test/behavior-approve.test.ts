/** A behavior is approved from a green run only, with stable step keys; the drift of a later run reads them. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initWorkspace, knowledgeWrite, loadKnowledge } from '@laru/core';
import { approveBehavior, behaviorDrift, readApproved, runsDir } from '../src/index.ts';

function fixture() {
  const ws = initWorkspace(join(mkdtempSync(join(tmpdir(), 'ks-approve-')), 'ws'), { app: 'shop', title: 'Shop', docsLanguage: 'es' });
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Shop', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pedidos'], team: [{ part: 'Todo', team: 'Equipo' }] } }).ok);
  assert.ok(knowledgeWrite(ws, { type: 'module', in: 'app:shop', title: 'Pedidos', kind: 'feature', status: 'active', summary: 'Pedidos.', fields: { purpose: 'Pedir.' } }).ok);
  const w = knowledgeWrite(ws, { type: 'flow', in: 'mod:pedidos', title: 'Pedir', status: 'active', summary: 'Se pide.', fields: { goal: 'Pedido.', actors: ['Cliente'], steps: [{ step: 'Pedir', actor: 'Cliente', expected: 'Hecho' }, { step: 'Pagar', actor: 'Cliente', expected: 'Pagado' }] } });
  assert.ok(w.ok);
  mkdirSync(runsDir(ws), { recursive: true });
  const ex = (id: string, step: number, to: string, method: string, path: string, t0: number) => ({ id, kind: 'http', from: 'browser', to, t0, t1: t0 + 5, step, label: `${method} ${path}`, ok: true, origin: 'observed', status: 200, method, path });
  const play = (run: string, o: { failure?: object; status?: string; second?: string }) => {
    mkdirSync(join(runsDir(ws), run, 'flows', 'pedir'), { recursive: true });
    writeFileSync(join(runsDir(ws), run, 'flows', 'pedir', 'trace.json'), JSON.stringify({ v: 1, run, flow: 'pedir', test: 'S', env: 'local', t0: 0, durationMs: 9, status: o.status ?? 'passed', story: true, stepsTotal: 2, participants: [], logs: [],
      steps: [{ n: 1, title: 'Pedir', t0: 0, t1: 10, status: 'passed' }, { n: 2, title: o.second ?? 'Pagar', t0: 10, t1: 20, status: o.status === 'failed' ? 'failed' : 'passed' }],
      exchanges: [ex('a', 1, 'api', 'POST', '/orders', 1), ex('b', 2, 'api', 'POST', '/orders/9/pay', 11)], ...(o.failure ? { failure: o.failure } : {}) }));
    writeFileSync(join(runsDir(ws), run, 'run.json'), JSON.stringify({ id: run, env: 'local', flows: ['pedir'], phase: 'done', status: 'passed', startedAt: new Date().toISOString(), pid: 1, results: {} }));
  };
  const row = (r: object) => writeFileSync(join(runsDir(ws), 'index.jsonl'), JSON.stringify(r) + '\n', { flag: 'a' });
  return { ws, play, row, id: loadKnowledge(ws).pieces.find((p) => p.type === 'flow')!.id };
}

test('a behavior is approved from a green run: the unexpected failure of a red one is refused, a known deviation is carried', () => {
  const { ws, play, row, id } = fixture();
  play('1', { status: 'failed', failure: { step: 2, message: 'expect(locator).toBeVisible() failed', known: 0, unexpected: 1 } });
  row({ run: '1', flow: 'pedir', status: 'failed' });
  assert.throws(() => approveBehavior(ws, id), /last run was not green/);
  assert.throws(() => approveBehavior(ws, id, { run: '1' }), /not green for pedir: 1 unexpected failure/);

  play('2', { status: 'failed', failure: { step: 2, message: 'x', known: 2, unexpected: 0 } });
  row({ run: '2', flow: 'pedir', status: 'passed', known: 2 });
  const a = approveBehavior(ws, id);
  assert.deepEqual([a.run, a.hops, a.soft], ['2', 2, 2]);
  const doc = readFileSync(a.file, 'utf8');
  assert.match(doc, /key: pedir\n/);
  assert.match(doc, /key: pagar\n/);
  assert.deepEqual(readApproved(ws, id)!.steps.map((s) => [s.key, s.n, s.step]), [['pedir', 1, 'Pedir'], ['pagar', 2, 'Pagar']]);
});

test('a later run is compared through the keys: a retitled step still answers for its own, a changed write is the drift', () => {
  const { ws, play, row, id } = fixture();
  play('1', {}); row({ run: '1', flow: 'pedir', status: 'passed' });
  approveBehavior(ws, id);
  play('2', { second: 'Pagar el pedido' });
  assert.deepEqual(behaviorDrift(ws, '2', id)!.drifts, [], 'the second step was retitled, nothing it does changed');
  // an old file from before the keys is read by its titles
  writeFileSync(join(ws.root, loadKnowledge(ws).byId.get(id)!.dir, 'behavior.yaml'), readFileSync(join(ws.root, loadKnowledge(ws).byId.get(id)!.dir, 'behavior.yaml'), 'utf8').replace(/ {4}key: .*\n/g, '').replace(/ {4}n: .*\n/g, ''));
  assert.deepEqual(readApproved(ws, id)!.steps.map((s) => s.key), ['pedir', 'pagar']);
});
