/**
 * Laru's build cache (its own builder's, never Docker's shared one) is capped after each up, measured before and after: an older Docker that only knows
 * `--keep-storage` still gets it, one that ignores the cap loses the cache no build uses, and a trim that fails says so,
 * never "trimmed". Against a fake docker first on PATH (one process per test file).
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initWorkspace, register, type Workspace } from '@laru/core';
import { cleanDockerDetached, dirBytes, DOCKER_READ, forgetSizes, prune, workspacesDisk } from '../src/index.ts';

const tmp = mkdtempSync(join(tmpdir(), 'laru-buildcache-'));
const bin = join(tmp, 'bin');
mkdirSync(bin);
// `mode` says how Laru's builder answers `buildx prune`: ok, old (no --max-used-space), ignores (the cap does nothing),
// broken, hang (on `buildx du`), none (no builder yet) or theirs (a `laru` builder Laru did not create); `size` is the cache in GB that `buildx du` reports
writeFileSync(join(bin, 'docker'), `#!/bin/sh
echo "$*" >> "${bin}/calls"
mode=$(cat "${bin}/mode")
case "$*" in
  "image ls"*) [ -f "${bin}/images" ] || exit 0; if echo "$*" | grep -q "label=keelson.app"; then grep '"Labels":"keelson.app' "${bin}/images" || true; else cat "${bin}/images"; fi;;
  "buildx inspect laru"*) [ "$mode" = none ] && exit 1; [ "$mode" = theirs ] || echo 'Driver Options:        env.LARU_BUILDER="1"';;
  "buildx du --builder laru"*) [ "$mode" = hang ] && sleep 5; printf 'Reclaimable:\\t1GB\\nTotal:\\t\\t%sGB\\n' "$(cat "${bin}/size")";;
  "buildx prune --builder laru"*)
    if [ "$mode" = broken ]; then echo "Error response from daemon: permission denied" >&2; exit 1; fi
    if [ "$mode" = old ] && echo "$*" | grep -q max-used-space; then echo "unknown flag: --max-used-space" >&2; exit 125; fi
    if echo "$*" | grep -q -e max-used-space -e keep-storage; then [ "$mode" = ignores ] || echo 18 > "${bin}/size"; else echo 5 > "${bin}/size"; fi
    echo "Total: 0B";;
esac
`);
chmodSync(join(bin, 'docker'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.LARU_HOME = join(tmp, 'home');
process.env.LARU_DOCKER_CLEANUP = '1'; // the suite turns it off; here it is what is tested
// the machine's own Laru home is read too (its apps are never leftovers): here, one of the test's
process.env.HOME = join(tmp, 'user');
const ws = { root: join(tmp, 'ws'), app: 'shop', repos: [] } as unknown as Workspace;
const mode = (m: string, gb = 30) => { writeFileSync(join(bin, 'mode'), m); writeFileSync(join(bin, 'size'), String(gb)); writeFileSync(join(bin, 'calls'), ''); };
const prunes = () => readFileSync(join(bin, 'calls'), 'utf8').split('\n').filter((l) => l.startsWith('buildx prune'));
const cache = async () => (await prune(ws, { what: ['images'] })).buildCache;

test('the build cache goes down to 20 GB, least used first, with --keep-storage on an older Docker; under the cap it is left alone', async () => {
  mode('ok');
  assert.deepEqual(await cache(), { gb: 20, trimmed: true, before: 30e9, after: 18e9 });
  assert.deepEqual(prunes(), ['buildx prune --builder laru --all --force --max-used-space 20gb']);
  mode('old');
  assert.deepEqual(await cache(), { gb: 20, trimmed: true, before: 30e9, after: 18e9 });
  assert.deepEqual(prunes(), ['buildx prune --builder laru --all --force --max-used-space 20gb', 'buildx prune --builder laru --all --force --keep-storage 20gb']);
  mode('ok', 10);
  assert.deepEqual(await cache(), { gb: 20, trimmed: false, before: 10e9, after: 10e9 });
  assert.deepEqual(prunes(), []);
});

test('a Docker that ignores the cap loses the cache no build uses; the sizes are the ones measured', async () => {
  mode('ignores');
  assert.deepEqual(await cache(), { gb: 20, trimmed: true, before: 30e9, after: 5e9 });
  assert.deepEqual(prunes(), ['buildx prune --builder laru --all --force --max-used-space 20gb', 'buildx prune --builder laru --all --force']);
});

test('a trim that fails is reported as failed, with Docker\'s reason, and a dry run trims nothing', async () => {
  mode('broken');
  const r = (await cache())!;
  assert.equal(r.trimmed, false);
  assert.match(r.error ?? '', /permission denied/);
  assert.equal(prunes().length, 1, 'no other prune after a failure that is not the flag');
  // the record «Archivos locales» and laru where show says so too
  assert.match(JSON.parse(readFileSync(join(tmp, 'home', 'docker-cleanup.json'), 'utf8')).buildCache.error, /permission denied/);
  assert.ok(readFileSync(join(bin, 'calls'), 'utf8').includes('image prune --force --filter label=keelson.app'), 'nameless images of Laru go too');
  mode('ok');
  assert.deepEqual((await prune(ws, { what: ['images'], dryRun: true })).buildCache, { gb: 20, trimmed: false });
  assert.deepEqual(prunes(), []);
});

test('a Docker that hangs on the size question never holds the cleanup: it gives up and says why', async () => {
  mode('hang');
  const was = DOCKER_READ.ms;
  DOCKER_READ.ms = 300;
  try {
    const t0 = Date.now();
    const r = (await cache())!;
    assert.ok(Date.now() - t0 < 4000, `gave up in ${Date.now() - t0} ms`);
    assert.equal(r.trimmed, false);
    assert.match(r.error ?? '', /did not answer in time/);
    assert.deepEqual(prunes(), [], 'nothing pruned blind');
  } finally { DOCKER_READ.ms = was; }
});

test('after a run or an up, the cleanup runs in a detached process: the command returns at once, the cleanup still ends', async () => {
  mode('ok');
  const record = join(tmp, 'home', 'docker-cleanup.json');
  rmSync(record, { force: true });
  const t0 = Date.now();
  cleanDockerDetached('shop');
  assert.ok(Date.now() - t0 < 200, `returned in ${Date.now() - t0} ms`);
  for (let i = 0; i < 100 && !existsSync(record); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')).buildCache, { gb: 20, trimmed: true, before: 30e9, after: 18e9 });
});

test('what each workspace weighs: two workspaces of one app each show its images, the whole counts them once', async () => {
  mode('ok', 2);
  writeFileSync(join(bin, 'images'), [{ Repository: 'ks-shop/api', Tag: 'a', ID: 'a1', CreatedAt: '', Size: '1GB', Labels: 'keelson.app=shop' }, { Repository: 'postgres', Tag: '16', ID: 'p1', CreatedAt: '', Size: '400MB' }].map((r) => JSON.stringify(r)).join('\n'));
  for (const d of ['one', 'two']) await register(initWorkspace(join(tmp, d), { app: 'shop' }).root);
  // the app's snapshot lives in Laru's home
  mkdirSync(join(tmp, 'home', 'shop', 'snapshots', 'api@c1'), { recursive: true });
  writeFileSync(join(tmp, 'home', 'shop', 'snapshots', 'api@c1', 'code'), Buffer.alloc(64 * 1024, 1));
  forgetSizes();
  const r = await workspacesDisk();
  const snap = r.workspaces[0].bytes.snapshots;
  assert.ok(snap >= 64 * 1024, `the snapshot is counted: ${snap}`);
  assert.equal(r.home.bytes + snap, dirBytes(join(tmp, 'home')), 'Laru\'s home is shown without the snapshots, which go by app');
  assert.deepEqual(r.workspaces.map((w) => w.bytes.images), [1e9, 1e9], 'each shows its app\'s images, not another\'s');
  assert.equal(r.buildCache.bytes, 2e9);
  const own = r.workspaces.reduce((n, w) => n + w.total - w.bytes.images! - w.bytes.snapshots, 0);
  assert.equal(r.total, own + 1e9 + snap + r.home.bytes + 2e9, 'the app\'s images and snapshots once, then the rest of Laru\'s home and the build cache');
  rmSync(join(bin, 'images'));
});

test('an app registered only in the machine\'s own Laru home is never a leftover for a Laru with another LARU_HOME', async () => {
  mode('ok', 2);
  writeFileSync(join(bin, 'images'), ['ks-bench/api', 'ks-gone/api'].map((repo) => JSON.stringify({ Repository: repo, Tag: 'a', ID: repo, CreatedAt: '', Size: '1MB', Labels: `keelson.app=${repo.slice(3, -4)}` })).join('\n'));
  const bench = initWorkspace(join(tmp, 'bench'), { app: 'bench' }).root;
  mkdirSync(join(tmp, 'user', '.laru'), { recursive: true });
  writeFileSync(join(tmp, 'user', '.laru', 'workspaces.yaml'), `- root: ${bench}\n  addedAt: x\n`);
  assert.deepEqual((await prune(ws, { what: ['images'], dryRun: true })).images.map((i) => i.ref), ['ks-gone/api:a']);
  rmSync(join(bin, 'images'));
});

test('ups and runs in a row start one cleanup, not one each', async () => {
  rmSync(join(tmp, 'home', 'docker-cleanup.started'), { force: true });
  cleanDockerDetached('shop');
  const first = readFileSync(join(tmp, 'home', 'docker-cleanup.started'), 'utf8');
  await new Promise((r) => setTimeout(r, 20));
  cleanDockerDetached('shop');
  assert.equal(readFileSync(join(tmp, 'home', 'docker-cleanup.started'), 'utf8'), first, 'the second one did not start');
});

test('only what Laru built goes: an image named like Laru\'s but without its label stays, an unused older runner goes', async () => {
  mode('ok', 2);
  writeFileSync(join(bin, 'images'), [
    { Repository: 'ks-ajeno/api', Tag: 'a', ID: 'x1', CreatedAt: '', Size: '1MB' }, // someone else's, same prefix, no label
    { Repository: 'ks-gone/api', Tag: 'a', ID: 'g1', CreatedAt: '', Size: '1MB', Labels: 'keelson.app=gone' },
    { Repository: 'keelson/runner', Tag: 'old', ID: 'r1', CreatedAt: '', Size: '1MB' },
    { Repository: 'postgres', Tag: '16', ID: 'p1', CreatedAt: '', Size: '1MB' },
  ].map((r) => JSON.stringify(r)).join('\n'));
  assert.deepEqual((await prune(ws, { what: ['images'], dryRun: true })).images.map((i) => i.ref), ['ks-gone/api:a', 'keelson/runner:old']);
  rmSync(join(bin, 'images'));
});

test('Docker\'s own build cache, shared with every project on the machine, is never pruned; without a builder of its own, or with someone else\'s named laru, Laru prunes none', async () => {
  mode('ok');
  await cache();
  const calls = readFileSync(join(bin, 'calls'), 'utf8').split('\n').filter((l) => /prune/.test(l));
  assert.ok(calls.length && calls.every((l) => !l.startsWith('builder') && !l.startsWith('system') && (l.startsWith('image prune --force --filter label=') || l.includes('--builder laru'))), calls.join('\n'));
  mode('none');
  assert.deepEqual(await cache(), { gb: 20, trimmed: false, before: 0, after: 0 });
  assert.deepEqual(prunes(), []);
  // a builder named `laru` that Laru did not create (no mark) is someone else's: not measured, not trimmed
  mode('theirs');
  assert.deepEqual(await cache(), { gb: 20, trimmed: false, before: 0, after: 0 });
  assert.deepEqual(prunes(), []);
});
