/**
 * The system map, laid out in columns: who is called by nobody first, then whom they call, and data stores and
 * externals last. Edges are orthogonal, always: right-angled elbows, a lane each; one that skips columns crosses them
 * above or below their nodes when it can, and anything that goes backwards runs under the whole drawing instead of
 * across it.
 * Known limit: one barycentre pass orders each column; real crossing minimisation belongs to the diagram engine.
 */
import { causes, isConsume } from '@laru/trace/chain';
import type { Exchange, Fact, FlowInfo, Indexed, MapNode, Trace } from '../api.ts';

export type EdgeKind = 'call' | 'event' | 'store';
export interface MapEdge { id: string; from: string; to: string; kind: EdgeKind; label: string; origin: Fact['origin']; facts: Fact[] }
export interface Placed { node: MapNode; x: number; y: number; col: number }
/** An edge comes with its path and its label's box: centred on `lx`, `lw` wide, from 11px above its baseline `ly`, LABEL_H tall. */
export interface Layout<E extends MapEdge = MapEdge> {
  nodes: Placed[]; edges: Array<E & { d: string; lx: number; ly: number; lw: number }>; width: number; height: number; columns: Array<{ x: number; title: string }>;
  /** a band per application, top to bottom, when the map holds more than one; none otherwise */
  bands: Array<{ y: number; h: number; title: string }>;
}

export const NODE_W = 200, NODE_H = 56;
const COL_GAP = 120, ROW_GAP = 26, TOP = 44, LEFT = 24, UNDER = 18, BAND_HEAD = 26, BAND_GAP = 14;
/** An edge's label: 10.5px of a monospace font is 0.6em a character and 13.5px tall; its box keeps 3px each side. */
const LABEL_CH = 6.3;
export const LABEL_H = 14;
const labelW = (s: string) => (s ? Math.ceil(s.length * LABEL_CH) + 6 : 0);

const serviceOf = (g: Indexed, id: string): string | undefined => {
  const n = g.nodes.get(id);
  return n?.type === 'service' ? n.id : n?.type === 'endpoint' ? n.service : undefined;
};

/** The node a map address shows: a table or a topic is shown by the store that contains it, an endpoint by its service. */
export function homeOf(g: Indexed, id: string): string {
  const n = g.nodes.get(id);
  if (n?.type === 'endpoint') return n.service ?? id;
  return n?.type === 'table' || n?.type === 'topic' ? g.in(id).find((f) => f.p === 'contains')?.s ?? id : id;
}

/** Facts folded into one edge per pair and kind: a gateway's forty forwards are one line. */
export function edgesOf(g: Indexed): MapEdge[] {
  const by = new Map<string, MapEdge>();
  const add = (from: string | undefined, to: string | undefined, kind: EdgeKind, f: Fact, label: string) => {
    if (!from || !to || from === to) return;
    const id = `${kind}|${from}|${to}`;
    const e = by.get(id) ?? by.set(id, { id, from, to, kind, label: '', origin: 'derived', facts: [] }).get(id)!;
    e.facts.push(f);
    if (f.origin === 'extracted') e.origin = 'extracted';
    if (kind === 'event' && !e.label.split(', ').includes(label)) e.label = e.label ? `${e.label}, ${label}` : label;
  };
  for (const f of g.map.facts) {
    // A call recorded `through` a gateway is the gateway's path told end to end: the drawing already shows both hops.
    if ((f.p === 'calls' || f.p === 'forwards-to') && !f.note?.startsWith('through ')) {
      const to = g.nodes.get(f.o);
      if (to && (to.type === 'service' || to.type === 'endpoint')) add(serviceOf(g, f.s), serviceOf(g, f.o), 'call', f, '');
    }
    if (f.p === 'uses' && g.nodes.get(f.s)?.type === 'service') add(f.s, f.o, 'store', f, '');
  }
  for (const t of g.map.nodes.filter((n) => n.type === 'topic')) {
    const pubs = g.in(t.id).filter((f) => f.p === 'publishes'), subs = g.in(t.id).filter((f) => f.p === 'consumes');
    for (const p of pubs) for (const s of subs) add(p.s, s.s, 'event', s, t.name);
  }
  for (const e of by.values()) if (e.kind === 'call') e.label = `${new Set(e.facts.map((f) => f.o)).size} endpoints`;
  return [...by.values()];
}

