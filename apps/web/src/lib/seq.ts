/**
 * A trace drawn as a sequence diagram: lanes from the participants, a band per step, a row per request and per
 * response, in time order. Pure and deterministic (the same trace lays out the same way), so it is tested apart
 * from the screen. Also the exchange as cURL, built from the masked data the trace already holds.
 */
import type { Exchange, LogLine, Participant, ParticipantType, Step, Trace } from '@laru/trace';
import { actorOf, isConsume, isStream, type Act, type Chain } from '@laru/trace/chain';
import { shortId } from '@laru/trace/summarize';

export const LANE_W = 128, HEAD_H = 52, ROW_H = 28, BAND_H = 26, PAD = 16;
/** how long an instant row (a SQL statement, an event, a response) stays highlighted */
export const FLASH_MS = 300;

export interface Lane { id: string; name: string; sub: string; type: ParticipantType; x: number; project?: string }
/** With several projects, a header over each project's lanes */
export interface ProjectBand { project: string; x1: number; x2: number }
/** extra header height for the project bands */
export const PROJECT_H = 18;
export interface Band { type: 'band'; y: number; step: Step }
export interface Row {
  type: 'row';
  y: number;
  /** the row's place among rows */
  i: number;
  ex: Exchange;
  /** when the row happens: the request at t0, the response at t1 */
  t: number;
  x1: number;
  x2: number;
  label: string;
  /** a response going back */
  reply: boolean;
  /** Kafka and SSE: nobody waits for an answer */
  async: boolean;
  /** inferred, not seen on the wire */
  derived: boolean;
  /** where the exchange failed (the response, or the only row) */
  bad: boolean;
  fault?: string;
}
export interface SeqLayout { lanes: Lane[]; items: Array<Band | Row>; rows: Row[]; width: number; height: number; duration: number; bad: number; projects: ProjectBand[] }

const isFront = (p: Participant) => p.kind === 'web' || /front|portal|web|ui\b/i.test(p.name);
const isGateway = (p: Participant) => p.kind === 'gateway' || /gateway|proxy|edge|bff/i.test(p.name);
const rank = (p: Participant) => {
  switch (p.type) {
    case 'browser': return 0;
    case 'runner': return 1;
    case 'host': return 2;
    case 'service': return isFront(p) ? 3 : isGateway(p) ? 4 : 5;
    case 'tap': return 6;
    case 'datastore': return 7;
    case 'external': return 8;
  }
};
const SUB: Record<ParticipantType, string> = { browser: 'navegador', runner: 'prueba', host: 'tu máquina', service: 'servicio', tap: 'interceptor', datastore: 'almacén', external: 'externo' };

/**
 * Browser, runner, host; services with the front first and the gateway next; then stores, then externals.
 * Within a group, whoever takes part first comes first, then by name: never the order the list came in.
 * With several projects, lanes are grouped by project in the order each first takes part (browser, runner and host
 * before them, what belongs to none after), with that order inside each group.
 */
export function laneOrder(ps: Participant[], exchanges: Exchange[] = []): Participant[] {
  const first = new Map<string, number>();
  [...exchanges].sort((a, b) => a.t0 - b.t0).forEach((e, i) => { if (!first.has(e.from)) first.set(e.from, i); if (!first.has(e.to)) first.set(e.to, i); });
  const at = (p: Participant) => first.get(p.id) ?? Infinity;
  const byRank = [...ps].sort((a, b) => rank(a) - rank(b) || at(a) - at(b) || a.id.localeCompare(b.id));
  const projects = [...new Set([...ps].filter((p) => p.project).sort((a, b) => at(a) - at(b) || rank(a) - rank(b)).map((p) => p.project!))];
  if (projects.length < 2) return byRank;
  const group = (p: Participant) => (p.project ? 1 + projects.indexOf(p.project) : rank(p) <= 2 ? 0 : projects.length + 1);
  return byRank.map((p, i) => ({ p, i })).sort((a, b) => group(a.p) - group(b.p) || a.i - b.i).map((x) => x.p);
}

/** Who sends a hop and who gets it. An SSE event travels back down the stream: from the one that was asked (`to`) to the one that asked (`from`). */
export const ends = (e: Exchange): [string, string] => (e.kind === 'sse' ? [e.to, e.from] : [e.from, e.to]);
/** A hop as a route, sender first: «api-gateway ⇢ frontend» (⇢ for what nobody waits on: SSE and Kafka). */
export const route = (e: Exchange, name: (id: string) => string) => { const [a, b] = ends(e); return `${name(a)} ${e.kind === 'sse' || e.kind === 'kafka' ? '⇢' : '→'} ${name(b)}`; };

