/**
 * Why each exchange of a trace happened, and which person action (or test call) each chain hangs from. Pure: the
 * trace alone decides, never the map or the knowledge, so old traces get the same tree. Links are sure (the same
 * request forwarded, the same message delivered, the same notice relayed), inferred (one candidate in time, or one
 * left by a stated reason) or possible (several fit; the first is drawn, the rest are named).
 */
import { isBrowser, type Action, type ActionKind, type Exchange, type Trace } from './trace.ts';

export type Certainty = 'sure' | 'inferred' | 'possible';
export type How = 'forward' | 'message' | 'relay' | 'stream' | 'inside' | 'consume' | 'reaction' | 'callback';
/** why an ambiguous link was narrowed to one candidate */
export type Why = { by: 'shape'; like: string } | { by: 'id'; id: string } | { by: 'write' } | { by: 'conn'; conn: string };
export interface Cause { parent: string; how: How; certainty: Certainty; why?: Why; alt?: string[] }
export type Noise = 'asset' | 'stream' | 'hello' | 'preflight' | 'foreign';
export type ActKind = 'person' | 'burst' | 'page' | 'setup' | 'check';
/** A top-level node of the tree. `id`: `preparacion`, `m<n>` for marks that sent nothing, else its first root's id. */
export interface Act { id: string; kind: ActKind; t0: number; step?: number; marks: Action[]; roots: string[]; /** ×N compacted checks */ n?: number }
export interface Chain {
  cause: Map<string, Cause>;
  /** what each exchange caused, in time order */
  effects: Map<string, string[]>;
  /** in time order */
  acts: Act[];
  orphans: Array<{ id: string; reason: 'unknown-ip' | 'ambiguous-publisher' | 'host' | 'no-cause' }>;
  noise: Map<string, Noise>;
  /** exchange id → act id, through its root */
  actOf: Map<string, string>;
}

