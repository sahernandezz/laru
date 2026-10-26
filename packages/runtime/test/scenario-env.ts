/**
 * An env with scenarios, without Docker: a fake `docker` first on PATH plays what scenarios touch. A Postgres (a
 * database made from a template and dropped, as snapshot and reset do), the other containers (listed and inspected),
 * and the runner: it leaves in out/ what a setup leaves, a write in the tap's journal and a statement in Postgres'
 * log, as `script` says. The runner reads its values from the file docker is given, as the real one does, so a
 * password from the vault comes back in the identities. Every call is logged.
 *
 * PATH and LARU_HOME are set and never put back: one process per test file, and work still in flight when a test
 * times out keeps calling the fake docker, never the real one.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRepo, initWorkspace, knowledgeWrite, loadGraph, loadKnowledge, refreshMap, register, STANDARD, type FieldValue, type Workspace } from '@laru/core';
import { envDir, setVar, writeState } from '../src/index.ts';
import { makeFixture } from '../../core/test/fixture.ts';

/** What the runner leaves for one scenario (by slug): who can sign in, whether it ended signed in, what it wrote. */
export interface Script {
  /** `passwordVar`: the vault variable (a `flows` one) whose value the setup puts in the identity, as a real setup does */
  identities?: Array<{ name: string; username?: string; passwordVar?: string }>;
  signedIn?: boolean;
  /** a statement that writes, in Postgres' log */
  pgWrite?: boolean;
  /** conversations with a datastore, in the tap's journal */
  traffic?: Array<{ svc: string; kind: 'http' | 'tcp'; method?: string }>;
  /** the setup fails (the runner exits with this) */
  exit?: number;
  /**
   * a hostile runner's events: `link` swaps events.jsonl and runner.log for links to `victim.txt` of the fake's folder;
   * `garbage` puts a line that is not JSON before a real one. Either way it prints a line of log.
   */
  events?: 'link' | 'garbage';
}

