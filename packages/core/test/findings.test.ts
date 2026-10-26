import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { acceptFinding, addRepo, computeFindings, Graph, initWorkspace, knowledgeWrite, loadGraph, loadKnowledge, refreshMap } from '../src/index.ts';
import { makeFixture } from './fixture.ts';

test('findings: one seeded case per type, accepted with a reason, reopened when it expires', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio' });
  await addRepo(ws, fx.billingUrl);
  await addRepo(ws, fx.portalUrl, { role: 'frontend' });
  await refreshMap(ws);
  const g0 = loadGraph(ws);
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => { const r = knowledgeWrite(ws, x, g0); assert.ok(r.ok, JSON.stringify(r.issues)); };
  w({ type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } });
  w({ type: 'convention', in: 'app:comercio', title: 'Sin anotar secretos', summary: 'Los secretos vienen de la bóveda.', anchors: ['billing:api/src/main/java/acme/RefundResource.java'], fields: { rule: 'No se lee un secreto con ConfigProperty.', rationale: 'Va a la bóveda.', good: '`@Inject Vault`', check: ['forbid: webhook-secret'] } });
  w({ type: 'service', id: 'svc:billing-api', in: 'app:comercio', title: 'billing-api', summary: 'Cobros y devoluciones.', fields: { responsibility: 'Cobrar y devolver.' } });
  w({ type: 'contract', in: 'svc:billing-api', title: 'API de devoluciones', summary: 'Pedir devoluciones.', fields: { purpose: 'Pedir devoluciones.', operations: [{ method: 'POST', path: '/refunds', service: 'svc:billing-api', summary: 'Pide una devolución' }], errors: [{ status: '409', when: 'Ya devuelto' }] } });

  // What runs saw: one call the code does not declare, writes to one table from two services, a flaky flow.
  const sd = join(ws.root, '.laru');
  writeFileSync(join(sd, 'observed.json'), JSON.stringify({ facts: [
    { s: 'svc:billing-api', p: 'calls', o: 'ep:portal:POST /api/refunds', seen: { run: '3', at: new Date().toISOString(), count: 2 } },
    { s: 'svc:portal', p: 'writes', o: 'tbl:billing.refunds', seen: { run: '3', at: new Date().toISOString(), count: 1 } },
    { s: 'svc:billing-api', p: 'writes', o: 'tbl:billing.refunds', seen: { run: '3', at: new Date().toISOString(), count: 1 } },
  ] }));
  mkdirSync(join(sd, 'runs', '3', 'flows', 'devolver'), { recursive: true });
  writeFileSync(join(sd, 'runs', 'index.jsonl'), ['passed', 'failed', 'error', 'passed', 'failed', 'passed'].map((s, i) => JSON.stringify({ run: String(i + 1), flow: 'devolver', status: s, at: '2026-10-01' })).join('\n') + '\n');
  mkdirSync(join(sd, 'runs', '6', 'flows', 'devolver'), { recursive: true });
  writeFileSync(join(sd, 'runs', '6', 'flows', 'devolver', 'trace.json'), JSON.stringify({ flow: 'devolver', exchanges: [
    { id: 'a', kind: 'http', from: 'portal', to: 'billing-api', label: 'POST /refunds', method: 'POST', path: '/refunds', status: 422 },
    { id: 'b', kind: 'http', from: 'billing-api', to: 'stripe', label: 'POST /v1/refunds', drift: ['body.amount is required', 'not validated: oneOf'] },
    { id: 'c', kind: 'http', from: 'portal', to: 'billing-api', label: 'DELETE /refunds/9', method: 'DELETE', path: '/refunds/9', status: 204 },
  ] }));

  const g = loadGraph(ws);
  const k = loadKnowledge(ws);
  const vaultIssues = [{ level: 'error', code: 'missing-var', key: 'STRIPE_WEBHOOK_SECRET', service: 'billing-api', message: 'STRIPE_WEBHOOK_SECRET: no level sets it' }];
  const f = await computeFindings(ws, g, k, { vaultIssues });
  const types = new Set(f.map((x) => x.type));
  for (const t of ['undeclared-call', 'untested-endpoint', 'table-multi-writer', 'contract-drift', 'convention-violated', 'missing-var', 'flow-unstable'])
    assert.ok(types.has(t as never), `missing ${t}: ${[...types].join(', ')}`);
  const drift = f.filter((x) => x.type === 'contract-drift').map((x) => x.key).sort();
  assert.deepEqual(drift, ['contract-drift:billing-api:DELETE /refunds/9', 'contract-drift:billing-api:POST /refunds 422', 'contract-drift:stripe:body.amount is required']);
  const flaky = f.find((x) => x.type === 'flow-unstable')!;
  assert.match(flaky.message, /passed failed passed failed passed/, 'error runs do not count');

  // Accepted with a reason it is silenced; once `until` passes it is open again.
  assert.throws(() => acceptFinding(ws, flaky.key, { reason: ' ' }), /why/);
  acceptFinding(ws, flaky.key, { reason: 'ClamAV se recarga a medianoche', until: '2026-11-01', by: 'sergio' });
  const before = (await computeFindings(ws, g, k, { vaultIssues, today: '2026-10-22' })).find((x) => x.key === flaky.key);
  assert.equal(before?.accepted?.reason, 'ClamAV se recarga a medianoche');
  const after = (await computeFindings(ws, g, k, { vaultIssues, today: '2026-11-02' })).find((x) => x.key === flaky.key);
  assert.equal(after?.accepted, undefined);
});

