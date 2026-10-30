/**
 * A run: the flows' specs played by the runner container on an env's network, then everything the env saw in that
 * window turned into evidence. `queued → up → tests → evidence → destroy → done`; `error` (the infrastructure) is
 * kept apart from `failed` (a test). Runs are directories under .laru/runs/<id>/: run.json is rewritten at each
 * phase, out/ is the runner's, raw/ holds the masked slices, flows/<slug>/ the trace, video and screenshots.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative } from 'node:path';
import { loadGraph, loadKnowledge, parseLimit, shareEvidence, stateDir, type Row, type Workspace } from '@laru/core';
import { parse } from 'yaml';
import { interpolations } from './compose.ts';
import { ksVar, type TrafficRecord } from './types.ts';
import { assemble, isGreen, MASK_KEYS, parseKafkaDump, parsePgLog, type KafkaLine, type Masker, type RunInfo, type RunnerEvent, type ServiceLog, type SqlLine, type Trace } from '@laru/trace';
import { readConfig } from './config.ts';
import { prune } from './disk.ts';
import { byLabel, destroyByLabel, docker, dockerJson, dockerStream, envLock, inspectEnv, LABEL, stats, withLock, workspaceKey, type ContainerState } from './docker.ts';
import { envDir, envMasker, envProjects, flowProjects, forgetValues, isInstance, loadEnvSpec, projectName, readState } from './env.ts';
import { appendRunnerFile, readRunnerFile, RESULTS, runnerFile, runnerFiles } from './runner-file.ts';
import { applyPlan, applyScenario, isExclusive, ScenarioConfirm, seedScenario } from './scenarios.ts';
import { behaviorDrift } from './behavior.ts';
import { status, up } from './up.ts';
import { flowsVars, injection } from './vault.ts';

export const RUNNER_IMAGE = 'laru/runner:1.64.1';
export const runsDir = (ws: Workspace) => join(stateDir(ws), 'runs');
/** A run and a flow are names, never paths: an id with a `/` or a `..` reached folders the runner writes (out/). */
const NAME = /^[\w-]+$/;
export const runDir = (ws: Workspace, id: string) => { if (!NAME.test(id)) throw new Error(`no run ${JSON.stringify(id)}`); return join(runsDir(ws), id); };
/** Where a run keeps one flow's evidence. */
export const flowDir = (ws: Workspace, id: string, slug: string) => { if (!NAME.test(slug)) throw new Error(`no flow ${JSON.stringify(slug)}`); return join(runDir(ws, id), 'flows', slug); };

export interface FlowSpec { slug: string; id: string; title: string; spec: string; dir: string; exists: boolean; steps: Row[]; needs: string[]; /** the scenario it starts from */ scenario?: string; /** its time limit (`timeout` in flow.md), in ms */ timeoutMs?: number }

/** Every flow of the documentation with the spec that plays it (`<flow dir>/<slug>.spec.ts`). */
export function listFlows(ws: Workspace): FlowSpec[] {
  return loadKnowledge(ws).pieces.filter((p) => p.type === 'flow').map((p) => {
    const slug = p.id.replace(/^flow:/, '');
    const spec = join(p.dir, `${slug}.spec.ts`);
    const needs = p.meta?.needs;
    const scenario = p.meta?.scenario;
    const limit = parseLimit(p.meta?.timeout);
    return { slug, id: p.id, title: p.title, spec, dir: p.dir, exists: existsSync(join(ws.root, spec)), steps: (p.fields.steps ?? []) as Row[], needs: Array.isArray(needs) ? needs : needs ? [needs] : [], ...(scenario ? { scenario: String(Array.isArray(scenario) ? scenario[0] : scenario) } : {}), ...(limit ? { timeoutMs: limit } : {}) };
  }).sort((a, b) => a.slug.localeCompare(b.slug));
}

export function readRun(ws: Workspace, id: string): RunInfo | null {
  if (!NAME.test(id)) return null;
  const f = join(runDir(ws, id), 'run.json');
  if (!existsSync(f)) return null;
  const r = JSON.parse(readFileSync(f, 'utf8')) as RunInfo;
  // A run whose process died mid-way did not fail or pass: it was interrupted.
  // A session has no process of its own: it stays open until stopped.
  if (r.status === 'running' && r.kind !== 'session' && !alive(r.pid)) { r.status = 'interrupted'; r.phase = 'done'; writeFileSync(f, JSON.stringify(r, null, 2)); }
  return r;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * The session recording on an env, if one is open: its traffic is what a person is reading, so a run is not mixed into it.
 * An env of a flow or of one run is never shared, so it is never recording for someone else.
 */
export function recordingOn(ws: Workspace, env: string): RunInfo | undefined {
  if (isInstance(env)) return undefined;
  return listRuns(ws, 200).find((r) => r.kind === 'session' && r.phase === 'tests' && r.env === env && alive(r.pid));
}

export function listRuns(ws: Workspace, limit = 50): RunInfo[] {
  if (!existsSync(runsDir(ws))) return [];
  return readdirSync(runsDir(ws)).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(b) - Number(a)).slice(0, limit).map((d) => readRun(ws, d)).filter(Boolean) as RunInfo[];
}

export function nextId(ws: Workspace): string {
  mkdirSync(runsDir(ws), { recursive: true });
  const ids = readdirSync(runsDir(ws)).filter((d) => /^\d+$/.test(d)).map(Number);
  for (let n = (ids.length ? Math.max(...ids) : 0) + 1; ; n++) {
    try { mkdirSync(runDir(ws, String(n))); return String(n); } catch { /* taken by a concurrent start */ }
  }
}

export function readTrace(ws: Workspace, id: string, slug: string): Trace | null {
  const f = join(flowDir(ws, id, slug), 'trace.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Trace) : null;
}

/** Every trace of a run: each flow's story and its short cases. */
export function runTraces(ws: Workspace, id: string): Trace[] {
  const r = readRun(ws, id);
  return Object.keys(r?.results ?? {}).flatMap((slug) => {
    const story = readTrace(ws, id, slug);
    const f = join(flowDir(ws, id, slug), 'cases.json');
    const cases = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Trace[]) : [];
    return [...(story ? [{ ...story, story: story.story ?? true }] : []), ...cases];
  });
}

export function readEvents(ws: Workspace, id: string): RunnerEvent[] {
  return (readRunnerFile(runDir(ws, id), 'out/events.jsonl') ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunnerEvent);
}

