/**
 * Laru builds with its own builder, whose cache is the only one its cleanup trims. An image whose base exists only on
 * this machine cannot be built there: up builds it with Docker's own, and keeps doing so for that env.
 * Heavy: runs only with LARU_E2E=1 and Docker running. Nothing without this test's label may change.
 */
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addRepo, initWorkspace } from '@laru/core';
import { down, up, workspaceKey, type EnvError } from '../src/index.ts';
import { dockerUp, guard } from './guard.ts';

const heavy = !dockerUp ? 'Docker is not running' : process.env.LARU_E2E !== '1' ? 'set LARU_E2E=1' : false;

test('a base image only on this machine is built with Docker\'s own builder, and that env stays on it', { skip: heavy, timeout: 10 * 60_000 }, async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-builder-')));
  process.env.LARU_HOME = join(tmp, 'home');
  mkdirSync(process.env.LARU_HOME, { recursive: true });
  const base = `laruvalid${process.pid.toString(36)}-base:1`;
  execFileSync('docker', ['build', '-q', '-t', base, '-'], { input: 'FROM alpine:3.20\nRUN echo base > /base\n', stdio: ['pipe', 'ignore', 'ignore'] });
  const files: Record<string, string> = {
    'docker-compose.yml': 'services:\n  a:\n    build: ./a\n    command: ["sleep", "600"]\n',
    'a/Dockerfile': `FROM ${base}\nRUN cat /base\n`,
  };
  const work = join(tmp, 'seed', 'shop');
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(work, p)), { recursive: true }); writeFileSync(join(work, p), c); }
  const git = (...a: string[]) => execFileSync('git', a, { cwd: work, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '--quiet', '-b', 'main'); git('add', '-A'); git('commit', '--quiet', '-m', 'first');
  const ws = initWorkspace(join(tmp, 'ws'), { app: 'shopb', title: 'Shop' });
  await addRepo(ws, work);
  mkdirSync(join(ws.root, 'envs'));
  writeFileSync(join(ws.root, 'envs', 'local.yaml'), 'from: shop:docker-compose.yml\n');
  const g = guard(workspaceKey(ws));
  t.after(async () => { await down(ws, 'local').catch(() => undefined); spawnSync('docker', ['image', 'rm', base], { stdio: 'ignore' }); g.check(); });

  const lines: string[] = [];
  const r = await up(ws, { env: 'local', onEvent: (e: { kind: string; line?: string }) => { if (e.line) lines.push(e.line); } } as never).catch((e: EnvError) => { throw new Error(`${e.message}\n${(e.logs ?? []).join('\n')}`); });
  assert.ok(r.services.some((s) => s.service === 'a'), 'it was built and started');
  assert.ok(lines.some((l) => /builds with Docker's own from now on/.test(l)), 'it says why');
  assert.ok(existsSync(join(ws.root, '.laru', 'envs', 'local', 'shared-builder')), 'and remembers it for this env');
});
