/**
 * What a hostile test can leave in a run's out/: a video path with `..`, a screenshot that is a link to a secret, a
 * results folder that is a link to a folder of the person's. Masking, moving, deleting and reading them touches nothing
 * outside the run.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { Workspace } from '@laru/core';
import { createMasker, type Trace } from '@laru/trace';
import { dropRawMedia, keepEvidence, maskOutput, readEvents, runDir } from '../src/index.ts';

function fixture() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-out-')));
  const dir = join(tmp, 'run');
  const mine = join(tmp, 'mine'); // a folder of the person's, outside the run
  mkdirSync(mine);
  writeFileSync(join(mine, 'photo.png'), 'precious');
  writeFileSync(join(mine, 'notes.md'), 'token SECRET-9');
  writeFileSync(join(tmp, 'daemon.json'), 'the-token');
  const put = (p: string, text = p) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), text); };
  return { tmp, dir, mine, put };
}

test('keepEvidence moves only real files of out/: a video path that leaves it, and a screenshot that is a link, move nothing', () => {
  const { tmp, dir, put } = fixture();
  put('out/results/a-historia/video.webm');
  symlinkSync(join(tmp, 'daemon.json'), join(dir, 'out', 'results', 'a-historia', 's1.png'));
  const hostile = { test: 'historia', video: '/ks/out/../../daemon.json', steps: [{ n: 1 }] } as unknown as Trace;
  keepEvidence(dir, 'a', [hostile], hostile);
  assert.deepEqual(readdirSync(join(dir, 'flows', 'a')).sort(), ['trace.json'], 'no video, no screenshot kept');
  assert.equal(JSON.parse(readFileSync(join(dir, 'flows', 'a', 'trace.json'), 'utf8')).video, undefined);
  assert.equal(readFileSync(join(tmp, 'daemon.json'), 'utf8'), 'the-token', 'what the path pointed at is where it was');

  // the same story with a real video: it moves, and the link beside it still does not
  const story = { test: 'historia', video: '/ks/out/results/a-historia/video.webm', steps: [{ n: 1 }] } as unknown as Trace;
  keepEvidence(dir, 'b', [story], story);
  assert.deepEqual(readdirSync(join(dir, 'flows', 'b')).sort(), ['trace.json', 'video.webm']);
  assert.equal(existsSync(join(dir, 'out', 'results', 'a-historia', 's1.png')), true, 'the link was left alone, not moved into the served evidence');
});

test('dropRawMedia deletes the runner\'s media, never what a linked folder points at', () => {
  const { dir, mine, put } = fixture();
  put('out/results/t/video.webm');
  symlinkSync(mine, join(dir, 'out', 'results', 'docs'));
  dropRawMedia(join(dir, 'out', 'results'));
  assert.equal(existsSync(join(dir, 'out', 'results', 't', 'video.webm')), false);
  assert.equal(readFileSync(join(mine, 'photo.png'), 'utf8'), 'precious', 'a photo of the person\'s behind a link stays');
  // a results folder that is itself a link
  symlinkSync(mine, join(dir, 'out', 'results-1'));
  dropRawMedia(join(dir, 'out', 'results-1'));
  assert.equal(readFileSync(join(mine, 'photo.png'), 'utf8'), 'precious');
});

test('maskOutput masks every runner\'s results folder, and never rewrites a file through a link', () => {
  const { dir, tmp, mine, put } = fixture();
  const secret = 'flow-Secret-77ab9z';
  put('out/events.jsonl', JSON.stringify({ e: 'test-end', errors: [`got ${secret}`] }) + '\n');
  put('out/results/t/error-context.md', `- textbox "Token": ${secret}\n`);
  put('out/results-1/u/error-context.md', `- textbox "Token": ${secret}\n`);
  symlinkSync(mine, join(dir, 'out', 'results-2'));
  symlinkSync(join(tmp, 'daemon.json'), join(dir, 'out', 'results', 't', 'link.log'));
  maskOutput(join(dir, 'out'), createMasker([secret, 'SECRET-9', 'the-token']));
  for (const f of ['out/events.jsonl', 'out/results/t/error-context.md', 'out/results-1/u/error-context.md']) assert.ok(!readFileSync(join(dir, f), 'utf8').includes(secret), f);
  assert.equal(readFileSync(join(mine, 'notes.md'), 'utf8'), 'token SECRET-9', 'a file behind a linked folder is not rewritten');
  assert.equal(readFileSync(join(tmp, 'daemon.json'), 'utf8'), 'the-token', 'nor one a linked file points at');

  // events.jsonl itself a link: not read, not rewritten
  const bad = fixture();
  mkdirSync(join(bad.dir, 'out'), { recursive: true });
  symlinkSync(join(bad.tmp, 'daemon.json'), join(bad.dir, 'out', 'events.jsonl'));
  maskOutput(join(bad.dir, 'out'), createMasker(['the-token']));
  assert.equal(readFileSync(join(bad.tmp, 'daemon.json'), 'utf8'), 'the-token');
});

test('readEvents reads out/events.jsonl and nothing a link points at', () => {
  const { tmp } = fixture();
  const ws = { root: tmp } as Workspace;
  const run = runDir(ws, '3');
  mkdirSync(join(run, 'out'), { recursive: true });
  writeFileSync(join(run, 'out', 'events.jsonl'), '{"e":"phase","t":1}\n');
  assert.deepEqual(readEvents(ws, '3'), [{ e: 'phase', t: 1 }]);
  writeFileSync(join(tmp, 'other.jsonl'), '{"e":"phase","t":2}\n');
  mkdirSync(join(runDir(ws, '4'), 'out'), { recursive: true });
  symlinkSync(join(tmp, 'other.jsonl'), join(runDir(ws, '4'), 'out', 'events.jsonl'));
  assert.deepEqual(readEvents(ws, '4'), []);
});