type Route = { svc: string; ports: number[]; proto: string; net?: string; kind?: string };
const FRONT = /^(frontend|front|web|ui|portal|app|site|www)$/;
const urlOf = (r: { svc: string; ports: number[] }) => { const port = r.ports.includes(80) ? 80 : r.ports[0]; return `http://${r.svc}${port === 80 ? '' : `:${port}`}`; };
const httpRoutes = (ws: Workspace, env: string, run?: string): Route[] => {
  const f = join(envDir(ws, env), ...(run ? ['runs', run] : []), 'tap', 'routes.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { routes: Route[] }).routes.filter((r) => r.proto === 'http' && !r.kind && (!r.net || r.net === 'ks')) : [];
};

/** Where the browser starts: the env's web front (frontend, web, ui, portal…), else its first HTTP service. */
export function baseUrl(ws: Workspace, env: string, run?: string): string {
  const routes = httpRoutes(ws, env, run);
  const front = routes.find((r) => FRONT.test(r.svc)) ?? routes.find((r) => r.ports.includes(80)) ?? routes[0];
  return front ? urlOf(front) : 'http://frontend';
}

/**
 * In a joint env each flow starts on its own project's front: the project of the first service it needs, whose front
 * (by name, as baseUrl) or else first HTTP service. A flow needing no service keeps the env's base URL.
 */
export function baseUrls(ws: Workspace, env: string, run: string | undefined, flows: FlowSpec[], map: { nodes: Array<{ id: string; repo?: string }> } | null): Record<string, string> {
  const routes = httpRoutes(ws, env, run);
  const repoOf = new Map((map?.nodes ?? []).map((n) => [n.id.replace(/^svc:/, ''), n.repo]));
  const out: Record<string, string> = {};
  for (const f of flows) {
    const first = f.needs.find((n) => n.startsWith('svc:'));
    const repo = first && map?.nodes.find((n) => n.id === first)?.repo;
    if (!repo) continue;
    const mine = routes.filter((r) => repoOf.get(r.svc) === repo);
    const front = mine.find((r) => FRONT.test(r.svc) || FRONT.test(r.svc.replace(new RegExp(`^${repo}-`), ''))) ?? mine[0];
    if (front) out[f.slug] = urlOf(front);
  }
  return out;
}

export async function ensureRunner(onLine?: (l: string) => void): Promise<void> {
  const have = await docker(['image', 'inspect', RUNNER_IMAGE]).then(() => true, () => false);
  if (have) return;
  const dir = join(import.meta.dirname, '..', 'runner');
  const code = await dockerStream(['build', '-t', RUNNER_IMAGE, dir], onLine ?? (() => undefined));
  if (code !== 0) throw new Error(`could not build ${RUNNER_IMAGE}`);
}

export interface RunOptions {
  env: string;
  flows?: string[];
  ephemeral?: boolean;
  retries?: number;
  pwTrace?: boolean;
  id?: string;
  /** false: run every flow even when its inputs did not change since it last passed */
  cache?: boolean;
  /** build the env's repo from its working copy (uncommitted changes included) */
  worktree?: boolean;
  /** runners playing at once; default `workers` in config.yaml, else what Docker's memory leaves room for */
  workers?: number;
  /** the person agreed to what applying the scenarios of these flows deletes on a persistent env (`confirmRun` says what) */
  confirm?: boolean;
  onEvent?: (e: RunnerEvent | { e: 'phase'; phase: RunInfo['phase']; t: number }) => void;
}

const sha1 = (s: string | Buffer) => createHash('sha1').update(s).digest('hex');
const hashDir = (d: string): string => {
  if (!existsSync(d)) return '';
  const h = createHash('sha1');
  const walk = (x: string) => { for (const n of readdirSync(x).sort()) { const p = join(x, n); if (statSync(p).isDirectory()) walk(p); else h.update(`${relative(d, p)}\0`).update(readFileSync(p)); } };
  walk(d);
  return h.digest('hex');
};

/**
 * What a flow's result depends on: its spec, flow.md and support/, the runner and Laru's flow fixtures, the env's
 * definition, the images, mounted files and values of every service it needs or last went through, and the mock and
 * fault rules. The same key as a passed run means the result would be the same: the flow is reported cached instead
 * of played.
 */
export async function flowKeys(ws: Workspace, env: string, run: string | undefined, flows: FlowSpec[]): Promise<Record<string, string>> {
  const dir = run ? join(envDir(ws, env), 'runs', run) : envDir(ws, env);
  const compose = parse(readFileSync(join(dir, 'compose.yml'), 'utf8')) as { services: Record<string, any> };
  const normalized = existsSync(join(dir, 'normalized.json')) ? (JSON.parse(readFileSync(join(dir, 'normalized.json'), 'utf8')) as { services: Record<string, any> }) : { services: {} };
  const rules = existsSync(join(dir, 'tap', 'rules.json')) ? JSON.parse(readFileSync(join(dir, 'tap', 'rules.json'), 'utf8')) : {};
  delete rules.peers;
  const common = sha1([RUNNER_IMAGE, hashDir(join(import.meta.dirname, '..', '..', 'trace', 'src')), JSON.stringify(loadEnvSpec(ws, env)), JSON.stringify(rules), hashDir(join(ws.root, 'support'))].join('\0'));
  // service → what its container is made of: image (with its local id), mounted files, injected values.
  const bySvc = new Map<string, string>();
  const images = [...new Set(Object.values(compose.services).map((s) => String(s.image)))];
  const ids = await docker(['image', 'inspect', '-f', '{{.Id}}', ...images]).then((o) => o.trim().split('\n'), () => images);
  const idOf = new Map(images.map((im, i) => [im, ids[i] ?? im]));
  const infos = Object.entries(normalized.services).map(([name, sv]) => ({ name, built: Boolean(sv.build), interpolations: interpolations(sv), environment: Array.isArray(sv.environment) ? Object.fromEntries(sv.environment.map((e: string) => { const i = e.indexOf('='); return i < 0 ? [e, null] : [e.slice(0, i), e.slice(i + 1)]; })) : { ...(sv.environment ?? {}) } }));
  let g = null;
  try { g = loadGraph(ws); } catch { /* no map: values are keyed without readers */ }
  const inj = infos.length ? await injection(ws, env, infos, g) : { values: {} as Record<string, string> };
  for (const s of Object.values(compose.services)) {
    const name = s.labels?.[LABEL.service] ?? '';
    const binds = (s.volumes ?? []).filter((v: any) => v?.type === 'bind' && existsSync(v.source) && statSync(v.source).isFile()).map((v: any) => sha1(readFileSync(v.source)));
    const values = Object.entries(inj.values).filter(([k]) => k.startsWith(ksVar(name, ''))).sort().map(([k, v]) => `${k}=${sha1(v)}`);
    bySvc.set(name, sha1([idOf.get(String(s.image)), ...binds, ...values].join('\0')));
  }
  const last = new Map<string, string[]>();
  for (const f of flows) {
    const t = lastTrace(ws, f.slug);
    last.set(f.slug, (t?.participants ?? []).map((p) => p.id));
  }
  const out: Record<string, string> = {};
  for (const f of flows) {
    const names = [...new Set([...f.needs.map((n) => n.replace(/^[a-z]+:/, '')), ...(last.get(f.slug) ?? [])])].filter((n) => bySvc.has(n)).sort();
    const doc = join(ws.root, f.dir, 'flow.md');
    // the state it starts from is an input too: its scenario's setup and scenario.md
    const scn = f.scenario ? loadKnowledge(ws).byId.get(f.scenario) : undefined;
    const scnFiles = scn ? [join(ws.root, scn.dir, 'scenario.md'), join(ws.root, scn.dir, `${scn.id.replace(/^scn:/, '')}.setup.ts`)].filter((x) => existsSync(x)).map((x) => readFileSync(x)) : [];
    out[f.slug] = sha1([common, readFileSync(join(ws.root, f.spec)), existsSync(doc) ? readFileSync(doc) : '', ...names.map((n) => `${n}:${bySvc.get(n)}`), ...(f.scenario ? [f.scenario, ...scnFiles] : [])].join('\0')).slice(0, 16);
  }
  return out;
}

/** About what one runner (Chromium and the test) takes while it plays. */
const RUNNER_BYTES = 600 * 2 ** 20;
/**
 * How many runners play at once: as asked, else `workers` in config.yaml, else what 90 % of Docker's memory leaves
 * after every container running now, at about 600 MB each, between 1 and 3.
 */
export async function workersFor(asked?: number): Promise<number> {
  const set = asked ?? readConfig().workers;
  if (set) return Math.max(1, Math.floor(set));
  const total = Number((await docker(['info', '--format', '{{.MemTotal}}']).catch(() => '0')).trim()) || 0;
  const ids = (await docker(['ps', '-q']).catch(() => '')).split('\n').filter(Boolean);
  const used = (await stats(ids)).reduce((n, x) => n + x.memBytes, 0);
  return Math.max(1, Math.min(3, Math.floor((0.9 * total - used) / RUNNER_BYTES)));
}

/** The flows split into `n` runners of about the same length, by how long each took last time (longest first). */
export function splitFlows(ws: Workspace, flows: FlowSpec[], n: number): FlowSpec[][] {
  if (!flows.length) return [];
  const idx = join(runsDir(ws), 'index.jsonl');
  const ms = new Map<string, number>();
  if (existsSync(idx)) for (const l of readFileSync(idx, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l) as { flow: string; ms?: number }; if (r.ms) ms.set(r.flow, r.ms); }
  const out = Array.from({ length: Math.min(n, flows.length) }, () => ({ ms: 0, flows: [] as FlowSpec[] }));
  for (const f of [...flows].sort((a, b) => (ms.get(b.slug) ?? 30_000) - (ms.get(a.slug) ?? 30_000) || a.slug.localeCompare(b.slug))) {
    const least = out.reduce((a, b) => (b.ms < a.ms ? b : a));
    least.flows.push(f);
    least.ms += ms.get(f.slug) ?? 30_000;
  }
  return out.map((x) => x.flows);
}

/**
 * «Repetir fallidos»: the flows whose newest result in `env` (any env when none is given) failed unexpectedly or errored,
 * that still have a spec. A flow that only carries known deviations is green and is not repeated.
 */
export function failedFlows(ws: Workspace, env?: string): string[] {
  const idx = join(runsDir(ws), 'index.jsonl');
  const last = new Map<string, string>();
  if (existsSync(idx)) for (const l of readFileSync(idx, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l) as { flow: string; status: string; env?: string }; if (!env || r.env === env) last.set(r.flow, r.status); }
  const have = new Set(listFlows(ws).filter((f) => f.exists).map((f) => f.slug));
  return [...last].filter(([f, st]) => (st === 'failed' || st === 'error') && have.has(f)).map(([f]) => f).sort();
}

/** The story and cases of the last run that played a flow (not an error, not a cached reuse). */
function lastTraces(ws: Workspace, slug: string): Trace[] {
  const idx = join(runsDir(ws), 'index.jsonl');
  if (!existsSync(idx)) return [];
  const r = readFileSync(idx, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { run: string; flow: string; status: string }).filter((x) => x.flow === slug && (x.status === 'passed' || x.status === 'failed')).at(-1);
  if (!r) return [];
  const read = (f: string) => { try { return JSON.parse(readFileSync(join(runDir(ws, r.run), 'flows', slug, f), 'utf8')); } catch { return undefined; } };
  return [...(read('trace.json') ? [read('trace.json') as Trace] : []), ...((read('cases.json') ?? []) as Trace[])];
}

/**
 * The known deviations that stopped failing: a step (of a story that was green) that failed before and passes now, a case
 * that failed with known deviations and passes. The flow's documentation says «hoy …» about each: it is now out of date.
 */
export function fixedOf(before: Trace[], now: Trace[]): string[] {
  const out: string[] = [];
  for (const p of before.filter((t) => t.status === 'failed' && isGreen(t))) {
    const n = now.find((t) => t.test === p.test);
    if (!n) continue;
    if (p.story) { for (const st of p.steps.filter((x) => x.status === 'failed')) if (n.steps.find((x) => x.title === st.title)?.status === 'passed') out.push(st.title); }
    else if (n.status === 'passed') out.push(p.test);
  }
  return out;
}

/** The trace of the last run a flow did not error in. */
function lastTrace(ws: Workspace, slug: string): Trace | null {
  const idx = join(runsDir(ws), 'index.jsonl');
  if (!existsSync(idx)) return null;
  const rows = readFileSync(idx, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { run: string; flow: string; status: string }).filter((r) => r.flow === slug && r.status !== 'error');
  const r = rows.at(-1);
  return r ? readTrace(ws, r.run, slug) : null;
}

/** Every string inside a JSON value through the masker; numbers, keys and structure stay. */
export const maskJson = <T>(v: T, m: Masker): T => (typeof v === 'string' ? m.text(v) : Array.isArray(v) ? v.map((x) => maskJson(x, m)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskJson(x, m)])) : v) as T;

