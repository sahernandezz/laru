/**
 * Findings: where the code, the documentation and what runs disagree. Computed on demand from the map (with what
 * runs observed), the documentation, the runs index and the last traces; never stored. A finding is accepted in
 * the versioned findings.yaml with a reason and, optionally, an expiry that reopens it.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { Graph } from './graph.ts';
import { evaluateConventions } from './knowledge/coverage.ts';
import type { Row } from './knowledge/piece.ts';
import { freshness, type Knowledge } from './knowledge/store.ts';
import { stateDir, WorkspaceError, type Workspace } from './workspace.ts';

export type FindingType = 'undeclared-call' | 'dead-declaration' | 'contract-drift' | 'untested-endpoint' | 'stale-fact' | 'convention-violated' | 'missing-var' | 'unused-var' | 'table-multi-writer' | 'flow-unstable' | 'flow-env-missing' | 'scenario-broken' | 'behavior-drift' | 'deviation-fixed' | 'fidelity-gap';

export interface Finding {
  key: string;
  type: FindingType;
  subject: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  evidence?: string;
  accepted?: { reason: string; until?: string; by?: string };
  /** with several projects: the subject's (`audit`), or both ends of a call across (`audit → vaultflow`) */
  project?: string;
}

export interface Acceptance { reason: string; until?: string; by?: string }
export const findingsFile = (ws: Workspace) => join(ws.root, 'findings.yaml');

export function loadAccepted(ws: Workspace): Record<string, Acceptance> {
  const f = findingsFile(ws);
  if (!existsSync(f)) return {};
  const doc = (parse(readFileSync(f, 'utf8')) ?? {}) as { accepted?: Record<string, Acceptance> };
  for (const [k, a] of Object.entries(doc.accepted ?? {})) if (!a?.reason?.trim()) throw new WorkspaceError('an accepted finding needs a reason', `findings.yaml: accepted.${k}.reason`);
  return doc.accepted ?? {};
}

/** Accepts a finding; `flow-unstable` accepted is the flow's quarantine. */
export function acceptFinding(ws: Workspace, key: string, a: Acceptance): void {
  if (!a.reason?.trim()) throw new WorkspaceError('say why it is accepted', 'reason');
  if (a.until && !/^\d{4}-\d\d-\d\d$/.test(a.until)) throw new WorkspaceError('a date YYYY-MM-DD', 'until');
  const accepted = { ...loadAccepted(ws), [key]: { reason: a.reason.trim(), ...(a.until ? { until: a.until } : {}), ...(a.by ? { by: a.by } : {}) } };
  writeFileSync(findingsFile(ws), `# Findings accepted on purpose, with the reason. An expired \`until\` reopens the finding.\n${stringify({ accepted }, { lineWidth: 0 })}`);
}

interface RunIndexRow { run: string; flow: string; status: string; at: string; fixed?: string[] }
function runIndex(ws: Workspace): RunIndexRow[] {
  const f = join(stateDir(ws), 'runs', 'index.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunIndexRow) : [];
}

interface TraceLike { flow: string; run: string; test?: string; exchanges: Array<{ id: string; from: string; to: string; label: string; status?: number; endpoint?: string; method?: string; path?: string; drift?: string[]; kind: string; asset?: boolean; t0: number; t1?: number }> }
/**
 * What the service sheet reads too: each flow's newest result that is not an error (a cached one read from the run
 * it reused), its story and its cases, each with its test so a finding says where to look.
 */
function lastTraces(ws: Workspace, idx: RunIndexRow[]): TraceLike[] {
  const last = new Map<string, RunIndexRow>();
  for (const r of idx) if (r.status !== 'error') last.set(r.flow, r);
  const read = (f: string) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined);
  return [...last.values()].flatMap((r) => {
    const run = String((r.status === 'cached' ? read(join(stateDir(ws), 'runs', r.run, 'run.json'))?.results?.[r.flow]?.cachedFrom : undefined) ?? r.run);
    const dir = join(stateDir(ws), 'runs', run, 'flows', r.flow), story = read(join(dir, 'trace.json')) as TraceLike | undefined;
    return [...(story ? [story] : []), ...((read(join(dir, 'cases.json')) ?? []) as TraceLike[])].map((t) => ({ ...t, flow: r.flow, run }));
  });
}

