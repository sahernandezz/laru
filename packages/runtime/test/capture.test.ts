/**
 * A live session reads about every second: with its memo, a read after the first asks Docker only for the log lines
 * that came after the last one, not for the containers again, and keeps every line once. Without Docker: a `docker` on
 * PATH that answers for one container and records what it was asked.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Workspace } from '@laru/core';
import type { Masker } from '@laru/trace';
import { capture, captureMemo } from '../src/runs.ts';

test('a live session’s second read asks only for new log lines, not for the containers again, and keeps each line once', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'laru-fake-docker-')));
  const line = `${new Date().toISOString().replace('Z', '000000Z')} started`;
  const inspect = JSON.stringify([{ Id: 'c0ffee000000aa', Name: '/api', Config: { Labels: { 'keelson.service': 'api' }, Image: 'nginx' }, State: { Status: 'running', ExitCode: 0 }, NetworkSettings: { Networks: {}, Ports: {} } }]);
  writeFileSync(join(dir, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> '${dir}/argv.log'
case "$1" in
  ps) echo c0ffee000000 ;;
  inspect) cat '${dir}/inspect.json' ;;
  logs) if [ -e '${dir}/fail' ]; then echo 'Error response from daemon: request timed out' >&2; exit 1; fi; echo '${line}' ;;
esac
exit 0
`, { mode: 0o755 });
  writeFileSync(join(dir, 'inspect.json'), inspect);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  const ws = { root: join(dir, 'ws'), app: 'demo' } as Workspace;
  const m = { text: (s: string) => s, body: (s: string) => s } as unknown as Masker;
  const from = Date.now() - 60_000;
  try {
    const memo = captureMemo();
    const first = await capture(ws, 'local', undefined, from, Date.now() + 2000, m, undefined, { kafka: false, memo });
    const asked1 = readFileSync(join(dir, 'argv.log'), 'utf8').split('\n').filter(Boolean);
    writeFileSync(join(dir, 'argv.log'), '');
    const second = await capture(ws, 'local', undefined, from, Date.now() + 2000, m, undefined, { kafka: false, memo });
    const asked2 = readFileSync(join(dir, 'argv.log'), 'utf8').split('\n').filter(Boolean);
    assert.ok(asked1.some((a) => a.startsWith('ps ')) && asked1.some((a) => a.startsWith('inspect ')), asked1.join('\n'));
    assert.deepEqual(asked2.map((a) => a.split(' ')[0]), ['logs'], `only the log is asked again: ${asked2.join(' | ')}`);
    const since = (a: string) => Date.parse(a.split(' ')[3]);
    assert.equal(since(asked1.find((a) => a.startsWith('logs'))!), from, 'the first read starts at the session');
    assert.ok(since(asked2[0]) > from + 50_000, 'the second starts where the first stopped, 2 s back');
    assert.deepEqual([first.logs.length, second.logs.length], [1, 1], 'a line read twice is kept once');

    // Docker failing on a read: what was read stays, its error is no log line, and the next read starts where the last good one stopped
    const kept = structuredClone(memo.logs.get('c0ffee000000'));
    writeFileSync(join(dir, 'fail'), '');
    const failed = await capture(ws, 'local', undefined, from, Date.now() + 2000, m, undefined, { kafka: false, memo });
    assert.deepEqual(failed.logs.map((l) => l.line), ['started'], 'the lines read before, not the error');
    assert.deepEqual(memo.logs.get('c0ffee000000'), kept, 'the memo did not move');
    assert.equal(memo.at, 0, 'the containers are asked again next time');
    rmSync(join(dir, 'fail'));
    writeFileSync(join(dir, 'argv.log'), '');
    await capture(ws, 'local', undefined, from, Date.now() + 2000, m, undefined, { kafka: false, memo });
    const asked4 = readFileSync(join(dir, 'argv.log'), 'utf8').split('\n').filter(Boolean);
    assert.equal(since(asked4.find((a) => a.startsWith('logs'))!), kept!.until - 2000, 'from the last good read');
  } finally { process.env.PATH = path; }
});
