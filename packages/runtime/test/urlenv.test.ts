/**
 * An env by URL: the app already running at an address, which Laru never runs or changes. Its file says only where;
 * it is ready while the app answers; its browser is its tap, so a session on it keeps each request the page made and
 * what the page said in its console, and a runner leaves Laru's network to reach it (an app on this Mac through
 * host.docker.internal, its address unchanged).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initWorkspace, knowledgeWrite, WorkspaceError, type Workspace } from '@laru/core';
import { createMasker, hitOf as serviceHitOf, PLAIN } from '@laru/trace';
import { hitOf as runnerHitOf } from '../../trace/src/flow.ts';
import { baseUrl, down, EnvError, envUrl, hitRecord, isAppUrl, listFlows, loadEnvSpec, readTrace, runFlows, runnerArgs, runSessionBrowser, runTraces, sessionBrowser, startSession, status, stopSession, up, workspaceKey } from '../src/index.ts';
import { dockerUp, guard } from './guard.ts';

const listen = (s: Server) => new Promise<number>((done) => s.listen(0, '127.0.0.1', () => done((s.address() as { port: number }).port)));
function workspace(envs: Record<string, string>): Workspace {
  const ws = initWorkspace(join(mkdtempSync(join(tmpdir(), 'laru-urlenv-')), 'ws'), { app: 'shop', title: 'Shop', docsLanguage: 'es' });
  mkdirSync(join(ws.root, 'envs'), { recursive: true });
  for (const [name, body] of Object.entries(envs)) writeFileSync(join(ws.root, 'envs', `${name}.yaml`), body);
  return ws;
}

test('an env by URL says only where the app is: http or https, no user or password, nothing Laru would run', () => {
  const ws = workspace({ qa: 'url: https://qa.example.com/app#x\n', local: 'url: http://localhost:4200\n', ftp: 'url: ftp://files.example.com\n', creds: 'url: https://ana:secreto@qa.example.com\n', mixed: 'url: https://qa.example.com\nhybrid: [api]\n' });
  assert.equal(loadEnvSpec(ws, 'qa').url, 'https://qa.example.com/app', 'the hash goes, the path stays');
  assert.equal(envUrl(ws, 'local'), 'http://localhost:4200/');
  assert.equal(envUrl(ws, 'none'), undefined);
  assert.throws(() => loadEnvSpec(ws, 'ftp'), (e: WorkspaceError) => /http or https/.test(e.message) && /url$/.test(e.at ?? ''));
  assert.throws(() => loadEnvSpec(ws, 'creds'), /no user or password/);
  assert.throws(() => loadEnvSpec(ws, 'mixed'), (e: WorkspaceError) => /hybrid does not apply/.test(e.message) && /hybrid$/.test(e.at ?? ''));
  assert.equal(envUrl(ws, 'mixed'), undefined, 'a broken file is no env by URL');
});

test('it is ready while the app answers (any answer), there is nothing to bring up or take down, and runs start at its address', async (t) => {
  const app = createServer((_q, r) => r.writeHead(302, { location: '/login' }).end());
  const port = await listen(app);
  t.after(() => app.close());
  const gone = createServer();
  const closed = await listen(gone);
  await new Promise((r) => gone.close(r));
  const ws = workspace({ app: `url: http://127.0.0.1:${port}\n`, off: `url: http://127.0.0.1:${closed}\n` });
  const st = await status(ws, 'app');
  assert.equal(st.state, 'ready', 'a redirect to its sign-in is an answer');
  assert.deepEqual(st.addresses, [{ service: `127.0.0.1:${port}`, kind: 'http', url: `http://127.0.0.1:${port}/` }]);
  assert.equal((await status(ws, 'off')).state, 'failed');
  await assert.rejects(up(ws, { env: 'app' }), (e: EnvError) => e instanceof EnvError && /nothing to bring up/.test(e.message) && !/does not answer/.test(e.message));
  await assert.rejects(up(ws, { env: 'off' }), /does not answer now/);
  await assert.rejects(startSession(ws, { env: 'app', scenario: 'con-pedidos' }), /whose data live where it does: Laru cannot put con-pedidos in them/, 'a scenario goes into stores Laru runs');
  await assert.rejects(startSession(ws, { env: 'off' }), /off does not answer at http:\/\/127\.0\.0\.1:\d+\/: start the app where it lives/);
  assert.deepEqual(await down(ws, 'app'), { containers: 0, networks: 0, volumes: 0, left: [] });
  assert.equal(baseUrl(ws, 'app'), `http://127.0.0.1:${port}/`);
});

test('a request the browser saw becomes the record a tap would write: its body\'s head when textual, its secrets masked when masking is on', () => {
  const hit = {
    t0: 1000, t1: 1040, method: 'POST', url: 'https://qa.example.com/api/orders?token=abc&page=2', status: 201,
    reqHeaders: { 'content-type': 'application/json', authorization: 'Bearer abc.def', 'user-agent': 'Mozilla/5.0 HeadlessChrome' },
    resHeaders: { 'content-type': 'application/json' }, reqBytes: 31, req: Buffer.from('{"item":"pan","password":"x1"}').toString('base64'),
    resBytes: 120000, res: Buffer.from('{"id":7,' + '"x":"' + 'a'.repeat(70000) + '"}').toString('base64'),
  };
  const r = hitRecord(hit, '127.0.0.1', createMasker([]));
  assert.equal(r.svc, 'qa.example.com');
  assert.equal(r.port, 443);
  assert.equal(r.path, '/api/orders');
  assert.doesNotMatch(r.query ?? '', /abc/, 'a secret-looking parameter is masked');
  assert.doesNotMatch(r.reqHeaders?.authorization ?? '', /abc\.def/);
  assert.match(r.req?.text ?? '', /"item":"pan"/);
  assert.doesNotMatch(r.req?.text ?? '', /x1/);
  assert.equal(r.res?.bytes, 120000);
  assert.equal(r.res?.note, 'first 64 KB');
  const img = hitRecord({ ...hit, url: 'http://cdn.example.com/logo.png', resHeaders: { 'content-type': 'image/png' }, res: undefined, resBytes: 5000 }, '127.0.0.1', PLAIN);
  assert.equal(img.port, 80);
  assert.deepEqual(img.res, { bytes: 5000, note: 'image/png: not recorded' });
  assert.equal(img.reqHeaders?.authorization, 'Bearer abc.def', 'masking off on this machine: what passed');
});

test('the runner\'s browser keeps a request exactly as the session\'s does: one recorder, written twice because flow.ts imports nothing of its own', async () => {
  const fake = (o: { url: string; post?: string; ct?: string; status?: number; body?: string; failed?: string }) => ({
    url: () => o.url, method: () => (o.post ? 'POST' : 'GET'), timing: () => ({ startTime: 1700000000000.4, responseEnd: o.failed ? -1 : 12.6 }),
    allHeaders: async () => ({ 'content-type': o.ct ?? 'application/json', 'user-agent': 'Mozilla/5.0' }), postDataBuffer: () => (o.post ? Buffer.from(o.post) : null),
    response: async () => (o.failed ? null : { status: () => o.status ?? 200, allHeaders: async () => ({ 'content-type': o.ct ?? 'application/json', 'content-length': String(o.body?.length ?? 0) }), body: async () => Buffer.from(o.body ?? '') }),
    failure: () => (o.failed ? { errorText: o.failed } : null),
  });
  for (const q of [fake({ url: 'http://localhost:4200/api/x', post: '{"a":1}', body: '{"ok":true}' }), fake({ url: 'https://qa.example.com/app.css', ct: 'text/css', body: 'body{}' }),
    fake({ url: 'http://localhost:9/', failed: 'net::ERR_CONNECTION_REFUSED' }), fake({ url: 'data:text/plain,hola' })]) {
    const [a, b] = [await serviceHitOf(q), await runnerHitOf(q as never)];
    if (a?.error) { a.t1 = 0; b!.t1 = 0; } // a failed request ends now
    assert.deepEqual(b, a);
  }
});

test('the session browser of an env by URL opens only the app\'s own addresses', () => {
  assert.equal(isAppUrl('https://qa.example.com/pedidos/7?x=1', 'https://qa.example.com/app'), true);
  for (const u of ['http://qa.example.com/', 'https://qa.example.com:8443/', 'https://evil.test/', 'https://ana:pw@qa.example.com/', 'javascript:alert(1)', 'not a url']) assert.equal(isAppUrl(u, 'https://qa.example.com/app'), false, u);
});

/**
 * A bot rule in front of the app, as CloudFront's WAF has: 403 to a browser that says it is headless, in its user agent or
 * in its client hints. The person's own browser passes, and so must the session's and the runner's.
 */
