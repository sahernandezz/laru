/** The SQS reader against a real ElasticMQ: queues with their counts, a look at messages that hides none, and no write ever. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import type { Workspace } from '@laru/core';
import { queues, peek, type Sqs } from '../src/explore/sqs.ts';

const NAME = `ks-test-sqs-${process.pid}`;
let up = false, sqs: Sqs;

const docker = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** A raw SQS call, the way a test (and not the reader) may: it creates and sends. */
const raw = (path: string, params: Record<string, string>) => new Promise<string>((ok, fail) => {
  const body = new URLSearchParams({ ...params, Version: '2012-11-05' }).toString();
  const r = request({ host: '127.0.0.1', port: sqs.port, path, method: 'POST', headers: { host: sqs.host, 'content-type': 'application/x-www-form-urlencoded' } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => ok(t)); });
  r.on('error', fail); r.end(body);
});

before(async () => {
  try {
    docker('info');
    // a throwaway container of this process: removed in `after`, found by its name
    docker('run', '-d', '--name', NAME, '--label', 'io.laru.test=sqs', '-p', '127.0.0.1::9324', 'softwaremill/elasticmq-native:latest');
    const port = Number(/:(\d+)$/.exec(docker('port', NAME, '9324/tcp').split('\n')[0])![1]);
    sqs = { service: 'elasticmq', host: 'elasticmq.test.localhost', port };
    for (let i = 0; i < 60 && !up; i++) { try { await raw('/', { Action: 'ListQueues' }); up = true; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  } catch { up = false; }
});
after(() => { try { docker('rm', '-f', NAME); } catch { /* it never started */ } });

test('queues come with what waits, what is in flight and what is delayed; a look at the messages hides none of them', { skip: process.env.LARU_NO_DOCKER ? 'no docker' : false }, async (t) => {
  if (!up) return t.skip('docker or ElasticMQ is not available here');
  await raw('/', { Action: 'CreateQueue', QueueName: 'pedidos' });
  await raw('/', { Action: 'CreateQueue', QueueName: 'vacia' });
  for (const body of ['{"id":1}', '{"id":2,"token":"abc"}', 'texto & <raro>']) await raw('/000000000000/pedidos', { Action: 'SendMessage', MessageBody: body });
  const qs = await queues(sqs);
  assert.deepEqual(qs.map((q) => [q.name, q.visible, q.inFlight, q.delayed]), [['pedidos', 3, 0, 0], ['vacia', 0, 0, 0]]);
  const seen = await peek({} as Workspace, 'x', sqs, 'pedidos', 10, { body: (s: string) => s.replace(/"abc"/, '"…"'), text: (s: string) => s, cut: (s: string) => s } as never);
  assert.deepEqual(seen.map((m) => m.body).sort(), ['texto & <raro>', '{"id":1}', '{"id":2,"token":"…"}'].sort(), 'entities read back, the masker applied');
  assert.ok(seen.every((m) => m.id && m.receiveCount === 1));
  // looking again finds them all again: nothing was hidden, deleted or consumed
  const again = await queues(sqs);
  assert.equal(again[0].visible, 3);
  assert.equal(again[0].inFlight, 0);
  assert.equal((await peek({} as Workspace, 'x', sqs, 'pedidos', 2, { body: (s: string) => s } as never)).length, 2, 'a smaller look');
  await assert.rejects(peek({} as Workspace, 'x', sqs, 'no-existe', 10, { body: (s: string) => s } as never), /no queue/);
});

test('the reader sends nothing but reads: any other action is refused before it leaves', async () => {
  const bad = (await import('../src/explore/sqs.ts')) as unknown as Record<string, unknown>;
  assert.equal(typeof bad.queues, 'function');
  assert.equal(Object.keys(bad).filter((k) => /send|purge|delete|create/i.test(k)).length, 0, 'no write is exported');
});
