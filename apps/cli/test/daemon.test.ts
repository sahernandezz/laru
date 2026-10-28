import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appHome, idOf, initWorkspace, laruHome, knowledgeWrite, loadRegistry, loadWorkspace, resolveId, unregister } from '@laru/core';
import { envLock, hold } from '@laru/runtime';
import { makeFixture } from '../../../packages/core/test/fixture.ts';
import { run } from '../src/cli.ts';
import { daemonFile, liveDaemon, olderLaru, PROBE_CAP, probeFolder, readDaemonFile, removeDaemonFile, startDaemon, writeDaemonFile } from '../src/daemon.ts';

/** fetch() cannot set Host, so the rebinding check is exercised with node:http. */
const get = (url: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
  const req = request(url, { headers }, (res) => { let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => ok({ status: res.statusCode!, headers: res.headers, body })); });
  req.on('error', fail);
  req.end();
});

test('the local service started with --token: token once, cookie after, localhost only', async () => {
  const fx = makeFixture();
  const root = join(fx.tmp, 'ws');
  const quiet = { log: () => {}, err: () => {} };
  await run(['init', root, '--app', 'comercio'], quiet);
  await run(['repo', 'add', fx.billingUrl], quiet, root);
  await run(['map'], quiet, root);
  const d = await startDaemon(0, undefined, { token: true });
  try {
    const base = new URL(d.url).origin, api = `${base}/api/w/comercio`;
    assert.ok(loadRegistry().some((x) => x.root === root), 'init registered it');
    assert.equal((await get(`${api}/workspace`)).status, 401, 'no cookie, no API');
    assert.equal((await get(`${base}/?token=wrong`)).status, 403);
    const login = await get(d.url);
    assert.equal(login.status, 303);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    assert.match(String(login.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    const ws = await get(`${api}/workspace`, { cookie });
    assert.equal(ws.status, 200);
    assert.equal(JSON.parse(ws.body).app, 'comercio');
    assert.equal((await get(`${api}/workspace`, { cookie, host: 'evil.example:4100' })).status, 421, 'a rebinding host is refused');
    const map = JSON.parse((await get(`${api}/map`, { cookie })).body);
    assert.ok(map.nodes.some((n: { id: string }) => n.id === 'svc:billing-api'));
    assert.equal((await get(`${api}/context?target=billing-api`, { cookie })).status, 404, 'the interface no longer copies context; the CLI and MCP do');

    // Run files: ranges for the video, nothing outside the run's directory, streams only with the cookie.
    const runDir = join(root, '.laru', 'runs', '7');
    mkdirSync(join(runDir, 'flows', 'x'), { recursive: true });
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({ id: '7', env: 'local', ephemeral: false, flows: ['x'], phase: 'done', status: 'passed', startedAt: '', pid: 1, results: {} }));
    writeFileSync(join(runDir, 'flows', 'x', 'video.webm'), Buffer.alloc(1000, 7));
    const part = await get(`${api}/run-file?id=7&path=flows/x/video.webm`, { cookie, range: 'bytes=100-199' });
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], 'bytes 100-199/1000');
    assert.equal(part.body.length, 100);
    assert.equal((await get(`${api}/run-file?id=7&path=../../map.json`, { cookie })).status, 403);
    assert.equal((await get(`${api}/run-file?id=7&path=flows/x/video.webm`)).status, 401);
    assert.equal((await get(`${api}/run/events?id=7`)).status, 401, 'SSE needs the cookie');

    // A screen recorded outside the runner hands its video in: the one POST that is not JSON, and only as video/webm.
    const send = (path: string, type: string, body: Buffer, headers: Record<string, string> = { cookie }) => new Promise<{ status: number; body: string }>((ok, fail) => {
      const q = request(`${api}${path}`, { method: 'POST', headers: { 'content-type': type, ...headers } }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => ok({ status: res.statusCode!, body: t })); });
      q.on('error', fail); q.end(body);
    });
    const clip = Buffer.alloc(5000, 3);
    const kept = await send('/run/screen-video?id=7&flow=x&screen=luis', 'video/webm', clip);
    assert.equal(kept.status, 200, kept.body);
    assert.deepEqual(readFileSync(join(runDir, 'flows', 'x', 'video-luis.webm')), clip);
    assert.equal((await send('/run/screen-video?id=7&flow=x&screen=luis', 'application/octet-stream', clip)).status, 415, 'only video/webm skips the JSON rule');
    assert.equal((await send('/runs/start', 'video/webm', clip)).status, 415, 'and only on that route');
    assert.equal((await send('/run/screen-video?id=7&flow=x&screen=a%20b', 'video/webm', clip)).status, 400, 'a screen is a plain name');
    assert.equal((await send('/run/screen-video?id=7&flow=nada&screen=luis', 'video/webm', clip)).status, 409, 'a flow the run has no evidence of');
    assert.equal((await send('/run/screen-video?id=7&flow=x&screen=luis', 'video/webm', clip, {})).status, 401, 'with the cookie');

    // A flow's last result: the newest row that is not an error; a cached one points at the run with the evidence,
    // whose story is matched against today's map.
    const w = loadWorkspace(root);
    const write = (x: Parameters<typeof knowledgeWrite>[1]) => { const r = knowledgeWrite(w, x, null); assert.ok(r.ok, JSON.stringify(r.issues)); };
    write({ type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } });
    write({ type: 'module', id: 'mod:devoluciones', in: 'app:comercio', title: 'Devoluciones', summary: 'Devolver pedidos.', kind: 'area', fields: { purpose: 'Devolver el dinero.' } });
    write({ type: 'flow', id: 'flow:devolver', in: 'mod:devoluciones', title: 'Devolver un pedido', summary: 'Un cliente devuelve un pedido.', fields: { goal: 'El dinero vuelve.', actors: ['Cliente'], steps: [{ step: 'Pedir la devolución', actor: 'Cliente', expected: 'Queda pendiente' }] } });
    const runs = join(root, '.laru', 'runs');
    const at = (n: number) => new Date(Date.UTC(2026, 9, 22, 10, n)).toISOString();
    for (const [id, status, more] of [['5', 'passed', {}], ['6', 'cached', { cachedFrom: '5' }], ['8', 'error', {}]] as const) {
      mkdirSync(join(runs, id, 'flows', 'devolver'), { recursive: true });
      writeFileSync(join(runs, id, 'run.json'), JSON.stringify({ id, env: 'local', ephemeral: false, flows: ['devolver'], phase: 'done', status, startedAt: at(Number(id)), pid: 1, results: { devolver: { status, ...more } } }));
      appendFileSync(join(runs, 'index.jsonl'), JSON.stringify({ run: id, flow: 'devolver', status, at: at(Number(id)) }) + '\n');
    }
    writeFileSync(join(runs, '5', 'flows', 'devolver', 'trace.json'), JSON.stringify({
      v: 1, run: '5', flow: 'devolver', test: 'historia', env: 'local', t0: 0, durationMs: 1, status: 'passed', story: true, steps: [], logs: [],
      participants: [{ id: 'runner', name: 'Prueba', type: 'runner' }, { id: 'billing-api', name: 'billing-api', type: 'service', node: 'svc:billing-api' }],
      exchanges: [{ id: 'r', kind: 'http', from: 'runner', to: 'billing-api', t0: 0, label: 'POST /refunds', ok: true, origin: 'observed', step: 1, method: 'POST', path: '/refunds' }],
    }));
    const lastOf = async () => (JSON.parse((await get(`${api}/flows`, { cookie })).body) as Array<{ id: string; last: { run: string; at: string; status: string; endpoints: Array<{ id: string }> } | null }>).find((f) => f.id === 'flow:devolver')!.last;
    const last = await lastOf();
    assert.deepEqual([last?.run, last?.at, last?.status], ['5', at(6), 'cached'], 'run 8 errored; run 6 was cached from run 5');
    assert.deepEqual(last?.endpoints.map((e) => e.id), ['ep:billing-api:POST /refunds'], 'matched now, though the trace stored no endpoint');
    const seen = JSON.parse((await get(`${api}/seen`, { cookie })).body);
    assert.deepEqual([seen.endpoints['ep:billing-api:POST /refunds']?.statuses, seen.endpoints['ep:billing-api:POST /refunds']?.at], [{ error: 1 }, at(6)], 'what run 5 saw, confirmed by run 6');
    assert.deepEqual(JSON.parse((await get(`${api}/mock-contracts`, { cookie })).body), {}, 'no env mocks anything');
    // A map read again forgets what the old one matched.
    const mapFile = join(root, '.laru', 'map.json'), read = JSON.parse(readFileSync(mapFile, 'utf8'));
    writeFileSync(mapFile, JSON.stringify({ ...read, nodes: read.nodes.filter((n: { id: string }) => n.id !== 'ep:billing-api:POST /refunds') }));
    utimesSync(mapFile, new Date(), new Date(Date.now() + 60_000));
    assert.deepEqual((await lastOf())?.endpoints, []);
  } finally {
    await d.close();
  }
});