const said: string[] = [];
/** What the browsers said: everything but Laru's own check that the app answers, the one request that says `node`. */
const browsers = () => said.filter((x) => !/^node \|/.test(x));
const blocked = (q: import('node:http').IncomingMessage, r: import('node:http').ServerResponse) => {
  said.push(`${q.headers['user-agent'] ?? ''} | ${q.headers['sec-ch-ua'] ?? ''}`);
  if (!/headless/i.test(`${q.headers['user-agent'] ?? ''} ${q.headers['sec-ch-ua'] ?? ''}`)) return false;
  r.writeHead(403, { 'content-type': 'text/html', server: 'CloudFront' }).end('<h1>403 ERROR</h1><p>The request could not be satisfied. Request blocked.</p>');
  return true;
};

/** The Chrome installed on this Mac, which the session browser uses (no browser is downloaded). */
const chrome = (() => { try { return existsSync('/Applications/Google Chrome.app') || Boolean(execFileSync('which', ['google-chrome'], { encoding: 'utf8' }).trim()); } catch { return false; } })();

test('a session on an env by URL keeps what the page asked, from the person\'s browser, and what it said in its console', { skip: !chrome && 'no Chrome installed', timeout: 90_000 }, async (t) => {
  const app = createServer((q, r) => {
    if (blocked(q, r)) return;
    if (q.url === '/api/orders' && q.method === 'POST') { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => r.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 7, got: JSON.parse(b) }))); return; }
    if (q.url === '/api/missing') return void r.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no such order"}');
    r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<html><body><button id="b">Pedir</button><p id="out"></p><script>
      document.getElementById('b').onclick = async () => {
        console.log('pidiendo');
        const r = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item: 'pan' }) });
        await fetch('/api/missing');
        console.error('el pedido falló a medias');
        document.getElementById('out').textContent = 'pedido ' + (await r.json()).id;
        setTimeout(() => { throw new Error('boom en la página'); });
      };</script></body></html>`);
  });
  const port = await listen(app);
  t.after(() => app.close());
  const ws = workspace({ app: `url: http://localhost:${port}\n` });
  const run = await startSession(ws, { env: 'app', title: 'Pedir pan' });
  assert.equal(run.entrance, `http://localhost:${port}/`);
  let drove!: () => void;
  const driven = new Promise<void>((r) => (drove = r));
  const browser = runSessionBrowser(ws, run.id, { drive: async (page) => { await page.click('#b'); await page.getByText('pedido 7').waitFor(); await page.waitForTimeout(400); drove(); } });
  await Promise.race([driven, browser]);
  assert.equal(sessionBrowser(ws, run.id).outside.length, 0, 'nothing is outside: the browser is the tap');
  const saved = await stopSession(ws, run.id);
  await browser;
  assert.equal(saved.status, 'passed', saved.error);
  const trace = readTrace(ws, run.id, 'session')!;
  const hops = trace.exchanges.map((e) => `${e.from} → ${e.to} ${e.label} ${e.status ?? ''}`.trim());
  assert.ok(hops.includes(`browser → localhost:${port} POST /api/orders 201`), hops.join('\n'));
  assert.ok(hops.includes(`browser → localhost:${port} GET /api/missing 404`), hops.join('\n'));
  assert.ok(hops.some((h) => h.startsWith(`browser → localhost:${port} GET /`)), 'the page itself');
  const order = trace.exchanges.find((e) => e.label === 'POST /api/orders')!;
  assert.equal(order.req?.text, '{"item":"pan"}', 'what was sent, as the tap keeps it');
  assert.equal(order.res?.text, '{"id":7,"got":{"item":"pan"}}');
  const logs = trace.logs.map((l) => `${l.service} ${l.level} ${l.line}`);
  assert.ok(logs.includes('browser info pidiendo'), logs.join('\n'));
  assert.ok(logs.includes('browser error el pedido falló a medias'), logs.join('\n'));
  assert.ok(logs.some((l) => /^browser error boom en la página/.test(l)), logs.join('\n'));
  assert.ok(trace.participants.some((p) => p.id === 'browser' && p.type === 'browser'));
  assert.ok(browsers().length > 0 && browsers().every((x) => /Chrome\//.test(x) && !/headless/i.test(x)), `the browser says it is Chrome, never headless:\n${said.join('\n')}`);
});

