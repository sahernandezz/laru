/**
 * Two projects brought up together for real: `app` (a git repo: nginx, a node API, Postgres, Kafka) and `ledger` (a
 * plain folder: nginx, a node service, Postgres, Kafka). The ledger reaches the app's API by name and by its
 * published host port, and consumes what the app publishes on the app's broker (share). One browser flow crosses
 * both. Heavy: LARU_E2E=1 with Docker running (images build with npm). Nothing without this test's label changes.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addRepo, initWorkspace, knowledgeWrite, loadGraph, refreshMap } from '@laru/core';
import { destroyByLabel, inspectEnv, listFlows, runFlows, runTraces, up, workspaceKey, type EnvError } from '../src/index.ts';
import { envFor } from '../src/env.ts';
import { dockerUp, guard } from './guard.ts';

const KAFKA = `    image: apache/kafka:3.7.0
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_HEAP_OPTS: -Xmx256m -Xms256m
    ports: ["9092:9092"]
    healthcheck: { test: ["CMD-SHELL", "/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list"], interval: 5s, timeout: 10s, retries: 30, start_period: 20s }
`;
const PG = (db: string, port: number) => `    image: postgres:16-alpine
    environment: { POSTGRES_PASSWORD: devpass, POSTGRES_DB: ${db} }
    ports: ["${port}:5432"]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U postgres"], interval: 2s, retries: 30 }
    volumes: [pgdata:/var/lib/postgresql/data]
`;
const NODE = (deps: string) => `FROM node:24-alpine
WORKDIR /srv
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund ${deps} >/dev/null
COPY server.js /srv/server.js
EXPOSE 3000
CMD ["node", "/srv/server.js"]
`;
const WEB = (title: string, upstream: string) => ({
  Dockerfile: 'FROM nginx:alpine\nCOPY default.conf /etc/nginx/conf.d/default.conf\n',
  'default.conf': `server {\n  listen 80;\n  location /api/ { proxy_pass http://${upstream}:3000; proxy_set_header Host $host; }\n  location / { default_type text/html; return 200 '<h1>${title}</h1>'; }\n}\n`,
});
const APP: Record<string, string> = {
  'docker-compose.yml': `services:
  web:
    build: ./web
    ports: ["8088:80"]
    depends_on: [api]
  api:
    build: ./api
    ports: ["18080:3000"]
    environment:
      DATABASE_URL: postgres://postgres:devpass@postgres:5432/shop
    depends_on:
      postgres: { condition: service_healthy }
      kafka: { condition: service_healthy }
  postgres:
${PG('shop', 5432)}  kafka:
${KAFKA}volumes:
  pgdata: {}
`,
  'web/Dockerfile': WEB('Tienda', 'api').Dockerfile, 'web/default.conf': WEB('Tienda', 'api')['default.conf'],
  'api/Dockerfile': NODE('kafkajs@2.2.4 pg@8.13.1'),
  'api/server.js': `const http = require('http');
const { Pool } = require('pg');
const { Kafka, logLevel } = require('kafkajs');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
db.on('error', () => {}); // Laru's first snapshot of Postgres ends open connections: the pool reconnects
const producer = new Kafka({ clientId: 'api', brokers: ['kafka:9092'], logLevel: logLevel.WARN, retry: { retries: 50 } }).producer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = (async () => {
  for (;;) { try { await db.query('create table if not exists orders (id serial primary key, item text)'); break; } catch { await sleep(1000); } }
  await producer.connect();
})();
http.createServer(async (req, res) => {
  const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  try {
    if (req.url === '/health') return send(200, { ok: true });
    await ready;
    if (req.method === 'POST' && req.url === '/api/orders') {
      const { rows } = await db.query('insert into orders (item) values ($1) returning id', ['libro']);
      await producer.send({ topic: 'order.created', messages: [{ key: String(rows[0].id), value: JSON.stringify({ id: rows[0].id }) }] });
      return send(201, { id: rows[0].id });
    }
    const m = /^\\/orders\\/(\\d+)$/.exec(req.url);
    if (m) { const { rows } = await db.query('select id, item from orders where id = $1', [m[1]]); return rows[0] ? send(200, rows[0]) : send(404, {}); }
    send(200, { ok: true });
  } catch (e) { send(500, { error: String(e) }); }
}).listen(3000);
`,
};
const LEDGER: Record<string, string> = {
  'docker-compose.yml': `services:
  ledger-web:
    build: ./web
    ports: ["8089:80"]
    depends_on: [ledger]
  ledger:
    build: ./api
    environment:
      DATABASE_URL: postgres://postgres:devpass@postgres:5432/ledger
    depends_on:
      postgres: { condition: service_healthy }
      kafka: { condition: service_healthy }
  postgres:
${PG('ledger', 5433)}  kafka:
${KAFKA.replace('"9092:9092"', '"9094:9092"')}volumes:
  pgdata: {}
`,
  'web/Dockerfile': WEB('Libro mayor', 'ledger').Dockerfile, 'web/default.conf': WEB('Libro mayor', 'ledger')['default.conf'],
  'api/Dockerfile': NODE('kafkajs@2.2.4 pg@8.13.1'),
  'api/server.js': `const http = require('http');
const { Pool } = require('pg');
const { Kafka, logLevel } = require('kafkajs');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
db.on('error', () => {}); // Laru's first snapshot of Postgres ends open connections: the pool reconnects
const kafka = new Kafka({ clientId: 'ledger', brokers: ['kafka:9092'], logLevel: logLevel.NOTHING, retry: { retries: 50 } });
const consumer = kafka.consumer({ groupId: 'ledger' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (;;) { try { await db.query('create table if not exists entries (order_id int primary key, at timestamptz default now())'); break; } catch { await sleep(1000); } }
  // the topic may not exist yet (the app creates it on its first order): create it, whoever comes first
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: 'order.created', numPartitions: 1 }] }).catch(() => false);
  await admin.disconnect();
  await consumer.connect();
  await consumer.subscribe({ topic: 'order.created', fromBeginning: true });
  await consumer.run({ eachMessage: async ({ message }) => { const { id } = JSON.parse(String(message.value)); await db.query('insert into entries (order_id) values ($1) on conflict do nothing', [id]); } });
})().catch((e) => { console.error(e); process.exit(1); });
http.createServer(async (req, res) => {
  const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  try {
    if (req.url === '/api/entries') {
      const { rows } = await db.query('select order_id from entries order by order_id');
      const orders = [];
      for (const r of rows) orders.push(await (await fetch(\`http://api:3000/orders/\${r.order_id}\`)).json());
      return send(200, { entries: rows.length, orders });
    }
    if (req.url === '/api/shop-health') { const r = await fetch('http://host.docker.internal:18080/health'); return send(r.status, await r.json()); }
    send(200, { ok: true });
  } catch (e) { send(500, { error: String(e) }); }
}).listen(3000);
`,
};
const SPEC = `import { expect, step, story } from '@laru/flow';

story('Comprar y asentar', async ({ page }) => {
  await step('Comprar en la tienda', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Tienda' })).toBeVisible();
    const id = await page.evaluate(async () => (await (await fetch('/api/orders', { method: 'POST' })).json()).id);
    expect(id).toBeGreaterThan(0);
  });
  await step('Ver el asiento en el libro', async () => {
    await page.goto('http://ledger-web/');
    await expect(page.getByRole('heading', { name: 'Libro mayor' })).toBeVisible();
    await expect.poll(async () => page.evaluate(async () => (await (await fetch('/api/entries')).json()).entries), { timeout: 60_000 }).toBeGreaterThan(0);
    expect(await page.evaluate(async () => (await fetch('/api/shop-health')).status)).toBe(200);
  });
});
`;

const write = (root: string, files: Record<string, string>) => { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); } };
const heavy = !dockerUp ? 'Docker is not running' : process.env.LARU_E2E !== '1' ? 'set LARU_E2E=1' : false;

test('a joint env of a git project and a folder project, for real', { skip: heavy, timeout: 40 * 60_000 }, async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-joint-')));
  process.env.LARU_HOME = join(tmp, 'home');
  process.env.LARU_VAULT_KEYSTORE = 'file';
  mkdirSync(process.env.LARU_HOME, { recursive: true });
  writeFileSync(join(process.env.LARU_HOME, 'config.yaml'), 'maxEnvs: 9\n');
  // app: a git repo with a bare remote; ledger: a folder without git
  const work = join(tmp, 'seed', 'app');
  write(work, APP);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: work, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '--quiet', '-b', 'main'); git('add', '-A'); git('commit', '--quiet', '-m', 'first');
  git('clone', '--quiet', '--bare', work, join(tmp, 'remotes', 'app.git'));
  const ledger = join(tmp, 'code', 'ledger');
  write(ledger, LEDGER);
  const marker = join(tmp, 'marker');
  writeFileSync(marker, '');
  utimesSync(marker, Date.now() / 1000 + 1, Date.now() / 1000 + 1);

  const ws = initWorkspace(join(tmp, 'ws'), { app: 'shopj', title: 'Shop' });
  await addRepo(ws, `file://${join(tmp, 'remotes', 'app.git')}`, { name: 'app' });
  await addRepo(ws, ledger, { name: 'ledger' });
  await refreshMap(ws);
  const g0 = loadGraph(ws);
  assert.deepEqual(g0.map.names?.ledger, { 'ledger-web': 'ledger-web', ledger: 'ledger', postgres: 'ledger-postgres', kafka: 'ledger-kafka' });
  mkdirSync(join(ws.root, 'envs'));
  writeFileSync(join(ws.root, 'envs', 'app-local.yaml'), 'from: app:docker-compose.yml\ncache: [pgdata]\nresources: { kafka: { memory: 768m } }\n');
  writeFileSync(join(ws.root, 'envs', 'ledger-local.yaml'), 'from: ledger:docker-compose.yml\n');
  writeFileSync(join(ws.root, 'envs', 'both.yaml'), 'join: [app-local, ledger-local]\nshare: { ledger-kafka: kafka }\n');
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => { const r = knowledgeWrite(ws, x, g0); assert.ok(r.ok, JSON.stringify(r.issues)); };
  w({ type: 'application', title: 'Shop', kind: 'product', status: 'active', summary: 'Tienda y libro.', fields: { purpose: 'Vender y asentar.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Ventas'] } });
  w({ type: 'module', id: 'mod:ventas', in: 'app:shopj', title: 'Ventas', summary: 'Vender.', kind: 'area', fields: { purpose: 'Vender.' } });
  w({ type: 'flow', id: 'flow:comprar-y-asentar', in: 'mod:ventas', title: 'Comprar y asentar', summary: 'Una compra llega al libro.', meta: { needs: ['svc:web', 'svc:api', 'svc:ledger-web', 'svc:ledger', 'ds:postgres', 'ds:ledger-postgres', 'ds:kafka'] },
    fields: { goal: 'La compra queda asentada.', actors: ['Cliente'], steps: [{ step: 'Comprar en la tienda', actor: 'Cliente', service: 'svc:api', expected: 'Pedido creado' }, { step: 'Ver el asiento en el libro', actor: 'Cliente', service: 'svc:ledger', expected: 'El asiento está' }] } });
  writeFileSync(join(ws.root, listFlows(ws)[0].spec), SPEC);
  const g = guard(workspaceKey(ws));
  t.after(async () => {
    if (process.env.LARU_KEEP) { console.log('KEPT', ws.root); return; }
    for (const env of ['both', 'app-local', 'ledger-local']) await destroyByLabel(ws, { env, caches: true }).catch(() => undefined);
    g.check();
  });

  let first: Awaited<ReturnType<typeof up>>;
  await t.test('the flow runs on the joint env, and it comes up ready', async () => {
    assert.equal(envFor(ws, g0, listFlows(ws)), 'both', 'the only env with both projects');
    first = await up(ws, { env: 'both' }).catch((e: EnvError) => { throw new Error(`${e.message}\n${(e.logs ?? []).join('\n')}`); });
    const by = Object.fromEntries(first.services.map((s) => [s.service, s.health]));
    for (const s of ['web', 'api', 'postgres', 'kafka', 'ledger-web', 'ledger', 'ledger-postgres']) assert.ok(['healthy', 'running'].includes(by[s]), `${s}: ${by[s]}`);
    assert.ok(!by['ledger-kafka'], 'the shared broker is not started');
    const nets = execFileSync('docker', ['network', 'ls', '--filter', `label=keelson.workspace=${workspaceKey(ws)}`, '--filter', 'label=keelson.env=both', '--format', '{{.Name}}'], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(nets, ['ks-shopj-both', 'ks-shopj-both-app', 'ks-shopj-both-ledger']);
  });

  const cs = () => inspectEnv(ws, 'both');
  const exec = async (svc: string, ...cmd: string[]) => execFileSync('docker', ['exec', (await cs()).find((c) => c.service === svc)!.id, ...cmd], { encoding: 'utf8' });

  await t.test('each project keeps its own postgres under the same name', async () => {
    const ip = async (svc: string) => (await exec(svc, 'getent', 'hosts', 'postgres')).trim().split(/\s+/)[0];
    const [a, l] = [await ip('api'), await ip('ledger')];
    assert.ok(a && l && a !== l, `api sees ${a}, ledger sees ${l}`);
    const pg = (await cs()).find((c) => c.service === 'ledger-postgres')!;
    assert.ok(pg.ips.includes(l), 'ledger\'s postgres is ledger-postgres');
  });

  await t.test('the ledger reaches the app\'s api by name and by its published host port, both through the tap', async () => {
    const byName = JSON.parse(await exec('ledger', 'wget', '-qO-', 'http://api:3000/health'));
    const byPort = JSON.parse(await exec('ledger', 'wget', '-qO-', 'http://host.docker.internal:18080/health'));
    assert.deepEqual([byName, byPort], [{ ok: true }, { ok: true }]);
    const peers = JSON.parse(readFileSync(join(ws.root, '.laru', 'envs', 'both', 'tap', 'rules.json'), 'utf8')).peers as Record<string, string>;
    const traffic = readFileSync(join(ws.root, '.laru', 'envs', 'both', 'tap', 'traffic.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const health = traffic.filter((r) => r.svc === 'api' && r.path === '/health' && peers[r.from] === 'ledger');
    assert.deepEqual([...new Set(health.map((r) => r.port))].sort((a, b) => a - b), [3000, 18080], 'both journalled, from the ledger');
  });

  await t.test('one browser flow crosses both projects, with parents, the broker\'s consumer and each SQL statement on its own Postgres', async () => {
    const run = await runFlows(ws, { env: 'both', cache: false });
    assert.equal(run.status, 'passed', `${run.error ?? ''} ${JSON.stringify(run.results)}`);
    const story = runTraces(ws, run.id).find((x) => x.story)!;
    const ex = story.exchanges;
    const hop = (from: string, to: string, path?: string) => ex.find((e) => e.from === from && e.to === to && (!path || e.path === path));
    const order = hop('web', 'api', '/api/orders')!;
    assert.ok(order && ex.find((e) => e.id === order.parent)?.from === 'browser', 'browser → web → api');
    const viaName = ex.find((e) => e.from === 'ledger' && e.to === 'api' && /^\/orders\/\d+$/.test(e.path ?? ''))!;
    assert.ok(viaName, 'ledger → api by name');
    assert.equal(ex.find((e) => e.id === viaName.parent)?.from, 'ledger-web', 'its parent is the call into the ledger');
    assert.ok(hop('ledger', 'api', '/health'), 'ledger → api by host port');
    assert.ok(ex.some((e) => e.kind === 'kafka' && e.from === 'kafka' && e.to === 'ledger' && e.origin === 'derived'), 'order.created reaches the ledger (derived)');
    const sql = ex.filter((e) => e.kind === 'sql');
    assert.ok(sql.some((e) => e.from === 'api' && e.to === 'postgres' && /orders/.test(e.label)));
    assert.ok(sql.some((e) => e.from === 'ledger' && e.to === 'ledger-postgres' && /entries/.test(e.label)));
    assert.ok(!sql.some((e) => e.from === 'ledger' && e.to === 'postgres'), 'never the other project\'s postgres');
    assert.equal(story.participants.find((p) => p.id === 'ledger')?.project, 'ledger');
    assert.equal(story.participants.find((p) => p.id === 'kafka')?.project, 'app', 'a shared store belongs to its owner');
  });

  await t.test('a second up changes nothing: the same containers, the same compose.yml', async () => {
    const ids = (await cs()).filter((c) => !c.labels['keelson.run']).map((c) => c.id).sort();
    const yml = readFileSync(join(ws.root, '.laru', 'envs', 'both', 'compose.yml'), 'utf8');
    const again = await up(ws, { env: 'both' });
    assert.equal(again.changed, false);
    assert.deepEqual((await cs()).filter((c) => !c.labels['keelson.run']).map((c) => c.id).sort(), ids);
    assert.equal(readFileSync(join(ws.root, '.laru', 'envs', 'both', 'compose.yml'), 'utf8'), yml);
  });

  await t.test('destroy leaves nothing with the env\'s label; the cache stays; the ledger folder was never written', async () => {
    const r = await destroyByLabel(ws, { env: 'both' });
    assert.deepEqual(r.left, []);
    const left = (kind: string) => execFileSync('docker', [kind, 'ls', '-q', '--filter', `label=keelson.workspace=${workspaceKey(ws)}`, '--filter', 'label=keelson.env=both'], { encoding: 'utf8' }).trim();
    assert.deepEqual([left('network'), left('volume')], ['', '']);
    assert.equal(execFileSync('docker', ['ps', '-aq', '--filter', `label=keelson.workspace=${workspaceKey(ws)}`, '--filter', 'label=keelson.env=both'], { encoding: 'utf8' }).trim(), '');
    execFileSync('docker', ['volume', 'inspect', 'ks-shopj-cache-pgdata'], { stdio: 'ignore' });
    assert.ok(!existsSync(join(ledger, '.git')));
    assert.equal(execFileSync('find', [ledger, '-newer', marker], { encoding: 'utf8' }).trim(), '');
  });
});
