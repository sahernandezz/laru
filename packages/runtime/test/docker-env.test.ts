/**
 * A small app (nginx with a hardcoded upstream, a node API, postgres and a psql job) brought up for real.
 * Heavy: runs only with LARU_E2E=1 and Docker running. Nothing without this test's label may change.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addRepo, initWorkspace } from '@laru/core';
import { down, EnvError, inspectEnv, status, up, workspaceKey } from '../src/index.ts';
import { setVar } from '../src/vault.ts';
import { dockerUp, guard } from './guard.ts';

const APP = {
  'docker-compose.yml': `services:
  web:
    build: ./web
    ports: ["8088:80"]
    depends_on: [api]
  api:
    build: ./api
    environment:
      API_TOKEN: \${API_TOKEN}
      DB_HOST: postgres
    depends_on:
      postgres: { condition: service_healthy }
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: \${PG_PASSWORD:-devpass}
    healthcheck: { test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U postgres"], interval: 2s, retries: 20 }
    volumes: [pgdata:/var/lib/postgresql/data]
  seed:
    image: postgres:16-alpine
    environment:
      PGPASSWORD: \${PG_PASSWORD:-devpass}
    command: ["psql", "-h", "postgres", "-U", "postgres", "-c", "create table if not exists t(x int)"]
    depends_on:
      postgres: { condition: service_healthy }
volumes:
  pgdata: {}
`,
  'web/Dockerfile': 'FROM nginx:alpine\nCOPY default.conf /etc/nginx/conf.d/default.conf\n',
  'web/default.conf': `server {
  listen 80;
  location /api/ { proxy_pass http://api:3000; proxy_set_header Host $host; }
  location / { return 200 'web\\n'; }
}
`,
  'api/Dockerfile': 'FROM node:22-alpine\nCOPY server.js /srv/server.js\nEXPOSE 3000\nCMD ["node", "/srv/server.js"]\n',
  'api/server.js': `require('http').createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ path: req.url, host: req.headers.host, token: (process.env.API_TOKEN || '').length }));
}).listen(3000);
`,
};

function repo(tmp: string): string {
  const work = join(tmp, 'seed', 'shop');
  for (const [p, c] of Object.entries(APP)) { mkdirSync(dirname(join(work, p)), { recursive: true }); writeFileSync(join(work, p), c); }
  const git = (...a: string[]) => execFileSync('git', a, { cwd: work, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '--quiet', '-b', 'main'); git('add', '-A'); git('commit', '--quiet', '-m', 'first');
  const bare = join(tmp, 'remotes', 'shop.git');
  git('clone', '--quiet', '--bare', work, bare);
  return `file://${bare}`;
}

const heavy = !dockerUp ? 'Docker is not running' : process.env.LARU_E2E !== '1' ? 'set LARU_E2E=1' : false;

test('an env of a small app, for real', { skip: heavy, timeout: 15 * 60_000 }, async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-env-')));
  process.env.LARU_HOME = join(tmp, 'home');
  process.env.LARU_VAULT_KEYSTORE = 'file';
  mkdirSync(process.env.LARU_HOME, { recursive: true });
  writeFileSync(join(process.env.LARU_HOME, 'config.yaml'), 'maxEnvs: 9\n');
  const ws = initWorkspace(join(tmp, 'ws'), { app: 'shop', title: 'Shop' });
  await addRepo(ws, repo(tmp));
  mkdirSync(join(ws.root, 'envs'));
  writeFileSync(join(ws.root, 'envs', 'local.yaml'), 'from: shop:docker-compose.yml\ncache: [pgdata]\n');
  const g = guard(workspaceKey(ws));
  t.after(async () => { if (process.env.LARU_KEEP) { console.log('KEPT', ws.root); return; } await down(ws, 'local', { caches: true }).catch(() => undefined); g.check(); });

  await t.test('a missing value stops up before anything is created', async () => {
    await assert.rejects(up(ws, { env: 'local' }), (e: EnvError) => /API_TOKEN/.test(e.message) && /shop:docker-compose\.yml:\d+/.test(e.message));
    assert.equal((await inspectEnv(ws, 'local')).length, 0);
  });

  let first: Awaited<ReturnType<typeof up>>;
  await t.test('up builds, starts and waits; the job ends done', async () => {
    await setVar(ws, { key: 'API_TOKEN', value: 'tok-123456789', level: 'service', scope: 'api', secret: true });
    first = await up(ws, { env: 'local' }).catch((e: EnvError) => { throw new Error(`${e.message}\n${(e.logs ?? []).join('\n')}`); });
    const by = Object.fromEntries(first.services.map((s) => [s.service, s.health]));
    assert.equal(by.seed, 'done');
    assert.ok(['healthy', 'running'].includes(by.api) && ['healthy', 'running'].includes(by.web), JSON.stringify(by));
    assert.ok(!readFileSync(join(ws.root, '.laru', 'envs', 'local', 'compose.yml'), 'utf8').includes('tok-123456789'), 'no value in compose.yml');
  });

  await t.test('nginx reaches the API through the tap, Host unchanged', async () => {
    const web = first.addresses.find((a) => a.service === 'web')!;
    const r = await fetch(`${web.url}/api/ping`);
    const body = await r.json() as { path: string; host: string; token: number };
    assert.equal(body.path, '/api/ping');
    assert.equal(body.host, new URL(web.url).hostname, "nginx sends $host; the tap forwards it unchanged");
    assert.equal(body.token, 13, 'the secret reached the service');
    const web1 = (await inspectEnv(ws, 'local')).find((c) => c.service === 'web')!;
    const ips = execFileSync('docker', ['exec', web1.id, 'getent', 'ahostsv4', 'api'], { encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => l.split(/\s+/)[0]);
    assert.deepEqual([...new Set(ips)], [ips[0]].filter((ip) => ip.endsWith('.254')), 'the name api resolves to the tap only');
    const traffic = readFileSync(join(ws.root, '.laru', 'envs', 'local', 'tap', 'traffic.jsonl'), 'utf8');
    assert.match(traffic, /"svc":"api"/);
  });

  await t.test('a second up with no change is quick and keeps every container', async () => {
    const ids = (await inspectEnv(ws, 'local')).map((c) => c.id).sort();
    const again = await up(ws, { env: 'local' });
    assert.ok(again.ms < 20_000, `${again.ms} ms`);
    assert.equal(again.changed, false);
    assert.deepEqual((await inspectEnv(ws, 'local')).map((c) => c.id).sort(), ids);
  });

  await t.test('«Reconstruir sin caché»: only what is asked is built again with --no-cache and its container replaced; a name that is not built is refused', async () => {
    const before = Object.fromEntries((await inspectEnv(ws, 'local')).map((c) => [c.service, c.id]));
    await assert.rejects(up(ws, { env: 'local', rebuild: ['seed-nope'] }), /cannot rebuild seed-nope: not built from source/);
    const said: string[] = [];
    await up(ws, { env: 'local', rebuild: ['api'], onEvent: (e) => { if (e.kind === 'log' && e.source === 'laru') said.push(e.line); } });
    assert.ok(said.some((l) => /rebuilding without cache: api/.test(l)), said.join('\n'));
    const after = Object.fromEntries((await inspectEnv(ws, 'local')).map((c) => [c.service, c.id]));
    assert.notEqual(after.api, before.api, 'the api container was replaced by the new image');
    assert.equal(after.web, before.web, 'web was not rebuilt and kept its container');
    assert.match(readFileSync(join(ws.root, '.laru', 'envs', 'local', 'build.log'), 'utf8'), /api/, 'its build is in build.log');
  });

  await t.test('a container holding the project name without our label makes up refuse; down spares it', async () => {
    const foreign = execFileSync('docker', ['create', '--label', 'com.docker.compose.project=ks-shop-local', '--name', `ks-shop-local-x-${Date.now()}`, 'postgres:16-alpine'], { encoding: 'utf8' }).trim();
    const lookalike = execFileSync('docker', ['volume', 'create', 'ks-shop-local_pg'], { encoding: 'utf8' }).trim();
    try {
      await assert.rejects(up(ws, { env: 'local' }), /not Laru's/);
      const r = await down(ws, 'local');
      assert.deepEqual(r.left, []);
      assert.equal(execFileSync('docker', ['inspect', '-f', '{{.Id}}', foreign], { encoding: 'utf8' }).trim().slice(0, 12), foreign.slice(0, 12));
      execFileSync('docker', ['volume', 'inspect', lookalike], { stdio: 'ignore' });
      execFileSync('docker', ['volume', 'inspect', 'ks-shop-cache-pgdata'], { stdio: 'ignore' }); // the cache survives
      assert.equal((await status(ws, 'local')).state, 'stopped');
    } finally {
      execFileSync('docker', ['rm', '-f', foreign], { stdio: 'ignore' });
      execFileSync('docker', ['volume', 'rm', lookalike], { stdio: 'ignore' });
    }
  });
});
