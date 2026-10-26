/**
 * The approved behavior of a flow: what the system does under each step of its story, as hops that can be
 * compared run after run. A hop is `from → to operation class` — an endpoint's template with its status class, a
 * statement's verb and table, a topic published or consumed — hung from the hop that caused it, never from the time.
 * Noise (assets, streams, greetings, preflights, someone else's traffic) is left out with the Cadena's rules; a hop
 * seen several times in a step counts once. Pure: the caller reads the trace and writes the file.
 */
import { causes, noiseOf } from './chain.ts';
import { hopWhat } from './summarize.ts';
import type { EndpointMatch } from './assemble.ts';
import { isBrowser, type Exchange, type Trace } from './trace.ts';

export interface BehaviorStep {
  /** stable across wording: the title as a slug, so a step is found again after a retitle's case, spacing or punctuation */
  key: string;
  /** its place in the story */
  n: number;
  step: string;
  hops: string[];
  /** hop → the hop that caused it, when the chain is sure or inferred */
  causes: Record<string, string>;
  /** hops seen in some of the approved runs and not in others: allowed to come, never missed */
  sometimes?: string[];
  /** hops left out because several runners played at once and their chain does not lead back to this test's own requests */
  unsure?: number;
}
/** A step's key: its title lowercased, accents and punctuation gone. */
export const stepKey = (title: string) => title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export interface Behavior { flow: string; steps: BehaviorStep[] }
export interface Drift { step: string; kind: 'missing' | 'new' | 'cause'; hop: string; was?: string; now?: string }

/**
 * What a drift in a step is about: what changes something (a write, a message, a call out of the system) and anything
 * that fails. A read that succeeds (a GET, a SELECT) counts too, but over the whole story: whether a list's poll
 * lands in this step or the next is timing, a read that appears or disappears is behavior.
 */
export const matters = (hop: string) => / (error|4xx|5xx)$/.test(hop) || !/ (GET|HEAD|OPTIONS) .* (2xx|ok)$| SELECT .* ok$/.test(hop);
/** A read that succeeds: it counts, but its step is timing (a poll lands in this one or the next), so it is compared over the whole story. */
export const isRead = (hop: string) => !matters(hop);
/** A statement that only reads: the ORM, a cache or a poll decides whether it runs, so it is documented but the HTTP read that causes it is what counts. */
export const isSqlRead = (hop: string) => / SELECT .* ok$/.test(hop);
/** A notice pushed down a stream (`evento FILE_CLEAN`): whether the tap catches its delivery inside the window is timing, the message it carries is already a hop of its own. */
export const isPushed = (hop: string) => / evento \S+ ok$/.test(hop);

/** a path's ids and the values tests make (a UUID, a number, `luis-perfil-r129s2-3`): any segment with a digit */
const fold = (s: string) => s.replace(/(?<=\/)[^/\s?]*\d[^/\s?]*/g, '{id}');
const klass = (e: Exchange) => (e.error ? 'error' : e.kind === 'sql' ? (e.ok ? 'ok' : 'error') : e.status === undefined ? (e.ok ? 'ok' : 'error') : `${String(e.status)[0]}xx`);
/** a hop as a line: who to whom, what (ids folded), how it ended */
export function hopOf(e: Exchange, match: EndpointMatch): string {
  // a message is written without its subject or recipient (a random code or a new address is not a different behavior); `behaviorOf` adds how many
  const what = e.msg && !e.msg.cb ? (e.msg.kind === 'mail' ? 'correo' : 'sms') : e.kind === 'kafka' ? `${e.id.includes('>') ? 'consume' : 'publish'} ${e.label}` : e.kind === 'tcp' ? 'tcp' : fold(hopWhat(e, match));
  return `${e.from} → ${e.to} ${what} ${klass(e)}`;
}

/** The story's behavior, step by step, in a stable order: by causal depth, then by the hop's own text. */
export function behaviorOf(trace: Trace, match: EndpointMatch): Behavior {
  const cause = causes(trace.exchanges, { actions: trace.actions });
  const by = new Map(trace.exchanges.map((e) => [e.id, e]));
  const depth = (e: Exchange) => { let d = 0; for (let p = cause.get(e.id)?.parent; p && d < 50; p = cause.get(p)?.parent) d++; return d; };
  // With runners in parallel the tap sees everyone's service traffic: a hop is this test's only if its chain leads back to a request of its own runner.
  const owned = new Map<string, boolean>();
  const own = (e: Exchange, d = 0): boolean => {
    const known = owned.get(e.id);
    if (known !== undefined) return known;
    const c = cause.get(e.id), p = c && by.get(c.parent);
    const yes = !trace.concurrent || (c ? c.certainty !== 'possible' && Boolean(p) && d < 50 && own(p!, d + 1) : isBrowser(e.from) || e.from === 'runner');
    owned.set(e.id, yes);
    return yes;
  };
  const steps = trace.steps.map((s): BehaviorStep => {
    // what a status call provokes (a write the app does when its SMS is delivered) belongs to the step of that SMS, not to the one its time falls in; the call itself is no behavior
    const stepOf = (e: Exchange): number | undefined => { for (let x: Exchange | undefined = e, d = 0; x && d < 50; x = by.get(cause.get(x.id)?.parent ?? ''), d++) if (x.msg?.cb) return by.get(cause.get(x.id)?.parent ?? '')?.step ?? e.step; return e.step; };
    const all = trace.exchanges.filter((e) => stepOf(e) === s.n && !noiseOf(e) && !e.msg?.cb);
    const mine = all.filter((e) => own(e));
    // the only hops that count how often they happened: one mail twice is not one mail
    const times = new Map<string, number>();
    for (const e of mine) if (e.msg) times.set(hopOf(e, match), (times.get(hopOf(e, match)) ?? 0) + 1);
    const seen = new Map<string, number>(), parents = new Map<string, Set<string>>();
    for (const e of mine) {
      const base = hopOf(e, match);
      const hop = (times.get(base) ?? 0) > 1 ? `${base} ×${times.get(base)}` : base;
      seen.set(hop, Math.min(seen.get(hop) ?? Infinity, depth(e)));
      const c = cause.get(e.id), p = c && by.get(c.parent);
      // a possible link is a guess: no cause at all, so an inference never makes a drift
      const set = parents.get(hop) ?? parents.set(hop, new Set()).get(hop)!;
      set.add(p && c.certainty !== 'possible' ? hopOf(p, match) : '?');
    }
    const hops = [...seen].sort(([a, da], [b, db]) => da - db || a.localeCompare(b)).map(([h]) => h);
    // a cause is kept only when every time the hop happened it came from the same one (a poll has many)
    const one = (h: string) => { const set = parents.get(h)!; return set.size === 1 && !set.has('?') ? [...set][0] : undefined; };
    return { key: stepKey(s.title), n: s.n, step: s.title, hops, causes: Object.fromEntries(hops.flatMap((h) => (one(h) ? [[h, one(h)!]] : []))), ...(all.length > mine.length ? { unsure: all.length - mine.length } : {}) };
  });
  return { flow: trace.flow, steps };
}

