/** The code index is parsed once and read again only when its file changes. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadExtraction } from '../src/extract.ts';
import type { Workspace } from '../src/workspace.ts';

test('the code index is parsed once, and again when the file changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'laru-extract-'));
  mkdirSync(join(root, '.laru', 'extract'), { recursive: true });
  const ws = { root } as Workspace;
  const put = (commit: string) => writeFileSync(join(root, '.laru', 'extract', 'app.json'), JSON.stringify({ repo: 'app', commit, ref: 'main', detectors: 8, files: {}, tree: { 'a.ts': 'b1' } }));
  assert.equal(loadExtraction(ws, 'nada'), null);
  put('c1');
  const a = loadExtraction(ws, 'app');
  assert.equal(loadExtraction(ws, 'app'), a, 'the same object, not parsed again');
  put('c2-longer');
  assert.equal(loadExtraction(ws, 'app')?.commit, 'c2-longer', 'a new file is read again');
});