test('contract drift reads what the service sheet reads: cases, a cached result\'s run, the map endpoint before a template', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio' });
  await addRepo(ws, fx.billingUrl);
  await refreshMap(ws);
  const g0 = loadGraph(ws);
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => { const r = knowledgeWrite(ws, x, g0); assert.ok(r.ok, JSON.stringify(r.issues)); };
  w({ type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } });
  w({ type: 'service', id: 'svc:billing-api', in: 'app:comercio', title: 'billing-api', summary: 'Cobros y devoluciones.', fields: { responsibility: 'Cobrar y devolver.' } });
  w({ type: 'contract', in: 'svc:billing-api', title: 'API de devoluciones', summary: 'Pedir devoluciones.', fields: { purpose: 'Pedir devoluciones.', operations: [
    { method: 'POST', path: '/refunds', service: 'svc:billing-api', summary: 'Pide una devolución' },
    { method: 'GET', path: '/refunds/{id}', service: 'svc:billing-api', summary: 'Una devolución' },
  ], errors: [{ status: '409', when: 'Ya devuelto' }, { status: '5xx', when: 'Se cayó' }] } });
  // The code has a literal GET /refunds/pending that no contract declares; {id} must not swallow it.
  const pending = { id: 'ep:billing-api:GET /refunds/pending', type: 'endpoint' as const, name: 'GET /refunds/pending', service: 'svc:billing-api', attrs: { method: 'GET', path: '/refunds/pending' } };
  const g = new Graph({ ...g0.map, nodes: [...g0.map.nodes, pending] });
  const match = (svc: string, method?: string, path?: string) => (svc === 'billing-api' && method === 'GET' && path === '/refunds/pending' ? pending.id : undefined);

  // Run 7 reused run 6 (cached); run 6 has the evidence, in its story and in a case.
  const runs = join(ws.root, '.laru', 'runs');
  mkdirSync(join(runs, '6', 'flows', 'devolver'), { recursive: true });
  mkdirSync(join(runs, '7'), { recursive: true });
  writeFileSync(join(runs, 'index.jsonl'), [{ run: '6', flow: 'devolver', status: 'passed', at: '2026-10-01' }, { run: '7', flow: 'devolver', status: 'cached', at: '2026-10-02' }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(runs, '7', 'run.json'), JSON.stringify({ id: '7', results: { devolver: { status: 'cached', cachedFrom: '6' } } }));
  const http = (id: string, method: string, path: string, status: number) => ({ id, kind: 'http', from: 'portal', to: 'billing-api', label: `${method} ${path}`, method, path, status });
  writeFileSync(join(runs, '6', 'flows', 'devolver', 'trace.json'), JSON.stringify({ flow: 'devolver', test: 'Devolver', exchanges: [http('a', 'POST', '/refunds', 201)] }));
  writeFileSync(join(runs, '6', 'flows', 'devolver', 'cases.json'), JSON.stringify([{ flow: 'devolver', test: 'Una pendiente', exchanges: [
    http('b', 'GET', '/refunds/pending', 200), http('c', 'GET', '/refunds/9', 503), http('d', 'GET', '/refunds/9', 404),
  ] }]));

  const drift = (await computeFindings(ws, g, loadKnowledge(ws), { match })).filter((x) => x.type === 'contract-drift');
  assert.deepEqual(drift.map((x) => [x.key, x.evidence]), [
    ['contract-drift:billing-api:GET /refunds/pending', 'run 6 devolver · Una pendiente'],
    ['contract-drift:billing-api:GET /refunds/{id} 404', 'run 6 devolver · Una pendiente'],
  ], 'a 503 is listed as 5xx');
  const plain = (await computeFindings(ws, g, loadKnowledge(ws))).filter((x) => x.type === 'contract-drift').map((x) => x.key);
  assert.deepEqual(plain, ['contract-drift:billing-api:GET /refunds/{id} 404'], 'with no map endpoint for it, the templates decide');
  // an endpoint a run reached is not «sin probar», even when the trace carries no endpoint and only the matcher knows it
  const untested = async (o: { match?: typeof match }) => (await computeFindings(ws, g, loadKnowledge(ws), o)).filter((x) => x.type === 'untested-endpoint').map((x) => x.subject);
  assert.ok((await untested({})).includes(pending.id));
  assert.ok(!(await untested({ match })).includes(pending.id));
});