/** A field's accessible name (or an attribute) that says it holds a secret: the masker's secret names, and a form's words for one. */
const SECRET_FIELD = new RegExp(`${MASK_KEYS.source}|contrase[ñn]a|\\bclaves?\\b|\\bpin\\b`, 'i');
/** A page snapshot's text field and what was typed into it: `- textbox "Ingresa tu contraseña" [ref=e5]: Passw0rd!x` */
const TEXTBOX = /^([ \t]*- textbox(?: "(?:[^"\\\n]|\\.)*")?(?: \[[^\]\n]*\])*):[ \t]*(\S.*)$/gm;
/**
 * The masker, plus what a page snapshot shows typed into a secret field (Playwright's error-context.md, an aria snapshot
 * in an error). A typed value is no vault secret, so only the field's name can say it is one; its mark is the one a
 * secret header with that value gets.
 */
export const withFields = (m: Masker): Masker => ({
  ...m, text: (s) => m.text(s.replace(TEXTBOX, (all, head: string, v: string) => (SECRET_FIELD.test(head) ? `${head}: ${m.headers({ password: v }).password}` : all))),
});

/**
 * The runner's own files, masked in place once it has stopped: its events, and the text Playwright leaves next to a
 * failed test (error-context.md quotes the page, typed values included, and the spec). Videos and screenshots cannot be
 * masked; they stay.
 */
export function maskOutput(out: string, masker: Masker): void {
  const m = withFields(masker);
  const events = readRunnerFile(out, 'events.jsonl');
  if (events !== undefined) writeFileSync(join(out, 'events.jsonl'), events.split('\n').filter(Boolean).map((l) => { try { return JSON.stringify(maskJson(JSON.parse(l), m)); } catch { return m.text(l); } }).join('\n') + '\n');
  for (const n of readdirSync(out).filter((x) => RESULTS.test(x))) {
    for (const p of runnerFiles(out, n)) if (/\.(md|txt|log|json|jsonl|html|xml|ya?ml|csv)$/i.test(p)) writeFileSync(join(out, p), m.text(readRunnerFile(out, p) ?? ''));
  }
}