export const ACTORS = 'Actores', NO_GROUP = 'Sin grupo', SHARED = 'Compartido';
/**
 * The application each piece belongs to: its repo's group. One with no repo (an external) takes the group of whoever
 * uses it, or «Compartido» when several do. In order: the actors first, the groups as laru.yaml lists their repos,
 * «Sin grupo» and «Compartido» last.
 */
export function groupsOf(g: Indexed, edges: MapEdge[]): { of: Map<string, string>; order: string[] } {
  const byRepo = new Map(g.map.repos.map((r) => [r.name, r.group]));
  const of = new Map<string, string>();
  for (const n of g.map.nodes) if (n.kind === 'actor') of.set(n.id, ACTORS); else if (n.repo) of.set(n.id, byRepo.get(n.repo) ?? NO_GROUP);
  for (const n of g.map.nodes) {
    if (of.has(n.id)) continue;
    const users = new Set(edges.filter((e) => e.to === n.id || e.from === n.id).map((e) => of.get(e.to === n.id ? e.from : e.to)).filter((x) => x && x !== ACTORS && x !== NO_GROUP));
    of.set(n.id, users.size === 1 ? [...users][0]! : users.size ? SHARED : NO_GROUP);
  }
  const named = g.map.repos.map((r) => r.group).filter((x): x is string => Boolean(x));
  return { of, order: [...new Set([ACTORS, ...named, NO_GROUP, SHARED])] };
}

/** Each piece's application when the workspace names more than one (`group` in laru.yaml); undefined otherwise. */
export function appsOf(g: Indexed): Map<string, string> | undefined {
  return new Set(g.map.repos.map((r) => r.group).filter(Boolean)).size > 1 ? groupsOf(g, edgesOf(g)).of : undefined;
}

/**
 * `keep`: every store and external has its place, edges or not (the full map); else only the ones an edge reaches.
 * `bands`: a horizontal band per application when the map holds more than one; the columns stay, each split by band.
 */
