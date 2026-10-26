/**
 * What the local service refuses: a POST that is not JSON (a form or a no-cors fetch from another page cannot send
 * it), a request another page of this machine sent (Sec-Fetch-Site same-site or cross-site: a dev server on another
 * port is same-site, so the SameSite cookie goes with it), being framed, and a file the runner left that is a link.
 */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readConfig } from '@laru/runtime';
import { makeFixture } from '../../../packages/core/test/fixture.ts';
import { run } from '../src/cli.ts';
import { startDaemon } from '../src/daemon.ts';

/** fetch() cannot set Sec-Fetch-Site, Host or a raw Content-Type, so requests go through node:http. */
const send = (method: string, url: string, o: { headers?: Record<string, string>; body?: string; ms?: number } = {}) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
  const req = request(url, { method, headers: o.headers }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => ok({ status: res.statusCode!, headers: res.headers, body }));
    // a stream never ends: what arrived by then is the answer
    if (o.ms) setTimeout(() => { res.destroy(); ok({ status: res.statusCode!, headers: res.headers, body }); }, o.ms);
  });
  req.on('error', (e) => { if (!o.ms) fail(e); });
  req.end(o.body);
});

async function service() {
  const fx = makeFixture();
  const root = join(fx.tmp, 'ws');
  await run(['init', root, '--app', 'comercio'], { log: () => {}, err: () => {} });
  const dist = join(fx.tmp, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Laru</title>');
  const d = await startDaemon(0, dist);
  const base = new URL(d.url).origin;
  const cookie = String((await send('GET', d.url)).headers['set-cookie']).split(';')[0];
  return { fx, root, d, base, api: `${base}/api/w/comercio`, cookie };
}

test('a POST must say it is JSON: none, a form, a plain text, a type that only mentions json: 415, and nothing runs', async () => {
  const { d, base, cookie } = await service();
  try {
    const before = readConfig().maxEnvs;
    const post = (type: string | undefined, body = '{"maxEnvs":3}') => send('POST', `${base}/api/machine/config`, { headers: { cookie, ...(type ? { 'content-type': type } : {}) }, body });
    for (const type of [undefined, 'text/plain', 'text/plain;charset=UTF-8', 'text/plain; x=json', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', 'text/json']) {
      const r = await post(type);
      assert.equal(r.status, 415, String(type));
    }
    assert.equal((await send('POST', `${base}/api/machine/config`, { headers: { cookie } })).status, 415, 'no type and no body');
    assert.equal(readConfig().maxEnvs, before, 'nothing of the refused requests ran');
    // JSON gets to the handler (which refuses 0 itself), with or without a charset
    for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON']) assert.equal((await post(type, '{"maxEnvs":0}')).status, 400, type);
    assert.equal((await post('application/json', '{"maxEnvs":2}')).status, 200);
    assert.equal(readConfig().maxEnvs, 2);
  } finally { await d.close(); }
});

test('an /api/ request from another page of this machine is refused (403), whatever the cookie says; this page, the address bar and the CLI are not', async () => {
  const { d, base, api, cookie } = await service();
  try {
    const get = (site: string | undefined, path = '/workspace', c: string | undefined = cookie) => send('GET', `${api}${path}`, { headers: { ...(c ? { cookie: c } : {}), ...(site ? { 'sec-fetch-site': site } : {}) } });
    for (const site of ['same-site', 'cross-site']) {
      assert.equal((await get(site)).status, 403, `GET ${site}`);
      assert.equal((await get(site, '/workspace', undefined)).status, 403, `without a cookie: ${site}`);
      const before = readConfig().maxEnvs;
      const post = await send('POST', `${base}/api/machine/config`, { headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': site }, body: `{"maxEnvs":${before === 4 ? 5 : 4}}` });
      assert.equal(post.status, 403, `POST ${site}`);
      assert.equal(readConfig().maxEnvs, before, 'and it did not run');
      assert.equal((await send('GET', `${base}/api/ping`, { headers: { 'sec-fetch-site': site } })).status, 403, `ping ${site}`);
    }
    for (const site of ['same-origin', 'none', undefined]) {
      assert.equal((await get(site)).status, 200, String(site));
      assert.equal((await send('GET', `${base}/api/ping`, { headers: site ? { 'sec-fetch-site': site } : {} })).status, 200, `ping ${site}`);
    }
    // the CLI's own client (Node's fetch) sends no Sec-Fetch headers
    assert.equal((await fetch(`${base}/api/ping`)).status, 200);
    assert.equal((await fetch(`${api}/workspace`, { headers: { cookie } })).status, 200);
    // only /api/: a link from another site to this page (a navigation) still opens it
    assert.equal((await send('GET', `${base}/`, { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status, 200);
  } finally { await d.close(); }
});

test('every page the service serves says that only its own origin may frame it', async () => {
  const { d, base, cookie } = await service();
  try {
    for (const [path, c] of [['/', cookie], ['/w/comercio/', cookie], ['/index.html', cookie], ['/#/runs', cookie], ['/', undefined]] as const) {
      const r = await send('GET', `${base}${path}`, { headers: c ? { cookie: c } : {} });
      // no page of another origin frames this one, and it frames nothing but itself (a mail's HTML and a PDF come from here, never from elsewhere)
      assert.equal(r.headers['content-security-policy'], "frame-ancestors 'self'; frame-src 'self'", path);
      assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN', path);
      if (c) assert.match(String(r.headers['content-type']), /^text\/html/, `${path} is HTML`);
    }
    const api = await send('GET', `${base}/api/ping`);
    assert.equal(api.headers['x-frame-options'], 'SAMEORIGIN', 'and the answers that are not pages');
  } finally { await d.close(); }
});

test('a run\'s files are served and listed only as real files of the run: a link the runner left, `..` and out/ are not', async () => {
  const { d, root, fx, api, cookie } = await service();
  try {
    const secret = join(fx.tmp, 'daemon.json');
    writeFileSync(secret, 'the-token-of-the-service');
    const run7 = join(root, '.laru', 'runs', '7');
    mkdirSync(join(run7, 'flows', 'x'), { recursive: true });
    mkdirSync(join(run7, 'raw'), { recursive: true });
    mkdirSync(join(run7, 'out'), { recursive: true });
    writeFileSync(join(run7, 'run.json'), JSON.stringify({ id: '7', env: 'local', ephemeral: false, flows: ['x'], phase: 'done', status: 'passed', startedAt: '', pid: 1, results: {} }));
    writeFileSync(join(run7, 'flows', 'x', 'video.webm'), 'video');
    writeFileSync(join(run7, 'raw', 'sql.jsonl'), '{}');
    writeFileSync(join(run7, 'out', 'runner.log'), 'raw output');
    // what a moved screenshot or a results folder could be: links to the token and to a folder holding it
    symlinkSync(secret, join(run7, 'flows', 'x', 's1.png'));
    symlinkSync(fx.tmp, join(run7, 'flows', 'home'));
    symlinkSync(secret, join(run7, 'raw', 'traffic.jsonl'));
    const file = (path: string, id = '7') => send('GET', `${api}/run-file?id=${id}&path=${encodeURIComponent(path)}`, { headers: { cookie } });
    assert.deepEqual([(await file('flows/x/video.webm')).status, (await file('raw/sql.jsonl')).status], [200, 200], 'the evidence');
    for (const path of ['flows/x/s1.png', 'flows/home/daemon.json', 'raw/traffic.jsonl', 'flows/../out/runner.log', 'out/runner.log', 'flows/x/../../run.json', '../../ws/laru.yaml', 'flows/x', secret, '/etc/passwd']) {
      const r = await file(path);
      assert.equal(r.status, 403, path);
      assert.ok(!r.body.includes('the-token-of-the-service'), path);
    }
    assert.equal((await file('flows/x/video.webm', '7/../7')).status, 403, 'a run is a number');
    const listed = JSON.parse((await send('GET', `${api}/run/files?id=7`, { headers: { cookie } })).body) as Array<{ path: string }>;
    assert.deepEqual(listed.map((f) => f.path).sort(), ['flows/x/video.webm', 'raw/sql.jsonl'], 'listed as served: no link, nothing behind one, no out/');
  } finally { await d.close(); }
});

test('a run\'s live events are read from a real out/events.jsonl only: a link the runner swapped in streams nothing', async () => {
  const { d, root, fx, api, cookie } = await service();
  try {
    const secret = join(fx.tmp, 'daemon.json');
    writeFileSync(secret, '{"e":"phase","phase":"the-token-of-the-service","t":1}\n');
    for (const id of ['7', '8']) {
      mkdirSync(join(root, '.laru', 'runs', id, 'out'), { recursive: true });
      writeFileSync(join(root, '.laru', 'runs', id, 'run.json'), JSON.stringify({ id, env: 'local', ephemeral: false, flows: ['x'], phase: 'tests', status: 'running', startedAt: '', pid: process.pid, results: {} }));
    }
    writeFileSync(join(root, '.laru', 'runs', '7', 'out', 'events.jsonl'), '{"e":"phase","phase":"tests","t":1}\n');
    symlinkSync(secret, join(root, '.laru', 'runs', '8', 'out', 'events.jsonl'));
    const stream = (id: string) => send('GET', `${api}/run/events?id=${id}`, { headers: { cookie }, ms: 900 });
    assert.match((await stream('7')).body, /"phase":"tests"/, 'a real file streams');
    const linked = await stream('8');
    assert.equal(linked.status, 200);
    assert.ok(!linked.body.includes('the-token-of-the-service'), 'a link to the token streams nothing of it');
  } finally { await d.close(); }
});

test('a run and a flow are names, not paths: no route reads a folder the runner writes by way of one', async () => {
  const { d, root, api, cookie } = await service();
  try {
    const run7 = join(root, '.laru', 'runs', '7');
    mkdirSync(join(run7, 'flows', 'y'), { recursive: true });
    mkdirSync(join(run7, 'out', 'flows', 'x'), { recursive: true });
    writeFileSync(join(run7, 'run.json'), JSON.stringify({ id: '7', env: 'local', ephemeral: false, flows: ['y'], phase: 'done', status: 'passed', startedAt: '', pid: 1, results: {} }));
    writeFileSync(join(run7, 'flows', 'y', 'cases.json'), '[{"marker":"LARU-WROTE-THIS"}]');
    writeFileSync(join(run7, 'out', 'flows', 'x', 'cases.json'), '[{"marker":"RUNNER-WROTE-THIS"}]');
    const get = (path: string) => send('GET', `${api}${path}`, { headers: { cookie } });

    const ok = await get('/run/trace?id=7&flow=y');
    assert.equal(ok.status, 200);
    assert.match(ok.body, /LARU-WROTE-THIS/);
    for (const q of ['id=7%2Fout&flow=x', 'id=7&flow=..%2Fout%2Fflows%2Fx', 'id=7%2F..%2F7&flow=y', 'id=..&flow=y', 'id=7&flow=']) {
      const r = await get(`/run/trace?${q}`);
      assert.notEqual(r.status, 200, q);
      assert.ok(!r.body.includes('RUNNER-WROTE-THIS'), q);
    }
    for (const path of ['/run?id=7%2Fout', '/run?id=..%2F7']) assert.equal((await get(path)).status, 404, path);
  } finally { await d.close(); }
});

test('a peek that requeues what it reads is a POST: a link (a navigation sends the cookie) cannot fire it', async () => {
  const { d, api, cookie } = await service();
  try {
    const get = await send('GET', `${api}/rabbit/get?env=local&queue=q&count=50&reorder=1`, { headers: { cookie } });
    assert.deepEqual([get.status, JSON.parse(get.body).error], [404, 'Not found'], 'there is no GET to it');
    const post = await send('POST', `${api}/rabbit/get`, { headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ env: 'local', queue: 'q', reorder: true }) });
    assert.match(JSON.parse(post.body).error, /no env "local"/, 'the POST reaches the handler (which finds no env here)');
  } finally { await d.close(); }
});
