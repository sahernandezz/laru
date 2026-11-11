/**
 * Storage in plain sight: where a workspace keeps each thing on this machine, how big it is, and what retention may
 * remove. Sizes are disk blocks, as `du` counts them, and a walk never follows a symlink. Nothing here touches a
 * project's repo or folder: runs, snapshots, images and shadow git dirs are Laru's own.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { promisify } from 'node:util';
import { appHome, appOf, laruHome, loadRegistry, loadWorkspace, shadowDir, stateDir, withLock, type Workspace } from '@laru/core';
import { readConfig, type Retention } from './config.ts';
import { docker, DOCKER_READ, LABEL, sizeBytes } from './docker.ts';
import { RUNNER_IMAGE } from './runs.ts';
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
  /** flows/<slug>/video.webm, replay.json|mp4 and s<n>.png: the evidence's video, its rrweb recording and screenshots */
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
      raw: rawMedia(join(dir, id)), media: files(join(dir, id), 'flows', /^(video\.webm|replay\.(json|mp4)|s\d+\.png|trace(-\d+)?\.zip)$/),
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
  const bare = ({ video: _v, pwTrace: _p, replay: _r, ...t }: any) => ({ ...t, ...(Array.isArray(t.steps) ? { steps: t.steps.map(({ screenshot: _s, ...st }: any) => st) } : {}) });
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

/** Unused snapshots kept per project, the newest first: of a commit, of a folder, of a working copy. */
export const SNAPSHOTS_KEPT = { worktree: 3, commit: 2, folder: 2 };
/** How often the service cleans Docker by itself, and the least time between two cleanups started by ups and runs. */
export const CLEANUP_EVERY_MS = 6 * 3600_000, CLEANUP_GAP_MS = 120_000;

