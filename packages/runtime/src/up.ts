/**
 * An env's life. `up`: snapshot the repo at the env's ref, read its compose, check the values, render, pull and build
 * only what is missing, `compose up -d`, then wait service by service. `status`, `logs`, `down`. Containers are found
 * by this workspace's labels, never by name, and nothing without those labels is ever touched.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { parse } from 'yaml';
import { IMAGE_KINDS, loadGraph, WorkspaceError, type Graph, type Workspace } from '@laru/core';
import { writeMaskFile } from '@laru/trace';
import { closure, importCompose, interpolations, renderCompose, type ComposeDoc, type RenderContext, type Service, type Target } from './compose.ts';
import { readConfig } from './config.ts';
import { prune } from './disk.ts';
import { destroyByLabel, docker, dockerStream, envLock, hold, inspectEnv, LABEL, machineLock, stats, withLock, workspaceKey, type ContainerState, type DestroyReport } from './docker.ts';
import { checkShare, envDir, envKeys, envMasker, forgetValues, isInstance, jointSpec, loadEnvSpec, projectName, readState, translateSpec, writeState, type EnvState } from './env.ts';
import { joinComposes, jointRouting } from './join.ts';
import { nameOf, provisional } from './names.ts';
import { caDir, ensureTruststore, leafFor } from './tls.ts';
import * as kafka from './explore/kafka.ts';
import { decide, type Held } from './admission.ts';
import { ensureReader, hasSnapshot, seed, snapshot, stores as dbStores } from './db.ts';
import { contextKey, resolveEnvRef, snapshotRepo } from './snapshot.ts';
import { SMTP_PORTS, sinksOf, type EnvSpec, type TapConfig, type TapRules } from './types.ts';
import { injection, missingVars } from './vault.ts';

export type Health = 'waiting' | 'starting' | 'healthy' | 'running' | 'unhealthy' | 'exited' | 'oom' | 'done' | 'host' | 'absent';
export type Built = 'cached' | 'built' | 'image';

export interface ServiceStatus {
  service: string;
  /** compose name: `<svc>-real` when the tap fronts it */
  compose: string;
  mode: 'container' | 'host' | 'job' | 'tap';
  health: Health;
  built?: Built;
  image?: string;
  note?: string;
  container?: ContainerState;
  cpu?: number;
  memBytes?: number;
  memLimit?: number;
}

export interface Address { service: string; kind: 'http' | 'tcp' | 'store'; url: string }

export type EnvEvent =
  | { t: number; kind: 'phase'; phase: string; ms?: number; note?: string }
  | { t: number; kind: 'log'; source: string; line: string }
  | { t: number; kind: 'service'; service: string; health: Health; note?: string }
  | { t: number; kind: 'error'; message: string; service?: string; logs?: string[]; admission?: Admission }
  | { t: number; kind: 'ready'; ms: number };

/**
 * Why an up was not admitted: `maxEnvs` persistent envs already run, or the memory the others use plus what this env
 * needed at its last ready passes 90% of Docker's. `others` are the envs running (by their labels: workspace key, app).
 */
export interface Admission { kind: 'maxEnvs' | 'memory'; max?: number; needBytes?: number; totalBytes?: number; foreignBytes?: number; others: Array<{ key: string; app: string; env: string; memBytes?: number }>; /** an env of this workspace whose stop would make it fit */ offer?: { app: string; env: string; memBytes: number } }

export class EnvError extends Error {
  readonly service?: string;
  readonly logs?: string[];
  readonly issues?: Array<{ level: string; key: string; message: string; at?: string }>;
  readonly admission?: Admission;
  constructor(message: string, extra: { service?: string; logs?: string[]; issues?: EnvError['issues']; admission?: Admission } = {}) {
    super(message);
    this.service = extra.service; this.logs = extra.logs; this.issues = extra.issues; this.admission = extra.admission;
  }
}

/** `force`: skip the memory admission (never maxEnvs). */
/** `rebuild`: the services whose image is built again without the cache and then replaced (`all`: every one built from source). */
export interface UpOptions { env: string; services?: string[]; hybrid?: string[]; worktree?: boolean; onEvent?: (e: EnvEvent) => void; run?: string; force?: boolean; rebuild?: string[]; /** stop the env the refusal offers, and try again */ stopOffered?: boolean }

/** What a rebuild without cache does, said before it does it. */
export const rebuildText = (rebuild: string[]) => `Se reconstruyen sin caché ${rebuild.includes('all') ? 'todos los servicios que se construyen del código' : rebuild.join(', ')} y se vuelven a crear sus contenedores; el resto del entorno y los datos de sus bases se conservan.`;
export interface UpResult { env: string; project: string; ms: number; timings: Record<string, number>; changed: boolean; services: ServiceStatus[]; addresses: Address[]; warnings: string[] }

const tryGraph = (ws: Workspace): Graph | null => { try { return loadGraph(ws); } catch { return null; } };
const NOT_INTERCEPTED = new Set(['relational', 'document', 'cache', 'queue']);
const ENTRANCE = 7999;

/** Container ports a compose service listens on: compose ports and expose, then the Dockerfile's EXPOSE. */
export function listenPorts(s: Service): number[] {
  const out = new Set<number>();
  for (const p of s.ports ?? []) { const n = Number(typeof p === 'object' ? p.target : String(p).split(':').pop()?.split('/')[0]); if (n) out.add(n); }
  for (const e of s.expose ?? []) { const n = parseInt(String(e), 10); if (n) out.add(n); }
  if (s.build?.context) {
    const file = join(s.build.context, s.build.dockerfile ?? 'Dockerfile');
    if (existsSync(file)) for (const m of readFileSync(file, 'utf8').matchAll(/^\s*EXPOSE\s+(.+)$/gim)) for (const w of m[1].split(/\s+/)) { const n = parseInt(w, 10); if (n) out.add(n); }
  }
  return [...out].sort((a, b) => a - b);
}

/** DynamoDB Local (amazon/dynamodb-local, its ECR copy, dynamo-local-admin) speaks HTTP on 8000. */
const DYNAMO = /dynamodb|dynamo-local/;

/**
 * What the tap fronts (built services, file/search/directory stores, DynamoDB Local, other images over TCP), which
 * stores are which, and the readiness checks a fronted image needs because it has no wget (DynamoDB Local has curl).
 */
export function targetsOf(doc: ComposeDoc, names: string[]): { targets: Target[]; stores: Record<string, 'postgres' | 'kafka' | 'other'>; health: Record<string, { cmd: string }> } {
  const targets: Target[] = [];
  const stores: Record<string, 'postgres' | 'kafka' | 'other'> = {};
  const health: Record<string, { cmd: string }> = {};
  for (const name of names) {
    const s = doc.services[name];
    const ports = listenPorts(s);
    if (s.build) { if (ports.length) targets.push({ svc: name, ports, proto: 'http' }); continue; }
    const kind = IMAGE_KINDS.find(([re]) => re.test(String(s.image ?? '')))?.[2];
    const dynamo = DYNAMO.test(String(s.image ?? ''));
    if (kind && NOT_INTERCEPTED.has(kind) && !dynamo) {
      if (!ports.length) continue;
      stores[name] = /postgres/.test(s.image) ? 'postgres' : /kafka/.test(s.image) ? 'kafka' : 'other';
      // Postgres is fronted too, read as it passes: each statement's rows reach the trace (the server's log still says when and who)
      if (stores[name] === 'postgres') targets.push({ svc: name, ports, proto: 'pg' });
      continue;
    }
    if (dynamo && !ports.length) ports.push(8000);
    if (dynamo && !s.healthcheck) health[name] = { cmd: `(wget -qSO/dev/null http://127.0.0.1:${ports[0]}/ 2>&1 || curl -sSI http://127.0.0.1:${ports[0]}/ 2>&1) | grep -q HTTP/` };
    if (ports.length) targets.push({ svc: name, ports, proto: kind || dynamo ? 'http' : 'tcp' });
  }
  return { targets, stores, health };
}

