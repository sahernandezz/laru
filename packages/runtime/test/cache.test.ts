import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Workspace } from '@laru/core';
import { passedKeys, runsDir } from '../src/runs.ts';

test('a flow keeps every key it passed with, so a reverted change is cached again; a key that failed is forgotten', () => {
  const ws = { root: mkdtempSync(join(tmpdir(), 'ks-cache-')) } as Workspace;
  mkdirSync(runsDir(ws), { recursive: true });
  const row = (run: string, flow: string, status: string, key?: string) => JSON.stringify({ run, flow, status, key });
  writeFileSync(join(runsDir(ws), 'index.jsonl'), [
    row('1', 'a', 'passed', 'k1'), row('2', 'a', 'passed', 'k2'), row('3', 'a', 'passed', 'k1'),
    row('1', 'b', 'passed', 'k1'), row('2', 'b', 'failed', 'k1'), row('3', 'b', 'passed', 'k2'),
    row('1', 'c', 'passed', 'k1'), row('2', 'c', 'failed'),
    row('4', 'a', 'error', 'k3'),
  ].join('\n') + '\n');
  const p = passedKeys(ws);
  assert.deepEqual([...p.get('a')!], [['k1', '3'], ['k2', '2']]);
  assert.deepEqual([...p.get('b')!], [['k2', '3']]);
  assert.equal(p.get('c'), undefined);
});
