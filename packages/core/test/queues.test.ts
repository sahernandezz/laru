/** A topic against its contracts, the code and the runs: read from files, and the verdict says where they differ. */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Graph, initWorkspace, knowledgeWrite, loadKnowledge, queueContracts, type SystemMap } from '../src/index.ts';

test('each topic says whether its contract, the code and the runs agree, and where they do not', () => {
  const ws = initWorkspace(join(mkdtempSync(join(tmpdir(), 'ks-queues-')), 'ws'), { app: 'shop', title: 'Shop', docsLanguage: 'es' });
  const svc = (n: string) => ({ id: `svc:${n}`, type: 'service', name: n, kind: 'spring', repo: 'shop', attrs: { dir: n } });
  const fact = (s: string, p: string, o: string) => ({ s, p, o, origin: 'extracted' });
  const map = { nodes: [svc('orders'), svc('billing'), svc('mail'), { id: 'topic:order.placed', type: 'topic', name: 'order.placed' }, { id: 'topic:order.paid', type: 'topic', name: 'order.paid' }, { id: 'topic:order.shipped', type: 'topic', name: 'order.shipped' }, { id: 'topic:audit', type: 'topic', name: 'audit' }],
    facts: [fact('svc:orders', 'publishes', 'topic:order.placed'), fact('svc:billing', 'consumes', 'topic:order.placed'), fact('svc:billing', 'publishes', 'topic:order.paid'), fact('svc:mail', 'consumes', 'topic:order.paid'), fact('svc:orders', 'publishes', 'topic:order.shipped'), fact('ds:kafka', 'contains', 'topic:order.placed')], repos: [] } as unknown as SystemMap;
  const g = new Graph(map);
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => { const r = knowledgeWrite(ws, x, g); assert.ok(r.ok, JSON.stringify(r.issues)); };
  w({ type: 'application', title: 'Shop', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pedidos'] } });
  w({ type: 'module', id: 'mod:pedidos', in: 'app:shop', title: 'Pedidos', summary: 'Pedidos.', kind: 'area', fields: { purpose: 'Pedir.' } });
  w({ type: 'contract', in: 'mod:pedidos', title: 'Eventos de pedidos', summary: 'Lo que viaja.', fields: { purpose: 'Eventos.', events: [
    { topic: 'order.placed', direction: 'publishes', service: 'svc:orders', payload: 'el pedido' }, { topic: 'order.placed', direction: 'consumes', service: 'svc:billing' },
    { topic: 'order.paid', direction: 'publishes', service: 'svc:billing' },                       // the code also has mail consuming it: not declared
    { topic: 'order.refunded', direction: 'publishes', service: 'svc:billing' },                   // no code at all
  ] } });
  // a trace that published on order.placed
  const runs = join(ws.root, '.laru', 'runs');
  mkdirSync(join(runs, '7', 'flows', 'pedir'), { recursive: true });
  writeFileSync(join(runs, 'index.jsonl'), JSON.stringify({ run: '7', flow: 'pedir', status: 'passed' }) + '\n');
  writeFileSync(join(runs, '7', 'flows', 'pedir', 'trace.json'), JSON.stringify({ exchanges: [
    { kind: 'kafka', topic: 'order.placed', from: 'orders', to: 'kafka', t0: 1, req: { text: '{"id":42}' } }, { kind: 'kafka', topic: 'order.placed', from: 'kafka', to: 'billing', t0: 2 },
    { kind: 'kafka', topic: 'order.placed', from: 'orders', to: 'kafka', t0: 3, req: { text: '{"id":43}' } },
  ] }));
  const r = queueContracts(ws, g, loadKnowledge(ws));
  assert.equal(r.facts, 5, 'publishes and consumes only: «contains» is the store, not behavior');
  const by = Object.fromEntries(r.topics.map((t) => [t.topic, t]));
  assert.equal(by['order.placed'].verdict, 'agrees');
  assert.deepEqual(by['order.placed'].seen && [by['order.placed'].seen.run, by['order.placed'].seen.count], ['7', 2], 'two publications, not their deliveries');
  assert.equal(by['order.placed'].sample?.value, '{"id":43}', 'the newest');
  assert.equal(by['order.paid'].verdict, 'differs');
  assert.deepEqual(by['order.paid'].extra, ['mail consumes']);
  assert.equal(by['order.shipped'].verdict, 'code-not-declared');
  assert.equal(by['order.refunded'].verdict, 'declared-not-in-code');
  assert.deepEqual(by['order.refunded'].missing, ['billing publishes']);
  assert.equal(by.audit.verdict, 'only-seen', 'a topic the map has and nobody declared, publishes or consumes');
});
