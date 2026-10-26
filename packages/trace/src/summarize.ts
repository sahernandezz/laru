/**
 * Evidence for the AI, within a budget. The default answer says, per flow, how it ended, which step failed and what
 * it expected, then the first-anomaly chain deepest first (a transport error or an injected fault usually explains
 * the 502 above it), the error logs by service, and the calls that drill into a step, an exchange or a service.
 * Every answer says what it left out.
 */
import type { EndpointMatch } from './assemble.ts';
import { causes, noiseOf, type Cause } from './chain.ts';
import type { Exchange, RunInfo, Trace } from './trace.ts';

export interface EvidenceQuery { flow?: string; step?: number; exchange?: string; service?: string; budget?: number; /** a short case, by its title (or part of it) */ case?: string }

const tokens = (s: string) => Math.ceil(s.length / 4);
const ms = (e: Exchange) => (e.t1 === undefined ? 'open' : `${e.t1 - e.t0} ms`);
/** UUIDs are shown by their first 8 characters; composed ids (kafka:topic:partition:offset) in full. */
export const shortId = (id: string) => (/^[0-9a-f]{8}-[0-9a-f-]{27}/.test(id) ? id.slice(0, 8) + id.slice(36) : id);
const line = (e: Exchange) => `${shortId(e.id)} ${e.from}→${e.to} ${e.label}${e.status ? ` ${e.status}` : ''}${e.ok ? '' : ' ✕'} ${ms(e)}${e.fault ? ` [${e.fault}]` : ''}${e.mock ? ` [mock ${e.mock}]` : ''}${e.error ? ` (${e.error})` : ''}`;

/** How sure a link is, as the drill-down says it: nothing when sure, else the reason or the other candidates. */
const certainty = (c: Cause) => (c.certainty === 'sure' ? '' : c.certainty === 'possible' ? ` (possible; also ${(c.alt ?? []).map(shortId).join(', ')})`
  : ` (inferred${c.why?.by === 'shape' ? `: same statement as ${shortId(c.why.like)}` : c.why?.by === 'id' ? `: only it carries ${c.why.id.slice(0, 8)}` : c.why?.by === 'write' ? ': a write, not a read' : c.why?.by === 'conn' ? `: same connection ${c.why.conn}` : `: ${c.how}`})`);

/** Anomalies of a failed test, deepest in the cause tree first (through consumers too), then by time. */
export function anomalyChain(t: Trace): Array<{ why: string; e?: Exchange; log?: string }> {
  const cause = causes(t.exchanges, { actions: t.actions });
  const depth = (e: Exchange) => { let d = 0, p = cause.get(e.id)?.parent; while (p && d < 50) { d++; p = cause.get(p)?.parent; } return d; };
  const step = t.failure?.step;
  const inStep = (e: Exchange) => step === undefined || e.step === undefined || e.step <= step;
  const out: Array<{ why: string; e?: Exchange; log?: string; d: number; t: number }> = [];
  for (const e of t.exchanges.filter(inStep)) {
    const why = e.error ? 'transport error' : e.fault ? 'injected fault' : e.mock === 'miss' ? 'mock has no answer' : e.kind === 'sql' && !e.ok ? 'SQL error' : (e.status ?? 0) >= 500 ? `status ${e.status}` : null;
    if (why) out.push({ why, e, d: depth(e), t: e.t0 });
  }
  const seen = new Set<string>();
  const end = t.steps.find((s) => s.n === step)?.t1 ?? Infinity;
  for (const l of t.logs) if (l.level === 'error' && l.t <= end && !seen.has(l.service)) { seen.add(l.service); out.push({ why: `first ERROR in ${l.service}`, log: `${l.id} ${l.line.slice(0, 240)}`, d: -1, t: l.t }); }
  return out.sort((a, b) => b.d - a.d || a.t - b.t).map(({ why, e, log }) => ({ why, e, log }));
}

