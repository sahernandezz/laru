import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { unheld } from '../src/up.ts';

test('a consumer is ready when its groups hold every partition of the topic, whichever replica holds each', () => {
  const topics = [{ name: 'file.uploaded', partitions: [0, 1, 2].map((partition) => ({ partition, end: 0 })), messages: 0 }];
  const ipOf = new Map([['antivirus', '10.0.0.6'], ['antivirus-2', '10.0.0.7']]);
  const row = (partition: number, host?: string) => ({ group: 'antivirus-group', topic: 'file.uploaded', partition, current: 0, end: 0, lag: 0, consumer: host && `c-${host}`, host });
  const want = [{ svc: 'antivirus', topic: 'file.uploaded' }];
  // subscribed when the topic had one partition: it holds 1 of 3
  assert.deepEqual(unheld(want, [row(0, '10.0.0.6')], topics, ipOf), [{ svc: 'antivirus', topic: 'file.uploaded', held: 1, of: 3 }]);
  // a partition with a committed offset and nobody on it does not count
  assert.equal(unheld(want, [row(0, '10.0.0.6'), row(1), row(2)], topics, ipOf)[0].held, 1);
  // two replicas share the group: all three held
  assert.deepEqual(unheld(want, [row(0, '10.0.0.6'), row(1, '10.0.0.7'), row(2, '10.0.0.6')], topics, ipOf), []);
  // a topic not created yet is not waited for
  assert.deepEqual(unheld([{ svc: 'antivirus', topic: 'nope' }], [], topics, ipOf), []);
});
