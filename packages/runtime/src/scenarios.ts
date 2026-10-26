/**
 * Scenarios: a state of the system with a name. Provisioning plays its setup once, from the env's «base»,
 * in the runner and through the tap, so Laru sees which stores it wrote; the relational ones it wrote get a snapshot
 * of the scenario's own. Applying puts every relational store back (the scenario's snapshot, else «base»), sets its
 * mocks and faults, restarts what keeps state in memory and hands out who can sign in. A store with no snapshot that
 * the setup wrote (MinIO, Kafka, MongoDB, Redis…) cannot be put back: such a scenario plays its setup again each time,
 * and says what those stores keep from before. State lives in .laru/envs/<env>/scenarios/ (0600).
 * On a persistent env applying asks first (`applyPlan` says what it would do); the passwords of who can sign in never
 * leave this process (`shown`).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph, loadKnowledge, type Row, type Workspace } from '@laru/core';
import { sqlTarget } from '@laru/trace';
import { hasSnapshot, reset, snapshot, stores, type Store } from './db.ts';
import { docker, envLock, inspectEnv, withLock } from './docker.ts';
import { envDir, envMasker, loadEnvSpec } from './env.ts';
import * as mail from './explore/mail.ts';
import { clearFaults, setFaults, setMockMode } from './rules.ts';
import { readRunnerFile, runnerFile } from './runner-file.ts';
import { baseUrl, capture, ensureRunner, startRunner, withFields } from './runs.ts';
import type { FaultRule, MockSpec } from './types.ts';
import { status } from './up.ts';
import { flowsVars } from './vault.ts';

export interface Scenario {
  id: string; slug: string; title: string; summary: string; dir: string;
  /** the setup's workspace path; none for one that only `extends` */
  setup?: string;
  env?: string; extends?: string; needs: string[];
  /** needs the whole env to itself: it runs alone and restored, instead of seeded beside other flows */
  exclusive: boolean;
  given: Row[]; mocks: Array<{ service: string; mode: MockSpec['mode'] }>; faults: Array<{ service: string; rule: FaultRule }>; restart: string[];
  /** what it does to the env's mailbox: empty it, or send the app an incoming text */
  mailbox: Array<{ action: 'clear' | 'inbound-sms'; detail: string }>;
}
export interface Identity { name: string; username?: string; email?: string; password?: string }
/** What provisioning learned, kept per env. */
export interface ScenarioState {
  slug: string; env: string; key: string; provisionedAt: string; ms: number;
  /** restored from snapshots, or its setup played again on every apply */
  mode: 'snapshot' | 'replay';
  /** stores the setup wrote; `keeps`: those of them with no snapshot */
  touched: string[]; keeps: string[];
  identities: Identity[];
  /** the setup's page ended signed in: the session browser starts with it */
  signedIn: boolean;
  /** the setup failed: the scenario is broken until it passes */
  broken?: string;
  /** how long its last application took */
  applyMs?: number;
}
export interface Applied { slug: string; env: string; ms: number; provisioned: boolean; mode: ScenarioState['mode']; keeps: string[]; identities: Identity[]; signedIn: boolean }

export class ScenarioError extends Error {}
/** Applying would delete data of a persistent env and nobody said yes; the message says what it would do. */
export class ScenarioConfirm extends ScenarioError {}

/** The string fields `keys` of `x` and nothing else: a setup's word is a shape to trust, not a bag to pass on. */
const pick = (x: object, keys: string[]) => Object.fromEntries(keys.filter((k) => typeof (x as Record<string, unknown>)[k] === 'string').map((k) => [k, (x as Record<string, unknown>)[k]]));

/** What a page, the CLI or an AI is shown of who can sign in: who they are, never a password or any other field a setup added. */
export type Shown<T extends { identities: Identity[] }> = Omit<T, 'identities'> & { identities: Array<Omit<Identity, 'password'>> };
export const shown = <T extends { identities: Identity[] }>(x: T): Shown<T> => ({ ...x, identities: x.identities.map((i) => pick(i, ['name', 'username', 'email']) as Omit<Identity, 'password'>) });

