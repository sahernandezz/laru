/**
 * Storage in plain sight: where a workspace keeps each thing on this machine, how big it is, and what retention may
 * remove. Sizes are disk blocks, as `du` counts them, and a walk never follows a symlink. Nothing here touches a
 * project's repo or folder: runs, snapshots, images and shadow git dirs are Laru's own.
 */
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { appHome, appOf, laruHome, loadRegistry, loadWorkspace, shadowDir, stateDir, withLock, type Workspace } from '@laru/core';
import { readConfig, type Retention } from './config.ts';
import { docker, LABEL, sizeBytes } from './docker.ts';
import { envDir, listEnvs, readState } from './env.ts';
import { RESULTS, runnerFiles } from './runner-file.ts';
import { keyStore } from './vault.ts';

const memo = new Map<string, { at: number; bytes: number }>();
const blocks = (st: { blocks?: number; size: number }) => (st.blocks !== undefined ? st.blocks * 512 : st.size);

/** Bytes on disk under a path, symlinks counted as themselves; remembered 60 s per path (`skip`: a child left out). */
export function dirBytes(path: string, skip?: string): number {
  const key = `${path}\0${skip ?? ''}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.bytes;
  let bytes = 0;
  const walk = (p: string) => {
    if (p === skip) return;
    let st;
    try { st = lstatSync(p); } catch { return; }
    bytes += blocks(st);
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
  };
  walk(path);
  memo.set(key, { at: Date.now(), bytes });
  return bytes;
}
/** After a removal: sizes are read again. */
export const forgetSizes = () => memo.clear();

const runsOf = (ws: Pick<Workspace, 'root'>) => join(stateDir(ws), 'runs');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Files under `<base>/<sub>` whose name matches, with paths relative to `base`. */
const files = (base: string, sub: string, match: RegExp): Array<{ path: string; bytes: number }> => {
  const out: Array<{ path: string; bytes: number }> = [];
  const walk = (rel: string) => {
    const d = join(base, rel);
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) {
      const st = lstatSync(join(d, n));
      if (st.isDirectory()) walk(`${rel}/${n}`); else if (st.isFile() && match.test(n)) out.push({ path: `${rel}/${n}`, bytes: blocks(st) });
    }
  };
  walk(sub);
  return out;
};
const sum = (xs: Array<{ bytes: number }>) => xs.reduce((n, x) => n + x.bytes, 0);
/** The runner's raw video and screenshots, in out/results and out/results-<n>: what it left, not what a link of its points at. */
const rawMedia = (run: string): Array<{ path: string; bytes: number }> => {
  let outs: string[] = [];
  try { outs = readdirSync(join(run, 'out')).filter((n) => RESULTS.test(n)); } catch { /* no out/ */ }
  return outs.flatMap((n) => runnerFiles(run, `out/${n}`)).filter((p) => /\.(webm|png|zip)$/.test(p)).map((path) => ({ path, bytes: blocks(lstatSync(join(run, path))) }));
};

/** A run as retention sees it: its folder's size, the runner's raw media in out/ and the served media in flows/. */
export interface RunRow {
  id: string; env: string; status: string; startedAt: string; flows: number; running: boolean; bytes: number;
  /** out/results/**.webm|png, relative to the run's folder: the runner's own copies, never served */
  raw: Array<{ path: string; bytes: number }>;
  /** flows/<slug>/video.webm and s<n>.png: the evidence's video and screenshots */
  media: Array<{ path: string; bytes: number }>;
  results: Record<string, { status: string; cachedFrom?: string }>;
  pruned?: { at: string; what: string };
}

export function runRows(ws: Pick<Workspace, 'root'>): RunRow[] {
  const dir = runsOf(ws);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(a) - Number(b)).flatMap((id) => {
    const f = join(dir, id, 'run.json');
    if (!existsSync(f)) return [];
    let r;
    try { r = JSON.parse(readFileSync(f, 'utf8')); } catch { return []; }
    return [{
      id, env: r.env, status: r.status, startedAt: r.startedAt, flows: (r.flows ?? []).length, running: r.status === 'running' && alive(r.pid), bytes: dirBytes(join(dir, id)),
      raw: rawMedia(join(dir, id)), media: files(join(dir, id), 'flows', /^(video\.webm|s\d+\.png|trace(-\d+)?\.zip)$/),
      results: r.results ?? {}, ...(r.pruned ? { pruned: r.pruned } : {}),
    }];
  });
}

export interface PruneAction { run: string; what: 'raw' | 'media' | 'run'; bytes: number; paths: string[] }

/**
 * What retention removes, in order: the runner's raw media of finished runs; the video and screenshots of runs older
 * than `videoDays`; runs older than `runDays`; the oldest runs while the rest weighs more than `maxGB`. Kept whole: per
 * flow its last passed (or cached) and last failed run, every run a surviving result's `cachedFrom` points at, and
 * running runs. Pure: the same rows give the same plan, so a dry run lists exactly what an execution removes.
 */
export function planPrune(rows: RunRow[], index: Array<{ run: string; flow: string; status: string }>, policy: Retention, now: number): PruneAction[] {
  const keep = new Set<string>(rows.filter((r) => r.running).map((r) => r.id));
  const lastPass = new Map<string, string>(), lastFail = new Map<string, string>();
  for (const x of index) { if (x.status === 'passed' || x.status === 'cached') lastPass.set(x.flow, x.run); else if (x.status === 'failed') lastFail.set(x.flow, x.run); }
  for (const id of [...lastPass.values(), ...lastFail.values()]) keep.add(id);
  const days = (r: RunRow) => (now - Date.parse(r.startedAt)) / 86_400_000;
  const decide = () => {
    const media = new Set(rows.filter((r) => !keep.has(r.id) && !r.running && r.media.length && days(r) > policy.videoDays).map((r) => r.id));
    const gone = new Set(rows.filter((r) => !keep.has(r.id) && !r.running && days(r) > policy.runDays).map((r) => r.id));
    const left = (r: RunRow) => r.bytes - sum(r.raw) - (media.has(r.id) ? sum(r.media) : 0);
    let total = rows.filter((r) => !gone.has(r.id)).reduce((n, r) => n + left(r), 0);
    for (const r of [...rows].sort((x, y) => x.startedAt.localeCompare(y.startedAt))) {
      if (total <= policy.maxGB * 1e9) break;
      if (gone.has(r.id) || keep.has(r.id)) continue;
      gone.add(r.id);
      total -= left(r);
    }
    return { media, gone };
  };
  let plan = decide();
  // a result that survives keeps the run holding its evidence
  for (;;) {
    const before = keep.size;
    for (const r of rows) if (!plan.gone.has(r.id)) for (const x of Object.values(r.results)) if (x.cachedFrom) keep.add(x.cachedFrom);
    if (keep.size === before) break;
    plan = decide();
  }
  return [
    ...rows.filter((r) => !plan.gone.has(r.id) && !r.running && r.raw.length).map((r): PruneAction => ({ run: r.id, what: 'raw', bytes: sum(r.raw), paths: r.raw.map((x) => x.path) })),
    ...rows.filter((r) => !plan.gone.has(r.id) && plan.media.has(r.id)).map((r): PruneAction => ({ run: r.id, what: 'media', bytes: sum(r.media), paths: r.media.map((x) => x.path) })),
    ...rows.filter((r) => plan.gone.has(r.id)).map((r): PruneAction => ({ run: r.id, what: 'run', bytes: r.bytes, paths: ['.'] })),
  ];
}

/**
 * Removes what a plan names, only under the runs folder: an id that is not a number, a path that leaves its run, or a
 * run folder that resolves elsewhere (a symlink) is refused.
 */
export function applyPrune(ws: Pick<Workspace, 'root'>, actions: PruneAction[]): void {
  const base = realpathSync(runsOf(ws));
  for (const a of actions) {
    if (!/^\d+$/.test(a.run)) throw new Error(`refused: run id "${a.run}"`);
    const dir = join(base, a.run);
    if (!existsSync(dir)) continue;
    if (realpathSync(dir) !== dir) throw new Error(`refused: runs/${a.run} resolves outside ${base}`);
    if (a.what === 'run') { rmSync(dir, { recursive: true, force: true }); continue; }
    for (const p of a.paths) {
      const f = join(dir, p);
      if (!f.startsWith(dir + '/') || (existsSync(f) && realpathSync(f) !== f)) throw new Error(`refused: ${p} is not a file of run ${a.run}`);
      if (existsSync(f)) unlinkSync(f);
    }
    if (a.what === 'media') forgetMedia(dir);
  }
  forgetSizes();
}

/**
 * After a run's media went, nothing names it: each flow's traces lose `video` and their steps' `screenshot` (the player
 * would load a missing file), run.json's results lose `video`, and run.json says when and what was pruned. A file that
 * is not JSON, or not in its place, is left as it is.
 */
function forgetMedia(dir: string): void {
  const rewrite = (f: string, change: (v: any) => any) => {
    if (!existsSync(f) || realpathSync(f) !== f) return;
    let v;
    try { v = JSON.parse(readFileSync(f, 'utf8')); } catch { return; }
    writeFileSync(f, change(v));
  };
  const bare = ({ video: _v, pwTrace: _p, ...t }: any) => ({ ...t, ...(Array.isArray(t.steps) ? { steps: t.steps.map(({ screenshot: _s, ...st }: any) => st) } : {}) });
  const flows = join(dir, 'flows');
  for (const slug of existsSync(flows) ? readdirSync(flows) : []) {
    rewrite(join(flows, slug, 'trace.json'), (t) => JSON.stringify(bare(t)));
    rewrite(join(flows, slug, 'cases.json'), (ts) => JSON.stringify(Array.isArray(ts) ? ts.map(bare) : ts));
  }
  rewrite(join(dir, 'run.json'), (r) => JSON.stringify({
    ...r, results: Object.fromEntries(Object.entries(r.results ?? {}).map(([k, { video: _v, ...x }]: [string, any]) => [k, x])), pruned: { at: new Date().toISOString(), what: 'media' },
  }, null, 2));
}

const indexOf = (ws: Pick<Workspace, 'root'>) => {
  const f = join(runsOf(ws), 'index.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
};

export type PruneWhat = 'runs' | 'snapshots' | 'images' | 'shadow';
export interface PruneReport {
  runs: PruneAction[];
  snapshots: Array<{ path: string; bytes: number }>;
  images: Array<{ ref: string; bytes: number }>;
  shadow: string[];
  bytes: number;
}

/** Snapshot folders: what each is (a commit, a folder's content, a working copy) and which envs started from it. */
export function snapshotRows(ws: Workspace): Array<{ id: string; repo: string; path: string; kind: 'commit' | 'folder' | 'worktree'; bytes: number; usedBy: string[]; mtime: number }> {
  const base = join(appHome(ws.app), 'snapshots');
  if (!existsSync(base)) return [];
  const used = usedSnapshots(ws);
  return readdirSync(base).filter((d) => d.includes('@')).map((id) => {
    const repo = id.slice(0, id.indexOf('@')), path = join(base, id);
    const kind = id.includes('@wt-') ? 'worktree' as const : ws.repos.find((r) => r.name === repo)?.source === 'folder' ? 'folder' as const : 'commit' as const;
    return { id, repo, path, kind, bytes: dirBytes(path), usedBy: used.get(id) ?? [], mtime: statSync(path).mtimeMs };
  });
}

/** `<repo>@<id>` → the envs that started from it, in every registered workspace of this app (they share snapshots). */
function usedSnapshots(ws: Workspace): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const roots = [...new Set([ws.root, ...loadRegistry().map((x) => x.root).filter((r) => appOf(r) === ws.app)])];
  for (const root of roots) {
    let w: Workspace;
    try { w = root === ws.root ? ws : loadWorkspace(root); } catch { continue; }
    for (const env of listEnvs(w)) {
      const st = readState(w, env);
      for (const s of st?.sources ?? (st?.source ? [st.source] : [])) (out.get(s) ?? out.set(s, []).get(s)!).push(root === ws.root ? env : `${env} (${root})`);
    }
  }
  return out;
}

export interface ImageRow { Repository: string; Tag: string; ID: string; CreatedAt: string; Size: string }
const imageRows = async (app: string): Promise<ImageRow[]> => (await docker(['image', 'ls', '--filter', `label=${LABEL.app}=${app}`, '--format', '{{json .}}'])).split('\n').filter(Boolean).map((l) => JSON.parse(l));

/**
 * Images beyond the 3 newest of each service, skipping any a container (running or not) uses: `inUse` is each
 * container's image as it was named (repo:tag), or its id when it was created from one.
 */
export function staleImages(rows: ImageRow[], inUse: string[]): Array<{ ref: string; bytes: number }> {
  const byRepo = new Map<string, ImageRow[]>();
  for (const r of rows) (byRepo.get(r.Repository) ?? byRepo.set(r.Repository, []).get(r.Repository)!).push(r);
  return [...byRepo.values()].flatMap((list) => list.sort((a, b) => b.CreatedAt.localeCompare(a.CreatedAt)).slice(3))
    .filter((r) => !inUse.includes(`${r.Repository}:${r.Tag}`) && !inUse.some((u) => u.replace(/^sha256:/, '').startsWith(r.ID)))
    .map((r) => ({ ref: `${r.Repository}:${r.Tag}`, bytes: sizeBytes(r.Size) }));
}
const oldImages = async (app: string) => staleImages(await imageRows(app), (await docker(['ps', '-a', '--format', '{{.Image}}'])).split('\n').filter(Boolean));

const run = promisify(execFile);

/**
 * Retention and cleanup. `runs` as planPrune says; `snapshots`: commit and folder snapshots no env of any registered
 * workspace of this app started from, keeping the 2 newest per project (working copies: the last 3); `images`: see
 * oldImages, removed by tag without -f; `shadow`: `git gc` in each folder project's shadow. A dry run returns the
 * same report without removing anything.
 */
export async function prune(ws: Workspace, o: { dryRun?: boolean; what?: PruneWhat[] } = {}): Promise<PruneReport> {
  const what = new Set<PruneWhat>(o.what?.length ? o.what : ['runs', 'snapshots', 'images', 'shadow']);
  const report: PruneReport = { runs: [], snapshots: [], images: [], shadow: [], bytes: 0 };
  if (what.has('runs') && existsSync(runsOf(ws))) {
    report.runs = planPrune(runRows(ws), indexOf(ws), readConfig().retention, Date.now());
    if (!o.dryRun) {
      applyPrune(ws, report.runs);
      writeFileSync(join(runsOf(ws), 'prune.json'), JSON.stringify({ at: new Date().toISOString(), removed: { media: report.runs.filter((a) => a.what !== 'run').length, runs: report.runs.filter((a) => a.what === 'run').length, bytes: sum(report.runs) } }, null, 2));
    }
  }
  if (what.has('snapshots')) {
    const rows = snapshotRows(ws);
    for (const repo of new Set(rows.map((r) => r.repo))) {
      for (const [kind, n] of [['worktree', 3], ['commit', 2], ['folder', 2]] as const) {
        const mine = rows.filter((r) => r.repo === repo && r.kind === kind).sort((a, b) => b.mtime - a.mtime);
        report.snapshots.push(...mine.slice(n).filter((r) => !r.usedBy.length).map((r) => ({ path: r.path, bytes: r.bytes })));
      }
    }
    if (!o.dryRun) for (const s of report.snapshots) rmSync(s.path, { recursive: true, force: true });
  }
  if (what.has('images')) {
    report.images = await oldImages(ws.app).catch(() => []);
    if (!o.dryRun) for (const i of report.images) await docker(['image', 'rm', i.ref]).catch(() => undefined);
  }
  if (what.has('shadow')) {
    report.shadow = ws.repos.filter((r) => r.source === 'folder' && existsSync(shadowDir(ws, r.name))).map((r) => shadowDir(ws, r.name));
    // A scan's objects are referenced only by the shadow's index until the next scan replaces it, and a tree it handed
    // out may still be on its way to a ref or a snapshot: gc keeps whatever was written in the last hour (git freshens
    // an object written again), under the shadow's own lock.
    if (!o.dryRun) for (const s of report.shadow) await withLock(`gc ${s}`, () => run('git', ['--git-dir', s, 'gc', '--prune=1.hour.ago', '--quiet'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }), undefined, `${s}.lock`).catch(() => undefined);
  }
  if (!o.dryRun) forgetSizes();
  report.bytes = sum(report.runs) + sum(report.snapshots) + sum(report.images);
  return report;
}

/** What `laru where`, «Archivos locales» and MCP `where` show: every place, its absolute path and its size. */
export async function diskReport(ws: Workspace) {
  const state = stateDir(ws), runs = runsOf(ws), policy = readConfig().retention;
  const rows = runRows(ws);
  const last = existsSync(join(runs, 'prune.json')) ? JSON.parse(readFileSync(join(runs, 'prune.json'), 'utf8')) : undefined;
  const images = await imageRows(ws.app).then(async (list) => ({ count: list.length, bytes: list.reduce((n, r) => n + sizeBytes(r.Size), 0), old: (await oldImages(ws.app)).length })).catch(() => null);
  const managed = join(appHome(ws.app), 'repos');
  return {
    workspace: { path: ws.root, bytes: dirBytes(ws.root, state) },
    state: { path: state, bytes: dirBytes(state) },
    projects: ws.repos.map((r) => {
      const path = ws.checkouts[r.name] ?? null;
      const there = Boolean(path && existsSync(path));
      return { name: r.name, source: r.source, path, managed: Boolean(path?.startsWith(managed + '/')), bytes: there ? dirBytes(path!) : 0, ...(there ? {} : { problem: path ? 'missing' : 'not cloned' }) };
    }),
    snapshots: snapshotRows(ws).map(({ mtime: _m, ...s }) => s),
    runs: {
      path: runs, count: rows.length, bytes: existsSync(runs) ? dirBytes(runs) : 0,
      videoBytes: rows.reduce((n, r) => n + sum(r.media.filter((m) => m.path.endsWith('.webm'))) + sum(r.raw.filter((m) => m.path.endsWith('.webm'))), 0),
      rawBytes: rows.reduce((n, r) => n + sum(r.raw), 0),
      policy, ...(last ? { lastPrune: last } : {}),
      rows: rows.reverse().map((r) => ({ id: r.id, startedAt: r.startedAt, env: r.env, status: r.status, flows: r.flows, bytes: r.bytes, videoBytes: sum(r.media.filter((m) => m.path.endsWith('.webm'))), rawBytes: sum(r.raw), path: join(runs, r.id), ...(r.pruned ? { pruned: r.pruned } : {}) })),
    },
    envs: listEnvs(ws).map((env) => {
      const dir = envDir(ws, env), traffic = ['traffic.jsonl', 'traffic.jsonl.1'].map((f) => join(dir, 'tap', f)).filter(existsSync).reduce((n, f) => n + blocks(statSync(f)), 0);
      return { env, path: dir, bytes: existsSync(dir) ? dirBytes(dir) : 0, trafficBytes: traffic };
    }),
    personal: { path: appHome(ws.app), files: existsSync(appHome(ws.app)) ? readdirSync(appHome(ws.app)).sort() : [] },
    vaultKey: { store: keyStore(), service: 'laru-vault', account: ws.app },
    machine: { path: laruHome(), files: existsSync(laruHome()) ? readdirSync(laruHome()).filter((f) => !f.startsWith('.')).sort() : [] },
    images,
  };
}
export type DiskReport = Awaited<ReturnType<typeof diskReport>>;

/** Docker's own sizes for this app's volumes and images (`docker system df -v`: seconds, so only on demand). */
export async function dockerSizes(app: string): Promise<{ volumes: Array<{ name: string; bytes: number }>; imagesBytes: number }> {
  const df = JSON.parse(await docker(['system', 'df', '-v', '--format', 'json'], { timeoutMs: 120_000 })) as { Images?: Array<{ Repository: string; Size: string; SharedSize: string; UniqueSize: string }>; Volumes?: Array<{ Name: string; Size: string }> };
  const mine = (df.Images ?? []).filter((i) => i.Repository.startsWith(`ks-${app}/`));
  // Known limit: shared layers counted once as the largest shared part plus each image's own; exact needs per-layer ids
  const shared = Math.max(0, ...mine.map((i) => sizeBytes(i.SharedSize)));
  return {
    volumes: (df.Volumes ?? []).filter((v) => v.Name.startsWith(`ks-${app}`)).map((v) => ({ name: v.Name, bytes: sizeBytes(v.Size) })),
    imagesBytes: shared + mine.reduce((n, i) => n + sizeBytes(i.UniqueSize), 0),
  };
}
