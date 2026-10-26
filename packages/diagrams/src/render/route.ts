/**
 * How an arrow gets from one box to another without going through a third.
 *
 * A straight line from centre to centre is what every naive renderer draws, and on any
 * drawing with more than a handful of pieces it crosses something: the reader then follows
 * a line that appears to touch three boxes on its way, and the label sits on top of one of
 * them. Measuring a landscape of forty-five pieces, every single complaint the composition
 * pass made came from this and none from where the pieces were put.
 *
 * So the placement is left alone and the arrow is routed. Straight if it is clear, an L if
 * one of the two corners is clear, a Z out to the side if neither is — and when nothing is
 * clear it takes the shape that crosses least, still in right angles, and the composition
 * pass says what it crossed. A diagonal that cuts through the middle of a drawing looks
 * like a mistake even when it is the shortest way, so the fallback stays orthogonal.
 */
export interface Point { x: number; y: number }
export interface Obstacle { id: string; x: number; y: number; w: number; h: number }
export type Side = 'left' | 'right' | 'top' | 'bottom';

/**
 * How far an arrow comes straight out of the side it leaves, before it is free to turn.
 *
 * Without it the router only knew two points, and the shortest L between them very often
 * ended by running ALONG the edge it was supposed to arrive at: the last segment lay flat on
 * the box's own keyline and the arrowhead pointed down its side instead of into it, with the
 * box — painted after the arrows — covering most of the head. It read as a line that stops
 * near a box rather than one that arrives at it.
 */
const STUB = 16;

const NORMAL: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

const out = (p: Point, side: Side, by = STUB): Point =>
  ({ x: p.x + NORMAL[side].x * by, y: p.y + NORMAL[side].y * by });

/** How far a line stays off a box it is passing. */
const CLEARANCE = 12;
/** How far out a Z goes looking for a free channel. */
const CHANNELS = [70, 130, 200];

const grow = (o: Obstacle, by: number) => ({ x: o.x - by, y: o.y - by, w: o.w + by * 2, h: o.h + by * 2 });

/** Whether a segment touches a box, by the slab method. */
function hits(a: Point, b: Point, box: { x: number; y: number; w: number; h: number }): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, a.x - box.x], [dx, box.x + box.w - a.x], [-dy, a.y - box.y], [dy, box.y + box.h - a.y]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t0 <= t1;
}

/** Whether a whole path is clear of every obstacle that is not one of its two ends. */
export function clear(points: Point[], obstacles: Obstacle[], ends: [string, string]): boolean {
  return crossings(points, obstacles, ends) === 0;
}

/** How many boxes a path goes through, which is what decides the least bad way round. */
function crossings(points: Point[], obstacles: Obstacle[], ends: [string, string]): number {
  const others = obstacles.filter((o) => o.id !== ends[0] && o.id !== ends[1]).map((o) => grow(o, CLEARANCE));
  let n = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    for (const box of others) if (hits(points[i], points[i + 1], box)) n++;
  }
  return n;
}

/**
 * The path an arrow takes: the first shape that is clear, in order of how plain it looks.
 *
 * The order is the point. A straight line reads best, so it is tried first; an L is next
 * because a single corner is still one movement; a Z is a detour and is only worth it when
 * the alternative is crossing something.
 */
/** Points along a path, evenly enough to compare one with another. */
function samples(points: Point[], per = 8): Point[] {
  const out: Point[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    for (let t = 0; t <= per; t++) {
      const u = t / per;
      out.push({ x: points[i].x + (points[i + 1].x - points[i].x) * u, y: points[i].y + (points[i + 1].y - points[i].y) * u });
    }
  }
  return out;
}

/** Whether this path runs alongside one already drawn, close enough to be mistaken for it. */
function shares(path: Point[], taken: Point[][], gap = 20): boolean {
  const mine = samples(path);
  for (const other of taken) {
    for (const p of samples(other)) {
      for (const q of mine) if (Math.abs(p.x - q.x) < gap && Math.abs(p.y - q.y) < gap) return true;
    }
  }
  return false;
}

/**
 * @param taken the paths already drawn, so this one looks for a lane of its own. Two arrows
 * in the same corridor are the complaint the composition pass makes most often, and the
 * router is where it can be answered instead of reported.
 */
