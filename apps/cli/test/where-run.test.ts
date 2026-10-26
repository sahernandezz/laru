/** `laru where --run` (and MCP `where`) lists a run's files; what the runner left in out/ as a link is not followed. */
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { initWorkspace } from '@laru/core';
import { runsDir } from '@laru/runtime';
import { makeFixture } from '../../../packages/core/test/fixture.ts';
import { whereText } from '../src/env-cli.ts';

test('a run\'s file list names real files only: a link the runner left, and what is behind it, are not listed', async () => {
  const fx = makeFixture();
  const w = initWorkspace(join(fx.tmp, 'ws'), { app: 'where', title: 'Where' });
  const dir = join(runsDir(w), '7');
  mkdirSync(join(dir, 'out', 'results'), { recursive: true });
  writeFileSync(join(dir, 'run.json'), '{}');
  writeFileSync(join(dir, 'out', 'runner.log'), 'log');
  mkdirSync(join(fx.tmp, 'mine'));
  writeFileSync(join(fx.tmp, 'mine', 'photo.png'), 'precious');
  symlinkSync(join(fx.tmp, 'mine'), join(dir, 'out', 'results', 'docs'));
  symlinkSync(join(fx.tmp, 'mine', 'photo.png'), join(dir, 'out', 'shot.png'));
  const text = await whereText(w, '7');
  assert.match(text, /out\/runner\.log/);
  assert.match(text, /run\.json/);
  assert.doesNotMatch(text, /photo\.png|shot\.png|docs/, text);
});