/** Every key each flow passed with, and the last run that proved it; a key that later failed is forgotten. */
export function passedKeys(ws: Workspace): Map<string, Map<string, string>> {
  const idx = join(runsDir(ws), 'index.jsonl');
  const out = new Map<string, Map<string, string>>();
  if (!existsSync(idx)) return out;
  for (const l of readFileSync(idx, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(l) as { run: string; flow: string; status: string; key?: string };
    if (r.status === 'passed' && r.key) out.set(r.flow, (out.get(r.flow) ?? new Map()).set(r.key, r.run));
    // a failure with a key that once passed makes it unreliable; without a key nothing is known
    else if (r.status === 'failed') { if (r.key) out.get(r.flow)?.delete(r.key); else out.delete(r.flow); }
  }
  return out;
}

/**
 * `docker run -d` of the runner on an env's network, playing `specs` (workspace paths): the packages and the workspace
 * read-only, `out` writable, and the tap's journal (already masked; never mask.json) for the observed fixture.
 */
export function runnerArgs(ws: Workspace, env: string, runLabel: string | undefined, id: string, out: string, envFile: string, specs: string[]): string[] {
  const tap = join(envDir(ws, env), ...(runLabel ? ['runs', runLabel] : []), 'tap');
  // A missing file would be mounted as an empty folder: the journal exists before the runner starts.
  if (!existsSync(join(tap, 'traffic.jsonl'))) writeFileSync(join(tap, 'traffic.jsonl'), '');
  return ['run', '-d', '--init', '--shm-size=1g', '--network', projectName(ws, env, runLabel),
    '--label', `${LABEL.workspace}=${workspaceKey(ws)}`, '--label', `${LABEL.app}=${ws.app}`, '--label', `${LABEL.env}=${env}`, '--label', `${LABEL.run}=${id}`, '--label', `${LABEL.service}=runner`,
    '-v', `${join(import.meta.dirname, '..', '..')}:/ks/packages:ro`, '-v', `${ws.root}:/ks/ws:ro`, '-v', `${out}:/ks/out`,
    // The runner is untrusted code: the state folder (.laru, or its old name in a workspace made before the rename)
    // holds the env's mask.json (every secret value) and the scenarios' states. An empty tmpfs hides it; `out` and the
    // tap files are mounted on their own, above.
    '--tmpfs', `/ks/ws/${basename(stateDir(ws))}:size=1m`,
    '-v', `${join(tap, 'traffic.jsonl')}:/ks/tap/traffic.jsonl:ro`, '-v', `${join(tap, 'rules.json')}:/ks/tap/rules.json:ro`,
    // the env's mailbox, for the `mail` and `sms` fixtures: a file only an env with a sink has (the codes in it are the ones a test needs)
    ...(existsSync(join(tap, 'mail', 'messages.jsonl')) ? ['-v', `${join(tap, 'mail', 'messages.jsonl')}:/ks/tap/messages.jsonl:ro`] : []),
    '--env-file', envFile,
    RUNNER_IMAGE, 'npx', 'playwright', 'test', '-c', '/ks/packages/trace/src/playwright.config.ts', ...specs.map((sp) => `/ks/ws/${sp}`)];
}

/**
 * Starts a runner and answers its container's id. Its KS_* values (`vars`, `KEY=value` lines) reach it through a 0600
 * file that docker reads (`--env-file`) and that is gone as soon as docker returns: never on a command line, never in
 * the environment of a process that stays.
 */
export async function startRunner(ws: Workspace, env: string, runLabel: string | undefined, id: string, out: string, envFile: string, vars: string, specs: string[]): Promise<string> {
  // what can fail before docker runs goes first: the values are written only once nothing is left between them and their removal
  const args = runnerArgs(ws, env, runLabel, id, out, envFile, specs);
  writeFileSync(envFile, vars, { mode: 0o600 });
  // A joint env has a network per project: the runner also joins the first project's, before it starts, so it reaches by
  // name what a flow reaches in that project's own env (its mocks' admin ports, its browser's hosts). Only the first: a
  // name both projects have (edge) would lead to one or the other as the DNS answers.
  // Known limit: a later project's flow calling its own services by a name the tap does not expose still misses; the upgrade
  // joins the runner to the network of the project each flow's front belongs to.
  try {
    // Known limit: an env with no file of its own (only in tests: up has read it) is not a joint one
    const first = (() => { try { return loadEnvSpec(ws, env).join?.[0]; } catch { return undefined; } })();
    if (!first) return (await docker(args)).trim();
    const c = (await docker(['create', ...args.slice(2)])).trim();
    try {
      await docker(['network', 'connect', `${projectName(ws, env, runLabel)}-${loadEnvSpec(ws, first).from!.repo}`, c]);
      await docker(['start', c]);
    } catch (e) { await docker(['rm', '-f', c]).catch(() => ''); throw e; }
    return c;
  } finally { rmSync(envFile, { force: true }); }
}

/**
 * A flow that names a scenario has it applied before it plays, and on a persistent env that puts its stores back to a
 * snapshot: the rows of today are lost. Like «Aplicar» it says what, and waits for `confirm`. An ephemeral env has
 * nothing to lose (and refuses such flows later); an env that is down is told in general words, since it has no stores
 * to describe yet. It asks even when every flow turns out cached: it cannot know before the env is up.
 */
export async function confirmRun(ws: Workspace, o: Pick<RunOptions, 'env' | 'flows' | 'ephemeral' | 'confirm'>): Promise<void> {
  // a flow's environment is made to be played on: its scenario goes in without asking
  if (o.confirm || o.ephemeral || isInstance(o.env) || !loadEnvSpec(ws, o.env).persistent) return;
  const all = listFlows(ws);
  const picked = o.flows?.length ? all.filter((f) => o.flows!.includes(f.slug) || o.flows!.includes(f.id)) : all;
  // only an exclusive scenario is restored (and loses the rows of today); the others are seeded beside what is there, and nothing is asked
  const scns = [...new Set(picked.filter((f) => f.exists && f.scenario && isExclusive(ws, f.scenario)).map((f) => f.scenario!))];
  if (!scns.length) return;
  const ready = (await status(ws, o.env)).state === 'ready';
  const said = ready ? await Promise.all(scns.map(async (s) => `${s}: ${(await applyPlan(ws, s, { env: o.env })).text}`))
    : [`${o.env} está parado y se levanta para jugar los flujos: ${scns.join(', ')} se aplican antes del flujo que parte de cada uno, y lo que se restaura desde una instantánea pierde las filas de hoy.`];
  throw new ScenarioConfirm(said.join('\n'));
}

/** Plays the flows and writes their evidence. Resolves with the finished run; never throws for a failing test. */
export async function runFlows(ws: Workspace, o: RunOptions): Promise<RunInfo> {
  await confirmRun(ws, o); // before the run has a folder: a question is not a run
  const id = o.id ?? nextId(ws);
  const dir = runDir(ws, id);
  mkdirSync(join(dir, 'out'), { recursive: true });
  const all = listFlows(ws);
  const picked = o.flows?.length ? o.flows.map((f) => all.find((x) => x.slug === f || x.id === f) ?? (() => { throw new Error(`no flow ${f}; flows are ${all.map((x) => x.slug).join(', ')}`); })()) : all.filter((f) => f.exists);
  const missing = picked.filter((f) => !f.exists);
  const run: RunInfo = { id, env: o.env, ephemeral: Boolean(o.ephemeral), flows: picked.map((f) => f.slug), phase: 'queued', status: 'running', startedAt: new Date().toISOString(), pid: process.pid, results: {}, videoOffsetMs: readConfig().videoOffsetMs };
  const hold = readConfig().stepHoldMs; // a recorded story's pause at the end of each step
  const save = () => writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  const phase = (p: RunInfo['phase']) => { run.phase = p; save(); o.onEvent?.({ e: 'phase', phase: p, t: Date.now() }); };
  save();
  // a session is recording on this env: the run waits for it to be saved, and says so
  const rec = o.ephemeral ? undefined : recordingOn(ws, o.env);
  if (rec && !missing.length) {
    run.waiting = rec.id; run.note = `Espera a la sesión ${rec.id}: ${o.env} graba lo que haces y un run se mezclaría con ello.`; save();
    while (recordingOn(ws, o.env)) await new Promise((r) => setTimeout(r, 2000));
    delete run.waiting; run.note = `Esperó a que se guardara la sesión ${rec.id}.`; save();
  }
  if (missing.length) { run.status = 'error'; run.error = `no spec for ${missing.map((f) => f.slug).join(', ')}: laru flow scaffold ${missing[0].id}`; run.phase = 'done'; run.endedAt = new Date().toISOString(); save(); return run; }

  const runLabel = o.ephemeral ? id : undefined;
  const runners = new Set<string>();
  // A flow that needs a project the env does not run is reported, not played.
  let graph = null;
  try { graph = loadGraph(ws); } catch { /* no map: no project is known */ }
  if (ws.repos.length > 1) {
    const has = (() => { try { return envProjects(ws, o.env); } catch { return []; } })();
    for (const f of picked) {
      const lacks = flowProjects(graph, f).filter((r) => !has.includes(r));
      if (lacks.length) { run.results[f.slug] = { status: 'error' }; run.error = [run.error, `${f.slug} necesita ${lacks.join(' y ')}; ${o.env} no lo tiene`].filter(Boolean).join('. '); }
    }
    if (picked.every((f) => run.results[f.slug])) { run.status = 'error'; run.phase = 'done'; run.endedAt = new Date().toISOString(); save(); return run; }
  }
  try {
    await withLock(`run ${id}`, async () => {
      // up: an ephemeral env of its own, or the persistent one, started if it is not ready.
      phase('up');
      if (o.ephemeral) await up(ws, { env: o.env, run: id, worktree: o.worktree });
      else if (o.worktree || (await status(ws, o.env)).state !== 'ready') await up(ws, { env: o.env, worktree: o.worktree });
      await ensureRunner();
      const st = readState(ws, o.env);
      if (st?.sources ?? st?.source) { run.sources = st.sources ?? [st.source!]; save(); }

      // Flows whose inputs are the same as when they last passed are reported, not played.
      const keys = await flowKeys(ws, o.env, runLabel, picked).catch(() => ({} as Record<string, string>));
      if (o.cache !== false) {
        const passed = passedKeys(ws);
        for (const f of picked) {
          const from = keys[f.slug] && passed.get(f.slug)?.get(keys[f.slug]);
          if (from) run.results[f.slug] = { status: 'cached', cachedFrom: from };
        }
      }
      const toRun = picked.filter((f) => !run.results[f.slug]);
      if (!toRun.length) { run.status = Object.values(run.results).some((r) => r.status === 'error') ? 'error' : 'passed'; return; }

      // tests: the runner joins the env's network; values reach it through a 0600 env file deleted right after.
      phase('tests');
      // The flows that start as the env is go first, split among runners playing at once, and with them each flow whose scenario is
      // seeded: its setup is played under the flow's own name, nothing is put back, so they play beside the others. Then each flow
      // whose scenario is exclusive, alone, with the scenario applied (restored) right before it: an apply resets stores under
      // whatever else is playing.
      // Known limit: a runner per scenario flow (a few seconds each); one per scenario when its flows no longer share what
      // they change. A setup played again between them shows as an unknown participant at the edge of a window.
      const plain = toRun.filter((f) => !f.scenario), withScenario = toRun.filter((f) => f.scenario).sort((a, b) => a.scenario!.localeCompare(b.scenario!));
      const exclusive = withScenario.filter((f) => isExclusive(ws, f.scenario!)), seeded = withScenario.filter((f) => !isExclusive(ws, f.scenario!));
      if (o.ephemeral && exclusive.length) throw new Error(`${[...new Set(exclusive.map((f) => f.scenario))].join(', ')}: an exclusive scenario applies on a persistent env; run these flows without --ephemeral`);
      const shards = splitFlows(ws, plain, plain.length > 1 ? await workersFor(o.workers) : 1);
      const units = [...shards.map((flows) => ({ scn: '', seed: false, flows })), ...seeded.map((f) => ({ scn: f.scenario!, seed: true, flows: [f] })), ...exclusive.map((f) => ({ scn: f.scenario!, seed: false, flows: [f] }))];
      const perFlow = loadEnvSpec(ws, o.env).join ? baseUrls(ws, o.env, runLabel, toRun, graph?.map ?? null) : {};
      // each flow's own limit (`timeout` in flow.md), keyed by its spec file's name; a flow with none keeps KS_TIMEOUT_MS
      const limits = Object.fromEntries(toRun.filter((f) => f.timeoutMs).map((f) => [f.slug, f.timeoutMs]));
      let masker = withFields(envMasker(ws, o.env, runLabel));
      // the runner can swap these two for links while it plays: they are only ever appended to through appendRunnerFile
      const out = join(dir, 'out');
      // A link where a file of ours should be, or a line that is not JSON, costs that line, not the run (these run in timers and stream callbacks).
      let lost = 0;
      const log = (text: string) => { try { appendRunnerFile(out, 'runner.log', text); } catch { lost++; } };
      const runnerIps: string[] = [];
      /** which runner played each test, from whose events file it came */
      const unitOf = new Map<string, number>();
      // Each runner writes its own events file; this one process copies them into events.jsonl (the live view and the
      // evidence read that one) and says which runner played each test. What a runner writes is raw (a failed expect
      // prints its values): every line is masked before anyone sees it, and the files themselves once it is done.
      const seenBy: number[] = [];
      const pump = () => units.forEach((_, i) => {
        const lines = (readRunnerFile(out, `events-${i}.jsonl`) ?? '').split('\n').filter(Boolean);
        for (const l of lines.slice(seenBy[i] ?? 0)) {
          try {
            const e = JSON.parse(l) as RunnerEvent;
            appendRunnerFile(out, 'events.jsonl', l + '\n');
            if (e.e === 'test-begin') unitOf.set(e.test, i);
            o.onEvent?.(maskJson(e, masker));
          } catch { lost++; }
        }
        seenBy[i] = lines.length;
      });
      let exit = 0;
      const play = async (i: number, u: (typeof units)[number]) => {
        let given = '';
        if (u.scn && u.seed) {
          log(`laru: seeding ${u.scn} for ${u.flows[0].slug}\n`);
          const a = await seedScenario(ws, u.scn, { env: o.env, run: runLabel, as: `${id}-seed${i}`, out: join(dir, 'seed', String(i)) });
          rmSync(join(dir, 'seed', String(i)), { recursive: true, force: true });
          given = `KS_SCENARIO_JSON=${JSON.stringify({ scenario: u.scn, identities: a.identities })}\n`;
        } else if (u.scn) {
          log(`laru: applying ${u.scn} for ${u.flows.map((f) => f.slug).join(', ')}\n`);
          const a = await applyScenario(ws, u.scn, { env: o.env, confirm: true }); // said yes in `confirmRun`, or the env keeps nothing
          given = `KS_SCENARIO_JSON=${JSON.stringify({ scenario: u.scn, identities: a.identities })}\n`;
        }
        const runner = await startRunner(ws, o.env, runLabel, id, out, join(dir, `.runner-${i}.env`), `KS_RUN=${id}\nKS_BASE_URL=${baseUrl(ws, o.env, runLabel)}\n${Object.keys(perFlow).length ? `KS_BASE_URLS_JSON=${JSON.stringify(perFlow)}\n` : ''}${Object.keys(limits).length ? `KS_FLOW_TIMEOUTS_JSON=${JSON.stringify(limits)}\n` : ''}KS_FLOW_VARS_JSON=${JSON.stringify(await flowsVars(ws))}\nKS_RETRIES=${o.retries ?? 0}\n${hold ? `KS_STEP_HOLD_MS=${hold}\n` : ''}${o.pwTrace ? 'KS_PW_TRACE=1\n' : ''}KS_EVENTS=/ks/out/events-${i}.jsonl\n${i ? `KS_RESULTS=/ks/out/results-${i}\nKS_SHARD=${i}\n` : ''}${given}`, u.flows.map((f) => f.spec));
        runners.add(runner);
        const [raw] = await dockerJson<any[]>(['inspect', runner]);
        runnerIps[i] = Object.values(raw.NetworkSettings?.Networks ?? {}).map((n: any) => n.IPAddress).find(Boolean) ?? '';
        const tag = units.length > 1 ? `[${i}] ` : '';
        const follow = dockerStream(['logs', '-f', runner], (l) => log(tag + masker.text(l) + '\n'));
        exit = Math.max(exit, Number((await docker(['wait', runner])).trim()));
        await follow;
        await docker(['rm', '-f', runner]).catch(() => undefined);
        runners.delete(runner);
      };
      const tick = setInterval(pump, 400);
      const t0 = Date.now();
      try {
        // plain and seeded units play at once, a few runners at a time; exclusive scenarios play alone, one after the other, at the end
        const together = units.map((u, i) => [u, i] as const).filter(([u]) => !u.scn || u.seed);
        const width = Math.max(shards.length, await workersFor(o.workers), 1);
        const queue = [...together];
        await Promise.all(Array.from({ length: Math.min(width, queue.length) }, async () => { for (let next = queue.shift(); next; next = queue.shift()) await play(next[1], next[0]); }));
        for (const [i, u] of units.entries()) if (u.scn && !u.seed) await play(i, u);
      } finally {
        clearInterval(tick);
        // the last lines may have landed after the last tick; the raw per-runner files go once copied
        pump();
        units.forEach((_, i) => rmSync(join(dir, 'out', `events-${i}.jsonl`), { force: true }));
      }
      if (lost) run.error = [run.error, `${lost} line(s) the runner wrote could not be kept: its events or log file is a link, or a line is not JSON`].filter(Boolean).join('. ');
      if (units.length > 1) log(`laru: ${shards.length} runner(s) at once for ${plain.length} flow(s), ${seeded.length} seeded with their scenario beside them, then ${exclusive.length} exclusive\n`);
      const t1 = Date.now();
      // what a mail or SMS sink learned while the tests ran (its codes, its links' tokens) is masked in everything the run kept: the masker made at the start did not know it
      masker = withFields(envMasker(ws, o.env, runLabel));
      maskOutput(out, masker);

      // evidence: the window's traffic, SQL, Kafka and logs, masked, assembled per flow.
      phase('evidence');
      const captured = await capture(ws, o.env, runLabel, t0 - 1000, t1 + 2000, masker, dir);
      const ev = readEvents(ws, id);
      if (exit !== 0 && !ev.some((e) => e.e === 'test-end')) throw new Error(`the runner exited with ${exit} before any test ran; see .laru/runs/${id}/out/runner.log`);
      let map = null;
      try { map = loadGraph(ws).map; } catch { /* no map: participants keep their names */ }
      // Each recorded story's own offset, from the marker it drew at a known instant (ffmpeg).
      const offsets: Record<string, number> = {};
      for (const e of ev) {
        if (e.e !== 'marker') continue;
        const end = ev.find((x) => x.e === 'test-end' && x.test === e.test) as { video?: string } | undefined;
        const v0 = ev.find((x) => x.e === 'video-t0' && x.test === e.test)?.t;
        const video = end?.video && runnerFile(out, relative('/ks/out', end.video));
        if (!video || v0 === undefined) continue;
        const frame = await firstMagenta(video).catch(() => null);
        if (frame) offsets[e.test] = Math.round(e.t - v0 - frame);
      }
      run.videoOffsets = offsets;
      // The test's other screens, each with its own video and marker: where its clock stands against the trace's, the same way.
      const screenOffsets: Record<string, number> = {};
      for (const e of ev) {
        if (e.e !== 'test-end') continue;
        for (const s of e.screens ?? []) {
          const video = s.video && runnerFile(out, relative('/ks/out', s.video));
          if (!video || s.t0 === undefined || s.marker === undefined) continue;
          const frame = await firstMagenta(video).catch(() => null);
          if (frame) screenOffsets[`${e.test}|${s.name}`] = Math.round(s.marker - s.t0 - frame);
        }
      }
      const observed: Array<{ s: string; p: string; o: string }> = [];
      for (const f of toRun) {
        const mine = new Set(ev.filter((b) => b.e === 'test-begin' && b.file.endsWith(`/${f.slug}.spec.ts`)).map((b) => (b as { test: string }).test));
        const fileEv = ev.filter((e) => !('test' in e) || mine.has(e.test));
        const expected = Object.fromEntries(f.steps.map((s, i) => [i + 1, String(s.expected ?? '')]));
        // Every test of the run bounds the windows; only this flow's become its traces.
        const { traces, observed: obs } = assemble({ run: id, flow: f.slug, env: o.env, only: (t) => mine.has(t), stepsTotal: f.steps.length, concurrent: units.filter((u) => !u.scn || u.seed).length > 1, events: ev, traffic: captured.traffic, sql: captured.sql, kafka: captured.kafka, logs: captured.logs, peers: captured.peers, runnerIp: runnerIps[0], runnerIps, runnerIpOf: (t) => runnerIps[unitOf.get(t) ?? 0], gatewayIp: captured.gateways[0], gatewayIps: captured.gateways, hybrid: loadEnvSpec(ws, o.env).hybrid, map: map ?? undefined, videoOffsetMs: run.videoOffsetMs, offsets, screenOffsets, expected });
        observed.push(...obs);
        const story = traces.find((t) => fileEv.some((e) => e.e === 'test-begin' && e.title === t.test && e.story)) ?? traces[0];
        keepEvidence(dir, f.slug, traces, story);
        // the story against the flow's approved behavior, when it has one
        const drift = story ? (() => { try { return behaviorDrift(ws, id, f.slug); } catch { return null; } })() : null;
        const fixed = fixedOf(lastTraces(ws, f.slug), traces);
        // «verde»: every test played and only its known deviations (`// app:`) failed; that counts as passed, with how many it carries
        const known = traces.reduce((n, t) => n + (t.status === 'failed' ? (t.failure?.known ?? 0) : 0), 0);
        // how many mail or SMS the story's app sent: `laru check` asks a flow that provokes them to check them
        const msg = (story?.exchanges ?? []).filter((x) => x.msg && !x.msg.cb).length;
        run.results[f.slug] = { status: !traces.length ? 'error' : traces.every(isGreen) ? 'passed' : 'failed', ...(known ? { known } : {}), ...(fixed.length ? { fixed } : {}), ms: traces.reduce((s, t) => s + t.durationMs, 0), steps: story?.steps.length, failedStep: story?.failure?.step, trace: story ? `flows/${f.slug}/trace.json` : undefined, video: story?.video ? `flows/${f.slug}/video.webm` : undefined, ...(drift ? { drift: drift.drifts.length } : {}) };
        appendFileSync(join(runsDir(ws), 'index.jsonl'), JSON.stringify({ run: id, flow: f.slug, status: run.results[f.slug].status, ms: run.results[f.slug].ms, at: run.startedAt, key: keys[f.slug], env: o.env, ...(msg ? { msg } : {}), ...(known ? { known } : {}), ...(fixed.length ? { fixed } : {}) }) + '\n');
      }
      recordObserved(ws, id, observed);
      // What the runner leaves of media is never served (/api/run-file serves flows/ and raw/ only): it goes.
      for (const r of readdirSync(out).filter((n) => RESULTS.test(n))) dropRawMedia(join(out, r));
      const results = Object.values(run.results);
      run.status = results.some((r) => r.status === 'error') ? 'error' : results.some((r) => r.status === 'failed') ? 'failed' : 'passed';
    }, () => o.onEvent?.({ e: 'phase', phase: 'queued', t: Date.now() }), envLock(ws, o.env, runLabel));
  } catch (e) {
    run.status = 'error';
    run.error = (e as Error).message;
  } finally {
    if (runners.size) await docker(['rm', '-f', ...runners]).catch(() => undefined);
    if (o.ephemeral) { phase('destroy'); await destroyByLabel(ws, { env: o.env, run: id }).catch(() => undefined); forgetValues(ws, o.env, id); }
    run.phase = 'done';
    run.endedAt = new Date().toISOString();
    save();
  }
  // Each flow that passed becomes its shared evidence (evidence/<flow>/), the one git carries to the team.
  for (const [slug, r] of Object.entries(run.results)) if (r.status === 'passed') try { shareEvidence(ws, id, slug); } catch { /* the run stands without it */ }
  // Retention runs after every run; this one is the newest of its flows, so it stays.
  await prune(ws, { what: ['runs'] }).catch(() => undefined);
  return run;
}

/**
 * A flow's evidence in flows/<slug>/: the story's video and each step's screenshot moved, not copied, out of the
 * runner's results (the evidence keeps the one copy), then the story's trace and its cases naming them.
 */
export function keepEvidence(dir: string, slug: string, traces: Trace[], story: Trace | undefined): void {
  const out = join(dir, 'flows', slug), from = join(dir, 'out');
  mkdirSync(out, { recursive: true });
  if (story?.video) {
    // the path is the runner's word: only a real file of out/ moves
    const host = runnerFile(from, relative('/ks/out', story.video));
    if (host) { renameSync(host, join(out, 'video.webm')); story.video = 'video.webm'; } else story.video = undefined;
  }
  // The other screens' videos, the same way: `video-<screen>.webm` beside the story's.
  for (const t of traces) for (const sc of t.screens ?? []) {
    const host = t === story && sc.video ? runnerFile(from, relative('/ks/out', sc.video)) : undefined;
    if (host) { renameSync(host, join(out, `video-${sc.name}.webm`)); sc.video = `video-${sc.name}.webm`; } else sc.video = undefined;
  }
  let left = runnerFiles(from);
  // Playwright's own trace (only when the run asked): the story's is trace.zip, the cases' trace-<n>.zip. It is not masked.
  traces.forEach((t, i) => {
    // the path is the runner's word, as the video's: only a real file of out/ moves
    const host = t.pwTrace && runnerFile(from, relative('/ks/out', t.pwTrace));
    if (!host) { t.pwTrace = undefined; return; }
    const name = t === story ? 'trace.zip' : `trace-${i + 1}.zip`;
    renameSync(host, join(out, name));
    t.pwTrace = name;
    left = left.filter((f) => f !== relative(from, host));
  });
  for (const t of traces) for (const s of t.steps) {
    const shot = findFile(left, `s${s.n}.png`, t.test);
    if (shot) { renameSync(join(from, shot), join(out, `s${s.n}.png`)); s.screenshot = `s${s.n}.png`; left = left.filter((f) => f !== shot); }
  }
  if (story) writeFileSync(join(out, 'trace.json'), JSON.stringify(story));
  const others = traces.filter((t) => t !== story);
  if (others.length) writeFileSync(join(out, 'cases.json'), JSON.stringify(others));
}

/** Every video and screenshot under the runner's results folder: the evidence has moved its own into flows/. */
export function dropRawMedia(results: string): void {
  const out = dirname(results);
  for (const f of runnerFiles(out, basename(results))) if (/\.(webm|png|zip)$/.test(f)) unlinkSync(join(out, f));
}

/** The file called `name` among `files` (paths of out/): the one whose path holds the test's slug, else the only one. */
function findFile(files: string[], name: string, hint: string): string | undefined {
  const slug = hint.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20);
  const hits = files.filter((f) => basename(f) === name);
  return hits.find((h) => h.toLowerCase().includes(slug)) ?? (hits.length === 1 ? hits[0] : undefined);
}