/**
 * The behavior of several runs of one story: a hop is behavior when every run made it, and «sometimes» when only some
 * did (timing, a poll, a cached read): allowed to come, never missed. A cause stays only when it was the same each time.
 */
export function mergeBehaviors(runs: Behavior[]): Behavior {
  const [first, ...rest] = runs;
  const steps = first.steps.map((a): BehaviorStep => {
    const mine = [a, ...rest.flatMap((r) => r.steps.filter((b) => b.key === a.key))];
    const all = [...new Set(mine.flatMap((st) => st.hops))];
    const hops = a.hops.filter((h) => mine.every((st) => st.hops.includes(h)));
    const causes: Record<string, string> = {};
    for (const h of hops) { const c = new Set(mine.map((st) => st.causes[h])); if (c.size === 1 && !c.has(undefined as never)) causes[h] = [...c][0]; }
    const sometimes = all.filter((h) => !hops.includes(h)).sort();
    return { ...a, hops, causes, ...(sometimes.length ? { sometimes } : {}), unsure: undefined };
  });
  return { flow: first.flow, steps };
}

/** The step of `now` that stands for an approved one: the same key, else the same place when the story has the same number of steps (a retitled step). */
function pair(approved: Behavior, now: Behavior, a: BehaviorStep): BehaviorStep | undefined {
  return now.steps.find((s) => s.key === a.key) ?? (approved.steps.length === now.steps.length ? now.steps.find((s) => s.n === a.n && !approved.steps.some((x) => x.key === s.key)) : undefined);
}

/**
 * What a run's behavior does that the approved one does not, and the other way round. What changes something is
 * compared step by step; a read that succeeds, over the whole story (its step is timing). A hop the approved runs made
 * only sometimes is never missed and never new. Hops left out as unsure are not behavior: they never make a drift.
 */
export function driftOf(approved: Behavior, now: Behavior): Drift[] {
  const out: Drift[] = [];
  const counted = (h: string) => matters(h) && !isPushed(h);
  const reached: Array<[BehaviorStep, BehaviorStep]> = [];
  const maybe = new Set(approved.steps.flatMap((a) => a.sometimes ?? []));
  for (const a of approved.steps) {
    const b = pair(approved, now, a);
    if (!b) continue; // a step the run did not reach says nothing about the behavior
    reached.push([a, b]);
    // a hop that lands in the step before or after is the boundary's timing (an event the scan sends a moment earlier), not behavior
    const near = (steps: BehaviorStep[], h: string) => steps.some((x) => Math.abs(x.n - a.n) <= 1 && (x.hops.includes(h) || (x.sometimes ?? []).includes(h)));
    const known = (h: string) => near(approved.steps, h);
    // a hop the run left out as unsure may be the one it lacks: absence proves nothing in that step
    if (!b.unsure) for (const h of a.hops) if (counted(h) && !b.hops.includes(h) && !near(now.steps, h)) out.push({ step: a.step, kind: 'missing', hop: h });
    for (const h of b.hops) if (counted(h) && !known(h)) out.push({ step: a.step, kind: 'new', hop: h });
    for (const h of a.hops) if (counted(h) && b.hops.includes(h) && a.causes[h] && b.causes[h] && a.causes[h] !== b.causes[h]) out.push({ step: a.step, kind: 'cause', hop: h, was: a.causes[h], now: b.causes[h] });
  }
  // the reads, over the steps both have: one the story always made and no longer does, or one it never made
  const reads = (side: 0 | 1) => new Map(reached.flatMap((r) => r[side].hops.filter((h) => isRead(h) && !isSqlRead(h) && !isPushed(h)).map((h) => [h, r[0].step] as const)));
  const [was, is] = [reads(0), reads(1)];
  if (!reached.some(([, b]) => b.unsure)) for (const [h, step] of was) if (!is.has(h)) out.push({ step, kind: 'missing', hop: h });
  for (const [h, step] of is) if (!was.has(h) && !maybe.has(h)) out.push({ step, kind: 'new', hop: h });
  return out;
}
