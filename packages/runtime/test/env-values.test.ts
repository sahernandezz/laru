/**
 * What an env leaves on disk about its values. A fake `docker` comes first on PATH (every docker call goes through
 * dockerEnv's PATH), so nothing here reaches the real Docker: it answers `compose config` with a one-service compose,
 * echoes a value and fails on `build`, and lists nothing for everything else.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addRepo, initWorkspace, stateDir } from '@laru/core';
import { writeMaskFile } from '@laru/trace';
import { cancelRun, down, envDir, runFlows, up, withLock } from '../src/index.ts';

const SECRET = 'Build-Echoed-Pw-9x7';
const FAKE = `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === 'compose' && a[3] === 'config') {
  const context = require('node:path').join(require('node:path').dirname(a[2]), 'api');
  console.log(JSON.stringify({ name: 'shop', services: { api: { build: { context, dockerfile: 'Dockerfile' }, environment: { API_PASSWORD: process.env.DOCKER_FAKE_SECRET } } } }));
} else if (a[0] === 'compose' && a.includes('build')) {
  console.log('#5 [api 2/2] RUN echo using ' + process.env.DOCKER_FAKE_SECRET);
  process.exit(1);
}
`;

function repo(tmp: string): string {
  const work = join(tmp, 'seed', 'shop');
  for (const [p, c] of Object.entries({ 'docker-compose.yml': 'services:\n  api:\n    build: ./api\n', 'api/Dockerfile': 'FROM scratch\n' })) {
    mkdirSync(dirname(join(work, p)), { recursive: true });
    writeFileSync(join(work, p), c);
  }
  const git = (...a: string[]) => execFileSync('git', a, { cwd: work, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '--quiet', '-b', 'main'); git('add', '-A'); git('commit', '--quiet', '-m', 'first');
  const bare = join(tmp, 'remotes', 'shop.git');
  git('clone', '--quiet', '--bare', work, bare);
  return `file://${bare}`;
}

test('the runtime lock: a run holding it can up its env; two separate operations still wait for each other', { timeout: 10_000 }, async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'laru-lock-')), 'runtime.lock');
  assert.equal(await withLock('run 1', () => withLock('up shop/local', async () => 'nested', undefined, file), undefined, file), 'nested');
  const order: string[] = [];
  const a = withLock('a', async () => { order.push('a in'); await new Promise((r) => setTimeout(r, 200)); order.push('a out'); }, undefined, file);
  const b = withLock('b', async () => { order.push('b in'); }, undefined, file);
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a in', 'a out', 'b in']);
});

test("an env's values on disk, with a fake docker", { timeout: 120_000 }, async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-values-')));
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), FAKE, { mode: 0o755 });
  // Never put back: this file has a process of its own, and work in flight when the test times out keeps the fake docker.
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, LARU_HOME: join(tmp, 'home'), LARU_VAULT_KEYSTORE: 'file', DOCKER_FAKE_SECRET: SECRET });
  mkdirSync(process.env.LARU_HOME!, { recursive: true });
  const ws = initWorkspace(join(tmp, 'ws'), { app: 'shop', title: 'Shop' });
  await addRepo(ws, repo(tmp));
  mkdirSync(join(ws.root, 'envs'));
  writeFileSync(join(ws.root, 'envs', 'local.yaml'), 'from: shop:docker-compose.yml\n');
  const dir = envDir(ws, 'local');

  await t.test("a first up's build lines are masked with the values it has just written, in events.jsonl and build.log", async () => {
    await assert.rejects(up(ws, { env: 'local' }), /the build failed/);
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    const log = readFileSync(join(dir, 'build.log'), 'utf8');
    assert.match(events, /RUN echo using …[\w-]{4}/);
    assert.match(log, /RUN echo using …[\w-]{4}/);
    assert.ok(!events.includes(SECRET) && !log.includes(SECRET));
  });

  await t.test("an ephemeral run's tap dir, mask.json with it, goes when its env is destroyed at the end of the run", async () => {
    const run = await runFlows(ws, { env: 'local', ephemeral: true, id: 'e1' });
    assert.match(run.error ?? '', /the build failed/);
    assert.ok(!existsSync(join(dir, 'runs', 'e1', 'tap')), 'the run wrote it, and it is gone');
  });

  await t.test('and when the run is cancelled', async () => {
    const id = 'e2';
    mkdirSync(join(stateDir(ws), 'runs', id), { recursive: true });
    writeFileSync(join(stateDir(ws), 'runs', id, 'run.json'), JSON.stringify({ id, env: 'local', ephemeral: true, flows: [], phase: 'tests', status: 'running', startedAt: new Date().toISOString(), pid: process.pid, results: {} }));
    mkdirSync(join(dir, 'runs', id, 'tap'), { recursive: true });
    writeMaskFile(join(dir, 'runs', id, 'tap', 'mask.json'), [SECRET]);
    assert.equal(await cancelRun(ws, id), true);
    assert.ok(!existsSync(join(dir, 'runs', id, 'tap')));
  });

  await t.test("down removes the env's mask.json, keeps the traffic and the masks of the instances that run", async () => {
    mkdirSync(join(dir, 'runs', 'e3', 'tap'), { recursive: true });
    writeMaskFile(join(dir, 'runs', 'e3', 'tap', 'mask.json'), [SECRET]);
    writeMaskFile(join(dir, 'tap', 'mask.json'), [SECRET]);
    writeFileSync(join(dir, 'tap', 'traffic.jsonl'), '');
    await down(ws, 'local');
    assert.ok(!existsSync(join(dir, 'tap', 'mask.json')));
    assert.ok(existsSync(join(dir, 'runs', 'e3', 'tap', 'mask.json')), 'a flow\'s environment or a run still going keeps its own mask');
    assert.ok(existsSync(join(dir, 'tap', 'traffic.jsonl')));
  });
});