/**
 * What the env saw between two instants, masked, from the tap's journal, Postgres' log, Kafka's segments and each
 * service's log. With `dir` the masked slices are also kept in its raw/; without it (a live session) nothing is written.
 * `kafka: false` skips the broker's segments, the one slow source (a JVM per read, about 0.8 s).
 */
/**
 * What a live session's reads keep between them, so each asks Docker only for what is new: the containers and the
 * networks' gateways (asked again after 10 s), each container's log lines up to where the last read stopped, and where
 * each broker keeps its dump tool. A session reads about every second; Docker Desktop on Windows hangs when every read
 * asks for everything again.
 */
export interface CaptureMemo { at: number; cs: ContainerState[]; gateways: string[]; logs: Map<string, { until: number; lines: string[] }>; kafkaBin: Map<string, string> }
export const captureMemo = (): CaptureMemo => ({ at: 0, cs: [], gateways: [], logs: new Map(), kafkaBin: new Map() });
/** At most `n` of `f` running at once: Docker is asked a few things at a time, not one per container all at once. */
async function pool<T>(xs: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) await f(xs[i++]); }));
}

export async function capture(ws: Workspace, env: string, run: string | undefined, from: number, to: number, m: Masker, dir?: string, o: { kafka?: boolean; memo?: CaptureMemo } = {}) {
  const tapDir = run ? join(envDir(ws, env), 'runs', run, 'tap') : join(envDir(ws, env), 'tap');
  const learned = existsSync(join(tapDir, 'learned.json'));
  // a line the tap wrote before it learned a code carries it as it came: read again with what it learned (an env with no sink pays nothing)
  const again = (r: TrafficRecord): TrafficRecord => { if (!learned) return r; try { return JSON.parse(m.text(JSON.stringify(r))) as TrafficRecord; } catch { return r; } };
  const traffic = trafficSince(['traffic.jsonl.1', 'traffic.jsonl'].map((f) => join(tapDir, f)), from).filter((r) => r.t0 <= to).map(again);
  const memo = o.memo;
  let all: ContainerState[], gateways: string[];
  if (memo && Date.now() - memo.at < 10_000) ({ cs: all, gateways } = memo);
  else {
    let nets: string[];
    [all, nets] = await Promise.all([inspectEnv(ws, env, run), docker(['network', 'ls', '-q', ...byLabel(ws, { env, run })]).then((s) => s.split('\n').filter(Boolean), () => [] as string[])]);
    // Every network of the env (a joint env has one per project), found by label: their gateways are the host.
    gateways = nets.length ? (await docker(['network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Gateway}} {{end}}', ...nets]).catch(() => '')).split(/\s+/).filter(Boolean) : [];
    if (memo) Object.assign(memo, { at: Date.now(), cs: all, gateways });
  }
  const cs = all.filter((c) => (run ? true : !c.labels[LABEL.run]) && c.service !== 'runner');
  // Every IP of every container: in a joint env a service is on its project's network and maybe others'.
  const peers = Object.fromEntries(cs.flatMap((c) => c.ips.map((ip) => [ip, c.service])));
  const until = new Date(to).toISOString();
  // With a memo, only what came after the last read (2 s back, for lines written late), over the lines kept.
  const logsOf = async (id: string) => {
    const prev = memo?.logs.get(id), since = prev ? Math.max(from, prev.until - 2000) : from, asked = Date.now();
    const out: string[] = [];
    const code = await dockerStream(['logs', '--timestamps', '--since', new Date(since).toISOString(), '--until', until, id], (l) => out.push(l));
    if (!memo) return out;
    // Docker failed (its error came as lines): what was read stays as it was, and the containers are asked again next time
    if (code !== 0) { memo.at = 0; return prev?.lines ?? []; }
    const lines = [...(prev?.lines.filter((l) => !(Date.parse(l.slice(0, l.indexOf(' '))) >= since)) ?? []), ...out];
    memo.logs.set(id, { until: Math.min(asked, to), lines });
    return lines;
  };
  const sql: SqlLine[] = [];
  const kafka: KafkaLine[] = [];
  const logs: ServiceLog[] = [];
  if (dir) mkdirSync(join(dir, 'raw', 'logs'), { recursive: true });
  // Each container (a live session reads this every second), four at a time: its log, and a broker's segments beside it.
  await pool(cs.filter((x) => x.state === 'running' && x.service !== 'ks-tap'), 4, async (c) => {
    const [lines, msgs] = await Promise.all([logsOf(c.id), /kafka/.test(c.image) && o.kafka !== false ? kafkaMessages(c.id, c.service, m, memo) : []]);
    kafka.push(...msgs.filter((k) => k.t >= from && k.t <= to));
    if (/postgres/.test(c.image)) {
      for (const s of parsePgLog(lines, c.service)) sql.push({ ...s, statement: m.text(s.statement), params: s.params && m.text(s.params), error: s.error && m.text(s.error) });
      return;
    }
    const masked: string[] = [];
    for (const l of lines) {
      const sp = l.indexOf(' ');
      const t = Date.parse(l.slice(0, sp));
      const text = m.text(l.slice(sp + 1));
      masked.push(`${l.slice(0, sp)} ${text}`);
      if (!Number.isNaN(t)) logs.push({ service: c.service, t, line: text });
    }
    if (dir) writeFileSync(join(dir, 'raw', 'logs', `${c.service}.log`), masked.join('\n'));
  });
  // in time order, as the serial reading left them: assemble breaks ties by position
  sql.sort((a, b) => a.t1 - b.t1);
  logs.sort((a, b) => a.t - b.t);
  kafka.sort((a, b) => a.t - b.t || a.offset - b.offset);
  if (dir) {
    writeFileSync(join(dir, 'raw', 'traffic.jsonl'), traffic.map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(join(dir, 'raw', 'sql.jsonl'), sql.map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(join(dir, 'raw', 'kafka.jsonl'), kafka.map((r) => JSON.stringify(r)).join('\n'));
    // the mailbox's messages of the window, masked whole (the mailbox itself shows codes; evidence never does)
    const box = join(tapDir, 'mail', 'messages.jsonl');
    if (existsSync(box)) {
      const lines = readFileSync(box, 'utf8').split('\n').filter((l) => { try { const t = (JSON.parse(l) as { t?: number }).t; return t !== undefined && t >= from && t <= to; } catch { return false; } });
      if (lines.length) writeFileSync(join(dir, 'raw', 'messages.jsonl'), lines.map((l) => m.text(l)).join('\n'));
    }
  }
  return { traffic, sql, kafka, logs, peers, gateways };
}

/**
 * The tap's journal lines whose request began at `from` or later. A line is written when its exchange ends, so the file is only
 * roughly in order of `t0`: reading goes backwards, a block at a time, until a block starts well before `from` (SLACK). A journal
 * of 100 MB is therefore not read whole every second of a live session, only its recent end. `files` are oldest first.
 */
const SLACK_MS = 120_000, BLOCK = 1 << 20;
export function trafficSince(files: string[], from: number): TrafficRecord[] {
  const picked: string[] = [];
  for (const file of [...files].reverse()) {
    if (!existsSync(file)) continue;
    const fd = openSync(file, 'r');
    try {
      const size = fstatSync(fd).size;
      let end = size, text = '', reachedStart = false, enough = false;
      while (end > 0 && !enough) {
        const start = Math.max(0, end - BLOCK), buf = Buffer.alloc(end - start);
        readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8') + text;
        end = start;
        reachedStart = start === 0;
        // a block whose first whole line began before the window (with its slack) means everything older is out of it
        const nl = reachedStart ? -1 : text.indexOf('\n');
        const first = reachedStart ? text : text.slice(nl + 1);
        const head = first.slice(0, first.indexOf('\n') < 0 ? undefined : first.indexOf('\n'));
        if (head) { try { if ((JSON.parse(head) as { t0: number }).t0 < from - SLACK_MS) enough = true; } catch { /* a cut line */ } }
        if (enough && !reachedStart) text = text.slice(nl + 1);
      }
      picked.unshift(text);
      if (enough) break;
    } finally { closeSync(fd); }
  }
  return picked.join('\n').split('\n').filter(Boolean).map((l) => JSON.parse(l) as TrafficRecord).filter((r) => r.t0 >= from);
}

/** Messages of every non-internal topic, read from the broker's own log segments with one kafka-dump-log. */
async function kafkaMessages(container: string, broker: string, m: Masker, memo?: CaptureMemo): Promise<KafkaLine[]> {
  const files = (await docker(['exec', container, 'sh', '-c', 'for d in ${KAFKA_LOG_DIRS:-/tmp/kafka-logs} /var/lib/kafka/data /bitnami/kafka/data; do ls -d "$d"/*/*.log 2>/dev/null; done; true']).catch(() => ''))
    .split('\n').filter((f) => f && !/\/__/.test(f));
  if (!files.length) return [];
  const bin = memo?.kafkaBin.get(container) ?? (await docker(['exec', container, 'sh', '-c', 'command -v kafka-dump-log.sh || ls /opt/kafka/bin/kafka-dump-log.sh /opt/bitnami/kafka/bin/kafka-dump-log.sh 2>/dev/null | head -1']).catch(() => '')).trim();
  if (!bin) return [];
  memo?.kafkaBin.set(container, bin);
  const out = await docker(['exec', '-e', 'KAFKA_HEAP_OPTS=-Xmx96m', container, bin, '--print-data-log', '--files', files.join(',')], { timeoutMs: 60_000 }).catch(() => '');
  const msgs: KafkaLine[] = [];
  for (const section of out.split(/^Dumping /m).slice(1)) {
    const file = section.slice(0, section.indexOf('\n'));
    const tp = /\/([^/]+)-(\d+)\/[^/]+\.log$/.exec(file);
    if (tp) msgs.push(...parseKafkaDump(section, broker, tp[1], Number(tp[2])).map((k) => ({ ...k, key: k.key && m.text(k.key), value: k.value && m.body(k.value, 'application/json') })));
  }
  return msgs;
}

/** Facts a run observed, kept 30 days in .laru/observed.json for the map and impact. */
export function recordObserved(ws: Workspace, run: string, facts: Array<{ s: string; p: string; o: string }>) {
  const f = join(stateDir(ws), 'observed.json');
  const now = new Date().toISOString();
  const cur = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { facts: Array<{ s: string; p: string; o: string; seen: { run: string; at: string; count: number } }> }) : { facts: [] };
  const cutoff = Date.now() - 30 * 86400_000;
  const keep = cur.facts.filter((x) => Date.parse(x.seen.at) > cutoff);
  for (const x of facts) {
    const hit = keep.find((k) => k.s === x.s && k.p === x.p && k.o === x.o);
    if (hit) hit.seen = { run, at: now, count: hit.seen.count + 1 }; else keep.push({ ...x, seen: { run, at: now, count: 1 } });
  }
  writeFileSync(f, JSON.stringify({ facts: keep }, null, 1));
}

/** Starts a run in a detached `laru test … --run <id>` process and returns its id at once; a question for `confirm` comes before it, not as a failed run. */
export async function startRun(ws: Workspace, o: Omit<RunOptions, 'onEvent' | 'id'>): Promise<string> {
  // a session is recording on this env: a single flow whose own env is ready goes there; anything else waits for the session (runFlows)
  let note: string | undefined;
  const rec = o.ephemeral ? undefined : recordingOn(ws, o.env);
  if (rec && o.flows?.length === 1) {
    const own = `f-${o.flows[0].replace(/^flow:/, '')}`;
    if ((await status(ws, own).catch(() => undefined))?.state === 'ready') { note = `Se ejecuta en ${own}, el entorno de este flujo, porque ${o.env} graba la sesión ${rec.id}.`; o = { ...o, env: own }; }
  }
  await confirmRun(ws, o);
  const id = nextId(ws);
  writeFileSync(join(runDir(ws, id), 'run.json'), JSON.stringify({ id, env: o.env, ephemeral: Boolean(o.ephemeral), flows: o.flows ?? [], phase: 'queued', status: 'running', startedAt: new Date().toISOString(), pid: process.pid, results: {}, ...(note ? { note } : {}) } satisfies RunInfo, null, 2));
  const bin = join(import.meta.dirname, '..', '..', '..', 'apps', 'cli', 'bin', 'laru.js');
  const args = [bin, '-C', ws.root, 'test', ...(o.flows ?? []), '--env', o.env, '--run', id, ...(o.ephemeral ? ['--ephemeral'] : []), ...(o.worktree ? ['--worktree'] : []), ...(o.retries ? ['--retries', String(o.retries)] : []), ...(o.pwTrace ? ['--pw-trace'] : []), ...(o.workers ? ['--workers', String(o.workers)] : []), ...(o.confirm ? ['--yes'] : [])];
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return id;
}

/** Stops a run: its runner and, for an ephemeral run, its env, by label. */
export async function cancelRun(ws: Workspace, id: string): Promise<boolean> {
  const r = readRun(ws, id);
  if (!r || r.phase === 'done') return false;
  const ids = (await docker(['ps', '-aq', ...byLabel(ws, { run: id })])).split('\n').filter(Boolean);
  if (ids.length) await docker(['rm', '-f', ...ids]);
  if (alive(r.pid) && r.pid !== process.pid) { try { process.kill(r.pid); } catch { /* gone */ } }
  r.status = 'cancelled'; r.phase = 'done'; r.endedAt = new Date().toISOString();
  writeFileSync(join(runDir(ws, id), 'run.json'), JSON.stringify(r, null, 2));
  if (r.ephemeral) { await destroyByLabel(ws, { env: r.env, run: id }).catch(() => undefined); forgetValues(ws, r.env, id); }
  return true;
}

/** Two runs side by side: exchanges grouped by who called whom with what, and step outcomes per flow. */
export function compareRuns(ws: Workspace, a: string, b: string) {
  const group = (id: string) => {
    const g = new Map<string, { count: number; statuses: Set<number>; ms: number[] }>();
    const r = readRun(ws, id);
    for (const slug of Object.keys(r?.results ?? {})) for (const e of readTrace(ws, id, slug)?.exchanges ?? []) {
      const k = `${slug}|${e.from}|${e.to}|${e.label}`;
      const x = g.get(k) ?? { count: 0, statuses: new Set<number>(), ms: [] };
      x.count++; if (e.status) x.statuses.add(e.status); if (e.t1 !== undefined) x.ms.push(e.t1 - e.t0);
      g.set(k, x);
    }
    return g;
  };
  const p50 = (xs: number[]) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] : undefined);
  const ga = group(a), gb = group(b);
  const rows = [...new Set([...ga.keys(), ...gb.keys()])].map((k) => {
    const [flow, from, to, label] = k.split('|');
    const x = ga.get(k), y = gb.get(k);
    return { flow, from, to, label, a: x && { count: x.count, statuses: [...x.statuses], p50: p50(x.ms) }, b: y && { count: y.count, statuses: [...y.statuses], p50: p50(y.ms) } };
  });
  const steps = (id: string) => Object.fromEntries(Object.keys(readRun(ws, id)?.results ?? {}).map((slug) => [slug, (readTrace(ws, id, slug)?.steps ?? []).map((s) => `${s.n}:${s.status}`)]));
  return { exchanges: rows, steps: { a: steps(a), b: steps(b) } };
}