/** `{x}`, `:x` and `${x}` as one placeholder, so a contract's path and the code's compare (as the web's contracts read them). */
const norm = (p: string) => ('/' + p).replace(/\/+/g, '/').replace(/\$\{[^}]*\}|\{[^}]*\}|:[A-Za-z_]\w*/g, '{}').replace(/(.)\/$/, '$1');
const holes = (p: string) => (norm(p).match(/\{\}/g) ?? []).length;
/** A status a contract's errors list: itself, or a class written as `4xx`. */
const listed = (status: string, declared: string[]) => declared.some((d) => d === status || (/^\dxx$/i.test(d) && d[0] === status[0]));

export interface VaultIssueLike { level: string; key: string; code?: string; service?: string; message: string }

/** The map endpoint a request to a service reached (trace's `endpointMatcher`), so a literal one is not taken for a template. */
export type EndpointMatch = (svc: string, method?: string, path?: string) => string | undefined;

export async function computeFindings(ws: Workspace, g: Graph | null, k: Knowledge, o: { vaultIssues?: VaultIssueLike[]; today?: string; match?: EndpointMatch; envGaps?: Array<{ flow: string; projects: string[] }>; fidelityGaps?: Array<{ env: string; kind: string; name: string; aspect?: string; local: string; prod: string | null; source: string | null }> } = {}): Promise<Finding[]> {
  const out: Finding[] = [];
  const projectOf = (subject: string, detail?: string) => {
    if (ws.repos.length < 2 || !g) return undefined;
    const a = g.nodes.get(subject)?.repo, b = detail ? g.nodes.get(detail)?.repo : undefined;
    return a && b && a !== b ? `${a} → ${b}` : a ?? b;
  };
  const add = (f: Omit<Finding, 'key'> & { detail?: string }) => {
    const project = projectOf(f.subject, f.detail);
    out.push({ key: `${f.type}:${f.subject}${f.detail ? `:${f.detail}` : ''}`, type: f.type, subject: f.subject, severity: f.severity, message: f.message, evidence: f.evidence, ...(project ? { project } : {}) });
  };
  const idx = runIndex(ws);
  const traces = lastTraces(ws, idx);

  if (g) {
    // A call runs made that the code analysis does not know; a declared call no run has made although its caller ran.
    for (const f of g.map.facts) {
      if (f.origin === 'observed' && f.p === 'calls') add({ type: 'undeclared-call', subject: f.s, detail: f.o, severity: 'warning', message: `${f.s} calls ${f.o} in runs, and nothing in the code says so`, evidence: f.seen ? `run ${f.seen.run}, ${f.seen.count}×` : undefined });
    }
    const ran = new Set(g.map.facts.filter((f) => f.seen).map((f) => f.s));
    // Calls the last runs made, matched at read time too (old traces carry no endpoint and left no seen fact), and
    // followed through proxies: a call reaches whatever endpoint the same method and path hit inside its time.
    const made = new Set<string>();
    for (const t of traces) for (const e of t.exchanges) {
      if (!e.method || !e.path) continue;
      for (const x of t.exchanges) {
        if (x.method !== e.method || x.path !== e.path || x.t0 < e.t0 - 2 || x.t0 > (e.t1 ?? e.t0) + 2) continue;
        const id = x.endpoint ?? o.match?.(x.to, x.method, x.path);
        if (id) made.add(`svc:${e.from}|${id}`);
      }
    }
    for (const f of g.map.facts) {
      if (f.p !== 'calls' || f.origin === 'observed' || f.seen || made.has(`${f.s}|${f.o}`) || !ran.has(f.s) || !f.o.startsWith('ep:')) continue;
      add({ type: 'dead-declaration', subject: f.s, detail: f.o, severity: 'info', message: `${f.s} declares a call to ${f.o} that no run has made`, evidence: f.anchor ? `${f.anchor.path}${f.anchor.line ? `:${f.anchor.line}` : ''}` : undefined });
    }
    // Endpoints no run has reached, once runs exist.
    if (idx.length) {
      const reached = new Set(g.map.facts.filter((f) => f.p === 'calls' && f.seen).map((f) => f.o));
      // matched at read time too, as the service sheet does: old traces carry no endpoint
      for (const t of traces) for (const e of t.exchanges) { const id = e.endpoint ?? o.match?.(e.to, e.method, e.path); if (id) reached.add(id); }
      for (const ep of g.ofType('endpoint')) if (!reached.has(ep.id) && !ep.attrs?.contract) add({ type: 'untested-endpoint', subject: ep.id, severity: 'info', message: `no flow reaches ${ep.name}` });
    }
    // More than one service writing a table, against the owner the documentation names.
    const writers = new Map<string, Set<string>>();
    for (const f of g.map.facts) if (f.p === 'writes') (writers.get(f.o) ?? writers.set(f.o, new Set()).get(f.o)!).add(f.s);
    const owners = new Map<string, string>();
    for (const p of k.pieces) {
      if (p.type === 'data-model') for (const e of (p.fields.entities ?? []) as Row[]) if (e.table && e.owner) owners.set(`tbl:${e.table}`, e.owner);
      if (p.type === 'datastore') for (const c of (p.fields.contents ?? []) as Row[]) if (c.name && c.owner) owners.set(`tbl:${c.name}`, c.owner);
    }
    for (const [t, ws_] of writers) {
      const owner = owners.get(t);
      const others = [...ws_].filter((s) => !owner || s !== owner);
      if (ws_.size > 1 || (owner && others.length)) add({ type: 'table-multi-writer', subject: t, severity: 'warning', message: `${t} is written by ${[...ws_].join(', ')}${owner ? `; its owner is ${owner}` : ''}` });
    }
  }

  // Contract drift: what a mock saw stray, and observed operations the contracts of a service do not declare.
  const contracts = k.pieces.filter((p) => p.type === 'contract');
  for (const t of traces) for (const e of t.exchanges) {
    const evidence = `run ${t.run} ${t.flow}${t.test ? ` · ${t.test}` : ''}`;
    for (const d of e.drift ?? []) if (!d.startsWith('not validated')) add({ type: 'contract-drift', subject: e.to, detail: d, severity: 'warning', message: `${e.from}→${e.to} ${e.label}: ${d}`, evidence });
    if (e.kind !== 'http' || e.asset || !e.method || !e.path) continue;
    const mine = contracts.flatMap((c) => ((c.fields.operations ?? []) as Row[]).filter((op) => op.service === `svc:${e.to}`).map((op) => ({ c, op })));
    if (!mine.length) continue;
    const ops = mine.filter(({ op }) => String(op.method).toUpperCase() === e.method);
    // The map endpoint it reached decides, as on the service sheet: `/api/files/quarantine` is its own, not `{fileId}`.
    const id = e.endpoint ?? o.match?.(e.to, e.method, e.path), ep = id ? g?.nodes.get(id) : undefined;
    const match = ep ? ops.find(({ op }) => norm(op.path) === norm(String(ep.attrs?.path)))
      : [...ops].sort((a, b) => holes(a.op.path) - holes(b.op.path)).find(({ op }) => new RegExp(`^${norm(op.path).replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\}/g, '[^/]+')}/?$`).test(e.path!));
    if (!match) {
      // an endpoint the code's own OpenAPI file declares is documented there
      if (!ep?.attrs?.contract) add({ type: 'contract-drift', subject: e.to, detail: `${e.method} ${ep ? ep.attrs?.path : e.path}`, severity: 'warning', message: `${e.method} ${e.path} reached ${e.to} and none of its contracts declares it`, evidence });
      continue;
    }
    if (e.status && e.status >= 400) {
      const declared = ((match.c.fields.errors ?? []) as Row[]).map((r) => String(r.status ?? r.code ?? '').trim());
      if (!listed(String(e.status), declared)) add({ type: 'contract-drift', subject: e.to, detail: `${e.method} ${match.op.path} ${e.status}`, severity: 'warning', message: `${e.method} ${match.op.path} answered ${e.status}, which ${match.c.id} does not list among its errors`, evidence });
    }
  }

  // Documentation whose anchored code moved, and conventions the code breaks.
  for (const p of k.pieces) if (freshness(ws, p) === 'stale') add({ type: 'stale-fact', subject: p.id, severity: 'warning', message: `${p.id}: its anchored code changed since it was verified` });
  for (const [id, r] of await evaluateConventions(ws, k)) for (const v of r.violations) add({ type: 'convention-violated', subject: id, detail: `${v.file}${v.line ? `:${v.line}` : ''}`, severity: 'warning', message: `${v.file}${v.line ? `:${v.line}` : ''} breaks ${id} (${v.rule})` });

  // Variables, from the runtime's checks.
  for (const i of o.vaultIssues ?? []) {
    const type: FindingType | null = i.code === 'unused-var' ? 'unused-var' : i.code === 'missing-var' || i.code === 'blank-override' ? 'missing-var' : null;
    if (type) add({ type, subject: `var:${i.key}`, detail: i.service, severity: type === 'missing-var' ? 'error' : 'info', message: i.message });
  }

  // A flow whose projects no env runs together: it cannot be played anywhere.
  for (const gap of o.envGaps ?? []) add({ type: 'flow-env-missing', subject: gap.flow, severity: 'warning', message: `${gap.flow} necesita ${gap.projects.slice(0, -1).join(', ')}${gap.projects.length > 1 ? ' y ' : ''}${gap.projects.at(-1)}; ningún entorno los tiene` });

  // A flow that flips: at least 2 changes of result in its last 6 (infrastructure errors do not count).
  const byFlow = new Map<string, string[]>();
  for (const r of idx) if (r.status === 'passed' || r.status === 'failed') byFlow.set(r.flow, [...(byFlow.get(r.flow) ?? []), r.status]);
  for (const [flow, statuses] of byFlow) {
    const last = statuses.slice(-6);
    const flips = last.slice(1).filter((s, i) => s !== last[i]).length;
    if (flips >= 2) add({ type: 'flow-unstable', subject: `flow:${flow}`, severity: 'warning', message: `flow:${flow} changed result ${flips} times in its last ${last.length} runs (${last.join(' ')})` });
  }

  // A story whose newest run does not do what its approved behavior says (the run kept the drift beside its trace).
  for (const p of k.pieces.filter((x) => x.type === 'flow' && existsSync(join(ws.root, x.dir, 'behavior.yaml')))) {
    const slug = p.id.replace(/^flow:/, '');
    const last = idx.filter((r) => r.flow === slug && r.status !== 'error' && r.status !== 'cached').at(-1);
    const file = last && join(stateDir(ws), 'runs', last.run, 'flows', slug, 'behavior-diff.json');
    if (!file || !existsSync(file)) continue;
    const d = JSON.parse(readFileSync(file, 'utf8')) as { approvedRun: string; drifts: Array<{ step: string; kind: string; hop: string }> };
    if (!d.drifts.length) continue;
    const first = d.drifts[0];
    add({ type: 'behavior-drift', subject: p.id, severity: 'warning', evidence: last.run, message: `${p.id}: ${d.drifts.length} hop(s) differ from the behavior approved in run ${d.approvedRun}, in run ${last.run}; first, step «${first.step}»: ${first.kind} ${first.hop}` });
  }

  // A known deviation that stopped failing while the flow still says «hoy …» about it: the text is what is out of date.
  for (const p of k.pieces.filter((x) => x.type === 'flow')) {
    const slug = p.id.replace(/^flow:/, '');
    const fixed = new Set(idx.filter((r) => r.flow === slug).flatMap((r) => r.fixed ?? []));
    if (!fixed.size) continue;
    const rows = [...((p.fields.steps ?? []) as Row[]).map((r) => [String(r.step ?? ''), String(r.expected ?? ''), 'paso'] as const), ...((p.fields.cases ?? []) as Row[]).map((r) => [String(r.case ?? ''), String(r.expected ?? ''), 'caso'] as const)];
    const last = idx.filter((r) => r.flow === slug && (r.status === 'passed' || r.status === 'failed')).at(-1);
    const dir = last && join(stateDir(ws), 'runs', last.run, 'flows', slug);
    const failing = new Set<string>();
    for (const f of ['trace.json', 'cases.json']) {
      if (!dir || !existsSync(join(dir, f))) continue;
      const t = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { test?: string; status?: string; steps?: Array<{ title: string; status: string }> } | Array<{ test: string; status: string }>;
      for (const x of Array.isArray(t) ? t : [t]) { if (x.status === 'failed' && 'test' in x && x.test) failing.add(x.test); for (const st of ('steps' in x ? x.steps ?? [] : [])) if (st.status === 'failed') failing.add(st.title); }
    }
    for (const [name, expected, what] of rows) {
      if (!fixed.has(name) || failing.has(name) || !/\bhoy\b/i.test(expected)) continue;
      add({ type: 'deviation-fixed', subject: p.id, detail: name, severity: 'info', evidence: last?.run, message: `${p.id}: el ${what} «${name}» ya no falla, pero «Se espera» aún dice «hoy …»; actualiza el texto de «Lo que debe»` });
    }
  }

  // A scenario with no setup to play, or whose setup failed on an env (the runtime keeps that in .laru/envs/<env>/scenarios/).
  for (const p of k.pieces.filter((x) => x.type === 'scenario')) {
    const slug = p.id.replace(/^scn:/, '');
    if (!p.meta?.extends && !existsSync(join(ws.root, p.dir, `${slug}.setup.ts`))) add({ type: 'scenario-broken', subject: p.id, detail: 'setup', severity: 'warning', message: `${p.id} has no setup to play: ${p.dir}/${slug}.setup.ts` });
  }
  const envs = join(stateDir(ws), 'envs');
  for (const env of existsSync(envs) ? readdirSync(envs) : []) {
    const dir = join(envs, env, 'scenarios');
    for (const f of existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'applied.json' && !n.endsWith('.storage.json')) : []) {
      let st: { slug?: string; broken?: string; provisionedAt?: string } = {};
      try { st = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
      if (st.broken && st.slug && k.byId.has(`scn:${st.slug}`)) add({ type: 'scenario-broken', subject: `scn:${st.slug}`, detail: env, severity: 'error', message: `scn:${st.slug} failed its setup on ${env}: ${st.broken.split('\n')[0]}`, evidence: st.provisionedAt });
    }
  }

  // Where an env differs from what the repos (or a piece) say production runs: informative, accepted with a reason.
  for (const d of o.fidelityGaps ?? []) add({ type: 'fidelity-gap', subject: `env:${d.env}`, detail: `${d.kind}:${d.name}${d.aspect ? `:${d.aspect}` : ''}`, severity: 'info', evidence: d.source ?? undefined, message: `${d.env}: ${d.name} (${d.kind}) runs ${d.local}; production: ${d.prod} (${d.source})` });

  // Acceptances: a valid one silences its finding until it expires.
  const accepted = loadAccepted(ws);
  const today = o.today ?? new Date().toISOString().slice(0, 10);
  for (const f of out) { const a = accepted[f.key]; if (a && (!a.until || a.until >= today)) f.accepted = a; }
  const seen = new Set<string>();
  return out.filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)));
}
