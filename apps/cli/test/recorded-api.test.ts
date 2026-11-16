/**
 * The data screens on a run's recording (`?run=<id>`): the service answers them from the run's state/, with the env
 * off, never reaching Docker; a page, a filter or a search is answered over what the run kept; what the recording does
 * not hold says so; and nothing that changes data answers from a recording.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stateDir } from '@laru/core';
import { scenarioEnv } from '../../../packages/runtime/test/scenario-env.ts';
import { startDaemon } from '../src/daemon.ts';

test('a recording answers the data screens with the env off, browses what it kept, and refuses any change', async () => {
  const env = await scenarioEnv();
  const run = join(stateDir(env.ws), 'runs', '7', 'state');
  mkdirSync(join(run, 'blobs'), { recursive: true });
  writeFileSync(join(run, 'blobs', '0.bin'), 'PNGDATA');
  const mail = (id: string, from: string, subject: string) => ({ id, kind: 'mail', t: 1, from, to: 'x@y.test', subject, attachments: 0, codes: [], lints: [], status: 'delivered' });
  writeFileSync(join(run, 'reads.json'), JSON.stringify({
    at: '2026-11-13T10:00:00.000Z', env: 'f-gone', cut: [], docs: {},
    reads: {
      'db/stores': { ok: [{ service: 'postgres', kind: 'postgres' }] },
      'db/schema?service=postgres': { ok: [{ schema: 'public', name: 'users', rows: 3, columns: [] }] },
      'queue/peek?limit=100&topic=pedidos': { ok: [{ offset: 3 }, { offset: 2 }, { offset: 1 }] },
      'mail?kind=all': { ok: { env: 'f-gone', state: 'ready', counts: { all: 2, mail: 2, sms: 0 }, messages: [mail('a', 'ana@x.test', 'Pedido'), mail('b', 'luis@x.test', 'Factura')] } },
      'queues': { error: 'f-gone has no running Kafka' },
    },
    rows: { 'postgres|public.users': { columns: ['id', 'name'], rows: [['1', 'ana'], ['2', 'luis'], ['3', 'anabel']], truncated: false } },
    blobs: { 'storage/raw?path=fotos%2Fa.png': { status: 200, headers: { 'content-type': 'image/png' }, file: '0.bin' } },
  }));
  const dist = join(env.ws.root, '..', 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Laru</title>');
  const d = await startDaemon(0, dist);
  try {
    const base = new URL(d.url).origin;
    const cookie = String((await fetch(d.url, { redirect: 'manual' })).headers.get('set-cookie')).split(';')[0];
    const call = (method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/w/comercio${path}`, { method, headers: { cookie, ...headers, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
    const docker = env.calls().length;

    // the env «f-gone» no longer exists: a recording does not need it
    assert.deepEqual(await (await call('GET', '/db/stores?env=f-gone&run=7')).json(), [{ service: 'postgres', kind: 'postgres' }]);
    const rows = await (await call('POST', '/db/rows?run=7', { env: 'f-gone', service: 'postgres', browse: { schema: 'public', table: 'users', filters: [{ column: 'name', op: 'contains', value: 'ana' }], sort: { column: 'name', desc: true } } })).json();
    assert.deepEqual(rows.rows, [['3', 'anabel'], ['1', 'ana']]);
    assert.deepEqual(await (await call('GET', '/queue/peek?env=f-gone&topic=pedidos&limit=2&run=7')).json(), [{ offset: 3 }, { offset: 2 }], 'the page asked, of the messages kept');
    const box = await (await call('GET', '/mail?env=f-gone&kind=all&q=de%3Aluis&run=7')).json();
    assert.deepEqual(box.messages.map((m: { id: string }) => m.id), ['b'], 'a search over the messages kept');
    const part = await call('GET', '/storage/raw?env=f-gone&path=fotos%2Fa.png&run=7', undefined, { range: 'bytes=0-2' });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), 'PNG');
    // what the live screen would have said, as it said it
    const failed = await call('GET', '/queues?env=f-gone&run=7');
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).error, 'f-gone has no running Kafka');
    // what the recording does not hold, or a run with none, says so
    assert.equal((await call('GET', '/mongo/stores?env=f-gone&run=7')).status, 404);
    assert.match((await (await call('GET', '/db/stores?env=f-gone&run=8')).json()).error, /no grabó sus datos/);
    // nothing changes data from a recording
    for (const [path, body] of [['/db/query?run=7', { sql: 'delete from users' }], ['/db/update/apply?run=7', {}], ['/queue/publish?run=7', { topic: 'pedidos', value: '{}' }], ['/vars/set?run=7', { key: 'X', value: 'y', level: 'app' }], ['/mail/clear?run=7', {}]] as const) {
      const r = await call('POST', path, body);
      assert.equal(r.status, 409, path);
      assert.match((await r.json()).error, /grabación de un run/);
    }
    assert.equal(env.calls().length, docker, 'no docker call: the env is never reached');
  } finally { await d.close(); }
});