/**
 * The video clock against the VM clock: a calibration test draws a magenta frame at a known instant, and the host's
 * ffmpeg finds the first frame where it shows. offset = drawn − videoT0 − frame time. Several runs give the spread.
 */
export async function calibrate(ws: Workspace, runs = 3, onLine?: (l: string) => void): Promise<{ offsets: number[]; mean: number; spread: number }> {
  await ensureRunner(onLine);
  const packages = join(import.meta.dirname, '..', '..');
  const offsets: number[] = [];
  for (let i = 0, tries = 0; offsets.length < runs; i++) {
    if (++tries > runs * 3) throw new Error('the calibration video kept starting after the marker');
    const out = join(stateDir(ws), 'calibrate', String(i));
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const code = await dockerStream(['run', '--rm', '--init', '--shm-size=1g', '--network', 'none', '--label', `${LABEL.workspace}=${workspaceKey(ws)}`, '--label', `${LABEL.tool}=calibrate`,
      '-v', `${packages}:/ks/packages:ro`, '-v', `${out}:/ks/out`, RUNNER_IMAGE, 'npx', 'playwright', 'test', '-c', '/ks/packages/trace/calibrate/calibrate.config.ts'], (l) => onLine?.(l));
    if (code !== 0) throw new Error(`calibration run ${i + 1} failed (exit ${code})`);
    const mark = JSON.parse((readRunnerFile(out, 'marker.jsonl') ?? '').trim().split('\n').pop()!) as { videoT0: number; drawn: number };
    const video = findFile(runnerFiles(out, 'results'), 'video.webm', 'calibrate');
    if (!video) throw new Error('the calibration run left no video');
    const frame = await firstMagenta(join(out, video));
    if (frame === 0) { onLine?.(`run ${i + 1}: the video started after the marker; measured again`); continue; }
    offsets.push(Math.round(mark.drawn - mark.videoT0 - frame));
  }
  const mean = Math.round(offsets.reduce((a, b) => a + b, 0) / offsets.length);
  return { offsets, mean, spread: Math.max(...offsets) - Math.min(...offsets) };
}