export function layoutSeq(trace: Pick<Trace, 'participants' | 'steps' | 'exchanges' | 'failure' | 'durationMs'>): SeqLayout {
  // Every end of every exchange has a lane, even one the participants missed.
  const known = new Set(trace.participants.map((p) => p.id));
  const extra = [...new Set(trace.exchanges.flatMap((e) => [e.from, e.to]))].filter((id) => !known.has(id)).map((id): Participant => ({ id, name: id, type: 'service' }));
  const lanes: Lane[] = laneOrder([...trace.participants, ...extra], trace.exchanges).map((p, i) => ({
    id: p.id, name: p.name, type: p.type, sub: p.where === 'host' ? 'en tu máquina' : p.kind || SUB[p.type], x: PAD + i * LANE_W + LANE_W / 2, ...(p.project ? { project: p.project } : {}),
  }));
  // One header per run of lanes of the same project, drawn only when the trace has more than one.
  const projects: ProjectBand[] = [];
  for (const l of lanes) {
    if (!l.project) continue;
    const last = projects.at(-1);
    if (last?.project === l.project && Math.abs(last.x2 - (l.x - LANE_W / 2)) < 1) last.x2 = l.x + LANE_W / 2;
    else projects.push({ project: l.project, x1: l.x - LANE_W / 2, x2: l.x + LANE_W / 2 });
  }
  if (new Set(projects.map((b) => b.project)).size < 2) projects.length = 0;
  const x = new Map(lanes.map((l) => [l.id, l.x]));

  type Draft = Omit<Row, 'y' | 'i'> & { seq: number };
  const drafts: Draft[] = [];
  const push = (d: Omit<Draft, 'seq'>) => drafts.push({ ...d, seq: drafts.length });
  for (const ex of trace.exchanges) {
    const async = ex.kind === 'kafka' || ex.kind === 'sse';
    const derived = ex.origin === 'derived';
    const [a, b] = ends(ex);
    const replies = (ex.kind === 'http' || ex.kind === 'ws') && !ex.asset && ex.t1 !== undefined;
    const base = { ex, async, derived, x1: x.get(a)!, x2: x.get(b)! };
    push({ ...base, type: 'row', t: ex.t0, label: ex.label, reply: false, bad: !ex.ok && !replies, fault: ex.fault });
    if (replies) push({ ...base, type: 'row', t: ex.t1!, x1: base.x2, x2: base.x1, label: ex.status ? String(ex.status) : ex.error ?? 'sin respuesta', reply: true, bad: !ex.ok });
  }
  drafts.sort((p, q) => p.t - q.t || p.seq - q.seq);

  const steps = [...trace.steps].sort((p, q) => p.t0 - q.t0 || p.n - q.n);
  const items: Array<Band | Row> = [];
  const rows: Row[] = [];
  let y = 4, shown = 0;
  const band = () => { items.push({ type: 'band', y, step: steps[shown++] }); y += BAND_H; };
  for (const d of drafts) {
    // The bands of every step that has begun by this row come before it.
    while (shown < steps.length && steps[shown].t0 <= d.t) band();
    const { seq: _seq, ...rest } = d;
    const row: Row = { ...rest, y: y + ROW_H / 2, i: rows.length };
    items.push(row);
    rows.push(row);
    y += ROW_H;
  }
  while (shown < steps.length) band();

  const failed = trace.failure?.exchange;
  const bad = failed ? rows.findIndex((r) => r.ex.id === failed && (r.bad || !rows.some((o) => o.ex.id === failed && o.bad))) : -1;
  const last = Math.max(trace.durationMs, ...rows.map((r) => r.t), ...steps.map((s) => s.t1));
  return { lanes, items, rows, width: PAD * 2 + lanes.length * LANE_W, height: y + 12, duration: Math.max(0, last), bad, projects };
}

/**
 * What a flow that never ran should look like, from its Pasos: its actors and services as lanes, a band per step, and
 * one derived message per step from the actor to the step's service carrying what is expected. Nothing here was seen.
 */
