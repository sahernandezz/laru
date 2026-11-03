/** `laru hook start`: the session begins knowing the workspace, where Laru reaches Docker, its envs and flows, and the agreement. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addRepo, agentRoot, initWorkspace, loadWorkspace, register, touch } from '@laru/core';
import { makeFixture } from '../../../packages/core/test/fixture.ts';
import { sessionStart } from '../src/env-cli.ts';

test('a new workspace starts every agent session with Laru\'s view of it, Docker and the one-flow-one-env rule included', async () => {
  const fx = makeFixture();
  const w = initWorkspace(join(fx.tmp, 'ws'), { app: 'tienda', title: 'Tienda' });
  const hooks = JSON.parse(readFileSync(join(w.root, '.claude', 'settings.json'), 'utf8')).hooks;
  assert.deepEqual(hooks.SessionStart.flatMap((h: { hooks: Array<{ command: string }> }) => h.hooks.map((x) => x.command)), ['laru hook start']);
  const text = await sessionStart(w);
  assert.match(text, /«Tienda» \(tienda\)/);
  assert.match(text, /Docker, as Laru reaches it \(Laru runs on \w+/);
  assert.match(text, /never conclude there is none from `docker` in your shell/);
  assert.match(text, /own env f-<flow>/);
  assert.match(text, /No working agreement yet/);
  assert.match(readFileSync(join(w.root, 'CLAUDE.md'), 'utf8'), /Docker is Laru's to reach.*One flow, its own env/s, 'the guide says both');
});

test('a session opened in Laru\'s own folder starts on the workspace opened last, told it is outside, with the whole guide', async () => {
  const fx = makeFixture();
  const old = initWorkspace(join(fx.tmp, 'old'), { app: 'vieja', title: 'Vieja' });
  const w = initWorkspace(join(fx.tmp, 'ws'), { app: 'tienda', title: 'Tienda' });
  await register(old.root); await register(w.root); await touch(w.root);
  const laru = join(fx.tmp, 'laru-install');
  mkdirSync(laru);
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'laru.js'), 'hook', 'start'], { cwd: laru, input: JSON.stringify({ cwd: laru }), env: { ...process.env, LARU_WORKSPACE: '' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
  assert.match(text, /opened outside any workspace, in Laru's own folder/);
  assert.match(text, new RegExp(`«Tienda» \\(tienda\\) at ${w.root}`));
  assert.match(text, /Never edit Laru's own code here/);
  assert.match(text, /## The documentation standard/, 'the guide, whole');
});

test('the one opened last never replaces the workspace that is named or whose project holds the agent', async () => {
  const fx = makeFixture();
  const shop = initWorkspace(join(fx.tmp, 'shop'), { app: 'tienda', title: 'Tienda' });
  fx.write(join(fx.tmp, 'code', 'app'), { 'package.json': '{"name":"app"}' });
  await addRepo(shop, join(fx.tmp, 'code', 'app'), { name: 'app' });
  const other = initWorkspace(join(fx.tmp, 'other'), { app: 'otra', title: 'Otra' });
  await register(loadWorkspace(shop.root).root); await register(other.root); await touch(other.root);
  const laru = join(fx.tmp, 'laru-install');
  mkdirSync(laru);
  assert.deepEqual(agentRoot({ cwd: join(fx.tmp, 'code', 'app') }), { root: shop.root, inside: false, last: false }, 'in a project of tienda: tienda, not the one opened last');
  assert.deepEqual(agentRoot({ cwd: laru, env: 'tienda' }), { root: shop.root, inside: false, last: false }, 'LARU_WORKSPACE names it');
  assert.deepEqual(agentRoot({ cwd: laru }), { root: other.root, inside: false, last: true }, 'nowhere: the one opened last');
  assert.deepEqual(agentRoot({ cwd: shop.root }), { root: shop.root, inside: true, last: false });
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'laru.js'), 'hook', 'start'], { cwd: laru, input: JSON.stringify({ cwd: laru }), env: { ...process.env, LARU_WORKSPACE: 'tienda' }, encoding: 'utf8' });
  const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
  assert.match(text, /outside the workspace's folder.*«Tienda»/s, 'the hook goes by LARU_WORKSPACE too');
  assert.doesNotMatch(text, /opened last/);
});