const canBind = (port: number) => new Promise<boolean>((res) => {
  const s = createServer().once('error', () => res(false));
  s.listen(port, '127.0.0.1', () => s.close(() => res(true)));
});
const accepts = (port: number) => new Promise<boolean>((res) => {
  const c = connect(port, '127.0.0.1');
  const done = (ok: boolean) => { c.destroy(); res(ok); };
  c.once('connect', () => done(true)).once('error', () => done(false)).setTimeout(300, () => done(false));
});

async function freePort(from: number, taken: Set<number>): Promise<number> {
  for (let p = from; p < 65535; p++) if (!taken.has(p) && (await canBind(p))) { taken.add(p); return p; }
  throw new EnvError(`no free port from ${from}`);
}

const ipv4 = (a: string) => a.split('.').reduce((n, o) => n * 256 + Number(o), 0);
/** Every Docker network with its address ranges and Laru labels (none for a network that is not Laru's). */
async function networks(): Promise<Array<{ name: string; ranges: Array<readonly [number, number]>; ws: string; app: string; env: string; run: string }>> {
  const ids = (await docker(['network', 'ls', '-q'])).split('\n').filter(Boolean);
  if (!ids.length) return [];
  const out = await docker(['network', 'inspect', '--format', `{{.Name}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}|{{index .Labels "${LABEL.workspace}"}}|{{index .Labels "${LABEL.app}"}}|{{index .Labels "${LABEL.env}"}}|{{index .Labels "${LABEL.run}"}}`, ...ids]);
  return out.split('\n').filter(Boolean).map((l) => {
    const [name, subnets, ws, app, env, run] = l.split('|');
    const ranges = subnets.split(/\s+/).filter((c) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(c)).map((c) => { const [a, bits] = c.split('/'); const size = 2 ** (32 - Number(bits)); const start = Math.floor(ipv4(a) / size) * size; return [start, start + size] as const; });
    return { name, ranges, ws: ws ?? '', app: app ?? '', env: env ?? '', run: run ?? '' };
  });
}
const gib = (b: number) => `${(b / 2 ** 30).toFixed(1)} GiB`;

const secs = (d: unknown, dflt: number) => {
  if (d === undefined || d === null) return dflt;
  let s = 0;
  for (const [, n, u] of String(d).matchAll(/([\d.]+)(ms|s|m|h)/g)) s += Number(n) * ({ ms: 0.001, s: 1, m: 60, h: 3600 } as Record<string, number>)[u];
  return s;
};
/** The longest a service may take to be healthy, from its own healthcheck. */
const deadlineOf = (doc: ComposeDoc) => Math.max(60, ...Object.values(doc.services).map((s) => {
  const h = s.healthcheck;
  return h && !h.disable ? secs(h.start_period, 0) + secs(h.interval, 30) * (h.retries ?? 3) + secs(h.timeout, 30) : 0;
})) + 60;

function classify(c: ContainerState | undefined, s: Service): Health {
  if (!c) return 'waiting';
  if (c.oomKilled) return 'oom';
  if (c.state === 'created') return 'waiting';
  if (c.state === 'exited' || c.state === 'dead') return c.exitCode === 0 && !s.healthcheck ? 'done' : 'exited';
  if (c.health === 'healthy') return 'healthy';
  if (c.health === 'unhealthy') return 'unhealthy';
  if (c.health === 'starting' || c.state === 'restarting') return 'starting';
  return 'running';
}
const OK = new Set<Health>(['healthy', 'running', 'done', 'host']);
const FAILED = new Set<Health>(['unhealthy', 'exited', 'oom']);

const normImage = (i: string) => { const x = i.replace(/^docker\.io\/(library\/)?/, ''); return /:[^/]+$/.test(x) || x.includes('@') ? x : `${x}:latest`; };

async function lastLines(id: string, n = 30): Promise<string[]> {
  const lines: string[] = [];
  await dockerStream(['logs', '--tail', String(n), id], (l) => lines.push(l)).catch(() => 0);
  return lines;
}

/** Where an up writes its events: the env's own file, or the run's — an instance never rewrites the base env's. */
export const eventsFile = (ws: Workspace, env: string, run?: string) => join(envDir(ws, env), ...(run ? ['runs', run] : []), 'events.jsonl');

function eventSink(ws: Workspace, env: string, onEvent?: (e: EnvEvent) => void, run?: string) {
  const file = eventsFile(ws, env, run);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
  // Build, pull and compose lines can echo values: everything that reaches the file or a screen is masked, with the
  // values of the last up until up has written this one's mask.json and set `emit.masker` from it.
  const emit = (e: { [K in EnvEvent['kind']]: Omit<Extract<EnvEvent, { kind: K }>, 't'> }[EnvEvent['kind']]) => {
    const m = emit.masker;
    const ev = { t: Date.now(), ...e } as EnvEvent;
    if (ev.kind === 'log') ev.line = m.text(ev.line);
    if (ev.kind === 'error') { ev.message = m.text(ev.message); ev.logs = ev.logs?.map((l) => m.text(l)); }
    if (ev.kind === 'service' && ev.note) ev.note = m.text(ev.note);
    appendFileSync(file, JSON.stringify(ev) + '\n');
    onEvent?.(ev);
  };
  emit.masker = envMasker(ws, env, run, { allowMissing: true });
  return emit;
}