export function layout<E extends MapEdge>(g: Indexed, edges: E[], o: { keep?: boolean; bands?: boolean } = {}): Layout<E> {
  const services = g.map.nodes.filter((n) => n.type === 'service');
  const stores = g.map.nodes.filter((n) => (n.type === 'datastore' || n.type === 'external') && (o.keep || edges.some((e) => e.to === n.id || e.from === n.id)));
  const calls = edges.filter((e) => e.kind === 'call');

  // Rank: longest chain of calls reaching the service (cycles are cut where they close).
  const rank = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    if (rank.has(id)) return rank.get(id)!;
    stack.add(id);
    const callers = calls.filter((e) => e.to === id && !stack.has(e.from));
    const r = callers.length ? Math.max(...callers.map((e) => visit(e.from, stack) + 1)) : 0;
    stack.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const s of services) visit(s.id, new Set());
  // A service nobody calls and that calls nobody sits after whoever publishes what it consumes.
  const lonely = services.filter((s) => !calls.some((e) => e.from === s.id || e.to === s.id));
  for (let pass = 0; pass < 3; pass++) {
    for (const s of lonely) {
      const pubs = edges.filter((e) => e.kind === 'event' && e.to === s.id && !lonely.includes(g.nodes.get(e.from)!)).map((e) => rank.get(e.from) ?? 0);
      rank.set(s.id, pubs.length ? Math.max(...pubs) + 1 : Math.max(1, ...[...rank.values()]));
    }
  }
  const lastService = Math.max(0, ...services.map((s) => rank.get(s.id) ?? 0));
  for (const s of stores) rank.set(s.id, lastService + 1);
  // Ranks no node took become no column: when no service calls another, none ranks 0, and a hole in `cols` (which
  // map() skips) would leave its sizes undefined and every position NaN.
  const taken = [...new Set(rank.values())].sort((a, b) => a - b);
  for (const [id, r] of rank) rank.set(id, taken.indexOf(r));

  const cols: MapNode[][] = [];
  for (const n of [...services, ...stores]) (cols[rank.get(n.id)!] ??= []).push(n);
  for (const c of cols) c?.sort((a, b) => a.name.localeCompare(b.name));
  // One barycentre pass, left to right, then right to left.
  const pos = () => new Map(cols.flatMap((c) => (c ?? []).map((n, i) => [n.id, i] as const)));
  for (const dir of [1, -1]) {
    const order = dir === 1 ? cols.map((_, i) => i) : cols.map((_, i) => cols.length - 1 - i);
    for (const ci of order) {
      const p = pos();
      const bary = (id: string) => {
        const ns = edges.filter((e) => e.from === id || e.to === id).map((e) => (e.from === id ? e.to : e.from)).filter((o) => rank.get(o) !== ci).map((o) => p.get(o) ?? 0);
        return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : p.get(id) ?? 0;
      };
      cols[ci]?.sort((a, b) => bary(a.id) - bary(b.id));
    }
  }

  const step = NODE_H + ROW_GAP;
  const rowY = new Map<string, number>();
  const grp = o.bands && new Set(g.map.repos.map((r) => r.group).filter(Boolean)).size > 1 ? groupsOf(g, edges) : undefined;
  const bands: Layout['bands'] = [];
  let bottom: number;
  if (grp) {
    // each band as tall as its fullest column, the columns centred in it as they are on a map without bands
    let y = TOP - 10;
    for (const title of grp.order) {
      const per = cols.map((c) => (c ?? []).filter((n) => grp.of.get(n.id) === title));
      const rows = Math.max(...per.map((c) => c.length));
      if (!rows) continue;
      per.forEach((c) => c.forEach((node, i) => rowY.set(node.id, y + BAND_HEAD + ((rows - c.length) * step) / 2 + i * step)));
      bands.push({ y, h: BAND_HEAD + rows * step - ROW_GAP + 10, title });
      y += bands.at(-1)!.h + BAND_GAP;
    }
    bottom = y - BAND_GAP + 12;
  } else {
    const tallest = Math.max(...cols.map((c) => c?.length ?? 0));
    cols.forEach((c) => (c ?? []).forEach((node, i) => rowY.set(node.id, TOP + ((tallest - c.length) * step) / 2 + i * step)));
    bottom = TOP + tallest * step;
  }

  // Each edge gets its own vertical lane in a gap: from the left for whoever turns there, from the right for an edge
  // that comes back from under the drawing. One within a column takes the rightmost, so its label, right of its lane,
  // crosses no other. A gap is as wide as its labels need: between the last lane from the left and the first from the
  // right, where only the lines into the next column run, each at its own port.
  const laneCount = new Map<string, number>();
  const lane = (key: string) => { const n = laneCount.get(key) ?? 0; laneCount.set(key, n + 1); return n; };
  const lanesW = (key: string) => { const n = laneCount.get(key) ?? 0; return n ? 14 + (n - 1) * 11 : 0; };
  const plan = edges.filter((e) => rowY.has(e.from) && rowY.has(e.to)).map((e) => {
    const ca = rank.get(e.from)!, cb = rank.get(e.to)!;
    // a long edge also turns right after it leaves, to cross the columns between at a height of its own
    return { e, ca, cb, w: labelW(e.label), l: cb > ca ? lane(`gap${cb - 1}`) : cb < ca ? lane(`gap${ca}`) : 0, li: cb < ca ? lane(`gin${cb}`) : 0, lo: cb > ca + 1 ? lane(`gap${ca}`) : 0, pts: [] as number[][] };
  });
  for (const p of plan) if (p.cb === p.ca) p.l = lane(`gap${p.ca}`);
  const gap = cols.map(() => COL_GAP);
  const room = (i: number) => Math.max(lanesW(`gin${i + 1}`) + 6, 16);
  // Labels into one node sit by their arrowheads, a port apart; when ports are closer than a label is tall (a store many
  // services use, on the full map), its labels need room side by side.
  const ins = Map.groupBy(plan.filter((p) => p.cb > p.ca && p.w), (p) => p.e.to);
  const into = (id: string) => edges.filter((e) => e.to === id && rowY.has(e.from)).length;
  for (const p of plan) {
    const side = ins.get(p.e.to) ?? [];
    const w = side.length > 1 && NODE_H / (into(p.e.to) + 1) < LABEL_H + 4 ? side.reduce((s, q) => s + q.w + 8, 0) : p.w;
    if (p.cb > p.ca) gap[p.cb - 1] = Math.max(gap[p.cb - 1], lanesW(`gap${p.cb - 1}`) + 6 + w + room(p.cb - 1));
    else if (p.cb === p.ca) gap[p.ca] = Math.max(gap[p.ca], 14 + p.l * 11 + 5 + p.w + room(p.ca));
  }
  const colX = cols.map((_, ci) => LEFT + gap.slice(0, ci).reduce((s, x) => s + NODE_W + x, 0));
  const width = (colX.at(-1) ?? LEFT) + NODE_W + (gap.at(-1) ?? COL_GAP) + LEFT;

  const placed = new Map<string, Placed>();
  cols.forEach((c, ci) => (c ?? []).forEach((node) => placed.set(node.id, { node, col: ci, x: colX[ci], y: rowY.get(node.id)! })));

  // Ports: each side spreads its edges.
  const portY = (id: string, edgeId: string, side: 'out' | 'in') => {
    const p = placed.get(id)!;
    const mine = edges.filter((e) => (side === 'out' ? e.from === id : e.to === id) && placed.has(e.from) && placed.has(e.to));
    const i = mine.findIndex((e) => e.id === edgeId);
    return p.y + ((i + 1) * NODE_H) / (mine.length + 1);
  };
  // `from` first, then a pixel at a time either way within [lo, hi].
  const near = (from: number, lo: number, hi: number) => {
    const out = [from];
    for (let d = 1; d <= hi - lo; d++) for (const v of [from - d, from + d]) if (v >= lo && v <= hi) out.push(v);
    return out;
  };
  type Box = { x: number; y: number; w: number; h: number };
  const segments = (pts: number[][]) => pts.slice(1).map(([x, y], i): Box => ({ x: Math.min(x, pts[i][0]), y: Math.min(y, pts[i][1]), w: Math.abs(x - pts[i][0]), h: Math.abs(y - pts[i][1]) }));

  // Every path first, as its corners; backwards, under the whole drawing, a lane each. Long edges go last: across the
  // columns between they run at the height nearest their port that keeps 9px from every other line there, so none
  // lies on another's line or under its label, and clear of the nodes they pass when there is such a height.
  const between = (p: (typeof plan)[number]) => [...placed.values()].filter((n) => n.col > p.ca && n.col < p.cb);
  let under = 0;
  for (const p of [...plan].sort((p, q) => Number(p.cb > p.ca + 1) - Number(q.cb > q.ca + 1))) {
    const a = placed.get(p.e.from)!, b = placed.get(p.e.to)!, sx = a.x + NODE_W, sy = portY(p.e.from, p.e.id, 'out'), ty = portY(p.e.to, p.e.id, 'in');
    if (p.cb > p.ca) {
      const mx = colX[p.cb - 1] + NODE_W + 14 + p.l * 11, ox = sx + 14 + p.lo * 11;
      const lines = plan.flatMap((q) => segments(q.pts)).filter((s) => !s.h && s.x < mx && s.x + s.w > ox);
      const free = (v: number) => lines.every((s) => Math.abs(s.y - v) >= 9), ys = near(sy, TOP - 12, bottom - 12);
      const passed = p.cb > p.ca + 1 ? between(p) : [];
      const y = p.cb > p.ca + 1 ? ys.find((v) => free(v) && passed.every((n) => v < n.y - 6 || v > n.y + NODE_H + 6)) ?? ys.find(free) ?? sy : sy;
      p.pts = [[sx, sy], ...(y === sy ? [] : [[ox, sy], [ox, y]]), [mx, y], [mx, ty], [b.x, ty]];
    } else if (p.cb === p.ca) {
      const mx = sx + 14 + p.l * 11;
      p.pts = [[sx, sy], [mx, sy], [mx, ty], [b.x + NODE_W, ty]];
    } else {
      const y = bottom + 12 + (under++) * UNDER, ox = sx + 14 + p.l * 11, ix = b.x - 14 - p.li * 11;
      p.pts = [[sx, sy], [ox, sy], [ox, y], [ix, y], [ix, ty], [b.x, ty]];
    }
  }
  const segs = plan.map((p) => segments(p.pts));
  const meets = (a: Box, b: Box, m = 0) => a.x - m < b.x + b.w && b.x < a.x + a.w + m && a.y - m < b.y + b.h && b.y < a.y + a.h + m;
  /** the distance between two boxes, 0 when they touch */
  const dist = (a: Box, b: Box) => {
    const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w)), dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
    return dx && dy ? Math.hypot(dx, dy) : dx + dy; // the same value, without hypot's cost when it is along one axis
  };
  // A label sits on its own line, which stops at its edges: forward, by the arrowhead, sliding back along the last
  // stretch; backwards, on its lane under the drawing, from the middle out. Within a column it sits right of its lane,
  // from the middle out, as far as just past either corner. It takes the first spot clear of every node, every label
  // placed and every other edge's line, so it never reads as a neighbour's; failing that, on the lane. Forward labels go
  // first: least room.
  const spots = ({ ca, cb, w, pts }: (typeof plan)[number]) => {
    const [[mx], [x2, y2]] = pts.slice(-2);
    if (cb > ca) return near(x2 - 16 - w, mx + 6, x2 - 16 - w).map((x) => ({ x, y: y2 - LABEL_H / 2 }));
    if (cb === ca) {
      // right of its lane first; then on the lane itself, as other labels sit on their lines
      const ys = near((pts[1][1] + y2) / 2, Math.min(pts[1][1], y2) - 9, Math.max(pts[1][1], y2) + 9);
      return [...ys.map((y) => ({ x: pts[1][0] + 5, y: y - LABEL_H / 2 })), ...ys.map((y) => ({ x: pts[1][0] - w / 2, y: y - LABEL_H / 2 }))];
    }
    const [[ox, uy], [ix]] = pts.slice(2, 4);
    return near((ox + ix) / 2, ix + 6 + w / 2, ox - 6 - w / 2).map((x) => ({ x: x - w / 2, y: uy - LABEL_H / 2 }));
  };
  // Known limit: a label with no clear spot keeps its first one; a bundle of labelled edges within one column can need it.
  // Widening that column's gap per label is the upgrade.
  // A spot is clear when no node or label is in it and its own line is strictly the nearest: every other line at least
  // 2px farther than its own, so a label never reads as the caption of another edge.
  const nodes: Box[] = [...placed.values()].map((p) => ({ x: p.x, y: p.y, w: NODE_W, h: NODE_H }));
  const label: Box[] = [];
  for (const i of plan.map((_, i) => i).sort((i, j) => Math.sign(plan[j].cb - plan[j].ca) - Math.sign(plan[i].cb - plan[i].ca))) {
    const r = plan[i], all = spots(r).map((s): Box => ({ ...s, w: r.w, h: LABEL_H }));
    if (!r.w) { label[i] = all[0]; continue; }
    const own = all.map((b) => { let m = Infinity; for (const s of segs[i]) m = Math.min(m, dist(b, s)); return m; });
    // Only what comes near the spots can rule one out: a line farther from all of them than any spot's own line plus 2px
    // never does. Weeded once per label, not once per spot: on a large map that is most of the drawing.
    const x0 = Math.min(...all.map((b) => b.x)), y0 = Math.min(...all.map((b) => b.y));
    const area: Box = { x: x0, y: y0, w: Math.max(...all.map((b) => b.x + b.w)) - x0, h: Math.max(...all.map((b) => b.y + b.h)) - y0 };
    const reach = Math.max(2, Math.max(...own) + 2);
    const lines = segs.flatMap((ss, j) => (j === i ? [] : ss.filter((s) => dist(area, s) < reach)));
    const boxes = [...nodes, ...label.filter(Boolean)].filter((n) => meets(area, n));
    const k = all.findIndex((b, k) => !boxes.some((n) => meets(b, n)) && lines.every((s) => dist(b, s) >= Math.max(2, own[k] + 2)));
    label[i] = all[k] ?? all[0];
  }
  const routed = plan.map(({ e, w, pts }, i) => ({
    ...e, d: pts.map(([x, y], k) => (!k ? `M${x} ${y}` : y === pts[k - 1][1] ? `H${x}` : `V${y}`)).join(' '), lx: label[i].x + w / 2, ly: label[i].y + 11, lw: w,
  }));

  // titled by the rank each column stands for, not by its place once the empty ones are gone
  const columns = cols.map((c, ci) => ({
    x: colX[ci],
    title: taken[ci] === lastService + 1 ? 'Datos e infraestructura' : taken[ci] === 0 ? 'Entrada' : `Servicios, nivel ${taken[ci]}`,
  })).filter((_, ci) => cols[ci]?.length);
  return { nodes: [...placed.values()], edges: routed, width, height: bottom + 24 + under * UNDER, columns, bands };
}