const fake = (dir: string) => `#!${process.execPath}
const fs = require('fs'), path = require('path');
const D = ${JSON.stringify(dir)}, a = process.argv.slice(2);
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')); } catch { return d; } };
const write = (f, v) => fs.writeFileSync(path.join(D, f), JSON.stringify(v));
const out = (s) => process.stdout.write(s);
fs.appendFileSync(path.join(D, 'calls.log'), a.join(' ') + '\\n');
const containers = read('containers.json', []);
const RUNNER = 'a1b2c3d4e5f6';
if (a[0] === 'ps') out(containers.map((c) => c.id).join('\\n') + (containers.length ? '\\n' : ''));
else if (a[0] === 'inspect' && a[1] === RUNNER) out(JSON.stringify([{ Id: RUNNER, NetworkSettings: { Networks: { ks: { IPAddress: '172.30.1.9' } } } }]));
else if (a[0] === 'inspect') out(JSON.stringify(a.slice(1).map((id) => containers.find((c) => c.id === id)).filter(Boolean).map((c) => ({
  Id: c.id + 'f'.repeat(52), Name: '/' + c.service, Config: { Image: c.image, Env: c.env || [], Labels: { 'com.docker.compose.service': c.service, 'keelson.service': c.service } },
  State: { Status: 'running', ExitCode: 0, StartedAt: new Date().toISOString() }, NetworkSettings: { Networks: {}, Ports: {} },
}))));
else if (a[0] === 'run') {
  const mount = (suffix) => { const v = a.find((x, i) => a[i - 1] === '-v' && x.endsWith(suffix)); return v && v.slice(0, v.length - suffix.length); };
  const outDir = mount(':/ks/out'), traffic = mount(':/ks/tap/traffic.jsonl:ro');
  const vars = Object.fromEntries(fs.readFileSync(a[a.indexOf('--env-file') + 1], 'utf8').split('\\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const slug = vars.KS_RUN.replace(/^scn-/, ''), script = (read('script.json', {}))[slug] || {};
  const flow = JSON.parse(vars.KS_FLOW_VARS_JSON || '{}');
  write('run.json', { exit: script.exit || 0, line: Boolean(script.events) });
  if (script.events) {
    const begin = JSON.stringify({ e: 'test-begin', test: 't1', title: 'Pagar', file: '/ks/ws/x/pagar-el-pedido.spec.ts', t: Date.now() }) + '\\n';
    fs.writeFileSync(path.join(outDir, 'events-0.jsonl'), (script.events === 'garbage' ? 'not json at all\\n' : '') + begin);
    if (script.events === 'link') for (const n of ['events.jsonl', 'runner.log']) { fs.rmSync(path.join(outDir, n), { force: true }); fs.symlinkSync(path.join(D, 'victim.txt'), path.join(outDir, n)); }
  }
  fs.writeFileSync(path.join(outDir, 'scenario.json'), JSON.stringify({ identities: (script.identities || []).map(({ passwordVar, ...i }) => ({ ...i, ...(passwordVar ? { password: flow[passwordVar] } : {}) })) }));
  if (script.signedIn) fs.writeFileSync(path.join(outDir, 'storage.json'), '{}');
  const now = Date.now();
  for (const t of script.traffic || []) fs.appendFileSync(traffic, JSON.stringify({ t0: now, t1: now, ...t }) + '\\n');
  fs.writeFileSync(path.join(D, 'pg.log'), '');
  if (script.pgWrite) fs.appendFileSync(path.join(D, 'pg.log'), '2026-10-25 10:00:00.000 UTC|172.30.1.5(5555)|42|shop|shop|LOG:  duration: 0.4 ms  statement: insert into orders (id) values (1)\\n');
  out(RUNNER + '\\n');
} else if (a[0] === 'wait') out(String(read('run.json', {}).exit || 0) + '\\n');
else if (a[0] === 'logs') {
  const last = a[a.length - 1], c = containers.find((x) => x.id === last);
  if (c && /postgres/.test(c.image) && fs.existsSync(path.join(D, 'pg.log'))) out(fs.readFileSync(path.join(D, 'pg.log'), 'utf8').split('\\n').filter(Boolean).map((l) => '2026-10-25T10:00:00.000000000Z ' + l).join('\\n') + '\\n');
  else if (last === RUNNER && read('run.json', {}).exit) out('Error: expect(received).toBe(201)\\n');
  else if (last === RUNNER && read('run.json', {}).line) out('a line of the runner\\n');
} else if (a[0] === 'exec' && a.includes('psql')) {
  const sql = fs.readFileSync(0, 'utf8');
  fs.appendFileSync(path.join(D, 'stdin.log'), sql + '\\n--\\n');
  let dbs = read('dbs.json', ['shop']);
  const res = [];
  for (const st of sql.split(';')) {
    let m;
    if ((m = /SELECT 1 FROM pg_database WHERE datname = '([^']+)'/.exec(st))) res.push('?column?\\n' + (dbs.includes(m[1]) ? '1\\n' : ''));
    else if ((m = /DROP DATABASE (?:IF EXISTS )?"([^"]+)"/.exec(st))) dbs = dbs.filter((d) => d !== m[1]);
    else if ((m = /CREATE DATABASE "([^"]+)" TEMPLATE "([^"]+)"/.exec(st))) {
      if (!dbs.includes(m[2])) { process.stderr.write('template ' + m[2] + ' does not exist'); process.exit(1); }
      dbs.push(m[1]);
      fs.appendFileSync(path.join(D, 'sql.log'), 'create ' + m[1] + ' from ' + m[2] + '\\n');
    } else if (/pg_database_size/.test(st)) res.push('size\\n4096\\n');
  }
  write('dbs.json', dbs);
  out(res.join(''));
}
`;

export interface ScenarioEnv {
  ws: Workspace;
  /** the fake docker's own folder */
  dir: string;
  /** every docker call, as one line each */
  calls(): string[];
  /** every SQL the fake Postgres was sent on stdin */
  stdin(): string;
  /** the databases the fake Postgres has now */
  dbs(): string[];
  /** which database was made from which, in order: `shop__ks_base from shop` */
  creates(): string[];
  script(s: Record<string, Script>): void;
  /** the fake Postgres is back to just `shop` and the log is empty */
  forget(): void;
  /** no container of the env is running any more */
  down(): void;
}

