/**
 * Folder projects through their shadow index: one hash for the same content wherever it lives, the defaults and the
 * project's ignore, nested repos and big files left out, and a folder no Laru operation ever writes.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addRepo, changesFromWorktrees, initWorkspace, keepTree, loadWorkspace, refreshMap, scanFolder, treeNow, workspaceKey } from '@laru/core';
import { makeFixture, snapshotOf } from '../../core/test/fixture.ts';
import { prune } from '../src/disk.ts';
import { contextKey, resolveEnvRef, snapshotRepo } from '../src/snapshot.ts';
import { importEnvFile, loadVault } from '../src/vault.ts';

process.env.LARU_VAULT_KEYSTORE = 'file';

const FILES = {
  'api/server.js': 'require("http").createServer((q, s) => s.end("ok")).listen(3000);\n',
  'api/Dockerfile': 'FROM node:24-alpine\nCOPY server.js /srv/\nEXPOSE 3000\n',
  'docker-compose.yml': 'services:\n  ledger:\n    build: ./api\n',
  '.env': 'LEDGER_TOKEN=very-secret-1\n',
  // the folder's own .gitignore asks for .env: Laru leaves it out all the same
  '.gitignore': '!.env\n',
  'notes/crlf.txt': 'a\r\nb\r\n',
  '.env.example': 'LEDGER_URL=http://ledger:3000\nLEDGER_TOKEN=change-me-please\n',
  'node_modules/x/index.js': 'x\n',
  'data/dump.sql': 'select 1;\n',
};

test('a folder\'s hash is its content: the same for two copies, whatever their mtimes or the user\'s global gitignore', async () => {
  const fx = makeFixture();
  const a = join(fx.tmp, 'one', 'ledger'), b = join(fx.tmp, 'two', 'ledger');
  fx.write(a, FILES);
  cpSync(a, b, { recursive: true });
  utimesSync(join(b, 'api/server.js'), 1_000_000, 1_000_000);
  // a HOME whose global excludes, attributes and config would hide every .js and convert line endings
  const home = join(fx.tmp, 'userhome');
  mkdirSync(join(home, '.config', 'git'), { recursive: true });
  writeFileSync(join(home, '.config', 'git', 'ignore'), '*.js\n');
  writeFileSync(join(home, '.config', 'git', 'attributes'), '* text\n');
  writeFileSync(join(home, '.gitconfig'), '[core]\n\texcludesFile = ~/.config/git/ignore\n\tautocrlf = true\n');
  const [realHome, realXdg] = [process.env.HOME, process.env.XDG_CONFIG_HOME];
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  try {
    const one = initWorkspace(join(fx.tmp, 'ws1'), { app: 'one', title: 'One' });
    const two = initWorkspace(join(fx.tmp, 'ws2'), { app: 'two', title: 'Two' });
    await addRepo(one, a, { name: 'ledger', ignore: ['data/'] });
    await addRepo(two, b, { name: 'ledger', ignore: ['data/'] });
    const [ta, tb] = [await treeNow(one, 'ledger'), await treeNow(two, 'ledger')];
    assert.equal(ta, tb);
    const shadow = { cwd: a, env: { ...process.env, GIT_DIR: join(fx.home, 'one', 'shadow', 'ledger.git') }, encoding: 'utf8' as const };
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', ta], shadow).trim().split('\n');
    assert.deepEqual(files.sort(), ['.env.example', '.gitignore', 'api/Dockerfile', 'api/server.js', 'docker-compose.yml', 'notes/crlf.txt'], 'no .env, node_modules or ignore:d data/; every .js kept');
    assert.equal(execFileSync('git', ['cat-file', '-p', `${ta}:notes/crlf.txt`], shadow), 'a\r\nb\r\n', 'the bytes as they are: no attributes of the user\'s');
    const envBlob = execFileSync('git', ['hash-object', '.env'], shadow).trim();
    assert.throws(() => execFileSync('git', ['cat-file', '-e', envBlob], { ...shadow, stdio: 'ignore' }), 'the .env the folder re-includes never reaches the shadow\'s objects');
  } finally { process.env.HOME = realHome; if (realXdg !== undefined) process.env.XDG_CONFIG_HOME = realXdg; }
});

test('nested repos and big files are left out and reported; a changed ignore rebuilds the index; concurrent hashes wait', async () => {
  const fx = makeFixture();
  const dir = join(fx.tmp, 'code', 'ledger');
  fx.write(dir, { ...FILES, 'tools/a.txt': 'a\n', 'vendor/lib/b.txt': 'b\n' });
  fx.sh(join(dir, 'tools'), 'init', '--quiet'); // no commit: `git add -A` would abort on it
  fx.sh(join(dir, 'vendor', 'lib'), 'init', '--quiet');
  fx.sh(join(dir, 'vendor', 'lib'), 'add', '-A');
  fx.sh(join(dir, 'vendor', 'lib'), 'commit', '--quiet', '-m', 'x');
  writeFileSync(join(dir, 'big.bin'), '');
  truncateSync(join(dir, 'big.bin'), 51 * 1024 * 1024);
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'shop', title: 'Shop' });
  await addRepo(ws, dir, { name: 'ledger' });
  const scan = await scanFolder(ws, 'ledger');
  assert.deepEqual(scan.nested, ['tools', 'vendor/lib']);
  assert.deepEqual(scan.skipped, ['big.bin']);
  const tree = (t: string) => execFileSync('git', ['ls-tree', '-r', '--name-only', t], { cwd: dir, env: { ...process.env, GIT_DIR: join(fx.home, 'shop', 'shadow', 'ledger.git') }, encoding: 'utf8' }).split('\n');
  assert.ok(tree(scan.tree).includes('data/dump.sql'));
  // the project's ignore: changes, the index is rebuilt and the newly ignored path leaves the tree
  writeFileSync(join(ws.root, 'laru.yaml'), readFileSync(join(ws.root, 'laru.yaml'), 'utf8').replace('source: folder', 'source: folder\n    ignore: [data/]'));
  const ws2 = loadWorkspace(ws.root);
  const after = await treeNow(ws2, 'ledger');
  assert.ok(!tree(after).includes('data/dump.sql'));
  const all = await Promise.all([1, 2, 3, 4].map(() => treeNow(ws2, 'ledger')));
  assert.deepEqual(new Set(all), new Set([after]), 'four at once: each waited its turn, none failed');
  // the folder's own .gitignore now ignores a file the index holds: the index is rebuilt and the file leaves the tree
  writeFileSync(join(dir, '.gitignore'), '!.env\napi/Dockerfile\n');
  assert.ok(!tree(await treeNow(ws2, 'ledger')).includes('api/Dockerfile'));
});

test('no Laru operation writes the folder: hash, map, impact, snapshot, image key and vars import', async () => {
  const fx = makeFixture();
  const dir = join(fx.tmp, 'code', 'ledger');
  fx.write(dir, FILES);
  const before = snapshotOf(dir);
  const marker = join(fx.tmp, 'marker');
  writeFileSync(marker, '');
  utimesSync(marker, Date.now() / 1000 + 1, Date.now() / 1000 + 1);
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'shop', title: 'Shop' });
  await addRepo(ws, dir, { name: 'ledger' });
  await refreshMap(ws);
  await changesFromWorktrees(ws);
  const at = await resolveEnvRef(ws, 'ledger', undefined);
  await assert.rejects(resolveEnvRef(ws, 'ledger', 'main'), /refs\.ledger: a folder has no branches or commits/);
  const snap = await snapshotRepo(ws, 'ledger', at);
  assert.ok(existsSync(join(snap.dir, 'api/server.js')) && !existsSync(join(snap.dir, '.env')), 'the snapshot is the folder now, without .env');
  assert.match(snap.dir, /ledger@[0-9a-f]{7}$/);
  const k1 = await contextKey(ws, snap, 'api', '');
  writeFileSync(join(dir, 'docker-compose.yml'), FILES['docker-compose.yml'] + '# a comment\n');
  const snap2 = await snapshotRepo(ws, 'ledger', await resolveEnvRef(ws, 'ledger', undefined));
  assert.equal(await contextKey(ws, snap2, 'api', ''), k1, 'a change outside the build context keeps the image key');
  writeFileSync(join(dir, 'docker-compose.yml'), FILES['docker-compose.yml']);
  const r = await importEnvFile(ws, 'ledger:.env.example');
  assert.equal(r.level, 'app');
  assert.deepEqual(r.imported.map((x) => x.key), ['LEDGER_URL', 'LEDGER_TOKEN']);
  assert.ok((await loadVault(ws)).some((e) => e.key === 'LEDGER_TOKEN' && e.secret));
  await assert.rejects(importEnvFile(ws, 'ledger:.env'), /\.env no está en lo que Laru lee de ledger \(se excluye por seguridad\)/);
  assert.ok(!existsSync(join(dir, '.git')));
  assert.equal(execFileSync('find', [dir, '-newer', marker], { encoding: 'utf8' }).trim().split('\n').filter((l) => l && !/docker-compose\.yml$/.test(l) && l !== dir).join('\n'), '', 'nothing newer than the marker but the file the test itself rewrote');
  assert.deepEqual(snapshotOf(dir).map((l) => l.split('@')[0]), before.map((l) => l.split('@')[0]), 'the same files');
});

test('a shadow\'s gc waits for a scan: no scan loses the objects it has just written', async () => {
  const fx = makeFixture();
  const dir = join(fx.tmp, 'code', 'ledger');
  fx.write(dir, FILES);
  const ws = initWorkspace(join(fx.tmp, 'ws'), { app: 'shop', title: 'Shop' });
  await addRepo(ws, dir, { name: 'ledger' });
  const w = loadWorkspace(ws.root);
  let stop = false;
  const gc = (async () => { while (!stop) await prune(w, { what: ['shadow'] }); })();
  try {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 20; j++) writeFileSync(join(dir, `gen-${i}-${j}.txt`), `round ${i} ${j}\n`);
      await scanFolder(w, 'ledger');
    }
  } finally { stop = true; await gc; }
  await scanFolder(w, 'ledger'); // nothing changed: a shadow whose index points at a pruned object fails here too
  // a tree handed out, then a scan of other content, then a gc: the first tree is still there for keepTree and a snapshot,
  // even when nothing changed for hours (write-tree does not rewrite a tree the shadow has)
  const shadow = join(fx.home, 'shop', 'shadow', 'ledger.git');
  const old = Date.now() / 1000 - 3 * 3600;
  const age = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) age(p); else utimesSync(p, old, old); } };
  age(join(shadow, 'objects'));
  const t1 = await treeNow(w, 'ledger');
  writeFileSync(join(dir, 'later.txt'), 'later\n');
  await scanFolder(w, 'ledger');
  await prune(w, { what: ['shadow'] });
  await keepTree(w, 'ledger', 'map', t1);
  assert.ok(execFileSync('git', ['--git-dir', shadow, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).includes(`refs/laru/${workspaceKey(w)}/map`), 'a ref per workspace: a twin sharing the shadow keeps its own');
});