export function expectedTrace(flow: { steps: Array<Record<string, string>> }): Pick<Trace, 'participants' | 'steps' | 'exchanges' | 'failure' | 'durationMs'> {
  const lane = new Map<string, Participant>();
  const named = (id: string) => id.replace(/^(svc|ds|ext):/, '');
  for (const s of flow.steps) if (s.service && !lane.has(s.service)) {
    const type: ParticipantType = s.service.startsWith('ds:') ? 'datastore' : s.service.startsWith('ext:') ? 'external' : 'service';
    lane.set(s.service, { id: s.service, name: named(s.service), type });
  }
  // An actor named like a service (antivirus-service) is that service's lane.
  const actorOf = (name: string) => [...lane.values()].find((p) => p.name === name)?.id ?? `actor:${name}`;
  for (const s of flow.steps) if (s.actor && !lane.has(actorOf(s.actor))) lane.set(actorOf(s.actor), { id: actorOf(s.actor), name: s.actor, type: 'browser', kind: 'actor' });
  const steps: Step[] = flow.steps.map((s, i) => ({ n: i + 1, title: s.step ?? `Paso ${i + 1}`, t0: i * 1000, t1: (i + 1) * 1000, status: 'todo', expected: s.expected }));
  const exchanges: Exchange[] = flow.steps.flatMap((s, i): Exchange[] => (s.service ? [{
    id: `expected:${i + 1}`, kind: 'http', from: s.actor ? actorOf(s.actor) : s.service, to: s.service, t0: i * 1000 + 1, step: i + 1, label: s.expected ? `Se espera: ${s.expected}` : 'Se espera', ok: true, origin: 'derived',
  }] : []));
  return { participants: [...lane.values()], steps, exchanges, durationMs: flow.steps.length * 1000 };
}

export type RowState = 'past' | 'now' | 'future';
/** A request stays current while its exchange is open; anything instant flashes for FLASH_MS. */
export function rowState(r: Row, now: number): RowState {
  if (r.t > now) return 'future';
  if (now - r.t <= FLASH_MS) return 'now';
  // an open request stays current while it runs; a stream (SSE, WebSocket) stays open the whole run, so it only flashes
  return !r.reply && r.ex.t1 !== undefined && !r.ex.asset && !isStream(r.ex) && now <= r.ex.t1 ? 'now' : 'past';
}

/** The step running at `now`, if any. Steps can overlap by a millisecond at the seam: the one that began last wins. */
export const stepAt = (steps: Step[], now: number) => steps.findLast((s) => now >= s.t0 && now < s.t1);
/** The step a moment is placed in, as «Este mensaje» names it: the one running then; after the last step, the last one. */
export const stepOf = (steps: Step[], t: number) => stepAt(steps, t) ?? (steps.length && t >= steps.at(-1)!.t1 ? steps.at(-1) : undefined);

/** A place «Paso a paso» can be: an act's header, a Secuencia row, or the failure. */
export type Stop = { kind: 'act'; act: Act } | { kind: 'row'; i: number } | { kind: 'fail' };
export interface WalkStop { s: Stop; t: number }

/**
 * When a test failed: on its failing row, else 300 ms before its step ended (never before the step began), else at its
 * end; null when it did not fail.
 */
export function failTime(layout: SeqLayout, trace: Pick<Trace, 'steps' | 'failure' | 'status'>): number | null {
  if (trace.status !== 'failed' || !trace.failure) return null;
  if (layout.bad >= 0) return layout.rows[layout.bad].t;
  const step = trace.steps.find((x) => x.n === trace.failure!.step);
  return step ? Math.max(step.t0, step.t1 - 300) : layout.duration;
}

const ORDER = { act: 0, row: 1, fail: 2 } as const;
/**
 * «Paso a paso»'s walk: every row that does not fold (a folded one too when `shown` says so), each act's header at its
 * first mark or root, and the failure; in time order, a header before the rows of its moment and the failure after them.
 */
export function walk(layout: SeqLayout, c: Pick<Chain, 'acts' | 'noise'>, trace: Pick<Trace, 'steps' | 'failure' | 'status'>, shown: (id: string) => boolean = () => false): WalkStop[] {
  const out: Array<WalkStop & { o: number }> = [
    ...c.acts.map((act, o) => ({ s: { kind: 'act' as const, act }, t: act.t0, o })),
    ...layout.rows.filter((r) => !c.noise.has(r.ex.id) || shown(r.ex.id)).map((r) => ({ s: { kind: 'row' as const, i: r.i }, t: r.t, o: r.i })),
  ];
  const ft = failTime(layout, trace);
  if (ft !== null) out.push({ s: { kind: 'fail' }, t: ft, o: 0 });
  return out.sort((a, b) => a.t - b.t || ORDER[a.s.kind] - ORDER[b.s.kind] || a.o - b.o).map(({ s, t }) => ({ s, t }));
}
/** Where a Pasos step goes: its first stop that the card places in that step; a step with none has no stop. */
export const stepStop = (stops: WalkStop[], steps: Step[], step: Step) => stops.find((w) => stepOf(steps, w.t)?.n === step.n);
/**
 * How far a scrolling box scrolls (negative: up) to show a row in the part of the box that is on screen, the box cut by
 * `view` (a row taller than that part, its top); with none of the box on screen, in the box's own view. The page itself
 * never moves.
 */