export function route(
  a: Point,
  b: Point,
  obstacles: Obstacle[],
  ends: [string, string],
  taken: Point[][] = [],
  sides?: { a: Side; b: Side },
): Point[] {
  /*
   * Leave and arrive perpendicular to the side, always. The router is told which side each
   * end sits on, walks out of both by a stub, routes between the stub ends, and puts the two
   * ports back on. Everything below then works on a pair of points in open space, which is
   * the problem it was written for.
   */
  if (sides) {
    const from = out(a, sides.a);
    const to = out(b, sides.b);
    const middle = route(from, to, obstacles, ends, taken);
    const path = [a, ...middle, b];
    // Three points in a line are two segments pretending to be one; drop the middle.
    return path.filter((p, i) => {
      if (i === 0 || i === path.length - 1) return true;
      const q = path[i - 1], r = path[i + 1];
      return !((q.x === p.x && p.x === r.x) || (q.y === p.y && p.y === r.y));
    });
  }
  const straight = [a, b];
  /*
   * Only when the two ends line up. A clear diagonal is the shortest way across and it is
   * the wrong drawing: a family of boxes reads in right angles, and one line at 37 degrees
   * through the middle of a C4 looks like something went wrong even when nothing did.
   */
  const aligned = a.x === b.x || a.y === b.y;
  /* The first shape that is clear of the boxes; among those, the first with a lane to itself. */
  let fallback: Point[] | undefined;
  const take = (path: Point[]): Point[] | undefined => {
    if (!clear(path, obstacles, ends)) return undefined;
    if (!shares(path, taken)) return path;
    fallback ??= path;
    return undefined;
  };

  if (aligned) { const straightPath = take(straight); if (straightPath) return straightPath; }

  for (const corner of [{ x: b.x, y: a.y }, { x: a.x, y: b.y }]) {
    const path = take([a, corner, b]);
    if (path) return path;
  }

  const vertical = Math.abs(b.y - a.y) >= Math.abs(b.x - a.x);
  const detours: Point[][] = [];
  for (const offset of CHANNELS) {
    for (const side of [1, -1]) {
      // Out around the piece it leaves, and out around the piece it arrives at: the free
      // channel is as often beside the far end as beside the near one.
      const near = vertical
        ? [a, { x: a.x + offset * side, y: a.y }, { x: a.x + offset * side, y: b.y }, b]
        : [a, { x: a.x, y: a.y + offset * side }, { x: b.x, y: a.y + offset * side }, b];
      const far = vertical
        ? [a, { x: b.x + offset * side, y: a.y }, { x: b.x + offset * side, y: b.y }, b]
        : [a, { x: a.x, y: b.y + offset * side }, { x: b.x, y: b.y + offset * side }, b];
      for (const path of [near, far]) {
        const chosen = take(path);
        if (chosen) return chosen;
        detours.push(path);
      }
    }
  }

  // Nothing had a lane of its own. What was at least clear of the boxes beats what is not.
  if (fallback) return fallback;

  // Nothing was clear either. The least bad, and never a diagonal.
  const corners = [[a, { x: b.x, y: a.y }, b], [a, { x: a.x, y: b.y }, b]];
  const candidates = a.x === b.x || a.y === b.y ? [straight, ...corners, ...detours] : [...corners, ...detours];
  return candidates.reduce((best, path) =>
    crossings(path, obstacles, ends) < crossings(best, obstacles, ends) ? path : best);
}

/** The middle of the longest stretch: where a label has the most room. */
export function labelAt(points: Point[]): Point {
  let best = 0;
  let length = -1;
  for (let i = 0; i + 1 < points.length; i++) {
    const l = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    if (l > length) { length = l; best = i; }
  }
  return { x: (points[best].x + points[best + 1].x) / 2, y: (points[best].y + points[best + 1].y) / 2 };
}

/**
 * Every place a label could sit on this arrow, the roomiest first.
 *
 * Mermaid puts a label at the midpoint and dodges nothing, which is the single complaint
 * this engine exists to answer. The renderer walks these in order and keeps the first that
 * lands on nothing — the middle of the longest stretch when it is free, a step along it
 * when it is not, a shorter stretch when the long one is crowded end to end.
 */
export function labelSpots(points: Point[]): Point[] {
  const segments = [];
  for (let i = 0; i + 1 < points.length; i++) {
    segments.push({ a: points[i], b: points[i + 1], length: Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y) });
  }
  segments.sort((x, y) => y.length - x.length);
  const out: Point[] = [];
  for (const t of [0.5, 0.35, 0.65, 0.22, 0.78]) {
    for (const s of segments) {
      if (s.length < 24) continue; // a stub has no room for a word
      out.push({ x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t });
    }
  }
  return out.length ? out : [labelAt(points)];
}

export const path = (points: Point[]): string =>
  points.map((p, i) => `${i === 0 ? 'M' : 'L'}${Math.round(p.x)} ${Math.round(p.y)}`).join(' ');