/** An edge of a flow's map: the exchanges it folds, how many went wrong, and whether the code knows it. */
export interface FlowEdge extends MapEdge {
  /** the exchanges it stands for, in time order */
  ex: string[];
  n: number;
  sse: number;
  /** the failing hop and the non-ok exchanges of the failed step */
  failed: number;
  /** the other exchanges that did not end well (an expected 400 in a step that passed) */
  errors: number;
  /** it holds the failing hop, or a non-ok exchange of the failed step */
  bad: boolean;
  tables: string[];
  /** false when the code does not have it: seen, never read */
  inMap: boolean;
}

const ACTOR: Record<string, string> = { browser: 'Navegador', runner: 'Prueba', host: 'Tu máquina' };
const sub = (g: Indexed, nodes: MapNode[]): Indexed => ({ map: { ...g.map, nodes, facts: [] }, nodes: new Map(nodes.map((n) => [n.id, n])), out: () => [], in: () => [] });
const few = (xs: string[]) => (xs.length > 2 ? `${xs.slice(0, 2).join(', ')} +${xs.length - 2}` : xs.join(', '));

/**
 * A trace drawn on the map: its participants' nodes, with the browser, the test and the host as actors in front, and
 * its exchanges folded into one edge per pair and kind. A stream counts on the call that opened it; a Kafka message
 * published by A and consumed by B is an event from A to B.
 */
