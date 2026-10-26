import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { composition, drawModel, fromMermaid, renderTyped } from '@laru/diagrams';
import { addRepo, deriveDiagram, derivedList, initWorkspace, knowledgeWrite, loadGraph, loadKnowledge, refreshMap } from '../src/index.ts';
import { makeFixture } from './fixture.ts';

test('derived diagrams are read from the map and the documentation, drawn fast, and survive a trip through Mermaid', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio', docsLanguage: 'es' });
  await addRepo(ws, fx.billingUrl);
  await addRepo(ws, fx.portalUrl);
  await refreshMap(ws);
  const g = loadGraph(ws);
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda en línea.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } }, g).ok);
  assert.ok(knowledgeWrite(ws, { type: 'module', in: 'app:comercio', title: 'Pagos', kind: 'area', status: 'active', summary: 'Cobros y devoluciones de pedidos pagados.', fields: { purpose: 'Dinero.' } }, g).ok);
  assert.ok(knowledgeWrite(ws, { type: 'decision', in: 'mod:pagos', title: 'Cobro por cola', status: 'proposed', summary: 'Por cola.', fields: { context: 'c', decision: 'd', alternatives: [{ option: 'o', 'why-not': 'w' }], tradeoffs: 't' }, relations: { relates_to: ['mod:pagos'] } }, g).ok);
  const k = loadKnowledge(ws);
  const envs = [{ env: 'local', services: ['billing-api', 'portal', 'postgres', 'kafka'] }];

  const list = derivedList(ws, g, k, envs);
  assert.deepEqual(list.map((d) => d.id), ['c4-context', 'c4-container', 'er', 'dependencies', 'relations', 'topology:local']);

  const containers = deriveDiagram(ws, g, k, envs, 'c4-container')!;
  const refs = containers.nodes.map((n) => n.ref).filter(Boolean);
  assert.ok(refs.includes('svc:billing-api') && refs.includes('svc:portal') && refs.includes('ds:postgres'), 'every box is a way into its sheet');
  assert.ok(containers.edges.some((e) => e.technology === 'SQL') && containers.edges.some((e) => e.technology === 'Kafka'), 'arrows carry their protocol');
  assert.ok(containers.edges.some((e) => e.technology === 'HTTP'), 'a call between services is HTTP');
  assert.equal(deriveDiagram(ws, g, k, envs, 'er')!.nodes.filter((n) => n.shape === 'entity').length, g.ofType('table').length);
  assert.ok(deriveDiagram(ws, g, k, envs, 'relations:mod:pagos')!.nodes.length >= 2, 'a relation draws both its ends');

  for (const d of list) {
    const model = deriveDiagram(ws, g, k, envs, d.id)!;
    const drawn = drawModel(model);
    assert.ok(drawn.ms <= 100, `${d.id} took ${drawn.ms} ms`);
    assert.deepEqual(composition(renderTyped(drawn.model as never), drawn.model).filter((i) => i.severity === 'error'), [], `${d.id} has no legibility errors`);
    const back = fromMermaid(drawn.mermaid, model.kind);
    assert.equal(back?.model.nodes.length, model.nodes.length, `${d.id}: Mermaid read back has the same pieces`);
    assert.equal(back?.model.edges.length, model.edges.length, `${d.id}: and the same arrows`);
  }
});

test('scaffold starts the missing pieces from the code, creates only what does not exist, and never writes a value of a secret', async () => {
  const { scaffoldPieces } = await import('../src/index.ts');
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio', docsLanguage: 'es' });
  await addRepo(ws, fx.billingUrl);
  await refreshMap(ws);
  const g = loadGraph(ws);
  assert.ok(knowledgeWrite(ws, { type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda en línea.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } }, g).ok);
  const first = scaffoldPieces(ws, loadKnowledge(ws), g, ['local']);
  assert.deepEqual(first.map((p) => p.type).sort(), ['architecture', 'infrastructure', 'secrets', 'stack', 'versioning']);
  for (const p of first) assert.ok(knowledgeWrite(ws, p, g).ok, JSON.stringify(p));
  assert.deepEqual(scaffoldPieces(ws, loadKnowledge(ws), g, ['local']).map((p) => p.type), [], 'a second scaffold has nothing left to create');
  assert.ok(!JSON.stringify(first).includes('sk_live'), 'names only');
});
