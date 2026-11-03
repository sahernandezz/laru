/** Open pages refresh when the workspace changes from outside; a Docker that does not answer holds no screen. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { addRepo, initWorkspace, knowledgeWrite, loadGraph, loadWorkspace, refreshMap, stateDir, writeAgentFiles } from '@laru/core';
import { DOCKER_READ, dockerAnswers, envDir, status } from '@laru/runtime';
import { makeFixture } from '../../../packages/core/test/fixture.ts';
import { makeApi } from '../src/daemon.ts';

test('the pulse\'s changes move when an agent writes in the workspace, not for run files or the page\'s own saves', async () => {
  const fx = makeFixture();
  const w = initWorkspace(join(fx.tmp, 'ws'), { app: 'tienda' });
  const { api } = makeApi(w.root);
  const pulse = async () => (await api['GET /api/pulse']({} as never, new URL('http://x'), undefined)) as { changes: { n: number; files: string[] }; running: unknown[] };
  const n = async () => (await pulse()).changes.n;
  await n();
  await sleep(1000); // macOS may still deliver what initWorkspace wrote: the count starts after it
  const base = await n();
  writeFileSync(join(w.root, 'nota.md'), '# Nota\n');
  await sleep(1000);
  assert.equal(await n(), base + 1, 'a doc written from outside');
  assert.deepEqual((await pulse()).changes.files, ['nota.md'], 'naming what changed');
  mkdirSync(join(stateDir(w), 'runs', '7'), { recursive: true });
  writeFileSync(join(stateDir(w), 'runs', '7', 'trace.json'), '{}');
  await sleep(1000);
  assert.equal(await n(), base + 1, 'a run\'s files do not count');
  writeFileSync(join(stateDir(w), 'runs', 'index.jsonl'), '{}\n');
  await sleep(1000);
  assert.equal(await n(), base + 2, 'a run that ended does');
  await api['POST /api/findings/accept']({} as never, new URL('http://x'), { key: 'k', reason: 'probado' });
  await sleep(1000);
  assert.equal(await n(), base + 2, 'the page\'s own save does not');
});

test('a Docker that answered and then hangs is given up on too, and taken as not answering after', async () => {
  const fx = makeFixture();
  const w = initWorkspace(join(fx.tmp, 'ws'), { app: 'tienda' });
  const dir = envDir(w, 'local');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'compose.yml'), 'services: {}\n');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ ports: {} }));
  const bin = join(fx.tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\n[ "$1" = version ] && { echo 28.0; exit 0; }\nexec sleep 60\n', { mode: 0o755 });
  const path = process.env.PATH, was = DOCKER_READ.ms;
  process.env.PATH = `${bin}:/bin:/usr/bin`;
  DOCKER_READ.ms = 1000;
  try {
    assert.equal(await dockerAnswers(), true, 'version answers');
    const t = Date.now();
    assert.equal((await status(w, 'local')).state, 'unknown', 'docker ps hangs');
    assert.ok(Date.now() - t < 3000);
    assert.equal(await dockerAnswers(), false, 'the next screen does not ask it');
  } finally { process.env.PATH = path; DOCKER_READ.ms = was; }
});

test('an env whose Docker does not answer is «unknown» within 5 s, and no docker call is left hanging', async () => {
  const fx = makeFixture();
  const w = initWorkspace(join(fx.tmp, 'ws'), { app: 'tienda' });
  const dir = envDir(w, 'local');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'compose.yml'), 'services: {}\n');
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ ports: {}, lastReadyAt: '2026-11-01T00:00:00Z' }));
  const bin = join(fx.tmp, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 }); // a Docker that hangs
  const path = process.env.PATH;
  process.env.PATH = `${bin}:/bin:/usr/bin`;
  try {
    const t = Date.now();
    const s = await status(w, 'local');
    assert.equal(s.state, 'unknown');
    assert.equal(s.lastReadyAt, '2026-11-01T00:00:00Z');
    assert.ok(Date.now() - t < 7000, 'given up on after 5 s');
  } finally { process.env.PATH = path; }
});

test('/api/agreement: the very text the agent reads, whether it is in force, and how it reaches the agent', async () => {
  const fx = makeFixture();
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'comercio', title: 'Comercio' });
  await addRepo(ws, fx.billingUrl);
  await refreshMap(ws);
  const g = loadGraph(ws);
  const w = (x: Parameters<typeof knowledgeWrite>[1]) => { const r = knowledgeWrite(ws, x, g); assert.ok(r.ok, JSON.stringify(r.issues)); return r; };
  w({ type: 'application', title: 'Comercio', kind: 'product', status: 'active', summary: 'Tienda.', fields: { purpose: 'Vender.', users: [{ actor: 'Cliente', need: 'Comprar' }], scope: ['Pagos'] } });
  const agr = w({ type: 'agreement', in: 'app:comercio', title: 'Tickets', summary: 'Tickets del sprint, una rama por ticket.', fields: { purpose: 'Desarrollar tickets.', protected: ['main'], never: ['cmd: git push --force', 'Tocar producción'], confirm: ['cmd: ^git push'] } });
  writeAgentFiles(loadWorkspace(ws.root));
  const { api } = makeApi(ws.root);
  const r = (await api['GET /api/agreement']({} as never, new URL(`http://x/?id=${agr.id}`), undefined)) as { text: string; inForce: boolean; reaches: Record<string, boolean> };
  assert.match(r.text, /Never:\n- cmd: git push --force\n- Tocar producción/);
  assert.equal(r.inForce, true);
  assert.deepEqual(r.reaches, { claude: true, mcp: true, hooks: true });
  await assert.rejects(api['GET /api/agreement']({} as never, new URL('http://x/?id=app:comercio'), undefined), /no agreement/);
});