/** A workspace with the billing fixture mapped (postgres and kafka are datastores), three scenarios (pedido-pagado restarts billing-api) and an env `local` that is up. */
export async function scenarioEnv(o: { persistent?: boolean; secret?: { key: string; value: string } } = {}): Promise<ScenarioEnv> {
  const fx = makeFixture();
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-scn-env-')));
  process.env.LARU_HOME = join(tmp, 'home');
  process.env.LARU_VAULT_KEYSTORE = 'file';
  const dir = join(tmp, 'docker');
  mkdirSync(dir);
  writeFileSync(join(dir, 'docker'), fake(dir));
  chmodSync(join(dir, 'docker'), 0o755);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  const file = (f: string, v: unknown) => writeFileSync(join(dir, f), JSON.stringify(v));
  const lines = (f: string) => { try { return readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean); } catch { return []; } };

  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', docsLanguage: 'es' });
  await register(ws.root);
  await addRepo(ws, fx.billingUrl);
  await refreshMap(ws);
  const e = STANDARD.application.example;
  knowledgeWrite(ws, { type: 'application', title: e.title, kind: e.kind, status: e.status, summary: e.summary, fields: e.fields as Record<string, FieldValue> });
  const scenario = (title: string, extra: { restart?: string[] } = {}) => {
    const r = knowledgeWrite(ws, { type: 'scenario', in: 'app:comercio', title, status: 'active', summary: title, fields: { given: [{ kind: 'data', what: title }], ...(extra.restart ? { restart: extra.restart } : {}) } }, loadGraph(ws));
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const slug = title.toLowerCase().replace(/ /g, '-');
    const sdir = join(ws.root, 'docs', 'scenarios', slug);
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, `${slug}.setup.ts`), `// ${title}`);
  };
  scenario('Pedido pagado', { restart: ['svc:billing-api'] });
  scenario('Pedido publicado');
  scenario('Pedido vacio');
  // a flow that names the first one: its start applies it
  const m = knowledgeWrite(ws, { type: 'module', id: 'mod:pagos', in: 'app:comercio', title: 'Pagos', summary: 'Cobrar pedidos.', kind: 'area', fields: { purpose: 'Cobrar un pedido.' } }, loadGraph(ws));
  if (!m.ok) throw new Error(JSON.stringify(m.issues));
  const f = knowledgeWrite(ws, { type: 'flow', in: 'mod:pagos', title: 'Pagar el pedido', status: 'active', summary: 'Se paga.', meta: { needs: ['svc:billing-api'], scenario: 'scn:pedido-pagado' },
    fields: { goal: 'El pedido queda pagado.', actors: ['Cliente'], steps: [{ step: 'Pagar', actor: 'Cliente', service: 'svc:billing-api', expected: 'Queda pagado' }] } }, loadGraph(ws));
  if (!f.ok) throw new Error(JSON.stringify(f.issues));
  const fdir = join(ws.root, loadKnowledge(ws).byId.get('flow:pagar-el-pedido')!.dir);
  writeFileSync(join(fdir, 'pagar-el-pedido.spec.ts'), '// spec');

  mkdirSync(join(ws.root, 'envs'), { recursive: true });
  writeFileSync(join(ws.root, 'envs', 'local.yaml'), `persistent: ${o.persistent !== false}\n`);
  const edir = envDir(ws, 'local');
  mkdirSync(join(edir, 'tap'), { recursive: true });
  writeFileSync(join(edir, 'compose.yml'), 'services:\n  postgres:\n    image: postgres:16\n  kafka:\n    image: apache/kafka:3.8.0\n  billing-api:\n    image: billing-api:dev\n');
  writeFileSync(join(edir, 'tap', 'routes.json'), JSON.stringify({ routes: [] }));
  writeFileSync(join(edir, 'tap', 'rules.json'), JSON.stringify({ seed: 1, faults: {}, mocks: {}, peers: {} }));
  writeState(ws, 'local', { subnet: 1, entrance: 4180, ports: {} });
  file('containers.json', [
    { id: 'pg0000000001', service: 'postgres', image: 'postgres:16', env: ['POSTGRES_USER=shop', 'POSTGRES_DB=shop'] },
    { id: 'kafka0000002', service: 'kafka', image: 'apache/kafka:3.8.0' },
    { id: 'api000000003', service: 'billing-api', image: 'billing-api:dev' },
  ]);
  file('dbs.json', ['shop']);

  if (o.secret) await setVar(ws, { key: o.secret.key, value: o.secret.value, level: 'flows', secret: true });
  writeFileSync(join(dir, 'victim.txt'), 'untouched');
  return {
    ws,
    dir,
    calls: () => lines('calls.log'),
    stdin: () => { try { return readFileSync(join(dir, 'stdin.log'), 'utf8'); } catch { return ''; } },
    dbs: () => JSON.parse(readFileSync(join(dir, 'dbs.json'), 'utf8')),
    creates: () => lines('sql.log').map((l) => l.replace(/^create /, '')),
    script: (s) => file('script.json', s),
    down: () => file('containers.json', []),
    forget: () => { file('dbs.json', ['shop']); for (const f of ['calls.log', 'sql.log', 'pg.log']) writeFileSync(join(dir, f), ''); },
  };
}