test('the local service by default: no sign-in asked, and the walls that keep a web page of this machine out stay', async () => {
  const fx = makeFixture();
  const quiet = { log: () => {}, err: () => {} };
  const root = join(fx.tmp, 'ws');
  await run(['init', root, '--app', 'comercio'], quiet);
  const dist = join(fx.tmp, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Laru</title>');
  const d = await startDaemon(0, dist);
  try {
    const base = new URL(d.url).origin, api = `${base}/api/w/comercio`;
    assert.equal(d.token, null);
    assert.equal(d.url, `${base}/`, 'the address has nothing to copy: a bookmark is enough');
    const page = await get(`${base}/w/comercio/`);
    assert.equal(page.status, 200, 'the page opens with no cookie');
    assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'self'/);
    assert.equal((await get(`${api}/workspace`)).status, 200, 'and so does the API');
    // What keeps another page out is not a password.
    assert.equal((await get(`${api}/workspace`, { host: 'evil.example:4100' })).status, 421, 'a rebinding host');
    assert.equal((await get(`${api}/workspace`, { 'sec-fetch-site': 'cross-site' })).status, 403, 'a page of another site');
    assert.equal((await get(`${api}/workspace`, { 'sec-fetch-site': 'same-site' })).status, 403, 'a page of another port of this machine');
    assert.equal((await get(`${api}/workspace`, { 'sec-fetch-site': 'same-origin' })).status, 200);
    const post = (headers: Record<string, string>) => new Promise<number>((ok, fail) => { const q = request(`${api}/scenarios/apply`, { method: 'POST', headers }, (res) => { res.resume(); ok(res.statusCode!); }); q.on('error', fail); q.end('{}'); });
    assert.equal(await post({}), 415, 'a POST with no type');
    assert.equal(await post({ 'content-type': 'text/plain' }), 415, 'a POST a form could send');
    // An address of an earlier start (with ?token=) is not an error: the parameter is dropped, and no cookie is set.
    const old = await get(`${base}/w/comercio/?token=anything`);
    assert.deepEqual([old.status, old.headers.location, old.headers['set-cookie']], [303, '/w/comercio/', undefined]);
    // daemon.json names the service with no token in it, and a service that answers as another process is not it.
    writeDaemonFile(d);
    assert.equal('token' in JSON.parse(readFileSync(daemonFile(), 'utf8')), false);
    assert.equal(statSync(daemonFile()).mode & 0o777, 0o600);
    assert.equal((await liveDaemon())?.port, d.port);
    writeFileSync(daemonFile(), JSON.stringify({ pid: process.ppid, port: d.port, startedAt: '', version: '0.1.0' }), { mode: 0o600 });
    assert.equal(await liveDaemon(), null, 'the pid in the file is not the one that answers');
    removeDaemonFile();
  } finally { await d.close(); }
});