export function flowGraph(g: Indexed, trace: Pick<Trace, 'participants' | 'exchanges' | 'failure'>): { sub: Indexed; edges: FlowEdge[] } {
  const nodeOf = new Map<string, MapNode>();
  for (const p of trace.participants) {
    const id = ACTOR[p.type] ? `actor:${p.type}` : p.node ?? `${p.type}:${p.id}`;
    nodeOf.set(p.id, g.nodes.get(id) ?? { id, type: p.type === 'datastore' || p.type === 'external' ? p.type : 'service', name: ACTOR[p.type] ?? p.name, kind: ACTOR[p.type] ? 'actor' : p.kind });
  }
  const node = (id: string) => nodeOf.get(id) ?? nodeOf.set(id, { id: `service:${id}`, type: 'service', name: id }).get(id)!;
  const isStore = (n: MapNode) => n.type === 'datastore' || n.type === 'external';
  const f = trace.failure;
  const isBad = (e: Exchange) => Boolean(f) && (e.id === f!.exchange || (!e.ok && e.step === f!.step));

  const by = new Map<string, FlowEdge & { sql: number; http: number; tcp: number; names: string[]; topics: string[] }>();
  const add = (kind: EdgeKind, a: MapNode, b: MapNode, e: Exchange) => {
    if (a.id === b.id) return;
    const id = `${kind}|${a.id}|${b.id}`;
    const x = by.get(id) ?? by.set(id, { id, from: a.id, to: b.id, kind, label: '', origin: 'derived', facts: [], ex: [], n: 0, sse: 0, failed: 0, errors: 0, bad: false, tables: [], inMap: true, sql: 0, http: 0, tcp: 0, names: [], topics: [] }).get(id)!;
    if (x.ex.includes(e.id)) return;
    x.ex.push(e.id);
    if (e.origin === 'observed') x.origin = 'observed';
    if (e.kind === 'sse') x.sse++; else x.n++;
    if (isBad(e)) { x.failed++; x.bad = true; } else if (!e.ok) x.errors++;
    if (e.kind === 'sql') x.sql++; else if (e.kind === 'tcp') x.tcp++; else x.http++;
    if (e.table && !x.tables.includes(e.table)) x.tables.push(e.table);
    const bucket = e.kind === 'http' && isStore(b) ? e.path?.split('/')[1] : undefined;
    for (const name of [e.table?.split('.').pop(), bucket]) if (name && !x.names.includes(name)) x.names.push(name);
    if (e.topic && !x.topics.includes(e.topic)) x.topics.push(e.topic);
  };

  const sorted = [...trace.exchanges].sort((p, q) => p.t0 - q.t0);
  const kafka = sorted.filter((e) => e.kind === 'kafka');
  for (const e of sorted) {
    if (e.kind === 'kafka') continue;
    const a = node(e.from), b = node(e.to);
    add(isStore(b) && e.kind !== 'sse' ? 'store' : 'call', a, b, e);
  }
  // Kafka: a publish (A → broker) and a consume (broker → B) of the same topic are one event, A → B.
  for (const es of Map.groupBy(kafka, (e) => e.topic ?? e.label).values()) {
    const pubs = es.filter((e) => isStore(node(e.to))), subs = es.filter((e) => isStore(node(e.from)));
    for (const s of subs) {
      if (!pubs.length) add('event', node(s.from), node(s.to), s);
      for (const p of pubs) if (node(p.to).id === node(s.from).id) { add('event', node(p.from), node(s.to), p); add('event', node(p.from), node(s.to), s); }
    }
    if (!subs.length) for (const p of pubs) add('event', node(p.from), node(p.to), p);
  }

  const known = new Set(edgesOf(g).map((e) => e.id));
  const edges = [...by.values()].map(({ sql, http, tcp, names, topics, ...e }): FlowEdge => {
    const what = e.kind === 'event' ? topics.join(', ')
      : e.kind === 'store' ? [[sql && `${sql} SQL`, http && `${http} HTTP`, tcp && (tcp === 1 ? '1 conexión' : `${tcp} conexiones`)].filter(Boolean).join(' + '), few(names)].filter(Boolean).join(' · ')
      : e.n ? `${e.n}${e.sse ? ` · +${e.sse} SSE` : ''}` : `${e.sse} SSE`;
    const inMap = known.has(e.id) || !g.nodes.has(e.from) || !g.nodes.has(e.to);
    const errs = `${e.failed ? ` · ${e.failed} ${e.failed === 1 ? 'falló' : 'fallaron'}` : ''}${e.errors ? ` · ${e.errors} con error` : ''}`;
    return { ...e, inMap, label: `${what}${errs}${inMap ? '' : ' · no está en el código'}` };
  });
  const used = new Set(edges.flatMap((e) => [e.from, e.to]));
  return { sub: sub(g, [...new Map([...nodeOf.values()].filter((n) => used.has(n.id)).map((n) => [n.id, n])).values()]), edges };
}

