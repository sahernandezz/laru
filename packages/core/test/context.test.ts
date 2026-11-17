/**
 * What the agent reads of the graph: an endpoint with what runs saw it do and the flows that reach it, a table with who
 * writes it (and through which endpoint), questions in Spanish or by the documentation's words, and a checkout that
 * moved past what the map read.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addRepo, ask, context, initWorkspace, knowledgeWrite, loadGraph, loadKnowledge, refreshMap, stateDir, tree } from '../src/index.ts';
import { makeFixture } from './fixture.ts';

test('the graph as the agent reads it', async (t) => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio', docsLanguage: 'es' });
  await addRepo(ws, fx.billingUrl);
  await addRepo(ws, fx.portalUrl);
  await refreshMap(ws);
  const st = stateDir(ws);
  const ep = 'ep:billing-api:POST /refunds';
  // a run saw the refund endpoint write its table, and the flow «devolver» reached it
  writeFileSync(join(st, 'observed.json'), JSON.stringify({ facts: [{ s: 'svc:billing-api', p: 'writes', o: 'tbl:billing.refunds', via: [ep], seen: { run: '3', at: new Date().toISOString(), count: 2 } }] }));
  mkdirSync(join(st, 'runs', '3', 'flows', 'devolver'), { recursive: true });
  writeFileSync(join(st, 'runs', 'index.jsonl'), `${JSON.stringify({ run: '3', flow: 'devolver', status: 'passed', at: new Date().toISOString() })}\n`);
  writeFileSync(join(st, 'runs', '3', 'flows', 'devolver', 'trace.json'), JSON.stringify({
    participants: [{ id: 'billing-api', node: 'svc:billing-api' }],
    exchanges: [{ id: 'a', from: 'portal', endpoint: ep, method: 'POST', path: '/refunds' }, { id: 'b', from: 'billing-api', kind: 'sql', table: 'billing.refunds' }],
  }));
  const g = loadGraph(ws);

  await t.test('an endpoint says what runs saw it do and which flows reach it; a table, who writes it and through which endpoint', () => {
    const out = context(g, ws, ep);
    assert.match(out, /## What it did in runs \(1\)\n- writes table billing\.refunds/);
    assert.match(out, /## Flows that reach it \(their last run\) \(1\)\n- flow:devolver/);
    const table = context(g, ws, 'tbl:billing.refunds');
    assert.match(table, /is written by svc:billing-api — by POST \/refunds \[observed\]/);
    assert.match(table, /## Flows that go through it \(their last run\) \(1\)\n- flow:devolver/);
  });

  await t.test('a question in Spanish, with the kind and the verb it names, finds the table and its writers first', () => {
    const out = ask(g, '¿Quién escribe la tabla de refunds?');
    const first = out.split('\n## ')[1];
    assert.match(first, /^tbl:billing\.refunds/);
    assert.match(first.split('\n')[1], /is written by svc:billing-api/, 'the verb asked for comes first');
  });

  await t.test('the documentation answers in its own words, and brings what it names', () => {
    assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda en línea.', fields: { purpose: 'Vender.' } }).ok);
    assert.ok(knowledgeWrite(ws, { type: 'decision', in: 'app:comercio', title: 'Las devoluciones van por cola', summary: 'El reembolso se encola.', fields: { context: 'Stripe tarda.', decision: '`POST /refunds` deja el reembolso pendiente y publica `refund.requested`.', alternatives: [{ option: 'Esperar a Stripe', 'why-not': 'Se agota el tiempo' }], tradeoffs: 'Llega un correo después.' } }).ok);
    const out = ask(g, 'cómo funcionan las devoluciones', 2000, loadKnowledge(ws));
    assert.match(out, /## Documentation \(1\)\n- dec:las-devoluciones-van-por-cola «Las devoluciones van por cola» — El reembolso se encola\. \(names ep:billing-api:POST \/refunds, topic:refund\.requested\)/);
    assert.match(out, /## ep:billing-api:POST \/refunds/, 'what the piece names joins the answer');
  });

  await t.test('a checkout that moved past what the map read is said, with what to do', () => {
    const repo = ws.checkouts.billing;
    fx.write(repo, { 'api/src/main/java/acme/Note.java': 'class Note {}' });
    fx.sh(repo, 'add', '-A');
    fx.sh(repo, 'commit', '--quiet', '-m', 'local note');
    fx.write(repo, { 'api/src/main/java/acme/Note.java': 'class Note { int x; }' });
    const out = context(g, ws, 'svc:billing-api');
    assert.match(out, /Your checkout of billing is 1 commit ahead of what the map read \([0-9a-f]{7}\), with uncommitted changes: what follows is that commit; `impact` says what your changes touch\./);
    assert.match(tree(g, 2, ws), /repo:billing .*— your checkout: 1 ahead, uncommitted changes \(impact\)/);
  });
});