// Known limit: every knob was calibrated on vaultflow runs 42 and 44 only; recalibrate when another app's traces disagree.
export const KNOBS = {
  /** how far a parent may start after, or end before, what it contains */
  TOL_MS: 2,
  /** an SSE event relayed one hop nearer the browser, at most this later */
  RELAY_MS: 50,
  /** a consumer's work stops counting as the message's this long after the last thing linked to it */
  CONSUME_IDLE_MS: 1000,
  /** a browser request this soon after a notice reached it is the page reacting */
  REACT_MS: 100,
  /** without marks, a quieter stretch than this starts a new burst */
  BURST_GAP_MS: 300,
  /** with marks, a browser request this long after the person's last activity is the page's own */
  PAGE_IDLE_MS: 1000,
};
export type Knobs = typeof KNOBS;
export interface Opts extends Partial<Knobs> {
  actions?: Action[];
  /**
   * tier d, by store connection: off until one pid per request holds on real runs (≥ 95% of the requests and of the
   * listeners with ≥ 2 inferred statements). vaultflow run 55: requests 91/92, Kafka listeners 14/15 (93%), so off.
   */
  conn?: boolean;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const HELLO = new Set(['connected', 'open', 'ping', 'heartbeat', 'keep-alive']);
const WRITE_SQL = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE']);
const INPUT = new Set<ActionKind>(['fill', 'type', 'press', 'check', 'uncheck', 'select', 'hover']);
/** what assemble names a Kafka publisher the map cannot tell */
const AMBIGUOUS = 'publicador ambiguo';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const end = (e: Exchange) => e.t1 ?? e.t0;
/** Processing order: by start, then end, then id. */
const byTime = (a: Exchange, b: Exchange) => a.t0 - b.t0 || end(a) - end(b) || cmp(a.id, b.id);
/** Candidate rank: the latest started, then the one ending first, then id. */
const byRank = (a: Exchange, b: Exchange) => b.t0 - a.t0 || end(a) - end(b) || cmp(a.id, b.id);

/** A connection kept open: a WebSocket, or a response that streams (SSE). */
export const isStream = (e: Exchange) => e.kind === 'ws' || e.status === 101 || /event-stream/i.test(String(e.resHeaders?.['content-type'] ?? ''));
/** An SSE event that only greets or keeps the channel alive. */
export const isHello = (e: Exchange) => e.kind === 'sse' && (HELLO.has(e.label.replace(/^evento /, '')) || !e.res?.text);
export const isConsume = (e: Exchange) => e.kind === 'kafka' && e.id.includes('>');
/** Who acts in a hop: its sender, except an SSE event, which the server sends down the stream. */
export const actorOf = (e: Exchange) => (e.kind === 'sse' ? e.to : e.from);
export function noiseOf(e: Exchange): Noise | undefined {
  if (e.asset) return 'asset';
  if (isStream(e)) return 'stream';
  if (isHello(e)) return 'hello';
  if (e.method === 'OPTIONS') return 'preflight';
  if (e.from === 'host') return 'foreign';
}

const writes = (e: Exchange) => (e.kind === 'sql' ? WRITE_SQL.has(e.label.split(' ')[0]) : e.kind === 'kafka' ? !isConsume(e) : e.kind === 'http' && ['PUT', 'POST', 'DELETE', 'PATCH'].includes(e.method ?? ''));
const safe = (c: Exchange) => !isConsume(c) && ['GET', 'HEAD', 'OPTIONS'].includes(c.method ?? '');
const toks = (s?: string) => (s ? (s.match(UUID) ?? []) : []);
/**
 * The ids a request carries: in its path, query, header values and body (a statement's parameters included). A whole
 * value (a fileId) comes before an id inside a name (`40fd…_informe.pdf`), each in the order it is carried.
 */
const carried = (e: Exchange) => {
  const s = [e.path, e.query, e.req?.text, Object.values(e.reqHeaders ?? {}).join(' ')].join('\n');
  const named = (m: RegExpExecArray) => /[\w.]/.test(s[m.index - 1] ?? '') || /[\w.]/.test(s[m.index + m[0].length] ?? '');
  const ids = [...s.matchAll(UUID)].sort((a, b) => Number(named(a)) - Number(named(b))).map((m) => m[0]);
  // then the values that tell two requests of one shape apart: a username or an email a test made with uniq(), with
  // letters and digits and at least 8 characters (two people registering at once differ only there)
  return [...ids, ...new Set((s.match(VALUE) ?? []).filter((v) => /\d/.test(v) && /[a-z]/i.test(v) && !ids.some((id) => id.includes(v) || v.includes(id))))];
};
const VALUE = /[A-Za-z0-9][\w.@+-]{7,}/g;
/** The same statement or call: SQL before its parameters, http to the same place with its last segment open, else the label. */
const fingerprint = (e: Exchange) => (e.kind === 'sql' ? `sql:${(e.req?.text ?? '').split('\n-- ')[0]}`
  : e.kind === 'http' ? `http:${e.to} ${e.method} ${(e.path ?? '').replace(/\/[^/]*$/, '/*')}` : `${e.kind}:${e.label}`);
/** What a candidate stands for: its endpoint (method and path, ids folded) or the topic it consumed. */
const keyOf = (c: Exchange) => (isConsume(c) ? `consume:${c.label}` : `req:${c.to} ${c.method} ${(c.path ?? '').replace(UUID, '{id}')}`);
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

/** Every exchange's cause, by the rules in order (first match wins); roots have none. */
export function causes(exchanges: Exchange[], o: Opts = {}): Map<string, Cause> {
  const k = { ...KNOBS, ...o };
  const ex = [...exchanges].sort(byTime);
  const by = new Map(ex.map((e) => [e.id, e]));
  const out = new Map<string, Cause>();
  const sse = ex.filter((e) => e.kind === 'sse');
  // Known limit: per-actor arrays scanned in full, O(n·k); an interval tree past some 10k exchanges.
  const into = new Map<string, Exchange[]>();
  const consumesOf = new Map<string, Exchange[]>();
  for (const e of ex) {
    if ((e.kind === 'http' || e.kind === 'ws' || e.kind === 'tcp') && !e.asset) push(into, e.to, e);
    if (isConsume(e)) push(consumesOf, e.to, e);
  }
  /** fingerprint → candidate key it was seen under alone → the exchange that showed it */
  const learned = new Map<string, Map<string, string>>();
  /** consume id → when the last thing linked to it started */
  const lastWork = new Map<string, number>();
  /** candidate id → the connections its anchored statements ran on */
  const holds = new Map<string, Set<string>>();
  const pick = (e: Exchange, xs: Exchange[], how: How, one: Certainty) => {
    const [p, ...rest] = [...xs].sort(byRank);
    out.set(e.id, rest.length ? { parent: p.id, how, certainty: 'possible', alt: rest.map((x) => x.id) } : { parent: p.id, how, certainty: one });
  };
  const open = (p: Exchange, t: number) => (p.t1 ?? Infinity) >= t - k.TOL_MS;

  for (const e of ex) {
    // 1. message: a consume row is the delivery of the publish with the same topic, partition and offset
    if (isConsume(e)) {
      const pub = e.id.split('>')[0];
      if (by.has(pub)) out.set(e.id, { parent: pub, how: 'message', certainty: 'sure' });
      continue;
    }
    if (e.kind === 'sse') {
      // 2. relay: the same notice one hop further from the browser, a moment before
      const up = sse.filter((u) => u !== e && u.from === e.to && u.label === e.label && e.t0 - u.t0 >= 0 && e.t0 - u.t0 <= k.RELAY_MS && u.res?.text === e.res?.text);
      if (up.length) { pick(e, up, 'relay', 'sure'); continue; }
      // 3. stream, greetings only: their stream's row, or (its row comes at close, and it never closed) the stream into
      // its opener with the same method and path
      if (isHello(e)) {
        const x = e.id.slice(0, e.id.lastIndexOf('.'));
        if (x && by.has(x)) { out.set(e.id, { parent: x, how: 'stream', certainty: 'sure' }); continue; }
        const op = (into.get(e.from) ?? []).filter((p) => isStream(p) && p.method === e.method && p.path === e.path && p.t0 <= e.t0 + k.TOL_MS && open(p, e.t0));
        if (op.length) pick(e, op, 'stream', 'inferred');
        continue;
      }
    }
    // 3b. callback: a sink's status call about a message hangs from the exchange that made the message (the same id), however late it comes
    if (e.msg?.cb) {
      const made = ex.find((x) => x.msg?.id === e.msg!.id && !x.msg.cb);
      if (made) out.set(e.id, { parent: made.id, how: 'callback', certainty: 'sure' });
      continue;
    }
    // 4. the browser, the test and the host start chains
    if (isBrowser(e.from) || e.from === 'runner' || e.from === 'host') continue;
    const a = actorOf(e);
    const within = (into.get(a) ?? []).filter((p) => p !== e && p.t0 <= e.t0 + k.TOL_MS && open(p, end(e)));
    // 5. forward: the same call into its sender, around it (a proxy keeps the path)
    // Known limit: a proxy that rewrites paths falls to rule 6; the map's forwards-to facts would keep it a forward.
    const same = (p: Exchange) => e.kind === 'http' && p.method === e.method && p.path === e.path;
    // A proxy may close its side a few ms after answering: open when the call started is enough when nothing contains it.
    let fwd = within.filter(same);
    if (!fwd.length) fwd = (into.get(a) ?? []).filter((p) => p !== e && same(p) && p.t0 <= e.t0 + k.TOL_MS && open(p, e.t0));
    if (fwd.length) { pick(e, fwd, 'forward', 'sure'); continue; }
    // 6. inside a request the actor was serving, or while it processed a message it consumed
    // Known limit: one listener at a time per service; per-topic windows if a service runs listeners concurrently.
    let cands: Array<[Exchange, How]> = within.filter((p) => !isStream(p)).map((p) => [p, 'inside']);
    const mine = consumesOf.get(a) ?? [];
    for (const c of mine) {
      if (c.t0 > e.t0 + k.TOL_MS) break;
      if (mine.some((d) => c.t0 < d.t0 && d.t0 <= e.t0)) continue; // a later consume took over
      if (e.t0 - (lastWork.get(c.id) ?? c.t0) > k.CONSUME_IDLE_MS) continue; // idle since its own last work
      cands.push([c, 'consume']);
    }
    if (!cands.length) continue;
    let why: Why | undefined;
    if (cands.length > 1) {
      // a. shape: the same statement or call was seen alone under exactly one candidate's endpoint or topic
      const seen = learned.get(fingerprint(e));
      let hit = cands.filter(([c]) => seen?.has(keyOf(c)));
      if (hit.length === 1) { cands = hit; why = { by: 'shape', like: seen!.get(keyOf(hit[0][0]))! }; }
      // b. id: an id it carries that only one candidate's input carries
      const ids = carried(e);
      if (ids.length && cands.length > 1) {
        const ins = cands.map(([c]) => new Set(isConsume(c) ? [...toks(by.get(c.id.split('>')[0])?.req?.text), ...toks(c.label)] : carried(c)));
        const only = (i: number) => ids.find((t) => ins[i].has(t) && !ins.some((s, j) => j !== i && s.has(t)));
        hit = cands.filter((_, i) => only(i));
        if (hit.length === 1) { why = { by: 'id', id: only(cands.indexOf(hit[0]))! }; cands = hit; }
      }
      // c. write: a statement or call that writes is not a read's
      if (cands.length > 1 && writes(e)) {
        const nw = cands.filter(([c]) => !safe(c));
        if (nw.length && nw.length < cands.length) { cands = nw; why = { by: 'write' }; }
      }
      // d. conn: the candidate whose anchored statements ran on this connection, or the ones holding no other
      if (o.conn && e.conn && cands.length > 1) {
        const held = (c: Exchange) => holds.get(c.id);
        const on = cands.filter(([c]) => held(c)?.has(e.conn!));
        const free = cands.filter(([c]) => !held(c)?.size || held(c)!.has(e.conn!));
        const left = on.length === 1 ? on : free.length && free.length < cands.length ? free : cands;
        if (left !== cands) { cands = left; why = { by: 'conn', conn: e.conn }; }
      }
    }
    let p: Exchange, how: How;
    if (cands.length === 1) {
      [[p, how]] = cands;
      out.set(e.id, { parent: p.id, how, certainty: 'inferred', ...(why ? { why } : {}) });
      if (!why) { const f = fingerprint(e); const m = learned.get(f) ?? learned.set(f, new Map()).get(f)!; if (!m.has(keyOf(p))) m.set(keyOf(p), e.id); }
      if (e.conn && why?.by !== 'conn') (holds.get(p.id) ?? holds.set(p.id, new Set()).get(p.id)!).add(e.conn);
    } else {
      const ranked = [...cands].sort(([x], [y]) => byRank(x, y));
      [[p, how]] = ranked;
      out.set(e.id, { parent: p.id, how, certainty: 'possible', alt: ranked.slice(1).map(([c]) => c.id) });
    }
    if (how === 'consume') lastWork.set(p.id, e.t0);
  }

  // A second pass: a shape learned later in the trace settles an earlier possible link.
  for (const e of ex) {
    const l = out.get(e.id);
    const seen = learned.get(fingerprint(e));
    if (!l || l.certainty !== 'possible' || (l.how !== 'inside' && l.how !== 'consume') || !seen) continue;
    const hit = [l.parent, ...(l.alt ?? [])].map((id) => by.get(id)!).filter((c) => seen.has(keyOf(c)));
    if (hit.length === 1) out.set(e.id, { parent: hit[0].id, how: isConsume(hit[0]) ? 'consume' : 'inside', certainty: 'inferred', why: { by: 'shape', like: seen.get(keyOf(hit[0]))! } });
  }

  // 7. reaction: the page asks right after a notice reached it, and the person did nothing in between
  const marks = o.actions ?? [];
  for (const e of ex) {
    // a notice reaches one screen: only that screen's next request reacts to it
    if (!isBrowser(e.from) || e.kind !== 'http' || out.has(e.id) || e.asset) continue;
    const evs = sse.filter((s) => s.from === e.from && e.t0 - s.t0 > 0 && e.t0 - s.t0 <= k.REACT_MS && !isHello(s) && !marks.some((m) => m.t0 >= s.t0 && m.t0 <= e.t0));
    if (evs.length) out.set(e.id, { parent: [...evs].sort(byRank)[0].id, how: 'reaction', certainty: 'inferred' });
  }
  return out;
}

/** The trace as a tree: causes, the acts at its top, what folds as noise and what has no visible cause. */
export function chain(t: Pick<Trace, 'exchanges' | 'steps'> & { actions?: Action[] }, o: Opts = {}): Chain {
  const k = { ...KNOBS, ...o };
  const cause = causes(t.exchanges, { ...o, actions: t.actions });
  const ex = [...t.exchanges].sort(byTime);
  const by = new Map(ex.map((e) => [e.id, e]));
  const effects = new Map<string, string[]>();
  const noise = new Map<string, Noise>();
  for (const e of ex) {
    const c = cause.get(e.id);
    if (c) push(effects, c.parent, e.id);
    const n = noiseOf(e);
    if (n) noise.set(e.id, n);
  }
  // Folding hides a subtree: noise with real work under it (a stream whose forward was aborted) stays unfolded.
  for (const e of ex) if (!noise.has(e.id)) for (let x = cause.get(e.id)?.parent, i = 0; x && i < ex.length; x = cause.get(x)?.parent, i++) noise.delete(x);
  const roots = ex.filter((e) => !cause.has(e.id));
  const steps = [...t.steps].sort((a, b) => a.t0 - b.t0);
  const lastStep = steps.at(-1);
  /** the step an act starts in; after the last one, the last one */
  const stepOf = (time: number) => steps.findLast((s) => time >= s.t0 && time < s.t1)?.n ?? (lastStep && time >= lastStep.t1 ? lastStep.n : undefined);
  const extends_ = (e: Exchange) => noise.get(e.id) !== 'asset' && noise.get(e.id) !== 'stream';
  const acts: Act[] = [];
  const runner = roots.filter((r) => r.from === 'runner');
  const browser = roots.filter((r) => isBrowser(r.from));

  // The test's own calls: before the first step they prepare, after it they check.
  const setup = steps.length ? runner.filter((r) => r.t0 < steps[0].t0) : [];
  if (setup.length) acts.push({ id: 'preparacion', kind: 'setup', t0: setup[0].t0, marks: [], roots: setup.map((r) => r.id) });
  for (const r of runner.slice(setup.length)) acts.push({ id: r.id, kind: 'check', t0: r.t0, step: stepOf(r.t0), marks: [], roots: [r.id] });

  const marks = [...(t.actions ?? [])].sort((a, b) => a.t0 - b.t0);
  if (!marks.length) {
    // No marks: bursts of browser requests within a step. Assets and streams never stretch a burst.
    let cur: { act: Act; end: number } | undefined;
    for (const r of browser) {
      const step = stepOf(r.t0);
      if (!cur || cur.act.step !== step || r.t0 - cur.end > k.BURST_GAP_MS) acts.push((cur = { act: { id: r.id, kind: 'burst', t0: r.t0, step, marks: [], roots: [] }, end: r.t0 }).act);
      cur.act.roots.push(r.id);
      if (extends_(r)) cur.end = Math.max(cur.end, end(r));
    }
  } else {
    // Marks: each is an act, input marks folding into the next mark of their step; requests join the last mark while
    // the person is active, else they are the page's own.
    const actOfMark = new Map<Action, Act>();
    const mk = (ms: Action[]) => { const a: Act = { id: `m${marks.indexOf(ms[0])}`, kind: 'person', t0: ms[0].t0, step: stepOf(ms[0].t0), marks: ms, roots: [] }; acts.push(a); for (const m of ms) actOfMark.set(m, a); };
    let pending: Action[] = [];
    for (const m of marks) {
      if (pending.length && stepOf(pending[0].t0) !== stepOf(m.t0)) { mk(pending); pending = []; }
      if (INPUT.has(m.kind)) { pending.push(m); continue; }
      mk([...pending, m]);
      pending = [];
    }
    if (pending.length) mk(pending);
    const busy = new Map<Act, number>();
    let page: { act: Act; end: number } | undefined;
    for (const r of browser) {
      const m = marks.findLast((x) => x.t0 <= r.t0);
      const a = m && actOfMark.get(m)!;
      if (m && a && r.t0 - Math.max(m.t1, busy.get(a) ?? -Infinity) <= k.PAGE_IDLE_MS) {
        a.roots.push(r.id);
        if (!noise.has(r.id)) busy.set(a, Math.max(busy.get(a) ?? -Infinity, end(r)));
        page = undefined;
        continue;
      }
      if (!page || r.t0 - page.end > k.BURST_GAP_MS) acts.push((page = { act: { id: r.id, kind: 'page', t0: r.t0, step: stepOf(r.t0), marks: [], roots: [] }, end: r.t0 }).act);
      page.act.roots.push(r.id);
      if (extends_(r)) page.end = Math.max(page.end, end(r));
    }
    for (const a of acts) if (a.kind === 'person' && a.roots.length) a.id = a.roots[0];
  }

  acts.sort((a, b) => a.t0 - b.t0 || cmp(a.id, b.id));
  // Consecutive checks of the same call (ids folded) compact into one act ×N.
  const call = (id: string) => { const e = by.get(id)!; return `${e.method} ${(e.path ?? e.label).replace(UUID, '{id}')}`; };
  const compact: Act[] = [];
  for (const a of acts) {
    const prev = compact.at(-1);
    if (prev?.kind === 'check' && a.kind === 'check' && call(prev.roots[0]) === call(a.roots[0])) { prev.roots.push(...a.roots); prev.n = (prev.n ?? 1) + 1; continue; }
    compact.push(a);
  }

  const orphans = roots.filter((r) => !isBrowser(r.from) && r.from !== 'runner').map((r) => ({
    id: r.id, reason: r.from === 'host' ? 'host' as const : r.from.startsWith('?') || r.from === 'unknown' ? 'unknown-ip' as const : r.from === AMBIGUOUS ? 'ambiguous-publisher' as const : 'no-cause' as const,
  }));
  const actOfRoot = new Map(compact.flatMap((a) => a.roots.map((r) => [r, a.id] as const)));
  const actOf = new Map<string, string>();
  const rootOf = (id: string) => { let x = id; for (let i = 0; i < ex.length && cause.has(x); i++) x = cause.get(x)!.parent; return x; };
  for (const e of ex) { const a = actOfRoot.get(rootOf(e.id)); if (a) actOf.set(e.id, a); }
  return { cause, effects, acts: compact, orphans, noise, actOf };
}
