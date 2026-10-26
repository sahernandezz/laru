/**
 * Envs of different workspaces side by side, against a fake `docker` first on PATH that keeps what "runs" in a JSON
 * file: `compose up` records the project's services, ports and network from the rendered compose.yml; `ps`, `inspect`,
 * `network ls/inspect`, `stats` and `info` answer from it. Nothing here reaches the real Docker.
 *
 * This file runs in a process of its own (node --test): PATH and LARU_HOME are set and never put back, so work still
 * in flight when a test times out keeps calling the fake docker and writing the scratch home, never the real ones.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addRepo, initWorkspace, type Workspace } from '@laru/core';
import { down, EnvError, envLock, hold, machineLock, readState, up, withLock, workspaceKey, writeConfig, writeState, type EnvEvent } from '../src/index.ts';

const FAKE = `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
// One call at a time reads and writes the state (two ups at once must not lose each other's containers).
const file = process.env.DOCKER_FAKE_STATE, lock = file + '.lock', nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (let i = 0; ; i++) { try { fs.mkdirSync(lock); break; } catch { if (i > 4000) throw new Error('fake docker: ' + lock + ' held'); nap(5); } }
let held = true;
const unlock = () => { if (held) { held = false; fs.rmdirSync(lock); } };
process.on('exit', unlock);
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(st)); fs.renameSync(file + '.tmp', file); };
const out = (s) => process.stdout.write(s);
const filters = []; a.forEach((x, i) => { if (x === '--filter') filters.push(a[i + 1].replace(/^label=/, '').split('=')); });
const pass = (labels) => filters.every(([k, v]) => v === undefined ? k in labels : labels[k] === v);
const fmt = a.includes('--format') ? a[a.indexOf('--format') + 1] : null;
const render = (t, x) => t.replace(/\\{\\{\\.Label "([^"]+)"\\}\\}/g, (_, k) => x.labels[k] || '').replace(/\\{\\{\\.(\\w+)\\}\\}/g, (_, k) => x[k] ?? '');
if (a[0] === 'compose' && a.includes('config')) out(JSON.stringify({ name: 'x', services: { web: { image: 'nginx:alpine', ports: [{ target: 80 }] } } }));
else if (a[0] === 'compose' && a.includes('up')) {
  const p = a[a.indexOf('-p') + 1], y = fs.readFileSync(a[a.indexOf('-f') + 1], 'utf8');
  const labels = { 'keelson.workspace': /keelson.workspace: (\\S+)/.exec(y)[1], 'keelson.app': /keelson.app: (\\S+)/.exec(y)[1], 'keelson.env': /keelson.env: (\\S+)/.exec(y)[1] };
  const body = y.slice(y.indexOf('services:'), y.search(/^(networks|volumes):/m));
  const services = [...body.matchAll(/^  ([\\w.-]+):$/gm)].map((m) => m[1]);
  const ports = [...y.matchAll(/127\\.0\\.0\\.1:(\\d+):(\\d+)/g)].map((m) => '127.0.0.1:' + m[1] + '->' + m[2] + '/tcp').join(', ');
  st.containers = st.containers.filter((c) => c.project !== p);
  services.forEach((s, i) => st.containers.push({ ID: (p + s).replace(/[^a-z0-9]/g, '').slice(-12).padStart(12, '0'), Names: p + '-' + s + '-1', project: p, CreatedAt: '2026-10-23 08:00:00 -0500 -05', Ports: i ? '' : ports, labels: { ...labels, 'keelson.service': s, 'com.docker.compose.service': s, 'com.docker.compose.project': p } }));
  if (!st.networks.some((n) => n.Name === p)) st.networks.push({ Name: p, subnet: /subnet: (\\S+)/.exec(y)[1], labels });
  save();
  unlock();
  nap(Number(process.env.DOCKER_FAKE_UP_MS || 0));
} else if (a[0] === 'ps') {
  const rows = st.containers.filter((c) => pass(c.labels));
  out(rows.map((c) => (fmt ? render(fmt, c) : c.ID)).join('\\n') + (rows.length ? '\\n' : ''));
} else if (a[0] === 'inspect') {
  out(JSON.stringify(a.slice(1).map((id) => st.containers.find((c) => c.ID === id)).filter(Boolean).map((c) => ({ Id: c.ID, Name: '/' + c.Names, Config: { Labels: c.labels, Image: 'nginx:alpine' }, State: { Status: 'running', ExitCode: 0, StartedAt: new Date().toISOString() }, NetworkSettings: { Networks: { [c.project]: { IPAddress: '172.30.9.' + (2 + st.containers.indexOf(c)) } }, Ports: {} } }))));
} else if (a[0] === 'network' && a[1] === 'ls') {
  const rows = st.networks.filter((n) => pass(n.labels));
  out(rows.map((n) => (fmt ? render(fmt, n) : n.Name)).join('\\n') + (rows.length ? '\\n' : ''));
} else if (a[0] === 'network' && a[1] === 'inspect') {
  out(a.slice(4).map((name) => st.networks.find((n) => n.Name === name)).filter(Boolean).map((n) => [n.Name, n.subnet + ' ', n.labels['keelson.workspace'] || '', n.labels['keelson.app'] || '', n.labels['keelson.env'] || '', n.labels['keelson.run'] || ''].join('|')).join('\\n') + '\\n');
} else if (a[0] === 'network' && a[1] === 'rm') { st.networks = st.networks.filter((n) => n.Name !== a[2]); save(); }
else if (a[0] === 'rm') { st.containers = st.containers.filter((c) => !a.includes(c.ID)); save(); }
else if (a[0] === 'info') out(process.env.DOCKER_FAKE_MEM + '\\n');
else if (a[0] === 'stats') out(a.slice(4).map((id) => JSON.stringify({ ID: id, Name: id, MemUsage: '512MiB / 7.8GiB', CPUPerc: '1%' })).join('\\n') + '\\n');
`;

function repo(tmp: string, name: string): string {
  const work = join(tmp, 'seed', name);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx:alpine\n    ports: ["80"]\n');
  const git = (...x: string[]) => execFileSync('git', x, { cwd: work, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '--quiet', '-b', 'main'); git('add', '-A'); git('commit', '--quiet', '-m', 'first');
  const bare = join(tmp, 'remotes', `${name}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  git('clone', '--quiet', '--bare', work, bare);
  return `file://${bare}`;
}

const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });

test('locks: env locks are independent, the machine lock takes one at a time, env → machine re-enters', { timeout: 20_000 }, async () => {
  process.env.LARU_HOME = mkdtempSync(join(tmpdir(), 'laru-locks-'));
  const a = { root: '/w/a' }, b = { root: '/w/b' };
  assert.notEqual(envLock(a, 'local'), envLock(b, 'local'));
  assert.notEqual(envLock(a, 'local'), envLock(a, 'local', '12'), 'an ephemeral run has its own');
  // Two envs of two workspaces: both enter at once.
  const order: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const one = withLock('up a', async () => { order.push('a in'); await gate; order.push('a out'); }, undefined, envLock(a, 'local'));
  const two = withLock('up b', async () => { order.push('b in'); }, undefined, envLock(b, 'local'));
  await two;
  assert.deepEqual(order, ['a in', 'b in'], 'b did not wait for a');
  open(); await one;
  // The machine: a second holder waits until the first lets go.
  const first = await hold('up a', machineLock());
  let waited = '';
  const second = hold('up b', machineLock(), (h) => { waited = h; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(waited, 'up a');
  first();
  (await second)();
  // A run holds its env; the up it starts takes the machine and re-enters the env.
  assert.equal(await withLock('run 1', () => withLock('up a', () => withLock('up a again', async () => 'nested', undefined, envLock(a, 'local')), undefined, machineLock()), undefined, envLock(a, 'local')), 'nested');
});

test('side by side: two workspaces up at once; a persisted subnet, entrance and port another env holds move; admission refuses naming the envs', { timeout: 120_000 }, async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-side-')));
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), FAKE, { mode: 0o755 });
  writeFileSync(join(tmp, 'state.json'), JSON.stringify({ containers: [], networks: [] }));
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, LARU_HOME: join(tmp, 'home'), LARU_VAULT_KEYSTORE: 'file', DOCKER_FAKE_STATE: join(tmp, 'state.json'), DOCKER_FAKE_MEM: String(8 * 2 ** 30), DOCKER_FAKE_UP_MS: '1500' });
  mkdirSync(process.env.LARU_HOME!, { recursive: true });
  writeConfig({ maxEnvs: 2 });
  const make = async (app: string) => {
    const ws = initWorkspace(join(tmp, app), { app, title: app });
    await addRepo(ws, repo(tmp, app));
    mkdirSync(join(ws.root, 'envs'));
    writeFileSync(join(ws.root, 'envs', 'local.yaml'), `from: ${app}:docker-compose.yml\npersistent: true\n`);
    return ws;
  };
  const one = await make('one'), two = await make('two');
  // Both remember the same subnet, entrance and port, as vaultflow's local and fast do.
  const entrance = await freePort(), port = await freePort();
  for (const w of [one, two]) writeState(w, 'local', { subnet: 7, entrance, ports: { web: { 80: port } } });
  const logs = new Map<Workspace, string[]>([[one, []], [two, []]]);
  const onEvent = (w: Workspace) => (e: EnvEvent) => { if (e.kind === 'log' && e.source === 'laru') logs.get(w)!.push(e.line); };

  await t.test('two ups at once: one waits for the machine, none fails', async () => {
    await Promise.all([up(one, { env: 'local', onEvent: onEvent(one) }), up(two, { env: 'local', onEvent: onEvent(two) })]);
    const waited = [...logs.values()].flat().filter((l) => /^waiting for up /.test(l));
    assert.equal(waited.length, 1, waited.join('\n'));
  });

  await t.test('the second keeps nothing the first holds, and says what moved and who holds it', () => {
    const [a, b] = [readState(one, 'local')!, readState(two, 'local')!];
    assert.notEqual(a.subnet, b.subnet);
    assert.notEqual(a.entrance, b.entrance);
    assert.notEqual(a.ports.web['80'], b.ports.web['80']);
    const [firstWs, secondWs] = a.subnet === 7 ? [one, two] : [two, one];
    const said = logs.get(secondWs)!.join('\n');
    assert.match(said, new RegExp(`the subnet moves from 172\\.30\\.7\\.0/24 to 172\\.30\\.\\d+\\.0/24: ${firstWs.app}/local holds it`));
    assert.match(said, new RegExp(`the entrance moves from ${entrance} to \\d+: ${firstWs.app}/local holds it`));
    assert.match(said, new RegExp(`web:80 moves from ${port} to \\d+: ${firstWs.app}/local holds it`));
    assert.ok(a.lastMemBytes && b.lastMemBytes, 'what each took at ready is kept for admission');
  });

  await t.test('a running env keeps its own subnet and entrance on a second up', async () => {
    const before = readState(one, 'local')!;
    logs.set(one, []);
    await up(one, { env: 'local', onEvent: onEvent(one) });
    const after = readState(one, 'local')!;
    assert.deepEqual([after.subnet, after.entrance, after.ports], [before.subnet, before.entrance, before.ports]);
    assert.ok(!logs.get(one)!.some((l) => / moves from /.test(l)));
  });

  await t.test('maxEnvs 1: refused before anything is created, naming the env that runs', async () => {
    await down(two, 'local');
    writeConfig({ maxEnvs: 1 });
    await assert.rejects(up(two, { env: 'local' }), (e: EnvError) => e.admission?.kind === 'maxEnvs' && /one\/local/.test(e.message) && e.admission.others[0].key === workspaceKey(one));
    const fake = JSON.parse(readFileSync(join(tmp, 'state.json'), 'utf8')) as { networks: Array<{ Name: string }>; containers: Array<{ project: string }> };
    assert.ok(!fake.networks.some((n) => n.Name === 'ks-two-local') && !fake.containers.some((c) => c.project === 'ks-two-local'), 'no half-created network or container');
  });

  await t.test('memory: refused when what runs plus what it needed last time passes 90%; --force goes through', async () => {
    writeConfig({ maxEnvs: 2 });
    writeState(two, 'local', { ...readState(two, 'local')!, lastMemBytes: 7.5 * 2 ** 30 });
    await assert.rejects(up(two, { env: 'local' }), (e: EnvError) => e.admission?.kind === 'memory' && /one\/local uses [\d.]+ GiB; two\/local needed 7\.5 GiB last time and Docker has 8\.0 GiB/.test(e.message));
    await up(two, { env: 'local', force: true });
  });

  await t.test('--force skips the memory check only: maxEnvs still refuses', async () => {
    writeConfig({ maxEnvs: 1 });
    await assert.rejects(up(two, { env: 'local', force: true }), (e: EnvError) => e.admission?.kind === 'maxEnvs');
  });

  await t.test('an ephemeral run is not counted against maxEnvs, but its memory is', async () => {
    writeState(two, 'local', { ...readState(two, 'local')!, lastMemBytes: 7.5 * 2 ** 30 });
    await assert.rejects(up(two, { env: 'local', run: '77' }), (e: EnvError) => e.admission?.kind === 'memory' && /two\/local needed 7\.5 GiB/.test(e.message));
  });

  await t.test('a stopped env keeps a persisted port only while it can still bind it', async () => {
    await down(two, 'local');
    writeConfig({ maxEnvs: 2 });
    // another program on the port two remembers for web:80
    const other = createServer().listen(0, '127.0.0.1');
    await once(other, 'listening');
    const busy = (other.address() as { port: number }).port, st = readState(two, 'local')!;
    writeState(two, 'local', { ...st, ports: { ...st.ports, web: { 80: busy } }, lastMemBytes: 2 ** 20 });
    try {
      logs.set(two, []);
      await up(two, { env: 'local', onEvent: onEvent(two) });
      assert.match(logs.get(two)!.join('\n'), new RegExp(`web:80 moves from ${busy} to \\d+: another program holds it`));
      assert.notEqual(readState(two, 'local')!.ports.web['80'], busy);
    } finally { other.close(); }
  });
});