/** A flow's newest result that says something about the code (`error` runs do not), as the interface shows it. */
export interface FlowLast {
  run: string;
  at: string;
  status: 'passed' | 'failed' | 'cached';
  failure?: { step: number; message: string; hop?: { from: string; to: string; what: string; status?: number; error?: string } };
  cases: Array<{ test: string; status: string }>;
  /** the participants' map nodes (svc:, ds:, ext:) */
  nodes: string[];
  /** the endpoints its story reached inside a step (setup does not count), and whether every call to each was ok */
  endpoints: Array<{ id: string; steps: number[]; ok: boolean }>;
}

/** The endpoint an exchange reached: as the trace recorded it, or matched now (traces recorded before the matcher was fixed carry none). */
export const endpointOf = (e: Exchange, match: EndpointMatch) => e.endpoint ?? (e.kind === 'http' ? match(e.to, e.method, e.path) : undefined);
/** A hop as every screen says it: its endpoint's template when the map has one, else its own label. */
export const hopWhat = (e: Exchange, match: EndpointMatch) => endpointOf(e, match)?.replace(/^ep:[^:]*:/, '') ?? e.label;

/** What a flow's last traces say: the failing hop by name, the nodes it touched and the endpoints it reached. */
export function flowLast(story: Trace, cases: Trace[], match: EndpointMatch): Omit<FlowLast, 'run' | 'at' | 'status'> {
  const name = (id: string) => story.participants.find((p) => p.id === id)?.name ?? id;
  const f = story.failure, bad = f?.exchange ? story.exchanges.find((e) => e.id === f.exchange) : undefined;
  const eps = new Map<string, { id: string; steps: number[]; ok: boolean }>();
  for (const e of story.exchanges) {
    const id = e.step === undefined ? undefined : endpointOf(e, match);
    if (!id) continue;
    const ep = eps.get(id) ?? eps.set(id, { id, steps: [], ok: true }).get(id)!;
    if (!ep.steps.includes(e.step!)) ep.steps.push(e.step!);
    ep.ok &&= e.ok;
  }
  return {
    ...(f ? { failure: { step: f.step, message: f.message, ...(bad ? { hop: { from: name(bad.from), to: name(bad.to), what: hopWhat(bad, match), status: bad.status, error: bad.error } } : {}) } } : {}),
    cases: cases.map((c) => ({ test: c.test, status: c.status })),
    nodes: [...new Set([story, ...cases].flatMap((t) => t.participants.flatMap((p) => (p.node ? [p.node] : []))))],
    endpoints: [...eps.values()],
  };
}

/** One exchange kept as an example of what was asked and answered, masked as it was captured. */
export interface Sample { run: string; flow: string; test: string; id: string; method?: string; path?: string; query?: string; status?: number; reqType?: string; resType?: string; req?: Exchange['req']; res?: Exchange['res'] }
/** What the runs saw of an endpoint: how often, which statuses (`error` when none came back), the newest example of each. */
export interface SeenEndpoint { count: number; statuses: Record<string, number>; run: string; at: string; flows: string[]; drift: string[]; samples: Record<string, Sample> }
export interface SeenTopic { count: number; run: string; at: string; flows: string[]; publishers: string[]; consumers: string[]; sample?: Sample }
/** Traffic to an external or through a mock: how often, how it went over the wire, and where a mock saw it stray. */
export interface SeenTarget { count: number; run: string; at: string; kinds: string[]; mock?: string; drift: string[] }
export interface Seen { endpoints: Record<string, SeenEndpoint>; topics: Record<string, SeenTopic>; targets: Record<string, SeenTarget> }