test('one service, several workspaces: each under its id, the machine beside them, reveal by key, one instance per machine', { timeout: 60_000 }, async () => {
  const fx = makeFixture();
  const quiet = { log: () => {}, err: () => {} };
  const [a, b] = [join(fx.tmp, 'comercio'), join(fx.tmp, 'finanzas')];
  await run(['init', a, '--app', 'comercio', '--title', 'Comercio'], quiet);
  await run(['init', b, '--app', 'finanzas', '--title', 'Finanzas'], quiet);
  await run(['repo', 'add', fx.billingUrl], quiet, a);
  // Both envs fail before any Docker call (a compose file that is not there, a repo not on this machine): nothing starts.
  for (const w of [a, b]) { mkdirSync(join(w, 'envs'), { recursive: true }); writeFileSync(join(w, 'envs', 'local.yaml'), 'from: billing:no-such-compose.yml\n'); }
  process.env.LARU_REVEAL = 'off';
  const d = await startDaemon(0, undefined, { token: true });
  try {
    const base = new URL(d.url).origin;
    const ping = await get(`${base}/api/ping`);
    assert.deepEqual([ping.status, JSON.parse(ping.body)], [200, { laru: '0.1.0-beta.6', pid: process.pid }], 'ping needs no session and says only the version and whose it is');
    const cookie = String((await get(d.url.replace('/?', '/w/finanzas/?'))).headers['set-cookie']).split(';')[0];
    const call = async (method: string, path: string, body?: unknown) => new Promise<{ status: number; json: any }>((ok, fail) => {
      const req = request(`${base}${path}`, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => { let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => ok({ status: res.statusCode!, json: t ? JSON.parse(t) : null })); });
      req.on('error', fail);
      req.end(body ? JSON.stringify(body) : undefined);
    });

    // Each workspace answers with its own data, under its own id; an unknown id is a 404 the screen can name.
    assert.deepEqual([(await call('GET', '/api/w/comercio/workspace')).json.title, (await call('GET', '/api/w/finanzas/workspace')).json.title], ['Comercio', 'Finanzas']);
    assert.deepEqual(await call('GET', '/api/w/nope/workspace'), { status: 404, json: { error: 'no workspace nope on this machine', workspace: 'nope' } });
    assert.equal((await call('GET', '/api/workspace')).status, 404, 'a workspace route needs its id');
    const rows = (await call('GET', '/api/workspaces')).json as Array<{ id: string; title: string; projects: number }>;
    assert.deepEqual(rows.map((r) => [r.id, r.projects]).sort(), [['comercio', 1], ['finanzas', 0]]);
    assert.ok(loadRegistry().find((x) => x.root === a)?.openedAt, 'opening a workspace touches it');
    // a twin of comercio, opened last: each row's id is its own (the list is sorted by last opened, ids are not)
    const twin = join(fx.tmp, 'comercio-2');
    await run(['init', twin, '--app', 'comercio'], quiet);
    const twinId = idOf(twin)!;
    assert.match(twinId, /^comercio~/);
    await call('GET', `/api/w/${twinId}/workspace`);
    const all = (await call('GET', '/api/workspaces')).json as Array<{ id: string; root: string }>;
    assert.equal(all[0].root, twin, 'the one opened last comes first');
    for (const r of all) assert.equal(resolveId(r.id), r.root, r.id);
    await unregister(twin);
    assert.equal((await call('GET', `/api/workspaces/probe?path=${encodeURIComponent(b)}`)).json.app, 'finanzas');
    assert.equal((await call('GET', `/api/workspaces/probe?path=${encodeURIComponent(fx.tmp)}`)).json.reason, 'no-yaml');

    // An up in one workspace does not hold the other's: comercio's waits on its env lock, finanzas's runs and settles.
    const release = await hold('test', envLock({ root: a }, 'local'));
    assert.equal((await call('POST', '/api/w/comercio/env/up', { env: 'local' })).status, 200);
    assert.equal((await call('POST', '/api/w/finanzas/env/up', { env: 'local' })).status, 200);
    await new Promise((r) => setTimeout(r, 300));
    const op = async (id: string) => (await call('GET', `/api/w/${id}/env?env=local`)).json.op;
    assert.equal((await op('finanzas')).done, true, 'finanzas settled (its repo is not on this machine)');
    assert.match((await op('finanzas')).error, /billing/);
    assert.equal((await op('comercio')).done, undefined, 'comercio still waits for its env');
    release();
    await new Promise((r) => setTimeout(r, 1500));
    assert.match((await op('comercio')).error ?? '', /no-such-compose\.yml is not in billing@/);

    // Reveal takes a key; the service builds the path. A path from the client is refused.
    mkdirSync(join(a, '.laru', 'runs', '7', 'flows', 'x'), { recursive: true });
    writeFileSync(join(a, '.laru', 'runs', '7', 'flows', 'x', 'trace.json'), '{}');
    mkdirSync(join(appHome('comercio'), 'snapshots', 'billing@abc1234'), { recursive: true });
    const reveal = (body: unknown) => call('POST', '/api/w/comercio/reveal', body);
    const shown = [
      [{ what: 'workspace' }, a], [{ what: 'state' }, join(a, '.laru')], [{ what: 'runs' }, join(a, '.laru', 'runs')], [{ what: 'run', id: '7' }, join(a, '.laru', 'runs', '7')], [{ what: 'run-file', id: '7/flows/x/trace.json' }, join(a, '.laru', 'runs', '7', 'flows', 'x', 'trace.json')],
      [{ what: 'project', id: 'billing' }, loadWorkspace(a).checkouts.billing], [{ what: 'snapshot', id: 'billing@abc1234' }, join(appHome('comercio'), 'snapshots', 'billing@abc1234')],
      [{ what: 'personal' }, appHome('comercio')], [{ what: 'home' }, laruHome()],
    ] as const;
    for (const [body, path] of shown) assert.deepEqual(await reveal(body), { status: 200, json: { ok: true, path } }, JSON.stringify(body));
    assert.deepEqual((await reveal({ what: 'env', id: 'local' })).json, { ok: true, path: join(a, '.laru', 'envs', 'local') }, 'the up above made its folder');
    assert.equal((await reveal({ what: 'run', id: '99' })).status, 404);
    for (const bad of [{ what: 'workspace', path: '/etc' }, { what: 'run', id: '../x' }, { what: 'run-file', id: '7/../8/run.json' }, { what: 'run-file', id: '7/../../../laru.yaml' }, { what: 'run-file', id: 'x/run.json' }, { what: 'project', id: 'nope' }, { what: 'disk' }]) assert.equal((await reveal(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await call('POST', '/api/machine/reveal', { what: 'home' })).status, 200);
    // A joint env from the dialog: validated by writeJoint; refused with the field, nothing written anywhere.
    assert.deepEqual(await call('POST', '/api/w/comercio/env/create', { name: '../../outside-joint', join: ['local', 'x'] }), { status: 400, json: { error: 'name: env names are kebab-case', field: 'name' } });
    assert.ok(!existsSync(join(fx.tmp, 'outside-joint.yaml')));
    assert.equal((await call('POST', '/api/machine/config', { maxEnvs: 0 })).status, 400);
    assert.equal((await call('POST', '/api/machine/config', { maxEnvs: 2 })).json.maxEnvs, 2);
    // «Crear uno nuevo»: only under the home folder, never the home folder itself; nothing written when refused.
    const realHome = process.env.HOME;
    process.env.HOME = join(fx.tmp, 'userhome');
    try {
      for (const root of [join(fx.tmp, 'elsewhere', 'nuevo'), '~', '/']) assert.deepEqual(await call('POST', '/api/workspaces/init', { root, app: 'nuevo' }), { status: 400, json: { error: `root: a folder under ${join(fx.tmp, 'userhome')}`, field: 'root' } }, root);
      assert.ok(!existsSync(join(fx.tmp, 'elsewhere')) && !existsSync(join(fx.tmp, 'userhome')));
      const made = await call('POST', '/api/workspaces/init', { root: '~/laru/nuevo', app: 'nuevo' });
      assert.deepEqual([made.status, made.json.id], [200, 'nuevo']);
      assert.ok(existsSync(join(fx.tmp, 'userhome', 'laru', 'nuevo', 'laru.yaml')));
    } finally { process.env.HOME = realHome; }

    // One service per machine: daemon.json (0600) names it; another serve prints its address and leaves it running.
    writeDaemonFile(d);
    assert.equal(statSync(daemonFile()).mode & 0o777, 0o600);
    assert.equal((await liveDaemon())?.port, d.port);
    const said: string[] = [];
    assert.equal(await run(['serve'], { log: (s) => said.push(s), err: (s) => said.push(s) }, a), 0);
    assert.match(said.join('\n'), new RegExp(`already running on 127\\.0\\.0\\.1:${d.port}[\\s\\S]*/w/comercio/\\?token=${readDaemonFile()!.token}`));
    removeDaemonFile();
    // A stale daemon.json (a crash, a reboot): its pid is someone else's now and its port another Laru's. Not killed.
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      writeFileSync(daemonFile(), JSON.stringify({ pid: sleeper.pid, port: d.port, token: 'not-its-token', startedAt: '', version: '0.1.0' }), { mode: 0o600 });
      assert.equal(await liveDaemon(), null);
      const stop: string[] = [];
      assert.equal(await run(['serve', '--stop'], { log: (x) => stop.push(x), err: (x) => stop.push(x) }, a), 0);
      assert.deepEqual(stop, ['No Laru service is running.']);
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual([sleeper.exitCode, sleeper.signalCode], [null, null], 'the process the stale file named still runs');
      assert.ok(!existsSync(daemonFile()), 'the stale file is gone');
    } finally { sleeper.kill(); }
  } finally {
    delete process.env.LARU_REVEAL;
    await d.close();
  }
  // A Laru from before (one workspace per process) answers 401 with its old words: recognised.
  const old = createServer((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Open the address printed by `laru serve`.' })); });
  await new Promise<void>((ok) => old.listen(0, '127.0.0.1', ok));
  try { assert.equal(await olderLaru((old.address() as { port: number }).port), true); } finally { old.close(); }
});

test('«Añadir proyecto» probes as you type: the home folder answered at once as too wide, a big folder counted up to the cap', { timeout: 60_000 }, async () => {
  const fx = makeFixture();
  const w = initWorkspace(join(fx.tmp, 'ws'), { app: 'probe', title: 'Probe' });
  const realHome = process.env.HOME;
  process.env.HOME = join(fx.tmp, 'userhome');
  mkdirSync(process.env.HOME);
  try {
    const wide = { exists: true, isGit: false, origin: null, files: 0, wide: true };
    for (const p of ['~', '~/', '/']) assert.deepEqual(await probeFolder(w, p), wide, p);
  } finally { process.env.HOME = realHome; }
  const big = join(fx.tmp, 'big');
  mkdirSync(big);
  for (let i = 0; i <= PROBE_CAP + 5; i++) writeFileSync(join(big, `f${i}`), '');
  assert.equal((await probeFolder(w, big)).files, PROBE_CAP, 'counted to the cap, not lost past a buffer');
  fx.write(join(fx.tmp, 'small'), { 'a.txt': 'a', 'node_modules/x.js': 'x', '.env': 's', '.env.example': 'e' });
  assert.deepEqual(await probeFolder(w, join(fx.tmp, 'small')), { exists: true, isGit: false, origin: null, files: 2 });
});

test('the mailbox over HTTP: the frame is its own document with its own policy, an attachment is a download, and the walls of the service hold', async () => {
  const fx = makeFixture();
  const quiet = { log: () => {}, err: () => {} };
  const root = join(fx.tmp, 'ws');
  await run(['init', root, '--app', 'comercio'], quiet);
  mkdirSync(join(root, 'envs'), { recursive: true });
  writeFileSync(join(root, 'envs', 'correo.yaml'), 'persistent: true\n');
  const box = join(root, '.laru', 'envs', 'correo', 'tap', 'mail');
  mkdirSync(join(box, 'eml'), { recursive: true });
  const id = '3f2b7a40-0c1d-4e5f-8a9b-1c2d3e4f5a6b';
  const eml = 'From: a@t.test\r\nTo: b@t.test\r\nSubject: hola\r\nContent-Type: multipart/mixed; boundary="M"\r\n\r\n--M\r\nContent-Type: text/html\r\n\r\n<p onclick="x()">Hola <a href="http://web/ok">ok</a></p><script>alert(1)</script>\r\n--M\r\nContent-Type: image/svg+xml; name="x.svg"\r\nContent-Disposition: attachment; filename="x.svg"\r\n\r\n<svg onload="alert(1)"/>\r\n--M--\r\n';
  writeFileSync(join(box, 'eml', `${id}.eml`), eml);
  writeFileSync(join(box, 'messages.jsonl'), `${JSON.stringify({ v: 1, t: Date.now(), id, kind: 'mail', from: '1.2.3.4', sink: 'smtp', port: 587, tls: 'none', envelope: { from: 'a@t.test', rcpt: ['b@t.test'] }, size: eml.length, headers: { from: 'a@t.test', to: ['b@t.test'], cc: [], subject: 'hola' }, text: '', attachments: [{ name: 'x.svg', type: 'image/svg+xml', size: 20, sha256: 'x' }], links: [], codes: [], remote: [], lints: [], session: [], outcome: 'accepted', reply: '250' })}\n`);
  const d = await startDaemon(0);
  try {
    const api = `${new URL(d.url).origin}/api/w/comercio`;
    const list = JSON.parse((await get(`${api}/mail?env=correo`)).body);
    assert.deepEqual([list.counts.all, list.messages[0].subject], [1, 'hola']);
    assert.equal(JSON.parse((await get(`${api}/mail/message?id=${id}&env=correo`)).body).unmasked, true);
    const frame = await get(`${api}/mail/html?env=correo&id=${id}`);
    assert.equal(frame.status, 200);
    assert.match(String(frame.headers['content-security-policy']), /^sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'$/);
    assert.deepEqual([frame.headers['referrer-policy'], frame.headers['x-content-type-options'], frame.headers['cache-control']], ['no-referrer', 'nosniff', 'no-store']);
    assert.doesNotMatch(frame.body, /<script|onclick|\shref=|alert\(1\)/);
    assert.match(frame.body, /data-href="http:\/\/web\/ok"/);
    const att = await get(`${api}/mail/part?env=correo&id=${id}&n=0`);
    assert.deepEqual([att.headers['content-type'], att.headers['content-disposition'], att.headers['content-security-policy']], ['application/octet-stream', "attachment; filename*=UTF-8''x.svg", 'sandbox']);
    assert.equal((await get(`${api}/mail/eml?env=correo&id=../../x`)).status, 400);
    assert.equal((await get(`${api}/mail/html?env=nada&id=${id}`)).status, 500, 'an env that does not exist');
    // the walls: another page of this machine gets nothing, and a POST that is not JSON is refused
    for (const path of ['mail?env=correo', `mail/html?env=correo&id=${id}`, `mail/eml?env=correo&id=${id}`]) assert.equal((await get(`${api}/${path}`, { 'sec-fetch-site': 'cross-site' })).status, 403, path);
    const post = (type?: string) => new Promise<number>((ok, fail) => { const q = request(`${api}/mail/clear?env=correo`, { method: 'POST', headers: type ? { 'content-type': type } : {} }, (res) => { res.resume(); ok(res.statusCode!); }); q.on('error', fail); q.end(); });
    assert.equal(await post(), 415);
    assert.equal(await post('text/plain'), 415);
  } finally { await d.close(); }
});
