/**
 * Runs for real on a small app, each in an ephemeral env: the trace has the browser, nginx and the API; a vault
 * secret sent in a header, a body and a log line is nowhere in the evidence; a failing test is `failed`, a broken
 * env is `error`, a cancelled run leaves no runner, and a run whose process died reads as `interrupted`.
 * Heavy: LARU_E2E=1 with Docker running. Runs queue on the machine lock behind any other run.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addRepo, initWorkspace, knowledgeWrite } from '@laru/core';
import { cancelRun, listFlows, readRun, runFlows, runTraces, setVar, startRun, workspaceKey } from '../src/index.ts';
import { dockerUp, guard } from './guard.ts';

const TOKEN = 'flow-Secret-77ab9z';
const APP = {
  'docker-compose.yml': `services:
  web:
    build: ./web
    ports: ["8089:80"]
    depends_on: [api]
  api:
    build: ./api
`,
  'web/Dockerfile': 'FROM nginx:alpine\nCOPY default.conf /etc/nginx/conf.d/default.conf\n',
  'web/default.conf': `server {
  listen 80;
  location /api/ { proxy_pass http://api:3000; proxy_set_header Host $host; }
  location / { default_type text/html; return 200 '<h1>Tienda</h1>'; }
}
`,
  'api/Dockerfile': 'FROM node:22-alpine\nCOPY server.js /srv/server.js\nEXPOSE 3000\nCMD ["node", "/srv/server.js"]\n',
  'api/server.js': `require('http').createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    console.log('auth', req.headers.authorization, 'body', body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
}).listen(3000);
`,
};

const SPEC = `import { expect, step, story, test } from '@laru/flow';

story('Ver la tienda', async ({ page, vars }) => {
  await step('Abrir la tienda', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Tienda' })).toBeVisible();
  });
  await step('Llamar a la API', async () => {
    const r = await page.evaluate(async (t) => (await fetch('/api/pay', { method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: JSON.stringify({ password: t }) })).json(), vars.FLOW_TOKEN);
    expect(r.ok).toBe(true);
  });
});

test('Falla mostrando el secreto', async ({ vars }) => {
  expect(vars.FLOW_TOKEN).toBe('otro');
});

test('Falla a propósito', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Otra cosa' })).toBeVisible({ timeout: 1000 });
});
`;

const heavy = !dockerUp ? 'Docker is not running' : process.env.LARU_E2E !== '1' ? 'set LARU_E2E=1' : false;

test('runs on a small app, each in an ephemeral env', { skip: heavy, timeout: 30 * 60_000 }, async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-run-')));
  process.env.LARU_HOME = join(tmp, 'home');
  process.env.LARU_VAULT_KEYSTORE = 'file';
  mkdirSync(process.env.LARU_HOME, { recursive: true });
  writeFileSync(join(process.env.LARU_HOME, 'config.yaml'), 'maxEnvs: 9\n');
  const work = join(tmp, 'seed', 'shoprun');
  for (const [p, c] of Object.entries(APP)) { mkdirSync(dirname(join(work, p)), { recursive: true }); writeFileSync(join(work, p), c); }
  const git = (...a: string[]) => execFileSync('git', a, { cwd: work, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '--quiet', '-b', 'main'); git('add', '-A'); git('commit', '--quiet', '-m', 'first');
  git('clone', '--quiet', '--bare', work, join(tmp, 'remotes', 'shoprun.git'));
  const ws = initWorkspace(join(tmp, 'ws'), { app: 'shoprun', title: 'Shop' });
  await addRepo(ws, `file://${join(tmp, 'remotes', 'shoprun.git')}`);
  mkdirSync(join(ws.root, 'envs'));
  writeFileSync(join(ws.root, 'envs', 'local.yaml'), 'from: shoprun:docker-compose.yml\n');
  writeFileSync(join(ws.root, 'envs', 'broken.yaml'), 'from: shoprun:docker-compose.yml\noverlay:\n  services:\n    ghost: { image: "laru-does-not-exist/nothing:0" }\n');
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => assert.ok(knowledgeWrite(ws, x, null).ok);
  w({ type: 'application', title: 'Shop', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } });
  w({ type: 'module', id: 'mod:tienda', in: 'app:shoprun', title: 'Tienda', summary: 'La tienda.', kind: 'area', fields: { purpose: 'Vender.' } });
  w({ type: 'flow', id: 'flow:ver-tienda', in: 'mod:tienda', title: 'Ver la tienda', summary: 'Abrir y pagar.', fields: { goal: 'Se ve la tienda.', actors: ['Cliente'], steps: [{ step: 'Abrir la tienda', actor: 'Cliente', expected: 'Sale el título' }, { step: 'Llamar a la API', actor: 'Cliente', expected: 'Responde ok' }] } });
  writeFileSync(join(ws.root, listFlows(ws)[0].spec), SPEC);
  await setVar(ws, { key: 'FLOW_TOKEN', value: TOKEN, level: 'flows', secret: true });
  const g = guard(workspaceKey(ws));
  t.after(() => g.check());

  await t.test('a failing short case is `failed`; the story\'s trace crosses browser, nginx and the API; the secret is nowhere, not even in a failed expect', async () => {
    const run = await runFlows(ws, { env: 'local', ephemeral: true });
    assert.equal(run.status, 'failed', run.error);
    assert.equal(readRun(ws, run.id)?.phase, 'done');
    const traces = runTraces(ws, run.id);
    const story = traces.find((x) => x.story)!;
    assert.equal(story.status, 'passed');
    assert.deepEqual(traces.filter((x) => !x.story).map((x) => x.status), ['failed', 'failed']);
    assert.deepEqual(story.participants.map((p) => p.id).slice(0, 3), ['browser', 'web', 'api']);
    const hop = story.exchanges.find((e) => e.from === 'web' && e.to === 'api' && e.path === '/api/pay');
    assert.ok(hop, 'nginx → api through the tap');
    assert.equal(story.exchanges.find((e) => e.id === hop!.parent)?.from, 'browser');
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (!/\.(webm|png)$/.test(n)) files.push(p); } };
    walk(join(ws.root, '.laru', 'runs', run.id));
    const forms = [TOKEN, Buffer.from(TOKEN).toString('base64').replace(/=+$/, ''), encodeURIComponent(TOKEN)];
    const leaks = files.filter((f) => forms.some((x) => readFileSync(f, 'latin1').includes(x)));
    assert.deepEqual(leaks, [], 'the secret is in no file of the run');
    assert.ok(readFileSync(join(ws.root, '.laru', 'runs', run.id, 'raw', 'logs', 'api.log'), 'utf8').includes('auth Bearer …'), 'the api logged it masked');
    assert.equal(execFileSync('docker', ['ps', '-aq', '--filter', `label=keelson.run=${run.id}`], { encoding: 'utf8' }).trim(), '', 'the ephemeral env is gone');
    // Each video is kept once: the story's was moved into flows/<slug>/ with the screenshots; out/ keeps no media.
    const dir = join(ws.root, '.laru', 'runs', run.id);
    assert.deepEqual((readdirSync(join(dir, 'out'), { recursive: true }) as string[]).filter((f) => /\.(webm|png)$/.test(f)), [], 'no video or screenshot left in out/');
    assert.ok(statSync(join(dir, 'flows', story.flow, 'video.webm')).size > 0, 'the story\'s video');
    for (const s of traces.flatMap((x) => x.steps).filter((x) => x.screenshot)) assert.ok(existsSync(join(dir, 'flows', story.flow, s.screenshot!)), s.screenshot);
    assert.ok(JSON.parse(readFileSync(join(ws.root, '.laru', 'runs', 'prune.json'), 'utf8')).at, 'retention ran after the run');
  });

  await t.test('a flow with its own `timeout` is cut there and says so; one without keeps the runner\'s limit', async () => {
    w({ type: 'flow', id: 'flow:zeta-lento', in: 'mod:tienda', title: 'Zeta lento', summary: 'Espera de más.', meta: { timeout: '5s' }, fields: { goal: 'Se corta a los 5 s.', actors: ['Cliente'], steps: [{ step: 'Esperar', actor: 'Cliente', expected: 'Nada' }] } });
    const slow = listFlows(ws).find((f) => f.slug === 'zeta-lento')!;
    assert.equal(slow.timeoutMs, 5000, 'read from flow.md');
    writeFileSync(join(ws.root, slow.spec), `import { test } from '@laru/flow';\ntest('Espera de más', async () => { await new Promise((r) => setTimeout(r, 25_000)); });\n`);
    try {
      const run = await runFlows(ws, { env: 'local', ephemeral: true, flows: ['zeta-lento'] });
      assert.equal(run.status, 'failed', run.error);
      const events = readFileSync(join(ws.root, '.laru', 'runs', run.id, 'out', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { e: string; status?: string; error?: string; durationMs?: number });
      const end = events.find((e) => e.e === 'test-end' && e.status === 'timedOut');
      assert.ok(end, 'the test ended timed out');
      assert.match(end!.error ?? '', /^Cortado a los 5 s por el límite del flujo/);
      assert.ok(end!.durationMs! >= 4500 && end!.durationMs! < 12_000, `cut at ${end!.durationMs} ms, not at the 25 s the test wanted`);
    } finally { rmSync(join(ws.root, slow.dir), { recursive: true, force: true }); }
  });

  await t.test('Playwright\'s trace is kept only when the run asks for it, beside the video, and none is left in out/', async () => {
    const without = await runFlows(ws, { env: 'local', ephemeral: true, flows: ['ver-tienda'] });
    assert.ok(!existsSync(join(ws.root, '.laru', 'runs', without.id, 'flows', 'ver-tienda', 'trace.zip')), 'off by default: no trace.zip');
    const run = await runFlows(ws, { env: 'local', ephemeral: true, flows: ['ver-tienda'], pwTrace: true });
    const dir = join(ws.root, '.laru', 'runs', run.id);
    assert.ok(statSync(join(dir, 'flows', 'ver-tienda', 'trace.zip')).size > 1000, 'the story\'s trace.zip');
    assert.equal(readRun(ws, run.id) && JSON.parse(readFileSync(join(dir, 'flows', 'ver-tienda', 'trace.json'), 'utf8')).pwTrace, 'trace.zip', 'the trace names it');
    assert.deepEqual((readdirSync(join(dir, 'out'), { recursive: true }) as string[]).filter((f) => /\.(webm|png|zip)$/.test(f)), [], 'no media or zip left in out/');
  });

  await t.test('an env that cannot start makes the run `error`, not `failed`', async () => {
    const run = await runFlows(ws, { env: 'broken', ephemeral: true });
    assert.equal(run.status, 'error');
    assert.match(run.error ?? '', /pull|laru-does-not-exist/);
  });

  await t.test('cancel removes the runner; a dead run process reads as interrupted', async () => {
    const id = await startRun(ws, { env: 'local', ephemeral: true });
    for (let i = 0; i < 600 && readRun(ws, id)?.phase !== 'tests'; i++) await new Promise((r) => setTimeout(r, 1000));
    assert.equal(readRun(ws, id)?.phase, 'tests');
    assert.equal(await cancelRun(ws, id), true);
    assert.equal(readRun(ws, id)?.status, 'cancelled');
    assert.equal(execFileSync('docker', ['ps', '-aq', '--filter', `label=keelson.run=${id}`], { encoding: 'utf8' }).trim(), '');
    // A run.json left `running` by a process that no longer exists.
    const dead = join(ws.root, '.laru', 'runs', '999');
    mkdirSync(dead, { recursive: true });
    writeFileSync(join(dead, 'run.json'), JSON.stringify({ id: '999', env: 'local', ephemeral: false, flows: [], phase: 'tests', status: 'running', startedAt: '', pid: 2 ** 22 - 3, results: {} }));
    assert.equal(readRun(ws, '999')?.status, 'interrupted');
  });
});