test('a declared call is made when the runs reached its endpoint, through a proxy too', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio' });
  await addRepo(ws, fx.billingUrl);
  await refreshMap(ws);
  const g0 = loadGraph(ws);
  // portal declares a call to billing-api's GET /refunds/{id}; at runtime it goes through a gateway
  const ep = { id: 'ep:billing-api:GET /refunds/{id}', type: 'endpoint' as const, name: 'GET /refunds/{id}', service: 'svc:billing-api', attrs: { method: 'GET', path: '/refunds/{id}' } };
  const g = new Graph({ ...g0.map, nodes: [...g0.map.nodes, ep], facts: [...g0.map.facts, { s: 'svc:portal', p: 'calls', o: ep.id, origin: 'extracted' } as never, { s: 'svc:portal', p: 'reads', o: 'tbl:x', origin: 'observed', seen: { run: '6', at: '2026-10-01', count: 1 } } as never] });
  const match = (svc: string, method?: string, path?: string) => (svc === 'billing-api' && method === 'GET' && path === '/refunds/9' ? ep.id : undefined);
  const runs = join(ws.root, '.laru', 'runs');
  mkdirSync(join(runs, '6', 'flows', 'devolver'), { recursive: true });
  writeFileSync(join(runs, 'index.jsonl'), JSON.stringify({ run: '6', flow: 'devolver', status: 'passed', at: '2026-10-01' }) + '\n');
  const http = (id: string, from: string, to: string, t0: number, t1: number) => ({ id, kind: 'http', from, to, label: 'GET /refunds/9', method: 'GET', path: '/refunds/9', status: 200, t0, t1 });
  writeFileSync(join(runs, '6', 'flows', 'devolver', 'trace.json'), JSON.stringify({ flow: 'devolver', test: 'Devolver', exchanges: [http('a', 'portal', 'gateway', 100, 200), http('b', 'gateway', 'billing-api', 105, 195)] }));
  const dead = async (o: { match?: typeof match }) => (await computeFindings(ws, g, loadKnowledge(ws), o)).filter((x) => x.type === 'dead-declaration' && x.subject === 'svc:portal').map((x) => x.message);
  assert.deepEqual(await dead({}), [`svc:portal declares a call to ${ep.id} that no run has made`], 'without the matcher nothing says it was made');
  assert.deepEqual(await dead({ match }), [], 'the gateway forwarded it to the endpoint inside its time');
});

test('a known deviation that stopped failing is a finding while the flow still says «hoy …» about it, and goes when the text is updated', async () => {
  const ws = initWorkspace(join(makeFixture().tmp, 'ws'), { app: 'comercio', title: 'Comercio' });
  const g = new Graph({ nodes: [], facts: [], repos: [] } as never);
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => { const r = knowledgeWrite(ws, x); assert.ok(r.ok, JSON.stringify(r.issues)); };
  w({ type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } });
  w({ type: 'module', in: 'app:comercio', title: 'Pagos', kind: 'feature', status: 'active', summary: 'Pagos.', fields: { purpose: 'Cobrar.' } });
  const step = (expected: string) => ({ type: 'flow' as const, id: 'flow:pagar', in: 'mod:pagos', title: 'Pagar', status: 'active' as const, summary: 'Se paga.', fields: { goal: 'Pagado.', actors: ['Cliente'], steps: [{ step: 'Pagar', actor: 'Cliente', expected }] } });
  w(step('Queda pagado; hoy tarda 5 s más'));
  const sd = join(ws.root, '.laru', 'runs');
  mkdirSync(join(sd, '2', 'flows', 'pagar'), { recursive: true });
  writeFileSync(join(sd, 'index.jsonl'), [{ run: '1', flow: 'pagar', status: 'passed', known: 1 }, { run: '2', flow: 'pagar', status: 'passed', fixed: ['Pagar'] }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(sd, '2', 'flows', 'pagar', 'trace.json'), JSON.stringify({ flow: 'pagar', test: 'Pagar', status: 'passed', steps: [{ n: 1, title: 'Pagar', status: 'passed' }], exchanges: [] }));
  const stale = async () => (await computeFindings(ws, g, loadKnowledge(ws))).filter((x) => x.type === 'deviation-fixed');
  const [f] = await stale();
  assert.match(f.message, /«Pagar» ya no falla.*«hoy …»/);
  w(step('Queda pagado'));
  assert.deepEqual(await stale(), [], 'the text no longer says «hoy»: nothing is out of date');
});