/**
 * The ffmpeg that comes with Laru (ffmpeg-static, downloaded on install), or the machine's. It is optional: where it has
 * no build, or its download failed, the install goes on without it, so it may not be there at all.
 */
function bundledFfmpeg(): string | undefined {
  try { const p = createRequire(import.meta.url)('ffmpeg-static') as string | null; return p && existsSync(p) ? p : undefined; } catch { return undefined; }
}
export const FFMPEG = bundledFfmpeg() ?? 'ffmpeg';

/** ms from the start of a video to its first magenta frame (U and V both high), with ffmpeg. */
function firstMagenta(video: string): Promise<number> {
  return new Promise((ok, fail) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', video, '-vf', 'crop=64:64:608:328,showinfo', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c: Buffer) => { err += c; });
    p.on('error', () => fail(new Error('no ffmpeg: reinstall Laru (pnpm install) or install ffmpeg')));
    p.on('close', () => {
      for (const l of err.split('\n')) {
        const m = /pts_time:([\d.]+).*?mean:\[(\d+) (\d+) (\d+)\]/.exec(l);
        if (m && Number(m[3]) > 170 && Number(m[4]) > 170) return ok(Math.round(Number(m[1]) * 1000));
      }
      fail(new Error('no magenta frame found in the calibration video'));
    });
  });
}

