/** What the runner writes is untrusted: only a real file inside the run's own folder is ever read, listed, served, moved or masked. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { appendRunnerFile, readRunnerFile, runnerFile, runnerFiles } from '../src/runner-file.ts';

/** A run's folder with a file of its own, and beside it a secret the runner must never reach. */
function fixture() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-runner-file-')));
  const run = join(tmp, 'runs', '7');
  const put = (p: string, text = p) => { mkdirSync(dirname(join(run, p)), { recursive: true }); writeFileSync(join(run, p), text); };
  put('out/events.jsonl', '{"e":"a"}\n');
  put('out/results/t/error-context.md');
  const secret = join(tmp, 'daemon.json');
  writeFileSync(secret, 'the-token');
  return { tmp, run, put, secret };
}

test('runnerFile: a real file of the folder comes back as its real path; a link, `..`, an absolute path or a way out do not', () => {
  const { tmp, run, put, secret } = fixture();
  assert.equal(runnerFile(run, 'out/events.jsonl'), join(run, 'out', 'events.jsonl'));
  assert.equal(runnerFile(run, 'out/./results/t/error-context.md'), join(run, 'out', 'results', 't', 'error-context.md'));

  // `..`, even where it stays inside the folder; an absolute path, even one that would land on a file inside it
  for (const rel of ['../daemon.json', '../../daemon.json', 'out/../out/events.jsonl', 'out/results/../events.jsonl', join(run, 'out', 'events.jsonl'), '/out/events.jsonl', secret, '/etc/passwd', '', '.', '\0']) assert.equal(runnerFile(run, rel), undefined, JSON.stringify(rel));

  // a link to a file outside, to one inside, and a file behind a linked folder
  symlinkSync(secret, join(run, 'out', 'events-0.jsonl'));
  symlinkSync(join(run, 'out', 'events.jsonl'), join(run, 'out', 'inside.jsonl'));
  symlinkSync(tmp, join(run, 'out', 'results-1'));
  assert.equal(runnerFile(run, 'out/events-0.jsonl'), undefined, 'a link to the token');
  assert.equal(runnerFile(run, 'out/inside.jsonl'), undefined, 'even a link that stays inside');
  assert.equal(runnerFile(run, 'out/results-1/daemon.json'), undefined, 'a file behind a linked folder');
  assert.equal(runnerFile(run, 'out/results-1'), undefined);

  // a folder, a pipe, what is not there; and a base that is itself reached through a link (a temp folder on macOS) is fine
  put('out/dir/x');
  execFileSync('mkfifo', [join(run, 'out', 'pipe')]);
  for (const rel of ['out/dir', 'out/pipe', 'out/nada']) assert.equal(runnerFile(run, rel), undefined, rel);
  symlinkSync(run, join(tmp, 'via-link'));
  assert.equal(runnerFile(join(tmp, 'via-link'), 'out/events.jsonl'), join(run, 'out', 'events.jsonl'));
});

test('runnerFiles lists real files only: a linked file, a linked folder and everything behind it are left out', () => {
  const { tmp, run, put } = fixture();
  put('flows/a/video.webm');
  mkdirSync(join(tmp, 'elsewhere'));
  writeFileSync(join(tmp, 'elsewhere', 'big.bin'), 'x');
  symlinkSync(tmp, join(run, 'flows', 'home'));
  symlinkSync(join(tmp, 'daemon.json'), join(run, 'flows', 'a', 's1.png'));
  assert.deepEqual(runnerFiles(run, 'flows'), ['flows/a/video.webm']);
  assert.deepEqual(runnerFiles(run, 'out').sort(), ['out/events.jsonl', 'out/results/t/error-context.md']);
  assert.deepEqual(runnerFiles(run, 'nada'), []);
  assert.deepEqual(runnerFiles(run, 'flows/home'), [], 'a linked folder is not listed at all');
  assert.deepEqual(runnerFiles(run, '../elsewhere'), []);
  assert.deepEqual(runnerFiles(run).sort(), ['flows/a/video.webm', 'out/events.jsonl', 'out/results/t/error-context.md'], 'the whole folder when no sub is given');
});

test('readRunnerFile gives the text of a real file and nothing for a link', () => {
  const { run, secret } = fixture();
  assert.equal(readRunnerFile(run, 'out/events.jsonl'), '{"e":"a"}\n');
  symlinkSync(secret, join(run, 'out', 'events-0.jsonl'));
  assert.equal(readRunnerFile(run, 'out/events-0.jsonl'), undefined, 'the token is not read through a link');
  assert.equal(readRunnerFile(run, '../../daemon.json'), undefined);
});

test('appendRunnerFile appends to a plain name and never writes through a link the runner put there', () => {
  const { run, secret } = fixture();
  appendRunnerFile(join(run, 'out'), 'events.jsonl', 'two\n');
  appendRunnerFile(join(run, 'out'), 'runner.log', 'created\n');
  assert.equal(readFileSync(join(run, 'out', 'events.jsonl'), 'utf8'), '{"e":"a"}\ntwo\n');
  assert.equal(readFileSync(join(run, 'out', 'runner.log'), 'utf8'), 'created\n');
  // the runner swaps the file for a link to a file of this machine: the open is refused, the target is untouched
  symlinkSync(secret, join(run, 'out', 'swapped.log'));
  assert.throws(() => appendRunnerFile(join(run, 'out'), 'swapped.log', 'evil\n'), { code: 'ELOOP' });
  assert.equal(readFileSync(secret, 'utf8'), 'the-token');
  // a name, not a path
  for (const name of ['../x', 'a/b', '', '..', '/etc/passwd']) assert.throws(() => appendRunnerFile(join(run, 'out'), name, 'x'), /not a file name/, name);
});