/** Refuses when the project's names are held by something without this workspace's label. */
async function guardForeign(ws: Workspace, project: string, names: { networks: string[]; volumes: string[] }) {
  const key = workspaceKey(ws);
  const foreign: string[] = [];
  const rows = async (args: string[]) => (await docker(args)).split('\n').filter(Boolean).map((l) => l.split('|'));
  for (const [id, name, ws_] of await rows(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', `{{.ID}}|{{.Names}}|{{.Label "${LABEL.workspace}"}}`]))
    if (ws_ !== key) foreign.push(`container ${name} (${id})`);
  for (const [name, ws_] of await rows(['network', 'ls', '--format', `{{.Name}}|{{.Label "${LABEL.workspace}"}}`]))
    if (names.networks.includes(name) && ws_ !== key) foreign.push(`network ${name}`);
  for (const [name, ws_] of await rows(['volume', 'ls', '--format', `{{.Name}}|{{.Label "${LABEL.workspace}"}}`]))
    if (names.volumes.includes(name) && ws_ !== key) foreign.push(`volume ${name}`);
  if (foreign.length) throw new EnvError(`these are not Laru's and use this env's names; rename or remove them yourself:\n  ${foreign.join('\n  ')}`);
}

/**
 * What every running Laru container is, from one `docker ps` by label, split into this env's own and the others':
 * the host ports the others publish (claims) and the envs they belong to.
 */
async function claims(ws: Workspace, env: string, run?: string) {
  const key = workspaceKey(ws);
  const rows = (await docker(['ps', '--filter', `label=${LABEL.workspace}`, '--format', `{{.ID}}|{{.Label "${LABEL.workspace}"}}|{{.Label "${LABEL.app}"}}|{{.Label "${LABEL.env}"}}|{{.Label "${LABEL.run}"}}|{{.CreatedAt}}|{{.Ports}}`]))
    .split('\n').filter(Boolean).map((l) => { const [id, w, app, e, r, createdAt, ports] = l.split('|'); return { id, key: w, app, env: e, run: r, createdAt, ports: ports ?? '' }; });
  const mineRow = (x: { key: string; env: string; run: string }) => x.key === key && x.env === env && x.run === (run ?? '');
  const others = rows.filter((x) => !mineRow(x));
  const ports = new Map<number, string>();
  for (const x of others) for (const m of x.ports.matchAll(/:(\d+)->/g)) ports.set(Number(m[1]), `${x.app}/${x.env}${x.run ? ` (run ${x.run})` : ''}`);
  return { running: rows.some(mineRow), mine: rows.filter(mineRow).map((x) => x.id), others, ports };
}

/** What every running Laru env holds on this machine: its host ports and subnets, by workspace key, env and run. */
export async function heldByEnvs(): Promise<Array<{ key: string; app: string; env: string; run: string; ids: string[]; ports: number[]; subnets: string[]; since: string }>> {
  const rows = (await docker(['ps', '--filter', `label=${LABEL.env}`, '--format', `{{.ID}}|{{.Label "${LABEL.workspace}"}}|{{.Label "${LABEL.app}"}}|{{.Label "${LABEL.env}"}}|{{.Label "${LABEL.run}"}}|{{.CreatedAt}}|{{.Ports}}`])).split('\n').filter(Boolean);
  const nets = await networks();
  const out = new Map<string, { key: string; app: string; env: string; run: string; ids: string[]; ports: number[]; subnets: string[]; since: string }>();
  for (const l of rows) {
    const [id, key, app, env, run, created, ports] = l.split('|');
    const k = `${key}|${env}|${run}`;
    const e = out.get(k) ?? out.set(k, { key, app, env, run, ids: [], ports: [], subnets: [], since: created }).get(k)!;
    e.ids.push(id);
    for (const m of (ports ?? '').matchAll(/:(\d+)->/g)) if (!e.ports.includes(Number(m[1]))) e.ports.push(Number(m[1]));
    if (created < e.since) e.since = created;
  }
  for (const e of out.values()) {
    e.ports.sort((a, b) => a - b);
    e.subnets = nets.filter((n) => n.ws === e.key && n.env === e.env && n.run === e.run).flatMap((n) => n.ranges.map(([a, b]) => `${[24, 16, 8, 0].map((sh) => (a >>> sh) & 255).join('.')}/${32 - Math.log2(b - a)}`));
  }
  return [...out.values()];
}

/** `docker ps` shows a start as «2026-10-26 10:00:00 -0500 -05»: a date `Date` reads. */
const startedOf = (created: string | undefined) => { const m = (created ?? '').match(/^(\S+) (\S+) ([+-]\d\d)(\d\d)/); return m ? `${m[1]}T${m[2]}${m[3]}:${m[4]}` : undefined; };

/**
 * maxEnvs (persistent envs, machine-wide) and memory: what every container on the machine holds now (Laru's and the
 * others'), what an instance still settling will hold, and what this env used at its last ready. When it does not fit,
 * the refusal names who holds it and offers to stop a persistent env of this workspace if that is enough.
 */
async function admit(ws: Workspace, opts: UpOptions, others: Array<{ id: string; key: string; app: string; env: string; run: string; createdAt?: string }>, ownIds: string[] = []) {
  // a flow's environment is an instance: it counts against memory, not against the number of persistent envs
  const persistent = new Map(others.filter((x) => x.env && !x.run && !isInstance(x.env)).map((x) => [`${x.key}|${x.env}`, { key: x.key, app: x.app, env: x.env }]));
  const { maxEnvs } = readConfig();
  if (!opts.run && !isInstance(opts.env) && persistent.size >= maxEnvs) {
    throw new EnvError(`another env is running (${[...persistent.values()].map((o) => `${o.app}/${o.env}`).join(', ')}); stop it with \`laru down\` or raise maxEnvs in ~/.laru/config.yaml`, { admission: { kind: 'maxEnvs', max: maxEnvs, others: [...persistent.values()] } });
  }
  if (opts.force) return;
  const need = readState(ws, opts.env)?.lastMemBytes ?? 0;
  if (!need) return;
  const total = Number((await docker(['info', '--format', '{{.MemTotal}}']).catch(() => '0')).trim()) || 0;
  // an env that is running already holds its memory: «need» is what it will hold, so counting its containers too would count it twice
  const own = (id: string) => ownIds.some((m) => id.startsWith(m) || m.startsWith(id));
  const everything = await stats((await docker(['ps', '-q']).catch(() => '')).split('\n').map((s) => s.trim()).filter((id) => id && !own(id)));
  const by = new Map<string, Held>();
  for (const x of others) {
    const k = `${x.key}|${x.env}|${x.run}`;
    const e = by.get(k) ?? by.set(k, { key: x.key, app: x.app, env: x.env || 'tool', run: x.run, memBytes: 0, startedAt: startedOf(x.createdAt) }).get(k)!;
    e.memBytes += everything.find((u) => x.id.startsWith(u.id) || u.id.startsWith(x.id))?.memBytes ?? 0;
    const s = startedOf(x.createdAt);
    if (s && (!e.startedAt || s > e.startedAt)) e.startedAt = s;
  }
  const mine = workspaceKey(ws);
  const d = decide({
    total, need, laru: [...by.values()], allBytes: everything.reduce((n, u) => n + u.memBytes, 0), mine: { key: mine },
    // an instance settles where its base env settled at its last ready
    settled: (h) => (h.key === mine ? readState(ws, h.env)?.lastMemBytes : undefined),
  });
  if (d.fits) return;
  const list = d.others.map((e) => ({ key: e.key, app: e.app, env: e.run ? `${e.env} (run ${e.run})` : e.env, memBytes: e.memBytes }));
  const foreign = d.foreignBytes > 0.1 * 2 ** 30 ? ` and ${gib(d.foreignBytes)} are held by containers that are not Laru's` : '';
  throw new EnvError(`it does not fit: ${list.map((e) => `${e.app}/${e.env} uses ${gib(e.memBytes)}`).join(' and ') || 'nothing of Laru\'s'}${foreign}; ${ws.app}/${opts.env} needed ${gib(need)} last time and Docker has ${gib(total)}. ${d.offer ? `Stopping ${d.offer.app}/${d.offer.env} (${gib(d.offer.memBytes)}) would make it fit` : 'Stop one, give Docker more memory'}, or --force`,
    { admission: { kind: 'memory', needBytes: need, totalBytes: total, others: list, foreignBytes: d.foreignBytes, ...(d.offer ? { offer: d.offer } : {}) } });
}

export function addressesOf(app: string, cfg: { routes: Array<{ svc: string; ports: number[]; proto: string; net?: string; kind?: string }> }, state: EnvState): Address[] {
  const out: Address[] = [];
  // a joint env repeats a route per network: its addresses come from the `ks` one
  for (const r of cfg.routes.filter((x) => !x.kind && (!x.net || x.net === 'ks'))) {
    r.ports.forEach((p, i) => {
      if (r.proto === 'http' && state.entrance) out.push({ service: r.svc, kind: 'http', url: `http://${r.svc}${i ? `-${p}` : ''}.${app}.localhost:${state.entrance}` });
      else if (state.ports[r.svc]?.[String(p)]) out.push({ service: r.svc, kind: r.proto === 'pg' ? 'store' : 'tcp', url: `127.0.0.1:${state.ports[r.svc][String(p)]}` });
    });
  }
  return out;
}

export async function up(ws: Workspace, opts: UpOptions): Promise<UpResult> {
  const t0 = Date.now();
  const emit = eventSink(ws, opts.env, opts.onEvent, opts.run);
  const timings: Record<string, number> = {};
  let mark = Date.now();
  const phase = (name: string, note?: string) => { const ms = Date.now() - mark; timings[name] = ms; mark = Date.now(); emit({ kind: 'phase', phase: name, ms, note }); };
  let release: (() => void) | undefined; // the machine lock, while this up holds it
  try {
    return await withLock(`up ${ws.app}/${opts.env}`, async () => {
      // 1. Each project at the env's ref, and its compose as compose itself reads it. A project env has one member;
      // a joint env one per project env it joins.
      const base = loadEnvSpec(ws, opts.env);
      if (!base.from && !base.join) throw new WorkspaceError('which compose to start from: `<repo>:<path>`', `envs/${opts.env}.yaml: from`);
      const joint = Boolean(base.join);
      const memberSpecs = joint ? base.join!.map((m) => ({ env: m, spec: loadEnvSpec(ws, m) })) : [{ env: opts.env, spec: base }];
      const members: Array<{ env: string; repo: string; path: string; spec: EnvSpec; snap: Awaited<ReturnType<typeof snapshotRepo>>; composeFile: string; doc: ComposeDoc }> = [];
      for (const m of memberSpecs) {
        const repo = m.spec.from!.repo;
        const at = await resolveEnvRef(ws, repo, opts.worktree ? 'worktree' : base.refs[repo] ?? m.spec.refs[repo]);
        const snap = await snapshotRepo(ws, repo, at);
        members.push({ env: m.env, repo, path: m.spec.from!.path, spec: m.spec, snap, composeFile: join(snap.dir, m.spec.from!.path), doc: { services: {} } });
      }
      phase('snapshot', members.map((m) => `${m.repo}@${m.snap.id.slice(0, 7)}`).join(' · '));
      for (const m of members) {
        if (!existsSync(m.composeFile)) throw new WorkspaceError(`${m.path} is not in ${m.repo}@${m.snap.id.slice(0, 7)}`, `envs/${m.env}.yaml: from`);
        m.doc = await importCompose(m.composeFile);
      }

      // Names: a service is known by its unique name everywhere; with several projects they come from the map.
      const g = ws.repos.length > 1 ? loadGraph(ws) : tryGraph(ws);
      const unique = (repo: string, svc: string) => nameOf(ws, g, repo, svc);
      for (const m of members) for (const svc of Object.keys(m.doc.services)) if (provisional(ws, g, m.repo, svc)) emit({ kind: 'log', source: 'laru', line: `${unique(m.repo, svc)}: provisional name; run laru map` });
      // Each member's file is read against its compose (compose or unique names) and translated to unique names.
      for (const m of members) {
        const names = Object.keys(m.doc.services);
        const to = (n: string) => (m.doc.services[n] ? unique(m.repo, n) : n);
        m.spec = translateSpec(loadEnvSpec(ws, m.env, [...new Set([...names, ...names.map(to)])]), to);
      }
      const joined = joinComposes(members.map((m) => ({ repo: m.repo, env: m.env, doc: m.doc, spec: m.spec })), unique, base.share);
      const normalized = joined.doc;
      let spec: EnvSpec;
      if (joint) {
        const all = Object.keys(joined.repoOf);
        checkShare(opts.env, base.share, joined.repoOf);
        spec = jointSpec(loadEnvSpec(ws, opts.env, all.filter((n) => normalized.services[n])), envKeys(ws, opts.env), members, joined.repoOf, (line) => emit({ kind: 'log', source: 'laru', line }));
      } else spec = members[0].spec;
      if (opts.services) spec.services = opts.services;
      if (opts.hybrid) spec.hybrid = [...new Set([...spec.hybrid, ...opts.hybrid])];
      if (joint && spec.hybrid.length) throw new WorkspaceError(`not in a joint env; use it in ${base.join!.join(' or ')}`, `envs/${opts.env}.yaml: hybrid`);
      for (const h of spec.hybrid) if (!normalized.services[h]) throw new EnvError(`hybrid: "${h}" is not a service of the compose`);
      if (opts.run) spec.persistent = false;
      const included = closure(normalized, spec.services);
      const memberOf = (svc: string) => members.find((m) => m.repo === (joined.repoOf[svc] ?? members[0].repo))!;
      phase('import');

      // 2. Values: nothing starts while one is missing. Each member's issues name its own compose file.
      const infos = included.filter((n) => !spec.hybrid.includes(n)).map((name) => {
        const s = normalized.services[name];
        const environment: Record<string, string | null> = Array.isArray(s.environment)
          ? Object.fromEntries(s.environment.map((e: string) => { const i = e.indexOf('='); return i < 0 ? [e, null] : [e.slice(0, i), e.slice(i + 1)]; }))
          : { ...(s.environment ?? {}) };
        return { name, built: Boolean(s.build), environment, interpolations: interpolations(s), ...(joined.composeOf[name] !== name ? { compose: joined.composeOf[name] } : {}), ...(joint ? { env: joined.envOf[name] } : {}) };
      });
      const issues = members.flatMap((m) => missingVars(ws, opts.env, infos.filter((i) => memberOf(i.name) === m), g, { file: `${m.repo}:${m.path}`, lines: readFileSync(m.composeFile, 'utf8').split('\n') }));
      const errors = issues.filter((i) => i.level === 'error');
      if (errors.length) throw new EnvError(`${errors.length} value${errors.length > 1 ? 's are' : ' is'} missing:\n  ${errors.map((i) => i.message).join('\n  ')}`, { issues });
      const inj = await injection(ws, opts.env, infos, g);
      phase('values');

      // 3. The machine, under its lock until `compose up -d` returns: claims, admission, render, pull, build and up.
      // Health is watched outside it. Persisted subnets and ports are preferences: one another env holds now moves.
      release = await hold(`up ${ws.app}/${opts.env}`, machineLock(), (holder) => emit({ kind: 'log', source: 'laru', line: `waiting for ${holder} to finish` }));
      const project = projectName(ws, opts.env, opts.run);
      const prev = opts.run ? null : readState(ws, opts.env);
      const { targets, stores, health } = targetsOf(normalized, included);
      for (const [svc, h] of Object.entries(health)) spec.health[svc] ??= h;
      const held = await claims(ws, opts.env, opts.run);
      await admit(ws, opts, held.others, held.mine);
      const state: EnvState = prev ?? { subnet: 0, entrance: 0, ports: {} };
      const moved = (what: string, from: string | number, to: string | number, by: string) => emit({ kind: 'log', source: 'laru', line: `${what} moves from ${from} to ${to}: ${by} holds it` });
      const key = workspaceKey(ws);
      const foreign = (await networks()).filter((n) => !(n.ws === key && n.env === opts.env && n.run === (opts.run ?? '')));
      const clash = (sub: number) => { const lo = ipv4(`172.30.${sub}.0`), hi = lo + 256; return foreign.find((n) => n.ranges.some(([a, b]) => a < hi && lo < b)); };
      /** `from` when no network that is not this env's overlaps it; else the first 172.30.N.0/24 free of them all. */
      const subnetFor = (avoid: number[], from: number | undefined, what: string) => {
        const by = from ? clash(from) : undefined;
        if (from && !by) return from;
        for (let n = 1; n < 255; n++) if (!avoid.includes(n) && !clash(n)) { if (by) moved(what, `172.30.${from}.0/24`, `172.30.${n}.0/24`, by.app ? `${by.app}/${by.env}` : `network ${by.name}`); return n; }
        throw new EnvError('no free 172.30.N.0/24 subnet');
      };
      state.subnet = subnetFor([], state.subnet || undefined, 'the subnet');
      if (joint) {
        state.subnets = Object.fromEntries(Object.entries(state.subnets ?? {}).filter(([r]) => members.some((m) => m.repo === r)));
        for (const m of members) state.subnets[m.repo] = subnetFor([state.subnet, ...Object.entries(state.subnets).filter(([r]) => r !== m.repo).map(([, n]) => n)], state.subnets[m.repo] || undefined, `${m.repo}'s subnet`);
      }
      if (spec.persistent && !opts.run) {
        const taken = new Set<number>([...Object.values(state.ports).flatMap((m) => Object.values(m)), ...held.ports.keys()]);
        // A port this env does not hold now (it is not running) may have been taken by another env or program.
        const keepOr = async (cur: number | undefined, from: number, what: string) => {
          if (cur && !held.ports.has(cur) && (held.running || (await canBind(cur)))) return cur;
          const to = await freePort(from, taken);
          if (cur) moved(what, cur, to, held.ports.get(cur) ?? 'another program');
          return to;
        };
        state.entrance = await keepOr(state.entrance || undefined, 4180, 'the entrance');
        // [service, container port, preferred host port]; Kafka is reached through its HOST listener (29092 → 19092).
        const want: Array<[string, number, number]> = [];
        for (const t of targets) if (included.includes(t.svc) && !spec.intercept.exclude.includes(t.svc)) for (const p of [...t.ports, ...(spec.intercept.ports[t.svc] ?? [])]) want.push([t.svc, p, 10000 + p]);
        for (const n of sinksOf(spec.mocks, 'smtp')) if (!normalized.services[n]) for (const p of new Set([...SMTP_PORTS, ...(spec.mocks[n].implicitTls ?? [])])) want.push([n, p, 10000 + p]);
        for (const [svc, kind] of Object.entries(stores)) {
          if (!included.includes(svc) || spec.hybrid.includes(svc)) continue;
          if (kind === 'kafka') want.push([svc, 29092, 19092]);
          else for (const p of listenPorts(normalized.services[svc])) want.push([svc, p, 10000 + p]);
        }
        for (const [svc, p, host] of want) {
          state.ports[svc] ??= {};
          state.ports[svc][String(p)] = await keepOr(state.ports[svc][String(p)], host < 65535 ? host : 20000, `${svc}:${p}`);
        }
      }
      state.hybrid = spec.hybrid;
      if (!opts.run) writeState(ws, opts.env, state);

      // Joint envs: a network per project; a name is reached across when the project asking does not define it, and
      // a member's published host port reaches its service as host.docker.internal:<port>.
      let jointCtx: Partial<RenderContext> = {};
      if (joint) {
        const fronted = new Set(targets.filter((t) => included.includes(t.svc) && !spec.intercept.exclude.includes(t.svc)).map((t) => t.svc));
        const { visible, hostPortRoutes } = jointRouting(joined, included, fronted, (u) => listenPorts(normalized.services[u]).length > 0, base.share);
        jointCtx = {
          nets: [{ key: 'ks', name: project, subnet: state.subnet }, ...members.map((m) => ({ key: m.repo, name: `${project}-${m.repo}`, subnet: state.subnets![m.repo] }))],
          netOf: joined.repoOf, visible, hostPortRoutes,
        };
      }
      const firstRepo = ws.repos[0]?.name;
      const cacheNames = Object.fromEntries(members.flatMap((m) => m.spec.cache.map((v) => [joint ? `${m.repo}-${v}` : v, m.repo === firstRepo ? `ks-${ws.app}-cache-${v}` : `ks-${ws.app}-cache-${m.repo}-${v}`])));

      // 4. Image keys, render, files for the tap.
      const imageKeys: Record<string, string> = {};
      for (const name of included) {
        const s = normalized.services[name];
        if (!s.build || spec.hybrid.includes(name)) continue;
        const m = memberOf(name);
        const rel = relative(m.snap.dir, s.build.context);
        if (rel.startsWith('..')) throw new EnvError(`services.${name}.build.context points outside ${m.repo}; Laru builds only from the repo's own tree`);
        imageKeys[name] = await contextKey(ws, m.snap, rel, JSON.stringify([s.build.dockerfile, s.build.args, s.build.target, spec.overlay.services?.[name]]));
      }
      const dir = opts.run ? join(envDir(ws, opts.env), 'runs', opts.run) : envDir(ws, opts.env);
      const tapDir = join(dir, 'tap');
      mkdirSync(tapDir, { recursive: true });
      const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
      const packagesDir = join(import.meta.dirname, '..', '..');
      // Mocks: openapi.yaml compiled for the tap (stdlib only); an external reached through a variable points at its mock.
      const mocksDir = join(ws.root, 'mocks');
      const extraEnv: Record<string, Record<string, string>> = {};
      mkdirSync(join(tapDir, 'mocks'), { recursive: true });
      for (const [name, m] of Object.entries(spec.mocks)) {
        if (m.mode === 'sink') {
          // a sink has no folder in the workspace: the tap makes its mailbox. An SMTP one is reached by its name alone, also by whoever reads the server from a variable.
          const via = g?.nodes.get(`ext:${name}`)?.attrs?.via;
          if (m.sink === 'smtp' && !normalized.services[name] && typeof via === 'string') for (const svc of included) if (normalized.services[svc].build) (extraEnv[svc] ??= {})[via] = name;
          continue;
        }
        const mdir = join(mocksDir, m.dir ?? name);
        if (!existsSync(mdir)) throw new EnvError(`mocks.${name}: there is no mocks/${m.dir ?? name}/ in the workspace`);
        const oa = ['openapi.yaml', 'openapi.yml', 'openapi.json'].map((f) => join(mdir, f)).find(existsSync);
        if (oa) writeFileSync(join(tapDir, 'mocks', `${name}.openapi.json`), JSON.stringify(parse(readFileSync(oa, 'utf8'))));
        else if (m.mode === 'contract') throw new EnvError(`mocks.${name}: mode contract needs mocks/${m.dir ?? name}/openapi.yaml`);
        const via = g?.nodes.get(`ext:${name}`)?.attrs?.via;
        if (!normalized.services[name] && typeof via === 'string') for (const svc of included) if (normalized.services[svc].build) (extraEnv[svc] ??= {})[via] = `http://${name}:${m.port ?? 80}`;
      }
      // HTTPS hosts: a certificate per host from the local CA, and a truststore the env's JVMs are pointed at.
      let tls: { caDir: string; truststores: Record<string, string> } | undefined;
      const tlsNames = [...spec.hosts, ...sinksOf(spec.mocks, 'smtp').filter((n) => !normalized.services[n])];
      if (tlsNames.length) {
        for (const h of tlsNames) leafFor(h);
        const store = await ensureTruststore();
        tls = { caDir: caDir(), truststores: Object.fromEntries(included.filter((n) => normalized.services[n].build).map((n) => [n, store])) };
      }
      const rendered = renderCompose(normalized, spec, {
        app: ws.app, env: opts.env, run: opts.run, workspaceKey: workspaceKey(ws), project, subnet: state.subnet, targets, imageKeys,
        topics: (g?.ofType('topic') ?? []).filter((t) => Number(t.attrs?.partitions) > 0).map((t) => ({ name: t.name, partitions: Number(t.attrs!.partitions) })),
        packagesDir, tapDir, hostPorts: spec.persistent && !opts.run ? state.ports : {}, entrancePort: spec.persistent && !opts.run ? state.entrance : undefined,
        user, inject: inj.perService, stores, mocksDir, extraEnv, tls,
        composeOf: joined.composeOf, cacheNames, ...jointCtx,
      });
      for (const w of rendered.warnings) emit({ kind: 'log', source: 'laru', line: `warning: ${w}` });
      const composePath = join(dir, 'compose.yml');
      const before = existsSync(composePath) ? readFileSync(composePath, 'utf8') : undefined;
      const changed = before === undefined || before !== rendered.yaml;
      // opening or closing an env's internet access changes its network, and compose re-attaches the containers it keeps without their aliases: a change of that kind starts the env's containers again
      const isClosed = (y: string | undefined) => y !== undefined && /^networks:\n {2}ks:[\s\S]*?\n {4}internal: true/m.test(y);
      const reopened = before !== undefined && isClosed(before) !== isClosed(rendered.yaml);
      if (before !== undefined) writeFileSync(composePath.replace(/compose\.yml$/, 'compose.prev.yml'), before);
      writeFileSync(composePath, rendered.yaml);
      writeFileSync(join(dir, 'normalized.json'), JSON.stringify(joint ? { ...normalized, 'x-laru': { repoOf: joined.repoOf, envOf: joined.envOf, composeOf: joined.composeOf, shareAlias: joined.shareAlias } } : normalized));
      const tapCfg: TapConfig = { app: ws.app, env: opts.env, entrance: ENTRANCE, routes: rendered.routes, ...(jointCtx.nets ? { nets: Object.fromEntries(jointCtx.nets.map((n: { key: string; subnet: number }) => [`172.30.${n.subnet}.254`, n.key])) } : {}) };
      // The tap reads its routes at start: when they change and compose keeps the tap, it is restarted after up.
      const routesFile = join(tapDir, 'routes.json');
      const routesChanged = existsSync(routesFile) && readFileSync(routesFile, 'utf8') !== JSON.stringify(tapCfg, null, 2);
      writeFileSync(routesFile, JSON.stringify(tapCfg, null, 2));
      const rules: TapRules = { seed: 1, faults: spec.faults, mocks: spec.mocks, peers: {} };
      writeFileSync(join(tapDir, 'rules.json'), JSON.stringify(rules, null, 2));
      writeMaskFile(join(tapDir, 'mask.json'), inj.secrets);
      emit.masker = envMasker(ws, opts.env, opts.run, { allowMissing: true }); // a first up, an up after down or after a new secret: its own values from here on
      await guardForeign(ws, project, {
        networks: Object.values(rendered.doc.networks ?? {}).map((n: any) => n.name),
        volumes: Object.values(rendered.doc.volumes ?? {}).filter((v: any) => !v.external).map((v: any) => v.name),
      });
      phase('render', changed ? 'compose.yml changed' : 'compose.yml unchanged');

      // 5. Pull missing images, build missing tags. Cache volumes are created once and survive destroys.
      const env = { COMPOSE_PROJECT_NAME: project, COMPOSE_PARALLEL_LIMIT: '2', ...inj.values };
      const have = new Set((await docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])).split('\n').filter(Boolean).map(normImage));
      const built: Record<string, Built> = {};
      const toBuild: string[] = [];
      const fresh = new Set<string>(); // compose keys built again without the cache
      const toPull = new Set<string>();
      const rebuild = opts.rebuild ?? [];
      for (const [k, s] of Object.entries(rendered.doc.services)) {
        const svc = s.labels?.[LABEL.service] ?? k;
        if (s.build) {
          if (rebuild.includes('all') || rebuild.includes(svc)) { toBuild.push(k); fresh.add(k); built[svc] = 'built'; }
          else if (have.has(normImage(s.image))) built[svc] = 'cached';
          else { toBuild.push(k); built[svc] = 'built'; }
        }
        else { built[svc] = 'image'; if (!have.has(normImage(s.image))) toPull.add(s.image); }
      }
      const fromSource = Object.entries(built).filter(([, b]) => b !== 'image').map(([n]) => n);
      const unknown = rebuild.filter((n) => n !== 'all' && !fromSource.includes(n));
      if (unknown.length) throw new EnvError(`cannot rebuild ${unknown.join(', ')}: not built from source in ${opts.env}; built from source: ${fromSource.join(', ') || 'none'}`);
      for (const img of toPull) {
        emit({ kind: 'log', source: 'pull', line: `pulling ${img}` });
        const code = await dockerStream(['pull', '--quiet', img], (l) => emit({ kind: 'log', source: 'pull', line: l }));
        if (code !== 0) throw new EnvError(`could not pull ${img}; set another image for it in envs/${opts.env}.yaml overlay`);
      }
      phase('pull', toPull.size ? [...toPull].join(', ') : 'nothing to pull');
      for (const [v, def] of Object.entries(rendered.doc.volumes ?? {}) as Array<[string, any]>) {
        if (!def.external) continue;
        const exists = await docker(['volume', 'inspect', def.name]).then(() => true, () => false);
        if (!exists) await docker(['volume', 'create', '--label', `${LABEL.workspace}=${workspaceKey(ws)}`, '--label', `${LABEL.app}=${ws.app}`, '--label', `${LABEL.cache}=1`, def.name]);
        void v;
      }
      if (toBuild.length) {
        const log = join(dir, 'build.log');
        writeFileSync(log, '');
        // what is asked fresh is built with `--no-cache`, the rest as usual: the cache of the others is not thrown away
        for (const [keys, flags] of [[toBuild.filter((k) => !fresh.has(k)), []], [toBuild.filter((k) => fresh.has(k)), ['--no-cache']]] as Array<[string[], string[]]>) {
          if (!keys.length) continue;
          if (flags.length) emit({ kind: 'log', source: 'laru', line: `rebuilding without cache: ${keys.join(', ')}` });
          const code = await dockerStream(['compose', '--progress', 'plain', '-p', project, '-f', composePath, 'build', ...flags, ...keys], (l) => {
            const line = emit.masker.text(l);
            appendFileSync(log, line + '\n');
            emit({ kind: 'log', source: 'build', line });
          }, { env });
          if (code !== 0) throw new EnvError(`the build failed; see ${relative(ws.root, log)}`, { logs: readFileSync(log, 'utf8').trimEnd().split('\n').slice(-30) });
        }
      }
      phase('build', toBuild.length ? toBuild.join(', ') : 'all images cached');

      // 6. compose up, watched service by service until every one is ready or one fails.
      const real = (k: string) => rendered.doc.services[k];
      const svcOf = (k: string) => real(k).labels?.[LABEL.service] ?? k;
      const seen = new Map<string, Health>();
      const look = async () => {
        const cs = await inspectEnv(ws, opts.env, opts.run);
        const mine = cs.filter((c) => (opts.run ? true : !c.labels[LABEL.run]));
        return Object.keys(rendered.doc.services).map((k) => {
          const c = mine.find((x) => x.labels['com.docker.compose.service'] === k);
          const health = classify(c, real(k));
          if (seen.get(k) !== health) { seen.set(k, health); emit({ kind: 'service', service: svcOf(k), health, note: c?.probe }); }
          return { k, c, health };
        });
      };
      let upCode: number | null = null;
      if (reopened) {
        emit({ kind: 'log', source: 'laru', line: `internet access ${isClosed(rendered.yaml) ? 'closed' : 'opened'}: the containers start again on the new network` });
        await dockerStream(['compose', '-p', project, '-f', composePath.replace(/compose\.yml$/, 'compose.prev.yml'), 'down', '--remove-orphans'], (l) => emit({ kind: 'log', source: 'compose', line: l }), { env }).catch(() => undefined);
      }
      const upDone = dockerStream(['compose', '-p', project, '-f', composePath, 'up', '-d', '--no-build'], (l) => emit({ kind: 'log', source: 'compose', line: l }), { env })
        .then((c) => { upCode = c; });
      // the machine is free again once compose has created and started everything
      const free = release!;
      release = undefined;
      void upDone.then(free, free);
      const deadline = Date.now() + deadlineOf(rendered.doc) * 1000;
      let last: Awaited<ReturnType<typeof look>> = [];
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        last = await look();
        const failed = last.find((x) => FAILED.has(x.health));
        if (failed && failed.c) {
          await upDone;
          throw new EnvError(`${svcOf(failed.k)} is ${failed.health}${failed.c.probe ? ` (probe: ${failed.c.probe.split('\n').pop()})` : failed.health === 'exited' ? ` with code ${failed.c.exitCode}` : ''}`, { service: svcOf(failed.k), logs: await lastLines(failed.c.id) });
        }
        if (upCode !== null && upCode !== 0) throw new EnvError(`docker compose up failed (exit ${upCode}); the log above names the cause`);
        if (upCode === 0 && last.every((x) => OK.has(x.health))) break;
        if (Date.now() > deadline) {
          const slow = last.filter((x) => !OK.has(x.health));
          throw new EnvError(`not ready after ${Math.round(deadlineOf(rendered.doc))} s: ${slow.map((x) => `${svcOf(x.k)} ${x.health}`).join(', ')}`, { service: slow[0] && svcOf(slow[0].k), logs: slow[0]?.c ? await lastLines(slow[0].c.id) : [] });
        }
      }
      await upDone;
      const tap = last.find((x) => x.k === 'ks-tap')?.c;
      // the tap runs Laru's own code, mounted: newer code than the tap's start only reaches it with a restart
      const tapSrc = join(import.meta.dirname, '..', 'tap');
      const tapCode = Math.max(...readdirSync(tapSrc).map((f) => statSync(join(tapSrc, f)).mtimeMs));
      const stale = tap ? Date.parse(tap.startedAt) < tapCode : false;
      if ((routesChanged || stale) && tap && Date.parse(tap.startedAt) < t0) {
        emit({ kind: 'log', source: 'laru', line: `${routesChanged ? 'routes changed' : 'its code changed'}: restarting the tap` });
        await docker(['restart', '-t', '2', tap.id]);
      }
      phase('ready');

      // 7. Leftovers of an earlier render go; the tap learns who is who.
      const consumerWarnings: string[] = [];
      const keep = new Set(Object.keys(rendered.doc.services));
      const all = await inspectEnv(ws, opts.env, opts.run);
      const orphans = all.filter((c) => (opts.run ? true : !c.labels[LABEL.run]) && !keep.has(c.labels['com.docker.compose.service']));
      if (orphans.length) await docker(['rm', '-f', '-v', ...orphans.map((c) => c.id)]);
      rules.peers = Object.fromEntries(all.filter((c) => keep.has(c.labels['com.docker.compose.service'])).flatMap((c) => c.ips.map((ip) => [ip, c.service])));
      writeFileSync(join(tapDir, 'rules.json'), JSON.stringify(rules, null, 2));

      // 7b. HTTP answering is not enough for a service that consumes a topic: what lands on a partition its group does
      // not hold yet is read late, or never (auto.offset.reset=latest). A consumer that subscribed before the topic got
      // all its partitions (another service creates it) sees the rest only on its next metadata refresh (5 min by
      // default). Asked only when a consumer started in this up.
      const ours = all.filter((c) => keep.has(c.labels['com.docker.compose.service']) && (opts.run ? true : !c.labels[LABEL.run]));
      const ipOf = new Map(ours.filter((c) => c.ips.length).map((c) => [c.service, c.ips]));
      const started = new Set(ours.filter((c) => Date.parse(c.startedAt) >= t0 - 1000).map((c) => c.service));
      const allWants = (g?.map.facts ?? []).filter((f) => f.p === 'consumes' && f.s.startsWith('svc:') && started.has(f.s.slice(4)) && ipOf.has(f.s.slice(4)))
        .map((f) => ({ svc: f.s.slice(4), topic: g!.nodes.get(f.o)?.name ?? f.o.replace(/^topic:/, '') }));
      // One broker per project network (a shared one is on several): each consumer is asked of the broker it reaches.
      const net24 = (ip: string) => ip.split('.').slice(0, 3).join('.');
      for (const broker of ours.filter((c) => c.state === 'running' && /kafka|redpanda/.test(c.image))) {
        const reach = new Set(broker.ips.map(net24));
        const wants = allWants.filter((w) => ipOf.get(w.svc)!.some((ip) => reach.has(net24(ip))));
        if (!wants.length) continue;
        const b = { service: broker.service, container: broker.id, image: broker.image };
        const since = Date.now();
        let first: ReturnType<typeof unheld> | null = null;
        let missing: ReturnType<typeof unheld> = [];
        for (;;) {
          const [rows, topics] = await Promise.all([kafka.groups(b).catch(() => []), kafka.topics(b).catch(() => [])]);
          missing = unheld(wants, rows, topics, ipOf);
          if (!first && missing.length && Date.now() - since > 20_000) {
            first = missing;
            emit({ kind: 'log', source: 'laru', line: `waiting for ${missing.map((m) => `${m.svc} (${m.held} of ${m.of} partitions of ${m.topic}: ${m.held ? 'it subscribed before the topic had them all and sees the rest on its next metadata refresh, up to 5 min' : 'its group has not given it any yet'})`).join(', ')}` });
          }
          if (!missing.length || Date.now() - since > 360_000) break;
          await new Promise((r) => setTimeout(r, 3000));
        }
        const waited = Math.round((Date.now() - since) / 1000);
        for (const m of missing) consumerWarnings.push(`${m.svc} still holds ${m.held} of the ${m.of} partitions of ${m.topic} after ${waited} s: what lands on the others is not read`);
        for (const m of first ?? []) if (m.held && !missing.some((x) => x.svc === m.svc && x.topic === m.topic))
          consumerWarnings.push(`${m.svc} held ${m.held} of the ${m.of} partitions of ${m.topic} for ${waited} s: it subscribed before the service that creates the topic gave it all of them, so until its metadata refresh what landed on the others waited`);
        phase('consumers', missing.length ? `${missing.length} incomplete after ${waited} s` : `${wants.length} subscriptions complete${first ? ` after ${waited} s` : ''}`);
      }

      // 8. Databases: the read-only role always; seeds and the «base» snapshot once, after the first ready up.
      for (const db of await dbStores(ws, opts.env, opts.run)) {
        await ensureReader(db);
        if (opts.run || !spec.persistent || db.kind !== 'postgres' || (await hasSnapshot(db))) continue;
        const file = spec.seed[db.service];
        if (file) await seed(db, readFileSync(join(ws.root, file), 'utf8'));
        const b = await snapshot(db);
        emit({ kind: 'log', source: 'laru', line: `${db.service}: snapshot «base» of ${db.db} taken (${Math.round(b.bytes / 2 ** 20)} MB${file ? `, after ${file}` : ''})` });
      }
      phase('data');

      if (!opts.run) {
        // what it took at ready: the next up of this env is admitted against it
        const mem = (await stats(ours.filter((c) => c.state === 'running').map((c) => c.id))).reduce((n, x) => n + x.memBytes, 0);
        writeState(ws, opts.env, { ...state, lastReadyAt: new Date().toISOString(), lastUpAt: new Date(t0).toISOString(), composeHash: createHash('sha1').update(rendered.yaml).digest('hex').slice(0, 12), ...sourcesOf(members), built, ...(mem ? { lastMemBytes: mem } : {}) });
      }
      // Old image tags, unused snapshots and folder shadows' loose objects go after every successful up.
      void prune(ws, { what: ['images', 'snapshots', 'shadow'] }).catch(() => undefined);
      const ms = Date.now() - t0;
      emit({ kind: 'ready', ms });
      const services: ServiceStatus[] = last.map(({ k, c, health }) => ({ service: svcOf(k), compose: k, mode: k === 'ks-tap' ? 'tap' : health === 'done' ? 'job' : 'container', health, built: built[svcOf(k)], image: real(k).image, container: c }));
      for (const h of spec.hybrid) services.push({ service: h, compose: h, mode: 'host', health: 'waiting', note: 'start it with laru run' });
      return { env: opts.env, project, ms, timings, changed, services, addresses: addressesOf(ws.app, tapCfg, state), warnings: [...rendered.warnings, ...issues.filter((i) => i.level !== 'error').map((i) => i.message), ...consumerWarnings] };
    }, (holder) => emit({ kind: 'log', source: 'laru', line: `waiting for ${holder} to finish` }), envLock(ws, opts.env, opts.run));
  } catch (e) {
    release?.();
    const err = e as EnvError;
    const m = emit.masker;
    if (err.logs) (err as { logs?: string[] }).logs = err.logs.map((l) => m.text(l));
    emit({ kind: 'error', message: m.text(err.message), service: err.service, logs: err.logs, ...(err.admission ? { admission: err.admission } : {}) });
    throw e;
  }
}

