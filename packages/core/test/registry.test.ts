/** The workspaces a machine knows: concurrent writers, ids, and which workspace a command means from where it starts. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { byCwd, idOf, loadRegistry, realRoot, register, resolveId, resolveRoot, unregister, workspaceKey } from '../src/index.ts';

const run = promisify(execFile);
const INDEX = new URL('../src/index.ts', import.meta.url).href;

test('the registry: two processes writing at once lose nothing; ids; resolution in order 1 to 6', async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-registry-')));
  const saved = process.env.LARU_HOME;
  process.env.LARU_HOME = join(tmp, 'home');
  t.after(() => { if (saved === undefined) delete process.env.LARU_HOME; else process.env.LARU_HOME = saved; });

  await t.test('add and remove from two processes at once', async () => {
    const script = (fn: string) => `import { ${fn} } from ${JSON.stringify(INDEX)}; for (const r of JSON.parse(process.argv[1])) await ${fn}(r);`;
    const roots = (p: string) => Array.from({ length: 8 }, (_, i) => join(tmp, 'many', `${p}${i}`));
    const node = (fn: string, list: string[]) => run(process.execPath, ['--input-type=module', '-e', script(fn), JSON.stringify(list)], { env: process.env });
    await Promise.all([node('register', roots('a')), node('register', roots('b'))]);
    assert.equal(loadRegistry().length, 16);
    await Promise.all([node('unregister', roots('a').slice(0, 4)), node('unregister', roots('b').slice(0, 4))]);
    assert.deepEqual(loadRegistry().map((x) => x.root).sort(), [...roots('a').slice(4), ...roots('b').slice(4)].sort());
    for (const x of loadRegistry()) await unregister(x.root);
  });

  const mk = (dir: string, app: string) => { const r = join(tmp, dir); mkdirSync(r, { recursive: true }); writeFileSync(join(r, 'laru.yaml'), `app: ${app}\nrepos:\n  api: { source: folder }\n  web: { source: folder }\n`); return r; };
  const shopA = mk('shop-a', 'shop'), shopB = mk('shop-b', 'shop'), fin = mk('finanzas', 'finanzas');

  await t.test('ids: the app id, with a key for a later workspace that shares it; a missing root has none', async () => {
    assert.deepEqual(await register(shopA), { added: true });
    assert.deepEqual(await register(shopA), { added: false }, 'listed already: nothing written');
    symlinkSync(shopA, join(tmp, 'shop-link'));
    assert.deepEqual(await register(join(tmp, 'shop-link')), { added: false }, 'the same folder through a symlink is the same workspace');
    assert.deepEqual(await register(shopB), { added: true, twin: 'shop' });
    await register(fin);
    await register(join(tmp, 'gone'));
    assert.equal(idOf(fin), 'finanzas');
    assert.equal(idOf(shopA), 'shop', 'the first keeps its id: its links keep working');
    assert.equal(idOf(shopB), `shop~${workspaceKey({ root: shopB }).slice(0, 4)}`);
    assert.equal(resolveId(idOf(shopB)!), shopB);
    assert.equal(resolveRoot({ dir: join(tmp, 'shop-link', 'envs'), cwd: '/' }), shopA, 'one root, however it is reached');
    assert.equal(idOf(join(tmp, 'gone')), null, 'listed, shown as not found');
    assert.ok(loadRegistry().some((x) => x.root === join(tmp, 'gone')));
    // ids are kept: the newcomer's stays when the first goes, and the first's bare id is not handed to it
    const b = idOf(shopB);
    await unregister(join(tmp, 'shop-link'));
    assert.equal(idOf(shopB), b);
    assert.equal(resolveId('shop'), null, 'a tab still open on the first one finds it gone, not the other one');
    await register(shopA);
    assert.equal(idOf(shopA), 'shop', 'back on its own id');
    // a list written before ids were kept: the earliest takes the bare id, and the first write stores them
    const rows = loadRegistry().map(({ id: _id, ...x }) => x).sort((x, y) => Number(y.root === shopB) - Number(x.root === shopB));
    writeFileSync(join(tmp, 'home', 'workspaces.yaml'), stringify(rows));
    const legacy = ['shop', `shop~${workspaceKey({ root: shopA }).slice(0, 4)}`];
    assert.deepEqual([idOf(shopB), idOf(shopA)], legacy, 'shopB is listed first');
    await register(join(tmp, 'new'));
    assert.deepEqual(loadRegistry().filter((x) => x.root.includes('shop-')).map((x) => x.id), legacy);
    assert.match(readFileSync(join(tmp, 'home', 'workspaces.yaml'), 'utf8'), /id: shop\n[\s\S]*id: shop~/, 'kept in the file from the first write');
    // an app id that changes: a new id, never one another row holds, and a newcomer never takes a live one
    const p = mk('p', 'p'), q = mk('q', 'q');
    await register(p); await register(q);
    writeFileSync(join(p, 'laru.yaml'), 'app: x\n'); writeFileSync(join(q, 'laru.yaml'), 'app: x\n');
    assert.equal(idOf(p), 'x');
    assert.match(idOf(q)!, /^x~/);
    assert.equal(resolveId(idOf(q)!), q);
    const store = mk('store', 'store');
    writeFileSync(join(p, 'laru.yaml'), 'app: store\n');
    await register(store);
    assert.equal(idOf(p), 'store', 'p had it first');
    assert.match(idOf(store)!, /^store~/);
    // a folder that does not exist yet, reached through a symlink: under its real parent
    assert.equal(realRoot(join(tmp, 'shop-link', 'new', 'x')), join(shopA, 'new', 'x'));
  });

  await t.test('which workspace a command means', () => {
    // 1. -C: walking up from that folder
    assert.equal(resolveRoot({ dir: join(fin, 'docs', 'x'), cwd: '/' }), fin);
    // 2. --ws by id or by folder, before LARU_WORKSPACE (3.)
    assert.equal(resolveRoot({ ws: 'finanzas', env: idOf(shopB)!, cwd: '/' }), fin);
    assert.equal(resolveRoot({ ws: shopB, cwd: '/' }), shopB);
    assert.equal(resolveRoot({ env: 'finanzas', cwd: shopA }), fin);
    assert.throws(() => resolveRoot({ ws: 'nope', cwd: '/' }), /no workspace "nope"; known: .*finanzas \(/);
    // 4. a laru.yaml above the current folder
    assert.equal(resolveRoot({ cwd: join(shopA, 'envs') }), shopA);
    // 5. inside a project of exactly one registered workspace (its clone or folder, wherever it is)
    mkdirSync(join(tmp, 'home', 'finanzas'), { recursive: true });
    writeFileSync(join(tmp, 'home', 'finanzas', 'checkouts.yaml'), `api: ${join(tmp, 'code', 'finanzas-api')}\nold: ${join(tmp, 'code', 'removed')}\n`);
    mkdirSync(join(tmp, 'code', 'finanzas-api', 'src'), { recursive: true });
    assert.deepEqual(byCwd(join(tmp, 'code', 'finanzas-api', 'src')), [fin]);
    assert.equal(resolveRoot({ cwd: join(tmp, 'code', 'finanzas-api', 'src') }), fin);
    assert.deepEqual(byCwd(join(tmp, 'code', 'removed')), [], 'a project laru.yaml no longer names does not count');
    // two workspaces reading the same folder (both shop clones share ~/.laru/shop): an error naming both
    mkdirSync(join(tmp, 'home', 'shop'), { recursive: true });
    writeFileSync(join(tmp, 'home', 'shop', 'checkouts.yaml'), `web: ${join(tmp, 'code', 'shop-web')}\n`);
    mkdirSync(join(tmp, 'code', 'shop-web'), { recursive: true });
    assert.deepEqual(byCwd(join(tmp, 'code', 'shop-web')).sort(), [shopA, shopB].sort());
    assert.throws(() => resolveRoot({ cwd: join(tmp, 'code', 'shop-web') }), (e: Error) => e.message === `${join(tmp, 'code', 'shop-web')} is a project of several workspaces: ${byCwd(join(tmp, 'code', 'shop-web')).join(', ')}. Use --ws <id>`);
    // 6. nowhere: the known ones are listed
    assert.throws(() => resolveRoot({ cwd: join(tmp, 'code') }), /not inside a Laru workspace; known: .*finanzas \(.*\)\. Use --ws <id>/);
  });
});