const header = (h: Record<string, string> | undefined, name: string) => Object.entries(h ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
const add = (list: string[], x: string) => { if (!list.includes(x)) list.push(x); };

/**
 * What the given tests saw (each flow's newest story and cases, oldest run first): per endpoint matched now, per
 * topic and per external. A newer example replaces an older one unless it carries no body and the older one did.
 */
export function seenIn(tests: Array<{ trace: Trace; at: string }>, match: EndpointMatch): Seen {
  const out: Seen = { endpoints: {}, topics: {}, targets: {} };
  const sorted = [...tests].sort((a, b) => Number(a.trace.run) - Number(b.trace.run));
  for (const { trace: t, at } of sorted) {
    const type = new Map(t.participants.map((p) => [p.id, p.type]));
    const sample = (e: Exchange): Sample => ({
      run: t.run, flow: t.flow, test: t.test, id: e.id, method: e.method, path: e.path, query: e.query, status: e.status,
      reqType: header(e.reqHeaders, 'content-type'), resType: header(e.resHeaders, 'content-type'), req: e.req, res: e.res,
    });
    const told = (s?: Sample) => Boolean(s?.req?.text || s?.res?.text);
    for (const e of t.exchanges) {
      if (e.asset) continue;
      const ep = endpointOf(e, match);
      if (ep) {
        const s = (out.endpoints[ep] ??= { count: 0, statuses: {}, run: t.run, at, flows: [], drift: [], samples: {} });
        const k = e.status !== undefined ? String(e.status) : 'error';
        s.count++; s.statuses[k] = (s.statuses[k] ?? 0) + 1; s.run = t.run; s.at = at;
        add(s.flows, t.flow);
        for (const d of e.drift ?? []) add(s.drift, d);
        const x = sample(e);
        if (told(x) || !told(s.samples[k])) s.samples[k] = x;
      }
      if (e.kind === 'kafka' && e.topic) {
        const s = (out.topics[e.topic] ??= { count: 0, run: t.run, at, flows: [], publishers: [], consumers: [] });
        s.run = t.run; s.at = at;
        add(s.flows, t.flow);
        // the broker is a datastore: from it, the hop is a consumer reading; to it, a service publishing
        if (type.get(e.from) === 'datastore') add(s.consumers, e.to);
        else { s.count++; add(s.publishers, e.from); if (e.req?.text || !s.sample) s.sample = sample(e); }
      }
      if (type.get(e.to) === 'external' || e.mock || e.drift?.length) {
        const s = (out.targets[e.to] ??= { count: 0, run: t.run, at, kinds: [], drift: [] });
        s.count++; s.run = t.run; s.at = at;
        add(s.kinds, e.kind);
        if (e.mock) s.mock = e.mock;
        for (const d of e.drift ?? []) add(s.drift, d);
      }
    }
  }
  return out;
}

/**
 * What a session saw from `since` (ms from its start) on, for the AI: its anomalies deepest first, then each mark with
 * the hops it caused, noise left out, and the cursor to ask for what comes next.
 */
export function sessionSummary(run: RunInfo, t: Trace, since = 0, budget = 800): string {
  const fresh = t.exchanges.filter((e) => e.t0 >= since && !noiseOf(e));
  const open = run.phase !== 'done';
  const parts = [`session ${run.id} «${run.title ?? t.test}» on ${run.env}, ${open ? 'open' : 'saved'}: ${fresh.length} exchanges${since ? ` from ${(since / 1000).toFixed(1)} s` : ''}, ${t.steps.length} marks`];
  const bad = anomalyChain({ ...t, exchanges: fresh, logs: t.logs.filter((l) => l.t >= since), failure: undefined });
  if (bad.length) parts.push('anomalies:', ...bad.slice(0, 5).map((c, i) => `  ${i + 1}. ${c.why}: ${c.e ? line(c.e) : c.log}`));
  let step: number | undefined;
  for (const e of fresh) {
    if (e.step !== step) { step = e.step; const s = t.steps.find((x) => x.n === step); parts.push(s ? `«${s.title}» at ${(s.t0 / 1000).toFixed(1)} s` : 'before the first mark'); }
    parts.push(`  ${line(e)}`);
  }
  const next = fresh.length ? Math.max(...fresh.map((e) => e.t0)) + 1 : since;
  const tail = open ? `next: session_events({session:"${run.id}", since:${next}})` : `drill: run_evidence({run:"${run.id}", exchange:"<id>"})`;
  return `${fit(parts, budget - tokens(tail) - 1, (n) => `… ${n} more lines left out (raise budget, or ask from a later since)`)}\n${tail}`;
}

function fit(parts: string[], budget: number, omitted: (n: number) => string): string {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < parts.length; i++) {
    const cost = tokens(parts[i]) + 1;
    if (used + cost > budget - 30) { out.push(omitted(parts.length - i)); break; }
    out.push(parts[i]);
    used += cost;
  }
  return out.join('\n');
}