/** What an up started from: `<repo>@<sha7>` (or `@wt-…`), every member's in a joint env. */
const sourcesOf = (members: Array<{ repo: string; snap: { id: string; worktree: boolean } }>) => {
  const list = members.map((m) => `${m.repo}@${m.snap.id.slice(0, m.snap.worktree ? 15 : 7)}`);
  return { source: list[0], ...(list.length > 1 ? { sources: list } : {}) };
};

/**
 * Subscriptions whose groups do not hold every partition of their topic: a service's groups are the ones its address
 * is a member of; a topic not created yet is skipped.
 */
export function unheld(wants: Array<{ svc: string; topic: string }>, rows: kafka.GroupLag[], topics: kafka.Topic[], ipOf: Map<string, string | string[]>) {
  return wants.flatMap((w) => {
    const of = topics.find((t) => t.name === w.topic)?.partitions.length ?? 0;
    const mine = rows.filter((r) => r.topic === w.topic && r.consumer);
    const ips = [ipOf.get(w.svc) ?? []].flat();
    const groups = new Set(mine.filter((r) => r.host !== undefined && ips.includes(r.host)).map((r) => r.group));
    const held = new Set(mine.filter((r) => groups.has(r.group)).map((r) => r.partition)).size;
    return of && held < of ? [{ ...w, held, of }] : [];
  });
}

