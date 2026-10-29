/**
 * `envs/<env>.yaml`: which compose to transform, at which ref, what runs on the host, what is cached, what is
 * overridden. Errors name the field (`envs/local.yaml: hybrid[0]: "x" is not a service; did you mean …`).
 * Machine state (subnet, ports) lives apart, in `.laru/envs/<env>/state.json`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { stateDir, WorkspaceError, type Graph, type Workspace } from '@laru/core';
import { maskerOf, PROVIDER_HOSTS, readLearned, readMaskFile, type Masker } from '@laru/trace';
import type { EnvSpec } from './types.ts';

export const ENV_KEYS = new Set(['from', 'join', 'share', 'extends', 'refs', 'persistent', 'services', 'hybrid', 'cache', 'resources', 'health', 'seed', 'mocks', 'faults', 'intercept', 'overlay', 'hosts', 'egress']);
/** Env names, everywhere one is written: `envs/<env>.yaml`, the vault's `env.<env>` level. */
export const ENV_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** A flow's environment is an instance of a project env: named `f-<flow>`, its spec generated and kept with the machine's state, not in the workspace. */
export const isInstance = (env: string) => /^f-[a-z0-9][a-z0-9-]*$/.test(env);
export const instanceFile = (ws: Workspace, env: string) => join(stateDir(ws), 'instances', `${env}.yaml`);
export const listInstances = (ws: Workspace) => (existsSync(join(stateDir(ws), 'instances')) ? readdirSync(join(stateDir(ws), 'instances')).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).sort() : []);
export const envFile = (ws: Workspace, env: string) => (isInstance(env) && existsSync(instanceFile(ws, env)) ? instanceFile(ws, env) : join(ws.root, 'envs', `${env}.yaml`));
export const envDir = (ws: Workspace, env: string) => join(stateDir(ws), 'envs', env);
export const listEnvs = (ws: Workspace) => (existsSync(join(ws.root, 'envs')) ? readdirSync(join(ws.root, 'envs')).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).sort() : []);

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Maps merge, lists and scalars replace. */
export function merge(base: any, over: any): any {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

function readRaw(ws: Workspace, env: string, seen: string[] = []): Record<string, any> {
  const file = envFile(ws, env);
  if (!existsSync(file)) throw new WorkspaceError(`no envs/${env}.yaml; create it with \`laru env init ${env} --from <repo>:<compose file>\``, 'env');
  if (seen.includes(env)) throw new WorkspaceError(`extends makes a cycle: ${[...seen, env].join(' → ')}`, `envs/${seen[0]}.yaml: extends`);
  const raw = (parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, any>;
  if (!isObj(raw)) throw new WorkspaceError('must be a map', `envs/${env}.yaml`);
  return raw.extends ? merge(readRaw(ws, String(raw.extends), [...seen, env]), { ...raw, extends: undefined }) : raw;
}

/** Reads and validates an env. `services` are the service names it may refer to, for "did you mean". */
export function loadEnvSpec(ws: Workspace, env: string, services?: string[]): EnvSpec {
  if (!ENV_NAME.test(env)) throw new WorkspaceError('env names are kebab-case', 'env');
  return specFrom(ws, env, readRaw(ws, env), services);
}

/** The keys an env's file (with what it extends) sets: a joint env's own keys go over its members'. */
export const envKeys = (ws: Workspace, env: string): string[] => Object.entries(readRaw(ws, env)).filter(([, v]) => v !== undefined).map(([k]) => k);

/**
 * Validates an env's raw content, read from its file or about to be written (`env init --join`). `pending`: member envs
 * written in the same go, read from their content instead of their (missing) files.
 */
export function specFrom(ws: Workspace, env: string, raw: Record<string, any>, services?: string[], pending: Record<string, Record<string, any>> = {}): EnvSpec {
  const at = (k: string) => `envs/${env}.yaml: ${k}`;
  // a key Laru does not read is left alone and said when the env comes up, never a reason not to
  const ignored = Object.keys(raw).filter((k) => !ENV_KEYS.has(k) && raw[k] !== undefined);
  const list = (k: string): string[] => {
    const v = raw[k] ?? [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new WorkspaceError('a list of names', at(k));
    return v;
  };
  let from: EnvSpec['from'];
  if (raw.from !== undefined) {
    const m = String(raw.from).match(/^([a-z0-9][a-z0-9-]*):(.+)$/);
    if (!m) throw new WorkspaceError('`<repo>:<path to compose file>`', at('from'));
    if (!ws.repos.some((r) => r.name === m[1])) throw new WorkspaceError(`repo "${m[1]}" is not in laru.yaml`, at('from'));
    from = { repo: m[1], path: m[2] };
  }
  const refs = (raw.refs ?? {}) as Record<string, string>;
  for (const r of Object.keys(refs)) {
    const repo = ws.repos.find((x) => x.name === r);
    if (!repo) throw new WorkspaceError(`repo "${r}" is not in laru.yaml`, at(`refs.${r}`));
    if (repo.source === 'folder') throw new WorkspaceError('a folder has no branches or commits; remove it', at(`refs.${r}`));
  }
  let members: string[] | undefined;
  if (raw.join !== undefined) {
    if (from) throw new WorkspaceError('a joint env has no from: its members bring their composes', at('join'));
    members = list('join');
    if (members.length < 2) throw new WorkspaceError('two or more project envs', at('join'));
    if (list('hybrid').length) throw new WorkspaceError(`not in a joint env; use it in ${members.join(' or ')}`, at('hybrid'));
    const repos = new Map<string, string>();
    members.forEach((m, i) => {
      if (!ENV_NAME.test(m)) throw new WorkspaceError('env names are kebab-case', at(`join[${i}]`));
      const r = pending[m] ?? readRaw(ws, m);
      if (r.join !== undefined) throw new WorkspaceError(`${m} is itself joint; a joint env joins project envs`, at(`join[${i}]`));
      if (r.from === undefined) throw new WorkspaceError(`${m} has no from`, at(`join[${i}]`));
      if ((r.hybrid ?? []).length) throw new WorkspaceError(`${m} runs hybrid services, which a joint env cannot`, at(`join[${i}]`));
      const repo = String(r.from).split(':')[0];
      if (repos.has(repo)) throw new WorkspaceError(`${repos.get(repo)} and ${m} both bring ${repo}`, at('join'));
      repos.set(repo, m);
    });
  } else if (raw.share !== undefined) throw new WorkspaceError('only a joint env shares services', at('share'));
  const share = (raw.share ?? {}) as Record<string, string>;
  if (typeof share !== 'object' || Array.isArray(share) || Object.values(share).some((v) => typeof v !== 'string')) throw new WorkspaceError('a map of <service not started>: <service used instead>', at('share'));
  const spec: EnvSpec = {
    name: env, from, join: members, share, extends: raw.extends, refs, persistent: raw.persistent !== false,
    services: raw.services === undefined ? undefined : list('services'), hybrid: list('hybrid'), cache: list('cache'),
    resources: raw.resources ?? {}, health: raw.health ?? {}, seed: raw.seed ?? {}, mocks: raw.mocks ?? {}, faults: raw.faults ?? {},
    intercept: { exclude: raw.intercept?.exclude ?? [], ports: raw.intercept?.ports ?? {} }, overlay: raw.overlay ?? {}, hosts: list('hosts'),
  };
  if (raw.egress !== undefined) {
    if (raw.egress !== 'open' && raw.egress !== 'closed') throw new WorkspaceError('`open` or `closed`', at('egress'));
    if (raw.egress === 'closed') {
      if (list('hybrid').length) throw new WorkspaceError('a hybrid service runs on your Mac and needs host.docker.internal, which a closed env does not have: leave egress open or run it inside', at('egress'));
      if (members) throw new WorkspaceError('not in a joint env: close its member envs', at('egress'));
      spec.egress = 'closed';
    }
  }
  // What receives mail and texts keeps them and sends nothing: a sink cannot also forward, and nothing that forwards may stand for a mail or SMS provider.
  for (const [n, m] of Object.entries(spec.mocks)) {
    if (m.mode === 'sink') {
      if (m.sink !== 'smtp' && m.sink !== 'twilio') throw new WorkspaceError('`sink: smtp` or `sink: twilio`', at(`mocks.${n}.sink`));
      if (m.real) throw new WorkspaceError('a sink keeps what it receives and sends nothing: it has no `real`', at(`mocks.${n}.real`));
      if (m.sink === 'twilio' && !spec.hosts.includes(n)) spec.hosts.push(n);
    } else if ((m.mode === 'record' || m.mode === 'spy' || m.real) && (PROVIDER_HOSTS.includes(n) || /^smtp\./.test(n))) {
      throw new WorkspaceError(`${n} would send real mail or texts: use \`mode: sink\`, which keeps them in the env's mailbox`, at(`mocks.${n}.mode`));
    }
  }
  if (services) {
    const check = (k: string, names: string[]) => names.forEach((n, i) => {
      if (services.includes(n)) return;
      const near = services.filter((s) => s.startsWith(n.slice(0, 4)) || n.startsWith(s.slice(0, 4))).slice(0, 2);
      throw new WorkspaceError(`"${n}" is not a service of the compose${near.length ? `; did you mean ${near.join(' or ')}?` : ''}`, at(`${k}[${i}]`));
    });
    check('services', spec.services ?? []);
    check('hybrid', spec.hybrid);
    for (const k of ['resources', 'health', 'faults', 'seed'] as const) check(k, Object.keys(spec[k]).filter((n) => !(k === 'faults' && spec.mocks[n]?.mode === 'sink')));
    for (const [svc, file] of Object.entries(spec.seed)) if (!existsSync(join(ws.root, String(file)))) throw new WorkspaceError(`${file} does not exist in the workspace`, at(`seed.${svc}`));
  }
  if (ignored.length) spec.ignored = ignored;
  return spec;
}

/**
 * An env file names services by their unique name; a project env also by its compose names. Everything downstream
 * (render, vault, state, trace) uses unique names, so the keys are translated once, here.
 */
export function translateSpec(spec: EnvSpec, to: (name: string) => string): EnvSpec {
  const keys = <T>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [to(k), v]));
  return {
    ...spec,
    services: spec.services?.map(to), hybrid: spec.hybrid.map(to), resources: keys(spec.resources), health: keys(spec.health), seed: keys(spec.seed), mocks: keys(spec.mocks),
    faults: Object.fromEntries(Object.entries(spec.faults).map(([k, rules]) => [to(k), rules.map((r) => (r.from ? { ...r, from: to(r.from) } : r))])),
    intercept: { exclude: spec.intercept.exclude.map(to), ports: keys(spec.intercept.ports) },
    overlay: { ...spec.overlay, ...(spec.overlay.services ? { services: keys(spec.overlay.services) } : {}) },
  };
}

/**
 * A joint env's spec: its members' (translated to unique names; lists joined, maps merged, each cache volume keyed by
 * its project), then the joint file's own keys on top with today's merge: maps merge, lists replace.
 */
export function jointSpec(joint: EnvSpec, keys: string[], members: Array<{ repo: string; env: string; spec: EnvSpec }>, repoOf: Record<string, string> = {}, onDrop?: (line: string) => void): EnvSpec {
  const all = <K extends keyof EnvSpec>(k: K) => members.map((m) => m.spec[k]);
  let out: EnvSpec = {
    ...joint,
    services: undefined, hybrid: [], hosts: [...new Set(members.flatMap((m) => m.spec.hosts))],
    cache: members.flatMap((m) => m.spec.cache.map((v) => `${m.repo}-${v}`)),
    resources: Object.assign({}, ...all('resources')), health: Object.assign({}, ...all('health')), seed: Object.assign({}, ...all('seed')),
    mocks: Object.assign({}, ...all('mocks')), faults: Object.assign({}, ...all('faults')),
    intercept: { exclude: members.flatMap((m) => m.spec.intercept.exclude), ports: Object.assign({}, ...members.map((m) => m.spec.intercept.ports)) },
    overlay: { services: Object.assign({}, ...members.map((m) => m.spec.overlay.services ?? {})), volumes: Object.assign({}, ...members.map((m) => Object.fromEntries(Object.entries(m.spec.overlay.volumes ?? {}).map(([v, d]) => [`${m.repo}-${v}`, d])))) },
  };
  for (const k of keys) if (!['join', 'share', 'extends', 'refs', 'persistent', 'from'].includes(k)) out = { ...out, [k]: merge(out[k as keyof EnvSpec], joint[k as keyof EnvSpec]) };
  // A member's mock of a service another member runs: in the joint env it talks to the real one.
  for (const m of members) for (const mock of Object.keys(m.spec.mocks)) {
    if (repoOf[mock] && repoOf[mock] !== m.repo && !joint.mocks[mock]) { delete out.mocks[mock]; onDrop?.(`${m.env} simula ${mock}; en ${joint.name} habla con el de ${repoOf[mock]}`); }
  }
  return out;
}

/** `share` ends are services of the env, in two different members. */
export function checkShare(env: string, share: Record<string, string>, repoOf: Record<string, string>): void {
  for (const [dropped, used] of Object.entries(share)) {
    for (const n of [dropped, used]) if (!repoOf[n]) throw new WorkspaceError(`"${n}" is not a service of this env`, `envs/${env}.yaml: share.${dropped}`);
    if (repoOf[dropped] === repoOf[used]) throw new WorkspaceError(`${dropped} and ${used} are both ${repoOf[used]}'s; share is between projects`, `envs/${env}.yaml: share.${dropped}`);
  }
}

/** The projects an env runs: its `from` repo, or its members'. */
export function envProjects(ws: Workspace, env: string): string[] {
  const s = loadEnvSpec(ws, env);
  return s.from ? [s.from.repo] : (s.join ?? []).map((m) => loadEnvSpec(ws, m).from!.repo);
}

/** The projects a flow needs: the repo of each service and store in its `needs` (externals and topics have none). */
export const flowProjects = (g: Graph | null, flow: { needs: string[] }): string[] =>
  [...new Set(flow.needs.flatMap((n) => { const r = g?.nodes.get(n)?.repo; return r && /^(svc|ds):/.test(n) ? [r] : []; }))];

const and = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/**
 * The env a run of these flows uses: the smallest that runs every project they need; ties go to one that is ready,
 * then to `local`, then by name. With one project, today's choice: `local`, else the only env.
 */
export function envFor(ws: Workspace, g: Graph | null, flows: Array<{ id: string; needs: string[] }>, ready: Set<string> = new Set()): string {
  const envs = listEnvs(ws);
  if (ws.repos.length <= 1) {
    if (envs.includes('local')) return 'local';
    if (envs.length === 1) return envs[0];
    throw new WorkspaceError(envs.length ? `which env? ${envs.join(', ')}` : 'no envs yet; create one with `laru env init local --from <repo>:<compose file>`');
  }
  const need = [...new Set(flows.flatMap((f) => flowProjects(g, f)))];
  const projects = new Map<string, string[]>(envs.map((e) => { try { return [e, envProjects(ws, e)]; } catch { return [e, []]; } }));
  const fit = envs.filter((e) => need.every((r) => projects.get(e)!.includes(r)) && projects.get(e)!.length);
  fit.sort((a, b) => projects.get(a)!.length - projects.get(b)!.length || Number(ready.has(b)) - Number(ready.has(a)) || Number(b === 'local') - Number(a === 'local') || a.localeCompare(b));
  if (fit[0]) return fit[0];
  const own = need.map((r) => envs.filter((e) => projects.get(e)!.length === 1 && projects.get(e)![0] === r).sort((a, b) => Number(b === 'local') - Number(a === 'local') || a.localeCompare(b))[0] ?? `${r}-local`);
  const who = flows.filter((f) => flowProjects(g, f).length).map((f) => f.id);
  throw new WorkspaceError(`${who.join(', ') || 'these flows'} ${who.length > 1 ? 'need' : 'needs'} ${and(need)}; no env has ${need.length > 2 ? 'them all' : 'both'}: laru env init all --join ${own.join(',')}`);
}

/** Machine-local state of an env: the subnet and ports it was given, kept so they never move between ups. */
export interface EnvState {
  subnet: number;
  entrance: number;
  /** service → container port → host port (127.0.0.1) */
  ports: Record<string, Record<string, number>>;
  lastReadyAt?: string;
  lastUpAt?: string;
  composeHash?: string;
  /** what the last up started from: `<repo>@<sha7>` or `<repo>@wt-…` (the first project's, for older readers) */
  source?: string;
  /** joint envs: every member's snapshot, `vaultflow@cb83e92 · audit@3a9c1f2` as a list */
  sources?: string[];
  /** joint envs: each project's network, third octet of 172.30.N.0/24 (`subnet` is the `ks` one) */
  subnets?: Record<string, number>;
  /** the memory its containers used at its last ready (docker stats), for admission */
  lastMemBytes?: number;
  /** service → how its image came to be in the last up */
  built?: Record<string, 'cached' | 'built' | 'image'>;
  hybrid?: string[];
}

export function readState(ws: Workspace, env: string): EnvState | null {
  const f = join(envDir(ws, env), 'state.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as EnvState) : null;
}

export function writeState(ws: Workspace, env: string, state: EnvState): void {
  mkdirSync(envDir(ws, env), { recursive: true });
  writeFileSync(join(envDir(ws, env), 'state.json'), JSON.stringify(state, null, 2));
}

/** The compose project of an env (and of one ephemeral run of it). */
export const projectName = (ws: Workspace, env: string, run?: string) => `ks-${ws.app}-${env}${run ? `-r${run}` : ''}`;

/** The masker of an env (or of one ephemeral run of it): the vault's secrets the tap was given at its last up. */
export function envMasker(ws: Workspace, env: string, run?: string, o: { allowMissing?: boolean } = {}): Masker {
  const file = join(envDir(ws, env), ...(run ? ['runs', run] : []), 'tap', 'mask.json');
  // A flow's environment has its own values: with its mask gone Laru cannot tell a secret from any other text there, so it shows nothing.
  if (isInstance(env) && !o.allowMissing && !existsSync(file)) throw new Error(`${env} has no mask of its own (it was never brought up, or was taken down): bring it up before looking inside`);
  // what a mail or SMS sink learned (codes, tokens of its messages) is masked wherever Laru shows evidence
  const learned = readLearned(join(file, '..', 'learned.json'));
  return maskerOf(readMaskFile(file), learned, { short: learned });
}

/** JSON read from a store, masked as a JSON body is (secret-looking keys and known values, at any depth); the masked text when masking broke the JSON. */
export function maskedJson(json: string, m: Masker): unknown {
  const t = m.body(json, 'application/json');
  try { return JSON.parse(t); } catch { return t; }
}

/**
 * The values a tap was given (mask.json: the secrets in plain text and the mark key) go with its env: an ephemeral
 * run's whole tap dir when the run's env is destroyed; at down, the env's mask.json and every run's tap dir.
 */
export function forgetValues(ws: Workspace, env: string, run?: string, o: { runs?: boolean } = {}): void {
  const runs = join(envDir(ws, env), 'runs');
  if (run) return void rmSync(join(runs, run, 'tap'), { recursive: true, force: true });
  for (const f of ['mask.json', 'mask.txt', 'learned.json']) rmSync(join(envDir(ws, env), 'tap', f), { force: true }); // mask.txt: left by older versions
  rmSync(join(envDir(ws, env), 'tap', 'mail'), { recursive: true, force: true }); // a mailbox is the env's, not a run's: it goes with it
  // the instances of the env keep their own masks while they run: only a sweep of leftovers asks for them to go
  if (o.runs && existsSync(runs)) for (const r of readdirSync(runs)) rmSync(join(runs, r, 'tap'), { recursive: true, force: true });
}
