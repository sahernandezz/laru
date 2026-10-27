import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { importEvidence, shareEvidence, stateDir, type Workspace } from '../src/index.ts';

const wsAt = (root: string) => ({ root }) as Workspace;
const index = (root: string) => readFileSync(join(stateDir({ root }), 'runs', 'index.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function runOn(root: string, id: string, at: string, status: string) {
  const dir = join(stateDir({ root }), 'runs', id);
  mkdirSync(join(dir, 'flows', 'login'), { recursive: true });
  mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ id, env: 'local', ephemeral: false, flows: ['login', 'other'], phase: 'done', status, startedAt: at, pid: 1, results: { login: { status, ms: 10 }, other: { status: 'passed', ms: 5 } } }));
  writeFileSync(join(dir, 'flows', 'login', 'trace.json'), '{"test":"login"}');
  writeFileSync(join(dir, 'flows', 'login', 'video.webm'), 'video');
  writeFileSync(join(dir, 'out', 'events.jsonl'), [
    { e: 'test-begin', test: 'a', file: '/ks/ws/docs/flows/login/login.spec.ts' }, { e: 'step', test: 'a' },
    { e: 'test-begin', test: 'b', file: '/ks/ws/docs/flows/other/other.spec.ts' }, { e: 'step', test: 'b' }, { e: 'phase' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(stateDir({ root }), 'runs', 'index.jsonl'), JSON.stringify({ run: id, flow: 'login', status, at, key: 'k1', env: 'local' }) + '\n', { flag: 'a' });
}

test('the last passing evidence of a flow travels by git and opens as a run of the machine that receives it', () => {
  const mine = mkdtempSync(join(tmpdir(), 'laru-ev-'));
  runOn(mine, '7', '2026-10-26T10:00:00.000Z', 'passed');
  symlinkSync('/etc/hosts', join(stateDir({ root: mine }), 'runs', '7', 'flows', 'login', 'hosts'));
  assert.ok(shareEvidence(wsAt(mine), '7', 'login'));
  const ev = join(mine, 'evidence', 'login');
  assert.ok(existsSync(join(ev, 'flows', 'login', 'video.webm')));
  assert.ok(!existsSync(join(ev, 'flows', 'login', 'hosts')), 'a link is never shared');
  assert.deepEqual(readFileSync(join(ev, 'out', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).test ?? null), ['a', 'a', null], 'only this flow\'s events');
  assert.deepEqual(importEvidence(wsAt(mine)), [], 'the machine that shared it does not import it again');

  // A teammate clones it: one older run of their own, a failure of login after the shared pass.
  const theirs = mkdtempSync(join(tmpdir(), 'laru-ev-'));
  cpSync(join(mine, 'evidence'), join(theirs, 'evidence'), { recursive: true });
  runOn(theirs, '3', '2026-10-26T11:00:00.000Z', 'failed');
  assert.deepEqual(importEvidence(wsAt(theirs)), ['4']);
  const run = JSON.parse(readFileSync(join(stateDir({ root: theirs }), 'runs', '4', 'run.json'), 'utf8'));
  assert.deepEqual([run.id, run.flows, run.status, run.shared, run.origin, run.pid], ['4', ['login'], 'passed', true, '7', undefined]);
  assert.equal(readFileSync(join(stateDir({ root: theirs }), 'runs', '4', 'flows', 'login', 'video.webm'), 'utf8'), 'video');
  assert.deepEqual(index(theirs).map((x) => [x.run, x.status]), [['4', 'passed'], ['3', 'failed']], 'their later failure stays the result of login');
  assert.deepEqual(importEvidence(wsAt(theirs)), [], 'imported once');
});

test('an older pass never replaces newer shared evidence, and a failed flow is never shared', () => {
  const root = mkdtempSync(join(tmpdir(), 'laru-ev-'));
  runOn(root, '9', '2026-10-26T12:00:00.000Z', 'passed');
  runOn(root, '8', '2026-10-26T09:00:00.000Z', 'passed');
  runOn(root, '10', '2026-10-26T13:00:00.000Z', 'failed');
  assert.ok(shareEvidence(wsAt(root), '9', 'login'));
  assert.equal(shareEvidence(wsAt(root), '8', 'login'), false);
  assert.equal(shareEvidence(wsAt(root), '10', 'login'), false);
  assert.equal(JSON.parse(readFileSync(join(root, 'evidence', 'login', 'evidence.json'), 'utf8')).run.origin, '9');
});

test('a link anywhere on the way is never followed: not evidence/, not a flow\'s folders, not when sharing', () => {
  const outside = mkdtempSync(join(tmpdir(), 'laru-outside-'));
  mkdirSync(join(outside, 'login'), { recursive: true });
  writeFileSync(join(outside, 'login', 'secret.json'), 'secret');
  const mine = mkdtempSync(join(tmpdir(), 'laru-ev-'));
  runOn(mine, '7', '2026-10-26T10:00:00.000Z', 'passed');
  assert.ok(shareEvidence(wsAt(mine), '7', 'login'));

  // A teammate's commit made flows/ of the evidence a link out of the workspace.
  const theirs = mkdtempSync(join(tmpdir(), 'laru-ev-'));
  cpSync(join(mine, 'evidence'), join(theirs, 'evidence'), { recursive: true });
  rmSync(join(theirs, 'evidence', 'login', 'flows'), { recursive: true });
  symlinkSync(outside, join(theirs, 'evidence', 'login', 'flows'));
  assert.deepEqual(importEvidence(wsAt(theirs)), ['1']);
  assert.ok(!existsSync(join(stateDir({ root: theirs }), 'runs', '1', 'flows', 'login', 'secret.json')), 'nothing read through a linked folder');

  // evidence/ itself a link: nothing imported from it, nothing shared into it.
  const linked = mkdtempSync(join(tmpdir(), 'laru-ev-'));
  symlinkSync(join(mine, 'evidence'), join(linked, 'evidence'));
  assert.deepEqual(importEvidence(wsAt(linked)), []);
  runOn(linked, '2', '2026-10-26T12:00:00.000Z', 'passed');
  assert.equal(shareEvidence(wsAt(linked), '2', 'login'), false);
  assert.equal(JSON.parse(readFileSync(join(mine, 'evidence', 'login', 'evidence.json'), 'utf8')).run.origin, '7', 'the folder behind the link is untouched');
});
