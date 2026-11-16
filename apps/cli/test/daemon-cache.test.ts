/**
 * The service keeps what it derives (the documentation, the flows, the findings) until a file it is made from changes,
 * and tags every GET: asked again with the tag of an answer that did not change, it says 304 with no body. A change on
 * disk (an agent editing docs/) or one this service made shows on the next read.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { knowledgeWrite, stateDir } from '@laru/core';
import { scenarioEnv } from '../../../packages/runtime/test/scenario-env.ts';
import { startDaemon } from '../src/daemon.ts';

test('an answer that did not change is 304 by its tag; a change on disk or through the service shows on the next read', async () => {
  const env = await scenarioEnv();
  const dist = join(env.ws.root, '..', 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Laru</title>');
  const d = await startDaemon(0, dist);
  try {
    const base = new URL(d.url).origin;
    const cookie = String((await fetch(d.url, { redirect: 'manual' })).headers.get('set-cookie')).split(';')[0];
    const get = (path: string, tag?: string) => fetch(`${base}/api/w/comercio${path}`, { headers: { cookie, ...(tag ? { 'if-none-match': tag } : {}) } });
    const titles = async (r: Response) => ((await r.json()) as { pieces: Array<{ title: string }> }).pieces.map((p) => p.title);

    const first = await get('/knowledge');
    assert.equal(first.status, 200);
    const tag = first.headers.get('etag')!;
    assert.match(tag, /^"[\w-]{22}"$/);
    assert.equal(first.headers.get('cache-control'), 'no-store', 'the browser keeps nothing on disk');
    const before = await titles(first);

    const same = await get('/knowledge', tag);
    assert.equal(same.status, 304);
    assert.equal(await same.text(), '', 'no body: the page keeps what it has');

    // an agent writes a piece on disk: the next read past a quarter second has it
    const out = knowledgeWrite(env.ws, { type: 'guide', in: 'mod:pagos', title: 'Cobrar con tarjeta', status: 'active', summary: 'Cómo se cobra un pedido.', fields: { goal: 'Cobrar.', steps: ['Pedir el cobro.'] } });
    assert.ok(out.ok, JSON.stringify(out.issues));
    await new Promise((r) => setTimeout(r, 300));
    const changed = await get('/knowledge', tag);
    assert.equal(changed.status, 200, 'what changed comes whole');
    assert.notEqual(changed.headers.get('etag'), tag);
    assert.deepEqual((await titles(changed)).filter((t) => !before.includes(t)), ['Cobrar con tarjeta']);

    // one saved through the service shows at once, without waiting
    const now = await get('/knowledge');
    const nowTag = now.headers.get('etag')!;
    await now.text();
    const saved = await fetch(`${base}/api/w/comercio/knowledge/write`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'guide', in: 'mod:pagos', title: 'Devolver un cobro', status: 'active', summary: 'Cómo se devuelve.', fields: { goal: 'Devolver.', steps: ['Pedir la devolución.'] } }) });
    assert.equal(saved.status, 200);
    const after = await get('/knowledge', nowTag);
    assert.equal(after.status, 200);
    assert.ok((await titles(after)).includes('Devolver un cobro'));
  } finally { await d.close(); }
});

test('a scenario whose setup failed on a flow\'s own env reaches the kept findings and the overview on the next read', async () => {
  const env = await scenarioEnv();
  const dist = join(env.ws.root, '..', 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Laru</title>');
  const d = await startDaemon(0, dist);
  try {
    const base = new URL(d.url).origin;
    const cookie = String((await fetch(d.url, { redirect: 'manual' })).headers.get('set-cookie')).split(';')[0];
    const get = async (path: string) => (await fetch(`${base}/api/w/comercio${path}`, { headers: { cookie } })).json();
    const broken = (fs: Array<{ type: string; subject: string; key: string }>) => fs.filter((f) => f.type === 'scenario-broken' && f.key.endsWith(':f-pagar-el-pedido')).map((f) => f.subject);
    assert.deepEqual(broken(await get('/findings')), [], 'kept, with nothing broken yet');
    await get('/overview');
    // the runtime marks the setup broken on the flow's own env, an instance envs/ does not list
    const dir = join(stateDir(env.ws), 'envs', 'f-pagar-el-pedido', 'scenarios');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pedido-pagado.json'), JSON.stringify({ slug: 'pedido-pagado', env: 'f-pagar-el-pedido', broken: 'setup failed: no se pudo crear el pedido', provisionedAt: '2026-11-13T10:00:00.000Z' }));
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(broken(await get('/findings')), ['scn:pedido-pagado']);
    assert.equal((await get('/overview')).findings.byType['scenario-broken'] >= 1, true, 'the overview counts it too');
  } finally { await d.close(); }
});

