/** A joint env has several fronts: the session can show either, and says which one it is on. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frontAt, frontNodes, frontsOf } from '../src/lib/fronts.ts';

const addr = [
  { service: 'frontend', kind: 'http', url: 'http://frontend.shop.localhost:4181' },
  { service: 'api-gateway', kind: 'http', url: 'http://api-gateway.shop.localhost:4181' },
  { service: 'audit-web', kind: 'http', url: 'http://audit-web.shop.localhost:4181' },
  { service: 'ledger-ui', kind: 'http', url: 'http://ledger-ui.shop.localhost:4181' },
  { service: 'postgres', kind: 'store', url: '127.0.0.1:15432' },
];

test('the fronts are the web services of the map and the names that read as one, never a back or a store', () => {
  assert.deepEqual(frontsOf(addr, () => undefined).map((a) => a.service), ['frontend', 'audit-web', 'ledger-ui']);
  assert.deepEqual(frontsOf(addr, (s) => (s === 'api-gateway' ? 'web' : undefined)).map((a) => a.service), ['frontend', 'api-gateway', 'audit-web', 'ledger-ui'], 'the map says what is web');
});

test('an address belongs to the front whose origin it starts with', () => {
  const fronts = frontsOf(addr, () => undefined);
  assert.equal(frontAt(fronts, 'http://audit-web.shop.localhost:4181/accounts')?.service, 'audit-web');
  assert.equal(frontAt(fronts, 'http://frontend.shop.localhost:4181/')?.service, 'frontend');
  assert.equal(frontAt(fronts, 'http://elsewhere.test/'), undefined);
});

test('the map lists every front, web or mobile, with the backs it calls', () => {
  const nodes: any[] = [
    { id: 'repo:shop', type: 'repository', name: 'shop', kind: 'service' },
    { id: 'svc:web', type: 'service', name: 'web', kind: 'web', repo: 'shop', attrs: { stack: 'react', dir: 'web' } },
    { id: 'svc:pay-app', type: 'service', name: 'pay-app', kind: 'mobile', repo: 'shop', attrs: { stack: 'flutter', platform: 'cross', dir: 'mobile' } },
    { id: 'svc:api', type: 'service', name: 'api', kind: 'quarkus', repo: 'shop' },
    { id: 'ep:api:GET:/a', type: 'endpoint', name: '/a', service: 'svc:api' },
    { id: 'ep:api:GET:/b', type: 'endpoint', name: '/b', service: 'svc:api' },
  ];
  const facts: any[] = [
    { s: 'svc:web', p: 'calls', o: 'ep:api:GET:/a', origin: 'extracted' }, { s: 'svc:web', p: 'calls', o: 'ep:api:GET:/b', origin: 'extracted' },
    { s: 'svc:pay-app', p: 'calls', o: 'ep:api:GET:/a', origin: 'extracted' },
  ];
  const g: any = { map: { nodes, facts }, nodes: new Map(nodes.map((n) => [n.id, n])) };
  const fronts = frontNodes(g);
  assert.deepEqual(fronts.map((f) => [f.name, f.kind, f.stack]), [['web', 'web', 'react'], ['pay-app', 'mobile', 'flutter']]);
  assert.deepEqual(fronts.map((f) => f.backends), [[{ id: 'svc:api', name: 'api', endpoints: 2 }], [{ id: 'svc:api', name: 'api', endpoints: 1 }]]);
  assert.equal(frontsOf([{ service: 'pay-app', kind: 'http', url: 'http://x' }], () => 'mobile').length, 1, 'a mobile front served in a browser can be opened');
});