test('a runner on an env by URL leaves Laru\'s network: it goes out as any container, reaches this Mac by host.docker.internal and mounts no tap', () => {
  const ws = workspace({ app: 'url: http://localhost:4200\n' });
  const args = runnerArgs(ws, 'app', undefined, '9', join(ws.root, 'out'), join(ws.root, '.runner-0.env'), ['flows/x/x.spec.ts']);
  assert.ok(!args.includes('--network'));
  assert.deepEqual(args.slice(args.indexOf('--add-host'), args.indexOf('--add-host') + 2), ['--add-host', 'host.docker.internal:host-gateway']);
  assert.ok(!args.some((a) => a.includes('/ks/tap/')), args.join(' '));
});

/** A shop on this Mac's localhost: a button that orders through its API and says so in its console. */
const SHOP = (q: import('node:http').IncomingMessage, r: import('node:http').ServerResponse) => {
  if (blocked(q, r)) return;
  if (q.url === '/api/orders' && q.method === 'POST') { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => r.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 7, got: JSON.parse(b) }))); return; }
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<html><body><button id="b">Pedir</button><p id="out"></p><script>
    document.getElementById('b').onclick = async () => {
      console.log('pidiendo');
      const r = await fetch('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item: 'pan' }) });
      document.getElementById('out').textContent = 'pedido ' + (await r.json()).id;
    };</script></body></html>`);
};

test('a run on an env by URL plays in a runner that reaches this Mac\'s localhost as it is, and its trace is what the browser asked and said', { skip: !dockerUp && 'Docker is not running', timeout: 300_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'laru-urlenv-home-'));
  process.env.LARU_HOME = home;
  writeFileSync(join(home, 'config.yaml'), 'maxEnvs: 9\n');
  const app = createServer(SHOP);
  const port = await listen(app);
  t.after(() => app.close());
  const ws = workspace({ app: `url: http://localhost:${port}\n` });
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => assert.ok(knowledgeWrite(ws, x, null).ok);
  w({ type: 'application', title: 'Shop', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pedidos'] } });
  w({ type: 'module', id: 'mod:tienda', in: 'app:shop', title: 'Tienda', summary: 'La tienda.', kind: 'area', fields: { purpose: 'Vender.' } });
  w({ type: 'flow', id: 'flow:pedir-pan', in: 'mod:tienda', title: 'Pedir pan', summary: 'Un pedido.', fields: { goal: 'Sale el pedido.', actors: ['Cliente'], steps: [{ step: 'Abrir la tienda', actor: 'Cliente', expected: 'Sale el botón' }, { step: 'Pedir', actor: 'Cliente', expected: 'Sale el pedido 7' }] } });
  writeFileSync(join(ws.root, listFlows(ws)[0].spec), `import { expect, step, story } from '@laru/flow';

story('Pedir pan', async ({ page, observed }) => {
  await step('Abrir la tienda', async () => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Pedir' })).toBeVisible();
  });
  await step('Pedir', async () => {
    await page.getByRole('button', { name: 'Pedir' }).click();
    await expect(page.getByText('pedido 7')).toBeVisible();
    await observed.wait({ method: 'POST', path: '/api/orders', status: 201 });
  });
});
`);
  const g = guard(workspaceKey(ws));
  t.after(() => g.check());
  said.length = 0;
  const run = await runFlows(ws, { env: 'app' });
  const log = () => { try { return readFileSync(join(ws.root, '.laru', 'runs', run.id, 'out', 'runner.log'), 'utf8').slice(-3000); } catch { return ''; } };
  assert.equal(run.status, 'passed', `${run.error ?? ''}\n${log()}`);
  const story = runTraces(ws, run.id).find((x) => x.story)!;
  const hops = story.exchanges.map((e) => `${e.from} → ${e.to} ${e.label} ${e.status ?? ''}`.trim());
  assert.ok(hops.includes(`browser → localhost:${port} POST /api/orders 201`), hops.join('\n'));
  assert.equal(story.exchanges.find((e) => e.label === 'POST /api/orders')?.step, 2, 'in the step that ordered');
  assert.ok(story.logs.some((l) => l.service === 'browser' && l.line === 'pidiendo'), story.logs.map((l) => l.line).join('\n'));
  assert.ok(!existsSync(join(ws.root, '.laru', 'runs', run.id, 'out', 'hits-0.jsonl')), 'the raw hits went into the journal');
  assert.equal(execFileSync('docker', ['ps', '-aq', '--filter', `label=keelson.run=${run.id}`], { encoding: 'utf8' }).trim(), '', 'no runner is left');
  // the runner's page and its requests, user agent and client hints (localhost is a secure context: they are sent)
  assert.ok(browsers().length > 0 && browsers().every((x) => /Chrome\//.test(x) && /Chromium/.test(x) && !/headless/i.test(x)), `the runner's browser says it is Chrome, never headless:\n${said.join('\n')}`);
});
