/**
 * How a runner gets its values: the vault's secrets reach it through a 0600 file docker reads and that is gone when
 * docker returns, never on a command line (a world-readable `ps`, and Docker's events record it). Without Docker: a
 * `docker` on PATH that records what it was given.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Workspace } from '@laru/core';
import { envDir, setupResult, startRunner } from '../src/index.ts';

const SECRET = 'hunter2-vault-Secret';

/** Runs `body` with a fake docker on PATH: it logs its argv, and for `run` copies the --env-file and its permissions aside. */
async function withFakeDocker(body: (dir: string) => Promise<void>): Promise<{ argv: string[]; seen: string; mode: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'laru-fake-docker-')));
  writeFileSync(join(dir, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> '${dir}/argv.log'
[ "$1" = run ] || exit 0
while [ $# -gt 0 ]; do
  if [ "$1" = --env-file ]; then cp "$2" '${dir}/seen.env'; (stat -f %Lp "$2" || stat -c %a "$2") > '${dir}/seen.mode' 2>/dev/null; fi
  shift
done
[ -e '${dir}/fail' ] && { echo 'boom' >&2; exit 1; }
echo cid-0123456789ab
`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try { await body(dir); } finally { process.env.PATH = path; }
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  return { argv: read('argv.log').split('\n').filter(Boolean), seen: read('seen.env'), mode: read('seen.mode').trim() };
}

test('a runner\'s values go through a 0600 file that is gone when docker returns, whether it started or not; none is on argv', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-runner-')));
  const ws = { root: join(tmp, 'ws'), app: 'demo' } as Workspace;
  mkdirSync(join(envDir(ws, 'local'), 'tap'), { recursive: true });
  const envFile = join(tmp, '.runner-0.env');
  const vars = `KS_RUN=1\nKS_FLOW_VARS_JSON=${JSON.stringify({ password: SECRET })}\n`;

  let id = '';
  const ok = await withFakeDocker(async () => { id = await startRunner(ws, 'local', undefined, '1', join(tmp, 'out'), envFile, vars, ['flows/pagar.spec.ts']); });
  assert.equal(id, 'cid-0123456789ab');
  assert.equal(ok.seen, vars, 'docker read the values from the file');
  assert.equal(ok.mode, '600', 'which only the person can read');
  assert.ok(!existsSync(envFile), 'and which is gone when docker returned');
  const run = ok.argv.find((l) => l.startsWith('run '))!;
  assert.match(run, /--env-file \S+\.runner-0\.env/);
  assert.match(run, /--tmpfs \/ks\/ws\/\.laru(:|\s)/, 'the runner sees an empty .laru: its mask.json and scenario states stay out of its reach');
  assert.doesNotMatch(run, new RegExp(`${SECRET}|KS_|\\s-e\\s|--env\\s`), `no value or variable on the command line: ${run}`);

  // docker refusing to start it leaves nothing behind either
  const bad = await withFakeDocker(async (dir) => {
    writeFileSync(join(dir, 'fail'), '');
    await assert.rejects(startRunner(ws, 'local', undefined, '1', join(tmp, 'out'), envFile, vars, ['flows/pagar.spec.ts']), /boom/);
  });
  assert.equal(bad.seen, vars);
  assert.ok(!existsSync(envFile), 'a failed start deletes the file too');
  assert.ok(!Object.keys(process.env).some((k) => k.startsWith('KS_')), 'and no value went into this process\'s environment');
});

test('what a scenario setup leaves is read only from real files of its out/', () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-setup-')));
  const out = join(tmp, 'out');
  mkdirSync(out);
  assert.equal(setupResult(out), undefined, 'a setup that left nothing');
  writeFileSync(join(out, 'scenario.json'), JSON.stringify({ identities: [{ name: 'admin', username: 'ana' }] }));
  assert.deepEqual(setupResult(out), { identities: [{ name: 'admin', username: 'ana' }], signedIn: false });
  writeFileSync(join(out, 'storage.json'), '{}');
  assert.equal(setupResult(out)?.signedIn, true);

  // the runner made both of them links to files of the person's: neither counts
  const other = join(tmp, 'other');
  mkdirSync(join(tmp, 'bad'));
  writeFileSync(other, JSON.stringify({ identities: [{ name: 'root', username: 'leaked' }] }));
  symlinkSync(other, join(tmp, 'bad', 'scenario.json'));
  symlinkSync(other, join(tmp, 'bad', 'storage.json'));
  assert.equal(setupResult(join(tmp, 'bad')), undefined, 'a scenario.json that is a link is no result');
  mkdirSync(join(tmp, 'bad2'));
  writeFileSync(join(tmp, 'bad2', 'scenario.json'), '{"identities":[]}');
  symlinkSync(other, join(tmp, 'bad2', 'storage.json'));
  assert.equal(setupResult(join(tmp, 'bad2'))?.signedIn, false, 'a storage.json that is a link is not a signed-in session');
});