const SNAPSHOTS = new Set<Store['kind']>(['postgres', 'mssql']);
const rows = (v: unknown) => (Array.isArray(v) ? (v as Row[]) : []);
const one = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : v === undefined ? undefined : String(v));

/** Every scenario of the documentation, with its setup next to it (`<dir>/<slug>.setup.ts`). */
export function listScenarios(ws: Workspace): Scenario[] {
  return loadKnowledge(ws).pieces.filter((p) => p.type === 'scenario').map((p) => {
    const slug = p.id.replace(/^scn:/, '');
    const setup = join(p.dir, `${slug}.setup.ts`);
    const num = (s: unknown) => (s === undefined || s === '' ? undefined : Number(s));
    return {
      id: p.id, slug, title: p.title, summary: p.summary, dir: p.dir, setup: existsSync(join(ws.root, setup)) ? setup : undefined,
      env: one(p.meta?.env), extends: one(p.meta?.extends), exclusive: one(p.meta?.exclusive) === 'true', needs: ([] as string[]).concat((p.meta?.needs as string[] | string | undefined) ?? []),
      given: rows(p.fields.given),
      mocks: rows(p.fields.mocks).map((r) => ({ service: String(r.service), mode: String(r.mode) as MockSpec['mode'] })),
      faults: rows(p.fields.faults).map((r) => ({ service: String(r.service), rule: Object.fromEntries(Object.entries({ latency: num(r.latency), status: num(r.status), p: num(r.p), code: num(r.code), method: r.method ? String(r.method) : undefined, path: r.path ? String(r.path) : undefined }).filter(([, v]) => v !== undefined && !Number.isNaN(v))) as FaultRule })),
      restart: ([] as string[]).concat((p.fields.restart as string[] | undefined) ?? []).map((s) => s.replace(/^svc:/, '')),
      mailbox: rows(p.fields.mailbox).map((r) => ({ action: String(r.action) as 'clear' | 'inbound-sms', detail: String(r.detail ?? '') })).filter((r) => r.action === 'clear' || r.action === 'inbound-sms'),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function scenarioOf(ws: Workspace, name: string): Scenario {
  const id = name.startsWith('scn:') ? name : `scn:${name}`;
  const all = listScenarios(ws);
  const s = all.find((x) => x.id === id);
  if (!s) throw new ScenarioError(`no scenario ${id}; scenarios are ${all.map((x) => x.id).join(', ') || 'none yet'}`);
  return s;
}
/** The scenario and those it extends, the one with the setup first. */
function chainOf(ws: Workspace, s: Scenario): Scenario[] {
  const out = [s];
  for (let x = s; x.extends; ) {
    x = scenarioOf(ws, x.extends);
    if (out.includes(x)) throw new ScenarioError(`${s.id} extends itself through ${x.id}`);
    out.unshift(x);
  }
  if (!out[0].setup) throw new ScenarioError(`${out[0].id} has no setup: write ${out[0].dir}/${out[0].slug}.setup.ts, or make it extend one that has`);
  return out;
}

const dirOf = (ws: Workspace, env: string) => join(envDir(ws, env), 'scenarios');
export function scenarioState(ws: Workspace, env: string, slug: string): ScenarioState | null {
  const f = join(dirOf(ws, env), `${slug}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as ScenarioState) : null;
}
const saveState = (ws: Workspace, st: ScenarioState) => { mkdirSync(dirOf(ws, st.env), { recursive: true }); writeFileSync(join(dirOf(ws, st.env), `${st.slug}.json`), JSON.stringify(st, null, 2), { mode: 0o600 }); };
/** The signed-in session a scenario's setup left (the one it extends, if it has none), for the session browser; never served to a page. */
export function scenarioStorage(ws: Workspace, env: string, name: string): string | undefined {
  const base = chainOf(ws, scenarioOf(ws, name))[0];
  const f = join(dirOf(ws, env), `${base.slug}.storage.json`);
  return existsSync(f) ? f : undefined;
}
/** The scenario last applied on an env, and when. */
export function appliedOn(ws: Workspace, env: string): { slug: string; at: string } | null {
  const f = join(dirOf(ws, env), 'applied.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

/** What makes a provisioning stale: the setup and its scenario.md, the workspace's support/ code, the env's images. */
async function keyOf(ws: Workspace, env: string, s: Scenario): Promise<string> {
  const h = createHash('sha256');
  const add = (f: string) => { if (existsSync(f)) h.update(f).update(readFileSync(f)); };
  add(join(ws.root, s.setup!));
  add(join(ws.root, s.dir, 'scenario.md'));
  const support = join(ws.root, 'support');
  if (existsSync(support)) for (const f of (readdirSync(support, { recursive: true }) as string[]).sort()) if (statSync(join(support, f)).isFile()) add(join(support, f));
  for (const c of (await inspectEnv(ws, env)).filter((x) => x.service !== 'runner').sort((a, b) => a.service.localeCompare(b.service))) h.update(`${c.service}=${c.image}`);
  return h.digest('hex').slice(0, 16);
}

/** Mocks and faults of the chain (the last scenario wins) and its restarts. */
async function setChain(ws: Workspace, env: string, chain: Scenario[]): Promise<void> {
  clearFaults(ws, env);
  for (const s of chain) {
    for (const m of s.mocks) setMockMode(ws, env, m.service, m.mode);
    for (const f of s.faults) setFaults(ws, env, f.service, [f.rule]);
  }
  const restart = [...new Set(chain.flatMap((s) => s.restart))];
  if (restart.length) {
    const ids = (await inspectEnv(ws, env)).filter((c) => restart.includes(c.service)).map((c) => c.id);
    if (ids.length) await docker(['restart', ...ids], { timeoutMs: 180_000 });
  }
  // the mailbox last: what the scenario's setup sent is emptied when it says so, and an incoming text arrives once the app is as it should be
  for (const m of chain.flatMap((s) => s.mailbox)) {
    if (m.action === 'clear') await mail.clear(ws, env);
    else { const [from, ...body] = m.detail.split(':'); await mail.smsReply(ws, env, from.trim(), body.join(':').trim()); }
  }
}

/**
 * Plays the setup in the runner; what it returned, and the window it ran in. `as`: the name its accounts are made under
 * (`uniq()` draws on it), and `run`: the instance of the env it plays in, when it is not the env itself.
 */
async function playSetup(ws: Workspace, env: string, s: Scenario, out: string, o: { as?: string; run?: string } = {}): Promise<{ ok: boolean; error?: string; identities: Identity[]; signedIn: boolean; t0: number; t1: number }> {
  await ensureRunner();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const as = o.as ?? `scn-${s.slug}`;
  const vars = `KS_RUN=${as}\nKS_BASE_URL=${baseUrl(ws, env, o.run)}\nKS_FLOW_VARS_JSON=${JSON.stringify(await flowsVars(ws))}\n`;
  const t0 = Date.now();
  const id = await startRunner(ws, env, o.run, as, out, join(out, '..', `.${as}.runner.env`), vars, [s.setup!]);
  const exit = Number((await docker(['wait', id], { timeoutMs: 600_000 })).trim());
  const t1 = Date.now();
  const log = withFields(envMasker(ws, env, o.run)).text(await docker(['logs', '--tail', '40', id]).catch(() => ''));
  await docker(['rm', '-f', id]).catch(() => undefined);
  const result = setupResult(out);
  if (exit !== 0 || !result) return { ok: false, error: log.split('\n').filter((l) => /Error|✘|failed|expect/i.test(l)).slice(0, 6).join('\n') || `the setup exited with ${exit}`, identities: [], signedIn: false, t0, t1 };
  return { ok: true, ...result, t0, t1 };
}

/** What a setup left in out/ (the runner's word, so real files only): the identities it made, and whether it ended signed in. */
export function setupResult(out: string): { identities: Identity[]; signedIn: boolean } | undefined {
  const text = readRunnerFile(out, 'scenario.json');
  if (text === undefined) return undefined;
  try {
    const raw = (JSON.parse(text) as { identities?: unknown }).identities;
    // the runner's word: an identity is a name and what it signs in with, whatever else the file says
    const identities = (Array.isArray(raw) ? raw : []).filter((i) => typeof i?.name === 'string').map((i) => pick(i, ['name', 'username', 'email', 'password']) as unknown as Identity);
    return { identities, signedIn: runnerFile(out, 'storage.json') !== undefined };
  } catch { return undefined; }
}

/**
 * Which stores the setup wrote, as the env saw it in its window: SQL that writes, a write over HTTP to a datastore
 * (MinIO, DynamoDB Local…), any TCP conversation with one (Redis, MongoDB: it cannot be told a read from a write),
 * a message on a broker.
 */
export function storesWritten(c: Pick<Awaited<ReturnType<typeof capture>>, 'sql' | 'traffic' | 'kafka'>, datastores: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const q of c.sql) if (sqlTarget(q.statement).writes) out.add(q.store);
  for (const r of c.traffic) if (datastores.has(r.svc) && (r.kind === 'tcp' || !['GET', 'HEAD', 'OPTIONS'].includes(r.method ?? 'GET'))) out.add(r.svc);
  for (const k of c.kafka) out.add(k.broker);
  return [...out].sort();
}

async function written(ws: Workspace, env: string, t0: number, t1: number): Promise<string[]> {
  const c = await capture(ws, env, undefined, t0 - 500, t1 + 1500, withFields(envMasker(ws, env)));
  let map = null;
  try { map = loadGraph(ws).map; } catch { /* no map: only SQL and brokers are known */ }
  return storesWritten(c, new Set((map?.nodes ?? []).filter((n) => n.type === 'datastore').map((n) => n.name)));
}

const mustBeUp = async (ws: Workspace, env: string) => {
  const st = await status(ws, env);
  if (st.state !== 'ready') throw new ScenarioError(`${env} is ${st.state}; bring it up first: laru up ${env}`);
};

/**
 * Plays the scenario's setup from «base» and keeps what it can as snapshots. The env is left in the scenario's state.
 * Every store with a «base» goes back to it first, so a persistent env is not touched until `confirm` says yes to what
 * `applyPlan` tells (the rows written since are lost).
 */
export async function provisionScenario(ws: Workspace, name: string, o: { env: string; confirm?: boolean }): Promise<ScenarioState> {
  const chain = chainOf(ws, scenarioOf(ws, name)), s = chain[0];
  await mustBeUp(ws, o.env);
  if (!o.confirm) { const plan = await planOf(ws, o.env, [s], true); if (plan.persistent) throw new ScenarioConfirm(plan.text); }
  return withLock(`scenario ${s.slug}`, async () => {
    const t = Date.now();
    const relational = (await stores(ws, o.env)).filter((x) => SNAPSHOTS.has(x.kind));
    for (const x of relational) { if (await hasSnapshot(x)) await reset(x); else await snapshot(x); }
    await setChain(ws, o.env, chain.slice(0, 1));
    const out = join(dirOf(ws, o.env), s.slug);
    const r = await playSetup(ws, o.env, s, out);
    const key = await keyOf(ws, o.env, s);
    const base = { slug: s.slug, env: o.env, key, provisionedAt: new Date().toISOString(), identities: r.identities, signedIn: r.signedIn };
    if (!r.ok) { const broken: ScenarioState = { ...base, ms: Date.now() - t, mode: 'replay', touched: [], keeps: [], broken: r.error }; saveState(ws, broken); return broken; }
    const touched = await written(ws, o.env, r.t0, r.t1);
    const snap = relational.filter((x) => touched.includes(x.service));
    for (const x of snap) await snapshot(x, s.slug);
    const keeps = touched.filter((x) => !relational.some((y) => y.service === x));
    if (r.signedIn) writeFileSync(join(dirOf(ws, o.env), `${s.slug}.storage.json`), readRunnerFile(out, 'storage.json') ?? '', { mode: 0o600 });
    rmSync(out, { recursive: true, force: true });
    const state: ScenarioState = { ...base, ms: Date.now() - t, mode: keeps.length ? 'replay' : 'snapshot', touched, keeps };
    saveState(ws, state);
    return state;
  }, undefined, envLock(ws, o.env));
}

/** What applying a scenario on an env would do, and the words to say it. */
export interface ApplyPlan {
  /** the env keeps data worth keeping: applying asks first */
  persistent: boolean;
  /** its setup is played: never provisioned, broken, played again each time, or what it depends on changed */
  plays: boolean;
  /** relational stores put back, from the scenario's snapshot or from «base»: the rows written since are lost */
  restores: Array<{ x: Store; from: 'scenario' | 'base' }>;
  restarts: string[];
  /** the scenario empties the mailbox: how many messages it holds now */
  mailbox?: number;
  /** stores with nothing to put back: they keep what they hold */
  keeps: string[];
  /** how long its last application took */
  lastMs?: number;
  state: ScenarioState | null;
  text: string;
}

const and = (l: string[]) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} y ${l[l.length - 1]}` : l[0]);
/** The confirmation's words, as the person reads them in «Aplicar», `--yes` and `confirm`. */
export function planText(p: Pick<ApplyPlan, 'plays' | 'restores' | 'restarts' | 'keeps' | 'lastMs' | 'mailbox'>): string {
  const from = (k: 'scenario' | 'base') => p.restores.filter((r) => r.from === k).map((r) => r.x.service);
  const [sc, ba] = [from('scenario'), from('base')];
  const did = [
    ...(sc.length || ba.length ? [`se restaura${sc.length + ba.length > 1 ? 'n' : ''} ${[sc.length && `${and(sc)} desde la instantánea del escenario`, ba.length && `${and(ba)} desde la instantánea «base»`].filter(Boolean).join(' y ')} (se pierden las filas de hoy)`] : []),
    ...(p.plays ? ['se juega la preparación del escenario, que escribe sobre lo que hay'] : []),
    ...(p.restarts.length ? [`se reinicia${p.restarts.length > 1 ? 'n' : ''} ${and(p.restarts)}`] : []),
    ...(p.mailbox !== undefined ? [`se vacía el buzón: ${p.mailbox === 1 ? '1 mensaje' : `${p.mailbox} mensajes`}`] : []),
  ];
  const head = did.length ? and(did).replace(/^./, (c) => c.toUpperCase()) : 'No se borra ni se reinicia nada';
  return `${head}${p.keeps.length ? `; ${and(p.keeps)} conserva${p.keeps.length > 1 ? 'n' : ''} lo que ${p.keeps.length > 1 ? 'tienen' : 'tiene'}` : ''}.${p.lastMs === undefined ? '' : ` La última vez tardó ${(p.lastMs / 1000).toFixed(1).replace('.', ',')} s.`}`;
}

/** `play`: its setup is played whatever the state says (provisioning). */
async function planOf(ws: Workspace, env: string, chain: Scenario[], play = false): Promise<ApplyPlan> {
  const s = chain[0];
  const state = scenarioState(ws, env, s.slug);
  const plays = play || !state || Boolean(state.broken) || state.mode === 'replay' || state.key !== (await keyOf(ws, env, s));
  // played from «base», so no scenario snapshot is looked at; else every relational store goes back to its scenario's or «base»
  const touched = plays ? [] : state.touched;
  const relational = (await stores(ws, env)).filter((x) => SNAPSHOTS.has(x.kind));
  const restores: ApplyPlan['restores'] = [];
  for (const x of relational) {
    if (touched.includes(x.service) && (await hasSnapshot(x, s.slug))) restores.push({ x, from: 'scenario' });
    else if (await hasSnapshot(x)) restores.push({ x, from: 'base' });
  }
  const keeps = [...new Set([...(state?.keeps ?? []), ...relational.filter((x) => !restores.some((r) => r.x === x)).map((x) => x.service)])].sort();
  const clears = chain.some((c) => c.mailbox.some((m) => m.action === 'clear')) ? mail.list(ws, env).counts.all : undefined;
  const plan = { persistent: loadEnvSpec(ws, env).persistent, plays, restores, restarts: [...new Set(chain.flatMap((c) => c.restart))], keeps, lastMs: state?.applyMs, state, ...(clears !== undefined ? { mailbox: clears } : {}) };
  return { ...plan, text: planText(plan) };
}

/** What applying the scenario on the env would do, without doing it. */
export async function applyPlan(ws: Workspace, name: string, o: { env?: string } = {}): Promise<ApplyPlan> {
  const leaf = scenarioOf(ws, name), chain = chainOf(ws, leaf);
  return planOf(ws, o.env ?? leaf.env ?? chain[0].env ?? 'local', chain);
}

/**
 * Puts the env in the scenario's state: from its snapshots when it has them and nothing it depends on changed, else
 * by playing its setup again. Then its chain's mocks, faults and restarts. A persistent env is not touched until
 * `confirm` says yes to what `applyPlan` told: the rows written since the snapshot are lost. A flow's start confirms
 * itself (the person asked to play that flow).
 */
export async function applyScenario(ws: Workspace, name: string, o: { env?: string; confirm?: boolean } = {}): Promise<Applied> {
  const leaf = scenarioOf(ws, name), chain = chainOf(ws, leaf), s = chain[0];
  const env = o.env ?? leaf.env ?? s.env ?? 'local';
  const t = Date.now();
  await mustBeUp(ws, env); // an env that is down has no stores to describe: say so before asking for a yes
  const plan = await planOf(ws, env, chain);
  if (plan.persistent && !o.confirm) throw new ScenarioConfirm(plan.text);
  let state = plan.state as ScenarioState; // none only when its setup is played, which makes one
  if (plan.plays) {
    state = await provisionScenario(ws, s.id, { env, confirm: true });
    if (state.broken) throw new ScenarioError(`${s.id} is broken: its setup failed\n${state.broken}`);
  } else {
    await withLock(`scenario ${s.slug}`, async () => { for (const r of plan.restores) await reset(r.x, r.from === 'scenario' ? s.slug : undefined); }, undefined, envLock(ws, env));
  }
  await setChain(ws, env, chain);
  mkdirSync(dirOf(ws, env), { recursive: true });
  writeFileSync(join(dirOf(ws, env), 'applied.json'), JSON.stringify({ slug: leaf.slug, at: new Date().toISOString() }));
  const ms = Date.now() - t;
  saveState(ws, { ...state, applyMs: ms });
  return { slug: leaf.slug, env, ms, provisioned: plan.plays, mode: state.mode, keeps: state.keeps, identities: state.identities, signedIn: state.signedIn };
}

/** Whether a scenario needs the whole env: it asks to be, or it changes what every flow playing would notice (mocks, faults, restarts). */
export function isExclusive(ws: Workspace, name: string): boolean {
  return chainOf(ws, scenarioOf(ws, name)).some((s) => s.exclusive || s.mocks.length > 0 || s.faults.length > 0 || s.restart.length > 0);
}

/**
 * Seeds a scenario for one flow of a run: its setup is played under the flow's own name, so its accounts and rows are
 * the flow's alone, and nothing is put back — other flows play beside it and the env keeps what it had. What it returns
 * is what the flow is told (who can sign in). Not for an exclusive scenario, which is restored and plays alone.
 */
export async function seedScenario(ws: Workspace, name: string, o: { env: string; run?: string; as: string; out: string }): Promise<{ identities: Identity[]; signedIn: boolean }> {
  const chain = chainOf(ws, scenarioOf(ws, name));
  if (isExclusive(ws, name)) throw new ScenarioError(`${name} is exclusive: it is applied, not seeded`);
  const r = await playSetup(ws, o.env, chain[0], o.out, { as: o.as, run: o.run });
  if (!r.ok) throw new ScenarioError(`${name}: its setup failed\n${r.error}`);
  return { identities: r.identities, signedIn: r.signedIn };
}
