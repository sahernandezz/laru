import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addRepo, initWorkspace, knowledgeWrite, liveOf, loadGraph, loadKnowledge, refreshMap, serviceTests } from '../src/index.ts';
import { makeFixture } from './fixture.ts';

test('a module sheet reads its interfaces, variables, tables and tests from the code its anchors point at', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio', docsLanguage: 'es' });
  await addRepo(ws, fx.billingUrl);
  await refreshMap(ws);
  const g = loadGraph(ws);
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda en línea.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } }, g).ok);
  const m = knowledgeWrite(ws, { type: 'module', in: 'app:comercio', title: 'Devoluciones', kind: 'feature', status: 'active', summary: 'Devolver un pedido pagado.', anchors: ['billing:api/src/main/java/acme/RefundResource.java'], fields: { purpose: 'p' } }, g);
  assert.ok(m.ok, JSON.stringify(m.issues));
  assert.ok(knowledgeWrite(ws, { type: 'contract', in: 'mod:devoluciones', title: 'API de devoluciones', status: 'draft', summary: 'Lo que expone la devolución.', fields: { purpose: 'p', operations: [{ method: 'POST', path: '/refunds', service: 'svc:billing-api' }, { method: 'GET', path: '/refunds/{id}', service: 'svc:billing-api' }] } }, g).ok);
  const k = loadKnowledge(ws);
  const live = liveOf(ws, k, g, k.byId.get('mod:devoluciones')!);

  assert.deepEqual(live.endpoints.map((e) => `${e.method} ${e.path} ${e.declared}`), ['POST /refunds true']);
  assert.deepEqual(live.declaredOnly.map((o) => `${o.method} ${o.path}`), ['GET /refunds/{id}'], 'a contract operation the code lacks');
  assert.ok(live.events.some((e) => e.topic.includes('refund') && e.dir === 'publishes'));
  assert.ok(live.vars.some((v) => v.name.length && !('value' in v)), 'a variable is named, never valued');
  assert.deepEqual(live.tests.map((t) => `${t.file}:${t.cases.map((c) => c.name).join(',')}`), ['billing:api/src/test/java/acme/RefundResourceTest.java:creates,rejects']);
  // the service sheet reads the same tests from the service's directory
  assert.deepEqual(serviceTests(ws, g, 'svc:billing-api').map((t) => `${t.file}:${t.count}`), ['billing:api/src/test/java/acme/RefundResourceTest.java:2']);
});

test('a flow lists its spec by name and line, and the places it records what the app really does', () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio', docsLanguage: 'es' });
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda en línea.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } }).ok);
  const dir = join(ws.root, 'docs/flows/pagar');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'flow.md'), '---\nid: flow:pagar\ntype: flow\ntitle: Pagar\nstatus: active\nsummary: El cliente paga un pedido.\n---\n\n# Pagar\n');
  writeFileSync(join(dir, 'pagar.spec.ts'), "import { test } from '@playwright/test';\ntest('paga con tarjeta', async () => {\n  // app: acepta una tarjeta vencida\n});\ntest('rechaza sin saldo', async () => {});\n");
  const k = loadKnowledge(ws);
  const live = liveOf(ws, k, null, k.byId.get('flow:pagar')!);
  assert.deepEqual(live.tests.map((t) => t.cases.map((c) => `${c.name}:${c.line}`)), [['paga con tarjeta:2', 'rechaza sin saldo:5']]);
  assert.deepEqual(live.deviations, [{ line: 3, text: 'acepta una tarjeta vencida' }]);
});