export function revealBy(box: Span, view: Span, row: Span): number {
  let top = Math.max(box.top, view.top), bottom = Math.min(box.bottom, view.bottom);
  if (bottom <= top) [top, bottom] = [box.top, box.bottom];
  return row.top < top ? row.top - top : row.bottom > bottom ? Math.min(row.bottom - bottom, row.top - top) : 0;
}
interface Span { top: number; bottom: number }
/** Two stops are the same place. */
export const sameStop = (a: Stop | null | undefined, b: Stop | null | undefined) => Boolean(a && b && a.kind === b.kind && (a.kind === 'fail' || (a.kind === 'act' ? a.act.id === (b as typeof a).act.id : a.i === (b as typeof a).i)));

/** A stop as its address: `accion-<the act's first root>`, `accion-m<n>`, `preparacion`, `<row>` or `<row>/respuesta`, `fallo`. */
export function stopId(s: Stop, layout: SeqLayout): string {
  if (s.kind === 'fail') return 'fallo';
  if (s.kind === 'act') return s.act.id === 'preparacion' ? 'preparacion' : `accion-${shortId(s.act.id)}`;
  const r = layout.rows[s.i];
  return `${shortId(r.ex.id)}${r.reply ? '/respuesta' : ''}`;
}
/** An address's stop back, ids resolved by their short form or as a prefix; undefined when this test has none like it. */
export function stopOf(id: string, layout: SeqLayout, c: Pick<Chain, 'acts'>, failed: boolean): Stop | undefined {
  // the short form first; a prefix only when no id has that short form
  const find = <T,>(xs: T[], idOf: (x: T) => string, short: string) => xs.find((x) => shortId(idOf(x)) === short) ?? xs.find((x) => idOf(x).startsWith(short));
  if (id === 'fallo') return failed ? { kind: 'fail' } : undefined;
  if (id === 'preparacion') { const act = c.acts.find((a) => a.id === 'preparacion'); return act && { kind: 'act', act }; }
  if (id.startsWith('accion-')) { const act = find(c.acts.filter((a) => a.id !== 'preparacion'), (a) => a.id, id.slice(7)); return act && { kind: 'act', act }; }
  const [x, reply] = id.split('/');
  const r = find(layout.rows.filter((y) => y.reply === (reply === 'respuesta')), (y) => y.ex.id, x);
  return r && { kind: 'row', i: r.i };
}

/**
 * A hop's own log lines: its actor's and its target's (a consume row: the consumer's), within its span ±2 ms, or ±10 ms
 * of an instant row; at most `max`.
 */
export function hopLogs(e: Exchange, logs: LogLine[], max = 5): LogLine[] {
  const who = new Set(isConsume(e) ? [e.to] : [actorOf(e), e.to]);
  const [lo, hi] = e.t1 !== undefined && e.t1 > e.t0 ? [e.t0 - 2, e.t1 + 2] : [e.t0 - 10, e.t0 + 10];
  return logs.filter((l) => who.has(l.service) && l.t >= lo && l.t <= hi).slice(0, max);
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** The request as cURL, against the service's name inside the env. Values are the trace's, already masked. */
export function curl(ex: Exchange): string | null {
  if (ex.kind !== 'http' || !ex.method) return null;
  const skip = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
  const parts = [`curl -X ${ex.method} ${sh(`http://${ex.to}${ex.path ?? '/'}${ex.query ? `?${ex.query}` : ''}`)}`];
  for (const [k, v] of Object.entries(ex.reqHeaders ?? {})) if (!skip.has(k.toLowerCase())) parts.push(`-H ${sh(`${k}: ${v}`)}`);
  if (ex.req?.text) parts.push(`--data-raw ${sh(ex.req.text)}`);
  else if (ex.req?.note) parts.push(`# cuerpo no capturado: ${ex.req.note}`);
  return parts.join(' \\\n  ');
}

/** A label character: 11px of a monospace font is 0.6em wide. */
export const CH = 6.6;
/**
 * The room a row's label has, drawn from 8px right of its left end: between its two lanes, at least two lanes wide, and
 * never past the drawing's right edge (an arrow to the last lane has no lane beyond it).
 */
export const labelRoom = (r: Pick<Row, 'x1' | 'x2'>, width: number) => Math.min(Math.max(Math.abs(r.x2 - r.x1), LANE_W * 2), width - Math.min(r.x1, r.x2)) - 16;
/**
 * Labels are cut to their room; the whole one is in the tooltip. The cut never lands inside a mask mark (… and four
 * characters): the mark goes whole or not at all, so what is shown is boxed.
 */
export const fit = (s: string, px: number) => {
  const n = Math.max(4, Math.floor(px / CH));
  if (s.length <= n) return s;
  let k = n - 1;
  const m = s.lastIndexOf('…', k - 1);
  if (m >= 0 && m + 5 > k && /^…[\w-]{4}/.test(s.slice(m, m + 5))) k = m;
  return `${s.slice(0, k)}…`;
};

/** 0:12.4 */
export const clock = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`;
};