/** A piece of the system: a service, a store or an external (the actors are the test's, not the system's). */
export const isPiece = (n: MapNode) => (n.type === 'service' || n.type === 'datastore' || n.type === 'external') && n.kind !== 'actor';

/** What one test went through on the full map. */
export interface Lit {
  fg: ReturnType<typeof flowGraph>;
  /** the lit edges, each with this test's label and exchanges */
  edges: Map<string, FlowEdge>;
  nodes: Set<string>;
  /** event edges whose deliveries all caused nothing visible */
  quiet: Set<string>;
}

/**
 * A test on the full map: its own edges; the code's store edge between a service and a store it exchanged with (Kafka is
 * drawn as events, so a publish lights file-service → kafka this way); and its nodes, except a consumer whose only part
 * was deliveries that caused nothing visible. An event edge whose deliveries all caused nothing says so.
 */
export function litBy(g: Indexed, trace: Pick<Trace, 'participants' | 'exchanges' | 'failure'>): Lit {
  const fg = flowGraph(g, trace);
  const did = new Set([...causes(trace.exchanges).values()].map((c) => c.parent));
  const by = new Map(trace.exchanges.map((e) => [e.id, e]));
  const idle = (e?: Exchange) => Boolean(e && isConsume(e) && !did.has(e.id));
  const quiet = new Set(fg.edges.filter((e) => e.kind === 'event' && e.ex.some((id) => isConsume(by.get(id)!)) && e.ex.every((id) => !isConsume(by.get(id)!) || idle(by.get(id)))).map((e) => e.id));
  const edges = new Map(fg.edges.map((e) => [e.id, quiet.has(e.id) ? { ...e, label: `${e.label} · sin efecto visible` } : e]));
  const parts = new Map(trace.participants.map((p) => [p.id, p]));
  const nodeOf = (id: string) => { const p = parts.get(id); return !p ? `service:${id}` : ACTOR[p.type] ? `actor:${p.type}` : p.node ?? `${p.type}:${p.id}`; };
  const code = new Set(edgesOf(g).filter((e) => e.kind === 'store').map((e) => e.id));
  for (const e of trace.exchanges) {
    if (idle(e)) continue; // a delivery that caused nothing lights neither its consumer nor the way to it
    const a = nodeOf(e.from), b = nodeOf(e.to);
    for (const id of [`store|${a}|${b}`, `store|${b}|${a}`]) {
      if (!code.has(id)) continue;
      const x = edges.get(id);
      if (!x) edges.set(id, { id, from: id.split('|')[1], to: id.split('|')[2], kind: 'store', label: '', origin: 'extracted', facts: [], ex: [e.id], n: 1, sse: 0, failed: 0, errors: 0, bad: false, tables: [], inMap: true });
      else if (!fg.edges.some((f) => f.id === id) && !x.ex.includes(e.id)) { x.ex.push(e.id); x.n++; }
    }
  }
  const nodes = new Set(trace.participants.filter((p) => trace.exchanges.some((e) => (e.from === p.id || e.to === p.id) && !(e.to === p.id && idle(e)))).map((p) => nodeOf(p.id)));
  return { fg, edges, nodes, quiet };
}

