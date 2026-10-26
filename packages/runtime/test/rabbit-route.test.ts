import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createMasker } from '@laru/trace';
import { routeIn, type Exchange } from '../src/explore/rabbit.ts';

const m = createMasker([]);
const b = (source_name: string, destination_name: string, routing_key = '', destination_kind = 'queue') => ({ source_name, destination_name, destination_kind, routing_key });

test('a route keeps the queues the keys tell when another exchange on the way cannot tell; the rest is partial', () => {
  const xs: Exchange[] = [{ name: '', type: 'direct' }, { name: 'e7', type: 'direct' }, { name: 'h1', type: 'headers' }];
  const r = routeIn(xs, [b('e7', 'h1', 'k', 'exchange'), b('e7', 'dq', 'k'), b('h1', 'hq')], [], 'e7', 'k', m);
  assert.deepEqual(r, { type: 'direct', queues: [{ queue: 'dq', key: 'k' }], partial: true, via: ['h1'] });
});

test('a fanout passes everything to every binding; an alternate exchange takes what no binding matches', () => {
  const xs: Exchange[] = [{ name: 'f1', type: 'fanout' }, { name: 'e4', type: 'direct' }, { name: 'x5', type: 'direct', arguments: { 'alternate-exchange': 'unrouted' } }, { name: 'unrouted', type: 'fanout' }];
  const all = [b('f1', 'e4', '', 'exchange'), b('f1', 'x5', '', 'exchange'), b('unrouted', 'unrouted.q')];
  assert.deepEqual(routeIn(xs, all, [], 'f1', 'anything', m), { type: 'fanout', queues: [{ queue: 'unrouted.q', key: '' }], via: ['e4', 'x5'] });
  assert.equal(routeIn(xs, all, [], 'nope', 'k', m), null);
});
