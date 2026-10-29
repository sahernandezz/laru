/** Storage in plain sight: sizes, the retention plan and its execution, the machine's config file. No Docker. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { Workspace } from '@laru/core';
import { applyPrune, CONFIG_DEFAULTS, dirBytes, planPrune, prune, readConfig, runRows, staleImages, writeConfig, type RunRow } from '../src/index.ts';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const row = (id: string, days: number, o: Partial<RunRow> = {}): RunRow => ({ id, env: 'local', status: 'passed', startedAt: ago(days), flows: 1, running: false, bytes: 1000, raw: [], media: [], results: {}, ...o });
const POLICY = CONFIG_DEFAULTS.retention;
const ids = (plan: ReturnType<typeof planPrune>, what: string) => plan.filter((a) => a.what === what).map((a) => a.run);

test('retention keeps the last passed and the last failed run of each flow, and every run a kept result was cached from', () => {
  const rows = [
    row('1', 40), row('2', 40, { status: 'failed' }), row('3', 40), row('4', 35, { results: { a: { status: 'cached', cachedFrom: '1' } } }),
    row('5', 40, { results: { b: { status: 'passed' } } }), row('6', 41, { results: { b: { status: 'failed' } } }),
  ];
  const index = [
    { run: '1', flow: 'a', status: 'passed' }, { run: '2', flow: 'a', status: 'failed' }, { run: '3', flow: 'a', status: 'passed' }, { run: '4', flow: 'a', status: 'cached' },
    { run: '6', flow: 'b', status: 'failed' }, { run: '5', flow: 'b', status: 'passed' },
  ];
  // 4 is a's last pass (cached), so 1 stays for its evidence; 2 is a's last failure; 3 was superseded; b keeps 5 and 6.
  assert.deepEqual(ids(planPrune(rows, index, POLICY, NOW), 'run'), ['3']);
});

test('retention removes in order: raw runner media, media past videoDays, runs past runDays, then the oldest while over the cap', () => {
  const raw = [{ path: 'out/results/a/video.webm', bytes: 100 }];
  const media = [{ path: 'flows/a/video.webm', bytes: 200 }, { path: 'flows/a/s2.png', bytes: 10 }];
  const rows = [
    row('1', 2, { raw, media }), row('2', 10, { raw, media }), row('3', 40, { raw, media }),
    row('4', 1, { raw, running: true }), row('5', 1),
  ];
  const plan = planPrune(rows, [], POLICY, NOW);
  assert.deepEqual(plan.map((a) => `${a.what}:${a.run}`), ['raw:1', 'raw:2', 'media:2', 'run:3'], 'a running run is untouched; a run that goes takes its raw media with it');
  assert.deepEqual(plan.find((a) => a.what === 'media')!.paths, ['flows/a/video.webm', 'flows/a/s2.png']);
  // the cap: every run weighs 1000 bytes, the raw and media of run 2 go first, then the oldest until 2500 bytes are left
  // a running run is never touched, however old and whatever the cap
  assert.deepEqual(planPrune([row('11', 40, { raw, media, running: true })], [], { ...POLICY, maxGB: 0 }, NOW), []);
  const capped = planPrune([row('7', 3), row('8', 2), row('9', 1), row('10', 0.5)], [{ run: '7', flow: 'x', status: 'passed' }], { ...POLICY, maxGB: 2500 / 1e9 }, NOW);
  assert.deepEqual(ids(capped, 'run'), ['8', '9'], '7 is x\'s last pass: kept; the oldest of the rest go until under the cap');
});

test('prune: a dry run lists exactly what an execution removes; paths outside a run are refused; sizes never follow a symlink', async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-disk-')));
  const saved = process.env.LARU_HOME;
  process.env.LARU_HOME = join(tmp, 'home');
  t.after(() => { if (saved === undefined) delete process.env.LARU_HOME; else process.env.LARU_HOME = saved; });
  const ws = { root: join(tmp, 'ws'), app: 'shop', repos: [{ name: 'api', source: 'git' }], checkouts: {} } as unknown as Workspace;
  const runs = join(ws.root, '.laru', 'runs');
  const put = (p: string, bytes = 4096) => { mkdirSync(dirname(join(runs, p)), { recursive: true }); writeFileSync(join(runs, p), Buffer.alloc(bytes, 1)); };
  const run = (id: string, days: number, status = 'passed') => {
    put(`${id}/run.json`, 0);
    writeFileSync(join(runs, id, 'run.json'), JSON.stringify({ id, env: 'local', flows: ['a'], status, startedAt: new Date(Date.now() - days * 86_400_000).toISOString(), pid: 1, results: { a: { status, trace: 'flows/a/trace.json', video: 'flows/a/video.webm' } } }));
    put(`${id}/flows/a/trace.json`); put(`${id}/flows/a/video.webm`, 64 * 1024); put(`${id}/flows/a/s1.png`);
    writeFileSync(join(runs, id, 'flows', 'a', 'trace.json'), JSON.stringify({ test: 'historia', video: 'video.webm', steps: [{ n: 1, title: 'Abrir', screenshot: 's1.png' }, { n: 2, title: 'Pagar' }] }));
    writeFileSync(join(runs, id, 'flows', 'a', 'cases.json'), JSON.stringify([{ test: 'caso', steps: [{ n: 1, screenshot: 's1.png' }] }]));
    put(`${id}/out/results/case/video.webm`, 64 * 1024); put(`${id}/out/results/case/s1.png`); put(`${id}/out/events.jsonl`);
  };
  run('1', 40); run('2', 10); run('3', 2, 'failed'); run('4', 1);
  writeFileSync(join(runs, 'index.jsonl'), ['1', '2', '4'].map((r) => JSON.stringify({ run: r, flow: 'a', status: 'passed' })).concat(JSON.stringify({ run: '3', flow: 'a', status: 'failed' })).join('\n') + '\n');

  const dry = await prune(ws, { dryRun: true, what: ['runs'] });
  assert.deepEqual(dry.runs.map((a) => `${a.what}:${a.run}`), ['raw:2', 'raw:3', 'raw:4', 'media:2', 'run:1']);
  assert.ok(existsSync(join(runs, '1')) && existsSync(join(runs, '2', 'out', 'results', 'case', 'video.webm')), 'a dry run removes nothing');
  const done = await prune(ws, { what: ['runs'] });
  assert.deepEqual(done.runs, dry.runs, 'the same plan, executed');
  assert.ok(!existsSync(join(runs, '1')));
  for (const id of ['2', '3', '4']) assert.ok(!existsSync(join(runs, id, 'out', 'results', 'case', 'video.webm')) && existsSync(join(runs, id, 'out', 'events.jsonl')) && existsSync(join(runs, id, 'flows', 'a', 'trace.json')));
  assert.ok(!existsSync(join(runs, '2', 'flows', 'a', 'video.webm')) && existsSync(join(runs, '4', 'flows', 'a', 'video.webm')));
  const pruned = JSON.parse(readFileSync(join(runs, '2', 'run.json'), 'utf8'));
  assert.deepEqual([pruned.pruned.what, pruned.results.a], ['media', { status: 'passed', trace: 'flows/a/trace.json' }]);
  // the player reads the trace: once the media is gone it names no video and no screenshot (a kept run still does)
  const trace = (id: string, f = 'trace.json') => JSON.parse(readFileSync(join(runs, id, 'flows', 'a', f), 'utf8'));
  assert.deepEqual(trace('2'), { test: 'historia', steps: [{ n: 1, title: 'Abrir' }, { n: 2, title: 'Pagar' }] });
  assert.deepEqual(trace('2', 'cases.json'), [{ test: 'caso', steps: [{ n: 1 }] }]);
  assert.equal(trace('4').video, 'video.webm');
  assert.deepEqual(JSON.parse(readFileSync(join(runs, 'prune.json'), 'utf8')).removed.runs, 1);
  assert.deepEqual(runRows(ws).map((r) => r.id), ['2', '3', '4'], 'index.jsonl keeps its rows; the folders are what went');

  // Snapshots: the 2 newest commits of each project stay, and any an env started from, however old.
  const snaps = join(tmp, 'home', 'shop', 'snapshots');
  ['other@c0', 'api@c1', 'api@c2', 'api@c3', 'api@c4'].forEach((id, i) => { mkdirSync(join(snaps, id), { recursive: true }); utimesSync(join(snaps, id), 1e9 + i * 1000, 1e9 + i * 1000); });
  mkdirSync(join(ws.root, 'envs'), { recursive: true });
  writeFileSync(join(ws.root, 'envs', 'local.yaml'), 'from: api:docker-compose.yml\n');
  mkdirSync(join(ws.root, '.laru', 'envs', 'local'), { recursive: true });
  writeFileSync(join(ws.root, '.laru', 'envs', 'local', 'state.json'), JSON.stringify({ subnet: 1, entrance: 0, ports: {}, sources: ['api@c1'] }));
  assert.deepEqual((await prune(ws, { dryRun: true, what: ['snapshots'] })).snapshots.map((x) => x.path), [join(snaps, 'api@c2')]);
  await prune(ws, { what: ['snapshots'] });
  assert.deepEqual(readdirSync(snaps).sort(), ['api@c1', 'api@c3', 'api@c4', 'other@c0'], 'a removed project\'s are trimmed the same way: its 2 newest stay');

  // Refused: an id that is not a number, a path that leaves its run, a run folder that is a symlink to elsewhere.
  const outside = join(tmp, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'x');
  symlinkSync(outside, join(runs, '9'));
  assert.throws(() => applyPrune(ws, [{ run: '../x', what: 'run', bytes: 0, paths: ['.'] }]), /refused/);
  assert.throws(() => applyPrune(ws, [{ run: '9', what: 'run', bytes: 0, paths: ['.'] }]), /refused/);
  assert.throws(() => applyPrune(ws, [{ run: '4', what: 'raw', bytes: 0, paths: ['../../outside/keep.txt'] }]), /refused/);
  assert.ok(existsSync(join(outside, 'keep.txt')));

  // dirBytes counts a symlink as itself: the 1 MB behind it is not added, and a link to a parent does not loop.
  const d = join(tmp, 'sized');
  mkdirSync(d);
  writeFileSync(join(d, 'own.bin'), Buffer.alloc(100 * 1024, 1));
  writeFileSync(join(tmp, 'big.bin'), Buffer.alloc(1024 * 1024, 1));
  symlinkSync(join(tmp, 'big.bin'), join(d, 'link.bin'));
  symlinkSync(tmp, join(d, 'up'));
  const n = dirBytes(d);
  assert.ok(n >= 100 * 1024 && n < 300 * 1024, `${n}`);
});

test('images: beyond the 3 newest of each service, never one a container uses, by tag or by id', () => {
  const img = (tag: string, day: number, repo = 'ks-shop-api') => ({ Repository: repo, Tag: tag, ID: `${tag}0000000000`.slice(0, 12), CreatedAt: `2026-10-${String(day).padStart(2, '0')} 10:00:00 -0500 -05`, Size: '10MB' });
  const rows = [img('t1', 1), img('t2', 2), img('t3', 3), img('t4', 4), img('t5', 5), img('t6', 6), img('w1', 1, 'ks-shop-web')];
  // t6, t5, t4 are the newest; t3 runs by its tag, t2 by its id; t1 goes; the web has one image
  assert.deepEqual(staleImages(rows, ['ks-shop-api:t3', `sha256:${img('t2', 2).ID}ffffffffffff`, 'postgres:16']), [{ ref: 'ks-shop-api:t1', bytes: 10_000_000 }]);
  assert.deepEqual(staleImages(rows, []).map((x) => x.ref), ['ks-shop-api:t3', 'ks-shop-api:t2', 'ks-shop-api:t1']);
});

test('config.yaml: defaults when absent; a write keeps the other keys and the comments', (t) => {
  const saved = process.env.LARU_HOME;
  process.env.LARU_HOME = mkdtempSync(join(tmpdir(), 'laru-config-'));
  t.after(() => { if (saved === undefined) delete process.env.LARU_HOME; else process.env.LARU_HOME = saved; });
  assert.deepEqual(readConfig(), { maxEnvs: 0, videoOffsetMs: 0, retention: { videoDays: 7, runDays: 30, maxGB: 5 }, workers: 0, stepHoldMs: 0, mask: false });
  writeFileSync(join(process.env.LARU_HOME, 'config.yaml'), 'stepHoldMs: -5\n');
  assert.equal(readConfig().stepHoldMs, 0, 'a negative hold is no hold');
  writeFileSync(join(process.env.LARU_HOME, 'config.yaml'), 'stepHoldMs: 1500\n');
  assert.equal(readConfig().stepHoldMs, 1500);
  writeFileSync(join(process.env.LARU_HOME, 'config.yaml'), '# measured by laru calibrate\nvideoOffsetMs: -10\n');
  writeConfig({ maxEnvs: 2 });
  writeConfig({ retention: { videoDays: 3 } });
  const text = readFileSync(join(process.env.LARU_HOME, 'config.yaml'), 'utf8');
  assert.match(text, /^# measured by laru calibrate\nvideoOffsetMs: -10\nmaxEnvs: 2\nretention:\n  videoDays: 3\n$/);
  assert.deepEqual(readConfig(), { maxEnvs: 2, videoOffsetMs: -10, retention: { videoDays: 3, runDays: 30, maxGB: 5 }, workers: 0, stepHoldMs: 0, mask: false });
});

test('retention counts the raw media the runner left, in out/results and out/results-<n>, and nothing a link of the runner points at', async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-disk-raw-')));
  const saved = process.env.LARU_HOME;
  process.env.LARU_HOME = join(tmp, 'home');
  t.after(() => { if (saved === undefined) delete process.env.LARU_HOME; else process.env.LARU_HOME = saved; });
  const ws = { root: join(tmp, 'ws'), app: 'shop', repos: [], checkouts: {} } as unknown as Workspace;
  const run = join(ws.root, '.laru', 'runs', '1');
  const put = (p: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.alloc(4096, 1)); };
  writeFileSync(join(tmp, 'x'), '');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'run.json'), JSON.stringify({ id: '1', env: 'local', flows: ['a'], status: 'passed', startedAt: new Date().toISOString(), pid: 1, results: {} }));
  put(join(run, 'out', 'results-1', 'case', 'video.webm')); put(join(run, 'out', 'results-2', 's.png')); put(join(run, 'out', 'results-1', 'notes.txt'));
  const home = join(tmp, 'home-folder');
  put(join(home, 'photo.png'));
  symlinkSync(home, join(run, 'out', 'results'));
  symlinkSync(join(home, 'photo.png'), join(run, 'out', 'results-3'));

  assert.deepEqual(runRows(ws)[0].raw.map((x) => x.path).sort(), ['out/results-1/case/video.webm', 'out/results-2/s.png'], 'the parallel runners\' folders, and not the folder behind the link');
  await prune(ws, { what: ['runs'] });
  assert.ok(existsSync(join(home, 'photo.png')), 'what the link pointed at is untouched, and the prune did not stop for it');
  assert.ok(!existsSync(join(run, 'out', 'results-1', 'case', 'video.webm')) && !existsSync(join(run, 'out', 'results-2', 's.png')), 'the real raw media went');
  assert.ok(existsSync(join(run, 'out', 'results-1', 'notes.txt')), 'only video and screenshots');
});