/**
 * The full map of a flow's page: every piece of the system and the actors its tests used; the code's edges merged with
 * what each test drew. Each edge keeps room for the widest label any test gives it, so laid out once, nodes keep their
 * place from the story to its cases and each test writes its own label in that box. `onlyUsed`: only the pieces some
 * test went through, unless none went through any.
 */
export function archGraph(g: Indexed, tests: Array<Pick<Trace, 'participants' | 'exchanges' | 'failure'>>, o: { onlyUsed?: boolean } = {}): { sub: Indexed; edges: MapEdge[]; lits: Lit[]; pieces: MapNode[] } {
  const lits = tests.map((t) => litBy(g, t));
  const pieces = g.map.nodes.filter(isPiece);
  const seen = lits.flatMap((l) => l.fg.sub.map.nodes);
  const nodes = new Map((o.onlyUsed && seen.some(isPiece) ? [] : pieces).map((n) => [n.id, n]));
  for (const n of seen) if (!nodes.has(n.id)) nodes.set(n.id, n);
  const edges = new Map<string, MapEdge>();
  for (const e of edgesOf(g)) if (nodes.has(e.from) && nodes.has(e.to)) edges.set(e.id, { ...e, label: '' });
  for (const l of lits) for (const e of l.edges.values()) {
    const x = edges.get(e.id);
    if (!x || e.label.length > x.label.length) edges.set(e.id, { id: e.id, from: e.from, to: e.to, kind: e.kind, origin: x?.origin ?? e.origin, facts: x?.facts ?? [], label: e.label });
  }
  return { sub: sub(g, [...nodes.values()]), edges: [...edges.values()], lits, pieces };
}

/** What a flow that never ran should touch: what it needs and the services of its steps, with the code's edges among them. */
export function expectedGraph(g: Indexed, flow: Pick<FlowInfo, 'needs' | 'steps'>): { sub: Indexed; edges: MapEdge[] } {
  const ids = new Set([...flow.needs, ...flow.steps.map((s) => s.service ?? '')].filter((id) => g.nodes.has(id)));
  return { sub: sub(g, [...ids].map((id) => g.nodes.get(id)!)), edges: edgesOf(g).filter((e) => ids.has(e.from) && ids.has(e.to)) };
}