export type PruneWhat = 'runs' | 'snapshots' | 'images' | 'shadow';
export interface PruneReport {
  runs: PruneAction[];
  snapshots: Array<{ path: string; bytes: number }>;
  images: Array<{ ref: string; bytes: number }>;
  volumes: string[];
  /** Docker's build cache: the cap applied (gb 0: left alone), and why it could not be trimmed */
  buildCache?: { gb: number; trimmed: boolean; before?: number; after?: number; error?: string };
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
 * Laru's images no container (running or not) uses: of an app with a workspace on this machine, all but the newest of
 * each service (an env that is down comes back without a build); of an app without one (a test's, a deleted
 * workspace's), all; and the runner of an older Playwright or of the old name. `inUse` is each container's image as
 * it was named (repo:tag), or its id when it was created from one.
 */
export function staleImages(rows: ImageRow[], inUse: string[], known?: Set<string>): Array<{ ref: string; bytes: number }> {
  const byRepo = new Map<string, ImageRow[]>();
  for (const r of rows) (byRepo.get(r.Repository) ?? byRepo.set(r.Repository, []).get(r.Repository)!).push(r);
  const keep = (repo: string) => (/^(laru|keelson)\/runner$/.test(repo) ? 0 : !known || known.has(repo.slice(3, repo.indexOf('/'))) ? 1 : 0);
  return [...byRepo.entries()].flatMap(([repo, list]) => list.sort((a, b) => b.CreatedAt.localeCompare(a.CreatedAt)).slice(keep(repo)))
    .filter((r) => `${r.Repository}:${r.Tag}` !== RUNNER_IMAGE)
    .filter((r) => !inUse.includes(`${r.Repository}:${r.Tag}`) && !inUse.some((u) => u.replace(/^sha256:/, '').startsWith(r.ID)))
    .map((r) => ({ ref: `${r.Repository}:${r.Tag}`, bytes: sizeBytes(r.Size) }));
}
/** the apps of the workspaces registered on this machine, and this one's */
/**
 * The apps of the workspaces registered in this Laru home and in the machine's own (~/.laru, or the older ~/.keelson):
 * a Laru run with another LARU_HOME (a test bench, a test) knows only its own workspaces, and would take the machine's
 * apps for leftovers.
 */
const knownApps = (app: string) => {
  const machine = [join(homedir(), '.laru'), join(homedir(), '.keelson')].flatMap((h) => { // legacy-name
    try { return (parse(readFileSync(join(h, 'workspaces.yaml'), 'utf8')) as Array<{ root?: unknown }>).map((x) => String(x?.root ?? '')); } catch { return []; }
  });
  return new Set([app, ...[...loadRegistry().map((x) => x.root), ...machine].map((r) => appOf(r)).filter((a): a is string => Boolean(a))]);
};
const oldImages = async (app: string) => {
  const rows = (await docker(['image', 'ls', '--format', '{{json .}}'])).split('\n').filter(Boolean).map((l) => JSON.parse(l) as ImageRow)
    .filter((r) => /^ks-[^/]+\//.test(r.Repository) || /^(laru|keelson)\/runner$/.test(r.Repository));
  return staleImages(rows, (await docker(['ps', '-a', '--format', '{{.Image}}'])).split('\n').filter(Boolean), knownApps(app));
};
/**
 * Docker's build cache down to `gb` (0: left alone), measured before and after: Docker's own answer is not trusted.
 * Each build of a project's Dockerfile leaves its layers (an `npm ci` per change of the code) and Docker does not trim
 * them on its own. First the least recently used go (`--max-used-space`; `--keep-storage` on an older Docker); a Docker
 * that leaves it above the cap anyway (the containerd image store ignores those limits) loses all the cache no build is
 * using: the next build of each image starts from scratch, nothing else is lost (an image keeps its own layers).
 */
async function trimBuildCache(gb: number): Promise<{ before: number; after: number }> {
  const cap = gb * 1e9, before = await buildCacheBytes();
  if (before <= cap) return { before, after: before };
  const args = ['builder', 'prune', '--all', '--force'], o = { timeoutMs: 600_000 }; // a hung Docker never holds the cleanup
  await docker([...args, '--max-used-space', `${gb}gb`], o).catch((e: Error) => {
    if (!/unknown flag/i.test(e.message)) throw e;
    return docker([...args, '--keep-storage', `${gb}gb`], o);
  });
  if (await buildCacheBytes() > cap) await docker(args, o);
  return { before, after: await buildCacheBytes() };
}
/**
 * Docker's cleanup in a detached process (clean-docker.ts): it outlives the command that started it and never holds it.
 * `LARU_DOCKER_CLEANUP=0` turns it off (the test suite does: its fake Dockers answer one call at a time).
 */
export function cleanDockerDetached(app: string): void {
  if (process.env.LARU_DOCKER_CLEANUP === '0') return;
  // several ups and runs in a row start one cleanup, not one each: none if one started in the last 2 minutes
  const started = join(laruHome(), 'docker-cleanup.started');
  try { if (Date.now() - statSync(started).mtimeMs < CLEANUP_GAP_MS) return; } catch { /* never started */ }
  try { mkdirSync(laruHome(), { recursive: true }); writeFileSync(started, new Date().toISOString()); } catch { /* it runs all the same */ }
  spawn(process.execPath, [join(import.meta.dirname, 'clean-docker.ts'), app], { detached: true, stdio: 'ignore' }).unref();
}
/** When Laru last cleaned Docker (the machine's: images, volumes, build cache) and what it removed. */
const cleanupFile = () => join(laruHome(), 'docker-cleanup.json');
export type DockerCleanup = { at: string; images: number; imagesBytes?: number; volumes: number; buildCache?: PruneReport['buildCache'] };
export const lastCleanup = (): DockerCleanup | undefined => { try { return JSON.parse(readFileSync(cleanupFile(), 'utf8')); } catch { return undefined; } };
/** Docker's build cache as `docker system df` counts it */
const buildCacheBytes = async () => sizeBytes(JSON.parse((await docker(['system', 'df', '--format', '{{json .}}'], { timeoutMs: DOCKER_READ.ms })).split('\n').filter(Boolean).find((l) => l.includes('"Build Cache"')) ?? '{"Size":"0B"}').Size);

/** Laru's volumes no container uses, of an app without a workspace on this machine (a registered app's caches stay). */
const oldVolumes = async (app: string) => {
  const known = knownApps(app);
  return (await docker(['volume', 'ls', '--filter', 'dangling=true', '--filter', `label=${LABEL.app}`, '--format', `{{.Name}}|{{.Label "${LABEL.app}"}}`]))
    .split('\n').filter(Boolean).map((l) => l.split('|')).filter(([, a]) => !known.has(a)).map(([name]) => name);
};

const run = promisify(execFile);

/**
 * Retention and cleanup. `runs` as planPrune says; `snapshots`: commit and folder snapshots no env of any registered
 * workspace of this app started from, keeping the 2 newest per project (working copies: the last 3); `images`: see
 * staleImages, removed by tag without -f, oldVolumes, and Docker's build cache capped (trimBuildCache); `shadow`: `git gc` in each folder project's shadow. A dry run returns the
 * same report without removing anything.
 */
export async function prune(ws: Workspace, o: { dryRun?: boolean; what?: PruneWhat[] } = {}): Promise<PruneReport> {
  const what = new Set<PruneWhat>(o.what?.length ? o.what : ['runs', 'snapshots', 'images', 'shadow']);
  const report: PruneReport = { runs: [], snapshots: [], images: [], volumes: [], shadow: [], bytes: 0 };
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
      for (const [kind, n] of Object.entries(SNAPSHOTS_KEPT) as Array<[keyof typeof SNAPSHOTS_KEPT, number]>) {
        const mine = rows.filter((r) => r.repo === repo && r.kind === kind).sort((a, b) => b.mtime - a.mtime);
        report.snapshots.push(...mine.slice(n).filter((r) => !r.usedBy.length).map((r) => ({ path: r.path, bytes: r.bytes })));
      }
    }
    if (!o.dryRun) for (const s of report.snapshots) rmSync(s.path, { recursive: true, force: true });
  }
  if (what.has('images')) {
    report.images = await oldImages(ws.app).catch(() => []);
    report.volumes = await oldVolumes(ws.app).catch(() => []);
    if (!o.dryRun) for (const i of report.images) await docker(['image', 'rm', i.ref], { timeoutMs: 120_000 }).catch(() => undefined);
    if (!o.dryRun) for (const v of report.volumes) await docker(['volume', 'rm', v], { timeoutMs: 120_000 }).catch(() => undefined);
    // a tag built again leaves the image it pointed at without a name: Laru's (an app's, the runner's) go too
    if (!o.dryRun) for (const l of [LABEL.app, LABEL.tool]) await docker(['image', 'prune', '--force', '--filter', `label=${l}`], { timeoutMs: 120_000 }).catch(() => undefined);
    const gb = readConfig().buildCacheGB;
    report.buildCache = o.dryRun || !gb ? { gb, trimmed: false } : await trimBuildCache(gb).then((x) => ({ gb, trimmed: x.after < x.before, ...x }), (e: Error) => ({ gb, trimmed: false, error: e.message }));
    if (!o.dryRun) mkdirSync(laruHome(), { recursive: true });
    if (!o.dryRun) writeFileSync(cleanupFile(), JSON.stringify({ at: new Date().toISOString(), images: report.images.length, imagesBytes: sum(report.images), volumes: report.volumes.length, buildCache: report.buildCache }, null, 2));
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
    docker: { buildCacheBytes: await buildCacheBytes().catch(() => null), buildCacheGB: readConfig().buildCacheGB, lastCleanup: lastCleanup() },
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

/** The last retention of a workspace's runs (runs/prune.json), when there was one. */
export const lastRunsPrune = (ws: Pick<Workspace, 'root'>): { at: string; removed: { media: number; runs: number; bytes: number } } | undefined => {
  try { return JSON.parse(readFileSync(join(runsOf(ws), 'prune.json'), 'utf8')); } catch { return undefined; }
};

/**
 * What each registered workspace weighs on this machine, part by part: its own folder (without its state), the runs,
 * the envs, the rest of its state, the snapshots of its app (shared by the workspaces of one app) and its app's Docker
 * images (before Docker shares layers); then Laru's home without the snapshots (they live in it), Docker's build cache,
 * and the whole, where an app's snapshots and images count once. Folder sizes are kept a minute.
 */
export async function workspacesDisk() {
  const images = new Map<string, number>();
  const rows = await docker(['image', 'ls', '--format', '{{json .}}']).then((o) => o.split('\n').filter(Boolean).map((l) => JSON.parse(l) as ImageRow), () => null);
  for (const r of rows ?? []) { const m = /^ks-([^/]+)\//.exec(r.Repository); if (m) images.set(m[1], (images.get(m[1]) ?? 0) + sizeBytes(r.Size)); }
  const workspaces = loadRegistry().flatMap((x) => {
    let w: Workspace;
    try { w = loadWorkspace(x.root); } catch { return []; }
    const state = stateDir(w), runs = runsOf(w);
    const stateBytes = existsSync(state) ? dirBytes(state) : 0, runsBytes = existsSync(runs) ? dirBytes(runs) : 0;
    const envsBytes = listEnvs(w).reduce((n, e) => n + (existsSync(envDir(w, e)) ? dirBytes(envDir(w, e)) : 0), 0);
    const bytes = { workspace: dirBytes(w.root, state), runs: runsBytes, envs: envsBytes, state: Math.max(0, stateBytes - runsBytes - envsBytes), snapshots: snapshotRows(w).reduce((n, s) => n + s.bytes, 0), images: rows ? images.get(w.app) ?? 0 : null };
    return [{ root: w.root, app: w.app, title: w.title, bytes, total: bytes.workspace + stateBytes + bytes.snapshots + (bytes.images ?? 0) }];
  });
  const buildCache = { bytes: await buildCacheBytes().catch(() => null), gb: readConfig().buildCacheGB };
  // an app's snapshots and images count once, however many of its workspaces there are; the snapshots live in Laru's
  // home (<home>/<app>/snapshots), which is counted without them
  const perApp = new Map(workspaces.map((w) => [w.app, { snapshots: w.bytes.snapshots, images: w.bytes.images ?? 0 }]));
  const snapshots = [...perApp.values()].reduce((n, a) => n + a.snapshots, 0);
  const home = { path: laruHome(), bytes: Math.max(0, (existsSync(laruHome()) ? dirBytes(laruHome()) : 0) - snapshots) };
  const total = workspaces.reduce((n, w) => n + w.total - w.bytes.snapshots - (w.bytes.images ?? 0), 0) + snapshots + [...perApp.values()].reduce((n, a) => n + a.images, 0) + home.bytes + (buildCache.bytes ?? 0);
  return { workspaces: workspaces.sort((a, b) => b.total - a.total), home, buildCache, total, lastCleanup: lastCleanup() };
}
export type WorkspacesDisk = Awaited<ReturnType<typeof workspacesDisk>>;