export interface EnvStatus {
  env: string;
  project: string;
  state: 'ready' | 'starting' | 'failed' | 'stopped' | 'absent';
  source?: string;
  /** a joint env's: every member's snapshot */
  sources?: string[];
  /** a joint env's networks: project → third octet of 172.30.N.0/24 */
  subnets?: Record<string, number>;
  lastReadyAt?: string;
  services: ServiceStatus[];
  addresses: Address[];
}

/** What is running, from the last render and one inspect; CPU and memory from one `docker stats`. */
export async function status(ws: Workspace, env: string, opts: { stats?: boolean } = {}): Promise<EnvStatus> {
  const dir = envDir(ws, env);
  const state = readState(ws, env);
  const composePath = join(dir, 'compose.yml');
  const project = projectName(ws, env);
  if (!state || !existsSync(composePath)) return { env, project, state: 'absent', services: [], addresses: [] };
  const doc = parse(readFileSync(composePath, 'utf8')) as ComposeDoc;
  const cs = (await inspectEnv(ws, env)).filter((c) => !c.labels[LABEL.run]);
  const st = opts.stats ? await stats(cs.filter((c) => c.state === 'running').map((c) => c.id)) : [];
  const services: ServiceStatus[] = Object.entries(doc.services).map(([k, s]) => {
    const c = cs.find((x) => x.labels['com.docker.compose.service'] === k);
    const health = c ? classify(c, s) : 'absent';
    const svc = s.labels?.[LABEL.service] ?? k;
    const usage = c && st.find((x) => x.name === c.name);
    return { service: svc, compose: k, mode: k === 'ks-tap' ? 'tap' : health === 'done' ? 'job' : 'container', health, built: state.built?.[svc], image: s.image, container: c, note: c?.probe, cpu: usage?.cpu, memBytes: usage?.memBytes, memLimit: usage?.memLimit };
  });
  const routes = existsSync(join(dir, 'tap', 'routes.json')) ? (JSON.parse(readFileSync(join(dir, 'tap', 'routes.json'), 'utf8')) as TapConfig) : { routes: [] };
  for (const h of state.hybrid ?? []) {
    const r = routes.routes.find((x) => x.svc === h);
    const on = r ? (await Promise.all(r.ports.map(accepts))).some(Boolean) : false;
    services.push({ service: h, compose: h, mode: 'host', health: on ? 'host' : 'waiting', note: on ? 'En tu máquina' : `nothing listens on ${r?.ports.join(', ')}; start it with laru run --service ${h}` });
  }
  const healths = services.filter((s) => s.mode !== 'host').map((s) => s.health);
  const overall: EnvStatus['state'] = !cs.length ? 'stopped' : healths.some((h) => FAILED.has(h)) ? 'failed' : healths.every((h) => OK.has(h)) ? 'ready' : 'starting';
  const stores = Object.entries(state.ports).filter(([svc]) => !routes.routes.some((r) => r.svc === svc)).flatMap(([svc, m]) => Object.values(m).map((p) => ({ service: svc, kind: 'store' as const, url: `127.0.0.1:${p}` })));
  return { env, project, state: overall, source: state.source, ...(state.sources ? { sources: state.sources } : {}), ...(state.subnets ? { subnets: state.subnets } : {}), lastReadyAt: state.lastReadyAt, services, addresses: [...addressesOf(ws.app, routes, state), ...stores] };
}