export function summarize(run: RunInfo, traces: Trace[], q: EvidenceQuery = {}): string {
  const budget = q.budget ?? 600;
  const pick = traces.filter((t) => !q.flow || t.flow === q.flow);
  if (q.exchange) {
    const t = pick.find((x) => x.exchanges.some((e) => e.id === q.exchange)) ?? pick.find((x) => x.exchanges.some((e) => e.id.startsWith(q.exchange!)));
    const e = t?.exchanges.find((x) => x.id === q.exchange) ?? t?.exchanges.find((x) => x.id.startsWith(q.exchange!));
    if (!t || !e) return `No exchange ${q.exchange} in run ${run.id}.`;
    const cause = causes(t.exchanges, { actions: t.actions });
    const c = cause.get(e.id), parent = c && t.exchanges.find((x) => x.id === c.parent);
    const parts = [
      `${t.flow} step ${e.step ?? '-'}: ${line(e)} (${e.origin}${e.endpoint ? `, ${e.endpoint}` : ''}${e.table ? `, table ${e.table}` : ''}${e.topic ? `, topic ${e.topic}` : ''})`,
      c && parent ? `caused by ${line(parent)}${certainty(c)}` : 'no parent exchange',
      ...(e.query ? [`query: ${e.query}`] : []),
      ...(e.reqHeaders ? [`request headers: ${JSON.stringify(e.reqHeaders)}`] : []),
      ...(e.req?.text ? [`request body (${e.req.bytes} B): ${e.req.text}`] : e.req?.note ? [`request: ${e.req.note}`] : []),
      ...(e.resHeaders ? [`response headers: ${JSON.stringify(e.resHeaders)}`] : []),
      ...(e.res?.text ? [`response body (${e.res.bytes} B): ${e.res.text}`] : e.res?.note ? [`response: ${e.res.note}`] : []),
      ...t.exchanges.filter((x) => cause.get(x.id)?.parent === e.id).map((x) => `→ ${line(x)}`),
    ];
    return fit(parts, budget, (n) => `… ${n} more lines left out (raise budget)`);
  }
  if (q.step !== undefined || q.service || q.case) {
    const t = q.case ? pick.find((x) => !x.story && x.test.toLowerCase().includes(q.case!.toLowerCase())) : (pick.find((x) => x.story) ?? pick[0]);
    if (q.case && !t) return `No case «${q.case}»${q.flow ? ` in ${q.flow}` : ''} in run ${run.id}; cases: ${pick.filter((x) => !x.story).map((x) => x.test).join(', ')}`;
    if (q.case && t && q.step === undefined && !q.service) {
      const parts = [`${t.flow} case «${t.test}» ${t.status}${t.failure ? `: ${t.failure.message}` : ''}`, ...anomalyChain(t).slice(0, 5).map((c, i) => `  ${i + 1}. ${c.why}: ${c.e ? line(c.e) : c.log}`), ...t.exchanges.map(line)];
      return fit(parts, budget, (n) => `… ${n} more left out; drill with exchange=<id>`);
    }
    if (!t) return `No flow ${q.flow ?? ''} in run ${run.id}.`;
    const s = q.step !== undefined ? t.steps.find((x) => x.n === q.step) : undefined;
    if (q.step !== undefined && !s) return `${t.flow} has steps 1–${t.steps.length}.`;
    const ex = t.exchanges.filter((e) => (!s || e.step === s.n) && (!q.service || e.from === q.service || e.to === q.service));
    const logs = t.logs.filter((l) => (!s || (l.t >= s.t0 && l.t < s.t1)) && (!q.service || l.service === q.service) && l.level !== 'debug');
    const head = s ? `${t.flow} step ${s.n}/${t.stepsTotal ?? t.steps.length} «${s.title}» ${s.status}${s.error ? `: ${s.error}` : ''}${s.expected ? `\nexpected: ${s.expected}` : ''}` : `${t.flow}, service ${q.service}: ${ex.length} exchanges, ${logs.length} log lines`;
    const parts = [head, ...ex.map(line), ...logs.filter((l) => l.level !== 'info').map((l) => `${l.id} ${l.level} ${l.line.slice(0, 200)}`)];
    return fit(parts, budget, (n) => `… ${n} more left out; drill with exchange=<id> or service=<name>`);
  }

  const flows = Object.keys(run.results).filter((f) => !q.flow || f === q.flow);
  const parts: string[] = [`run ${run.id} on ${run.env}: ${run.status}${run.error ? ` (${run.error})` : ''}, ${flows.length} flows`];
  for (const flow of flows) {
    const r = run.results[flow];
    if (r?.status === 'cached') { parts.push(`= ${flow} cached: same inputs as run ${r.cachedFrom}, which passed`); continue; }
    const mine = pick.filter((x) => x.flow === flow);
    const story = mine.find((x) => x.story) ?? mine[0];
    const cases = mine.filter((x) => x !== story);
    const badCases = cases.filter((c) => c.status === 'failed');
    if (!story) { parts.push(`✕ ${flow}: ${r?.status ?? 'no trace'}`); continue; }
    if (story.status === 'passed' && !badCases.length) { parts.push(`✓ ${flow} ${(story.durationMs / 1000).toFixed(1)} s, ${story.steps.length} steps${cases.length ? `, ${cases.length} cases` : ''}`); continue; }
    for (const c of badCases) parts.push(`✕ ${flow} case «${c.test}»: ${(c.failure?.message ?? 'failed').slice(0, 240)}${c.failure?.exchange ? ` (${shortId(c.failure.exchange)})` : ''}`);
    if (story.status !== 'failed') continue;
    const t = story;
    const f = t.failure;
    const s = t.steps.find((x) => x.n === f?.step);
    parts.push(`✕ ${t.flow} failed at step ${f?.step}/${t.stepsTotal ?? t.steps.length} «${s?.title ?? ''}»: ${(f?.message ?? '').slice(0, 300)}${s?.expected ? `\n  expected: ${s.expected.slice(0, 200)}` : ''}`);
    for (const other of (f?.all ?? []).filter((m) => m !== f?.message).slice(0, 4)) parts.push(`  also: ${other.slice(0, 240)}`);
    const chain = anomalyChain(t);
    chain.slice(0, 5).forEach((c, i) => parts.push(`  ${i + 1}. ${c.why}: ${c.e ? line(c.e) : c.log}`));
    if (chain.length > 5) parts.push(`  … ${chain.length - 5} more anomalies`);
    const errs = new Map<string, string[]>();
    for (const l of t.logs) if (l.level === 'error') errs.set(l.service, [...(errs.get(l.service) ?? []), l.id]);
    if (errs.size) parts.push(`  error logs: ${[...errs].map(([svc, ids]) => `${svc} ${ids.length} (${ids.slice(0, 3).join(', ')})`).join('; ')}`);
    if (t.foreign) parts.push(`  note: ${t.foreign} requests from the host during the run (someone else used the env)`);
    parts.push(`  next: run_evidence({run:"${run.id}", flow:"${t.flow}", step:${f?.step ?? 1}})${chain[0]?.e ? ` · run_evidence({run:"${run.id}", exchange:"${shortId(chain[0].e.id)}"})` : ''}`);
  }
  return fit(parts, budget, (n) => `… ${n} more lines left out (raise budget or ask for one flow)`);
}