/** Lines of one service (or every one, prefixed), optionally followed until `signal` aborts. */
export async function logs(ws: Workspace, env: string, opts: { service?: string; tail?: number; follow?: boolean; signal?: AbortSignal }, onLine: (service: string, line: string) => void): Promise<void> {
  const cs = (await inspectEnv(ws, env)).filter((c) => !c.labels[LABEL.run] && (!opts.service || c.service === opts.service));
  if (opts.service && !cs.length) throw new EnvError(`no container of ${opts.service} in ${env}`);
  await Promise.all(cs.map((c) => dockerStream(['logs', '--timestamps', '--tail', String(opts.tail ?? 100), ...(opts.follow ? ['-f'] : []), c.id], (l) => onLine(c.service, l), { signal: opts.signal })));
}

/** Removes everything with this env's labels (caches only when asked), and the values the tap was given. */
export async function down(ws: Workspace, env: string, opts: { caches?: boolean; dryRun?: boolean } = {}): Promise<DestroyReport> {
  return withLock(`down ${ws.app}/${env}`, async () => {
    const report = await destroyByLabel(ws, { env, caches: opts.caches, dryRun: opts.dryRun });
    if (!opts.dryRun) {
      forgetValues(ws, env);
      const st = readState(ws, env);
      if (st) writeState(ws, env, { ...st, lastReadyAt: undefined });
    }
    return report;
  }, undefined, envLock(ws, env));
}

/**
 * `up`, and when the memory admission refuses and offers to stop a persistent env of this workspace, stop it and try again —
 * only when the caller has said yes (`stopOffered`). Nothing else is stopped, and never an env of another workspace.
 */
export async function upStoppingOffered(ws: Workspace, opts: UpOptions): Promise<UpResult & { stopped?: string }> {
  try { return await up(ws, opts); } catch (e) {
    const offer = e instanceof EnvError ? e.admission?.offer : undefined;
    if (!opts.stopOffered || !offer || offer.app !== ws.app) throw e;
    opts.onEvent?.({ t: Date.now(), kind: 'log', source: 'laru', line: `stopping ${offer.app}/${offer.env} to make room, as you confirmed` } as EnvEvent);
    await down(ws, offer.env);
    return { ...(await up(ws, opts)), stopped: offer.env };
  }
}
