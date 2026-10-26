// Portions derived from Rough.js (https://github.com/rough-stuff/rough), MIT License, Copyright (c) 2019 Preet Shihn
/**
 * The hand: the same geometry, drawn as if somebody had drawn it.
 *
 * Excalidraw's look is not a filter and not a font — it is Rough.js, and Rough.js is a very
 * specific set of decisions that read as «hand» only when all of them hold at once. Every
 * edge is drawn **twice**, the second pass at half the offset. The wobble of the middle of a
 * line is bigger than the wobble of its ends. The bow of a line is proportional to its own
 * length and then *damped* as it gets long, so a long edge does not read as a scribble. And
 * one stream of pseudo-random numbers runs through an entire shape in a fixed order, so the
 * four sides of a box are related rather than four independent accidents.
 *
 * So it is ported rather than imitated: the numbers below are Rough.js's, read from
 * `roughjs@4.6.6` — MIT, and on this machine only as a transitive dependency of Mermaid. It
 * is not taken as a dependency because this package has none, not even on Node, and never
 * will: the engine has to produce the same bytes in a browser, in Node and in a capture.
 *
 * Which is also why the randomness is seeded by something the model already guarantees: a
 * piece's id. The same drawing wobbles the same way for ever, in every renderer, so a diff
 * of a capture still means what it says.
 */

/**
 * How hard the hand presses, everywhere, by default.
 *
 * One number, in one place, because the drawing a reader sees and the drawing an author
 * drags have to be the same drawing. Excalidraw's own default for a freshly drawn shape.
 */
export const INK: number | false = false;

/* ---------------------------------------------------------------------------------- */
/* The stream of numbers                                                                */
/* ---------------------------------------------------------------------------------- */

/**
 * mulberry32 over a hash of the seed.
 *
 * Rough.js uses a Lehmer generator that **degenerates for seed 0** — it silently falls
 * through to `Math.random()`, and the drawing stops being reproducible without saying so.
 * This one is uniform for every seed including zero, which is the only property the wobble
 * needs from it.
 */
function stream(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Pen {
  next: () => number;
  /** 0 is Excalidraw's «architect», 1 its «artist», 2 its «cartoonist». */
  roughness: number;
  /** How far a point may travel. Rough.js's default is 2. */
  amplitude: number;
  /** How much a line bows out from the straight. Rough.js's default is 1. */
  bowing: number;
}

const offset = (pen: Pen, min: number, max: number, gain = 1) =>
  pen.roughness * gain * (pen.next() * (max - min) + min);

const jitter = (pen: Pen, x: number, gain = 1) => offset(pen, -x, x, gain);

/*
 * One decimal.
 *
 * The ink is five times as many bytes as the ruler was, and every one of them is parsed
 * again on every frame of a drag. At this scale the second decimal is a fifth of a pixel on
 * a hand-drawn line — invisible, and it costs about a sixth of the file.
 */
const n = (v: number) => (Math.round(v * 10) / 10).toString();

/* ---------------------------------------------------------------------------------- */
/* One edge, drawn twice                                                                */
/* ---------------------------------------------------------------------------------- */

/**
 * The damping that keeps a long edge from reading as a scribble.
 *
 * Under 200 units the full wobble; over 500 units four tenths of it; a straight ramp
 * between. Without this the boundary of a deployment diagram — which is a thousand units
 * wide — comes out looking like a scribble while the boxes inside it look drawn.
 */
function damping(length: number): number {
  if (length < 200) return 1;
  if (length > 500) return 0.4;
  return -0.0016668 * length + 1.233334;
}

/** One pass over an edge, as the two commands Rough.js emits: a move and a cubic. */
function pass(pen: Pen, x1: number, y1: number, x2: number, y2: number, overlay: boolean): string {
  const lengthSq = (x1 - x2) ** 2 + (y1 - y2) ** 2;
  const length = Math.sqrt(lengthSq);
  const gain = damping(length);

  // A short edge cannot take the full offset: it would cross itself.
  let amp = pen.amplitude;
  if (amp * amp * 100 > lengthSq) amp = length / 10;
  const half = amp / 2;

  // Where along the edge the two control points sit. Randomising it is what stops every
  // line in the drawing from bowing in the same place.
  const diverge = 0.2 + pen.next() * 0.2;

  let bowX = (pen.bowing * pen.amplitude * (y2 - y1)) / 200;
  let bowY = (pen.bowing * pen.amplitude * (x1 - x2)) / 200;
  bowX = jitter(pen, bowX, gain);
  bowY = jitter(pen, bowY, gain);

  const wobble = () => jitter(pen, overlay ? half : amp, gain);

  const mx = x1 + (overlay ? jitter(pen, half, gain) : wobble());
  const my = y1 + (overlay ? jitter(pen, half, gain) : wobble());
  const c1x = bowX + x1 + (x2 - x1) * diverge + wobble();
  const c1y = bowY + y1 + (y2 - y1) * diverge + wobble();
  const c2x = bowX + x1 + 2 * (x2 - x1) * diverge + wobble();
  const c2y = bowY + y1 + 2 * (y2 - y1) * diverge + wobble();
  const ex = x2 + wobble();
  const ey = y2 + wobble();

  return `M${n(mx)} ${n(my)}C${n(c1x)} ${n(c1y)},${n(c2x)} ${n(c2y)},${n(ex)} ${n(ey)}`;
}

/** An edge: two passes, which is what makes it read as ink rather than as a wavy line. */
const edge = (pen: Pen, x1: number, y1: number, x2: number, y2: number): string =>
  `${pass(pen, x1, y1, x2, y2, false)} ${pass(pen, x1, y1, x2, y2, true)}`;

export type Point = readonly [number, number];

/** A run of straight edges, open or closed. */
function linear(pen: Pen, points: readonly Point[], close: boolean): string {
  if (points.length < 2) return '';
  const out: string[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    out.push(edge(pen, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]));
  }
  if (close) {
    const last = points[points.length - 1];
    out.push(edge(pen, last[0], last[1], points[0][0], points[0][1]));
  }
  return out.join(' ');
}

/* ---------------------------------------------------------------------------------- */
/* A curve, which is the same idea through a spline                                     */
/* ---------------------------------------------------------------------------------- */

/** Rough.js's curve: a Catmull-Rom through jittered points, emitted as cubics. */
function spline(points: readonly Point[]): string {
  const len = points.length;
  if (len < 3) return '';
  const out = [`M${n(points[1][0])} ${n(points[1][1])}`];
  for (let i = 1; i + 2 < len; i++) {
    const b1x = points[i][0] + (points[i + 1][0] - points[i - 1][0]) / 6;
    const b1y = points[i][1] + (points[i + 1][1] - points[i - 1][1]) / 6;
    const b2x = points[i + 1][0] + (points[i][0] - points[i + 2][0]) / 6;
    const b2y = points[i + 1][1] + (points[i][1] - points[i + 2][1]) / 6;
    out.push(`C${n(b1x)} ${n(b1y)},${n(b2x)} ${n(b2y)},${n(points[i + 1][0])} ${n(points[i + 1][1])}`);
  }
  return out.join('');
}

/** The same points, each nudged, with the ends doubled so the spline reaches them. */
function drift(pen: Pen, points: readonly Point[], amount: number): Point[] {
  const out: Point[] = [];
  const nudge = (p: Point): Point => [p[0] + jitter(pen, amount), p[1] + jitter(pen, amount)];
  out.push(nudge(points[0]), nudge(points[0]));
  for (let i = 1; i < points.length; i++) {
    out.push(nudge(points[i]));
    if (i === points.length - 1) out.push(nudge(points[i]));
  }
  return out;
}

/** A curved run, drawn twice like an edge is. */
function curved(pen: Pen, points: readonly Point[]): string {
  if (points.length < 2) return '';
  const first = spline(drift(pen, points, 1 * (1 + pen.roughness * 0.2)));
  const second = spline(drift(pen, points, 1.5 * (1 + pen.roughness * 0.22)));
  return `${first} ${second}`;
}

/* ---------------------------------------------------------------------------------- */
/* The pen the renderer holds                                                           */
/* ---------------------------------------------------------------------------------- */

export interface Hand {
  /** A closed polygon: a box, a diamond, a hexagon. */
  polygon(points: readonly Point[]): string;
  /** An open run of straight edges. */
  polyline(points: readonly Point[]): string;
  /** An open or closed run through a curve: a lid, a shoulder, a torn edge. */
  curve(points: readonly Point[], close?: boolean): string;
  /** A rectangle, as its four corners. */
  rect(x: number, y: number, w: number, h: number): string;
  /** An ellipse, sampled and then drawn as a curve. */
  ellipse(cx: number, cy: number, rx: number, ry: number): string;
}

/**
 * A hand, seeded.
 *
 * `roughness` is Excalidraw's own scale: 0 draws straight (its «architect»), 1 is what a
 * freshly drawn Excalidraw shape carries («artist»), 2 is «cartoonist». At 0 this still
 * draws two passes, which is why it does not look like a plotter: two nearly-identical
 * strokes over each other is what ink looks like.
 */
export function hand(seed: string, roughness = 1): Hand {
  const pen: Pen = { next: stream(seed), roughness, amplitude: 2, bowing: 1 };
  const sample = (cx: number, cy: number, rx: number, ry: number): Point[] => {
    // Rough.js sizes the step from the perimeter; nine steps on a small ellipse, more on a
    // big one, so a cylinder's lid does not become a polygon when the box is wide.
    const psq = Math.sqrt(Math.PI * 2 * Math.sqrt((rx ** 2 + ry ** 2) / 2));
    const steps = Math.ceil(Math.max(9, (9 / Math.sqrt(200)) * psq));
    const inc = (Math.PI * 2) / steps;
    const out: Point[] = [];
    for (let a = 0; a < Math.PI * 2 + inc; a += inc) out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    return out;
  };
  return {
    polygon: (points) => linear(pen, points, true),
    polyline: (points) => linear(pen, points, false),
    curve: (points, close = false) => curved(pen, close ? [...points, points[0]] : points),
    rect: (x, y, w, h) => linear(pen, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true),
    ellipse: (cx, cy, rx, ry) => curved(pen, sample(cx, cy, rx, ry)),
  };
}

/* ---------------------------------------------------------------------------------- */
/* From the silhouette the engine already draws, to the points the hand walks           */
/* ---------------------------------------------------------------------------------- */

/**
 * The geometry is not written twice.
 *
 * Every silhouette in this renderer exists once, in `outline()`, and it is right: a piece
 * fills exactly the box placement solved for. A second, hand-drawn copy of each form would
 * be a second source of truth for that — and the census that produced `outline()` exists
 * precisely because two copies of a shape had drifted apart.
 *
 * So the hand does not re-derive anything. It reads what was drawn, samples it into points,
 * and walks them. The commands below are the ones `outline()` and the routers emit and no
 * others; anything else is left alone rather than guessed at.
 */
const STEP = 9;

function arcPoints(x: number, y: number, rx: number, ry: number, sweep: number, ex: number, ey: number): Point[] {
  // The centre of an elliptical arc from its two ends, for the one case this file needs:
  // a half-turn (the large flag is 0 and the ends are a diameter apart) or a quarter.
  const mx = (x + ex) / 2;
  const my = (y + ey) / 2;
  const dx = (x - ex) / 2;
  const dy = (y - ey) / 2;
  const rxs = rx * rx;
  const rys = ry * ry;
  const inside = rxs * rys - rxs * dy * dy - rys * dx * dx;
  const factor = inside <= 0 ? 0 : Math.sqrt(inside / (rxs * dy * dy + rys * dx * dx)) * (sweep ? -1 : 1);
  const cx = mx + (factor * rx * dy) / ry;
  const cy = my - (factor * ry * dx) / rx;
  const angle = (px: number, py: number) => Math.atan2((py - cy) / ry, (px - cx) / rx);
  let a0 = angle(x, y);
  let a1 = angle(ex, ey);
  if (sweep && a1 < a0) a1 += Math.PI * 2;
  if (!sweep && a1 > a0) a1 -= Math.PI * 2;
  const span = Math.abs(a1 - a0) * Math.max(rx, ry);
  const steps = Math.max(3, Math.min(14, Math.ceil(span / STEP)));
  const out: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

function cubicPoints(p: Point, c1: Point, c2: Point, e: Point): Point[] {
  const span = Math.hypot(e[0] - p[0], e[1] - p[1]) + Math.hypot(c1[0] - p[0], c1[1] - p[1]);
  const steps = Math.max(3, Math.min(14, Math.ceil(span / STEP)));
  const out: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([
      u * u * u * p[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e[0],
      u * u * u * p[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e[1],
    ]);
  }
  return out;
}

/** A path's `d`, as the runs of points it draws. */
export function pathPoints(d: string): Array<{ points: Point[]; closed: boolean }> {
  const runs: Array<{ points: Point[]; closed: boolean }> = [];
  let points: Point[] = [];
  let x = 0;
  let y = 0;
  const num = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
  for (const m of d.matchAll(/([MmLlHhVvAaCcSsQqTtZz])([^MmLlHhVvAaCcSsQqTtZz]*)/g)) {
    const cmd = m[1];
    const args = (m[2].match(num) ?? []).map(Number);
    const rel = cmd === cmd.toLowerCase();
    const at = (i: number) => (rel ? x + args[i] : args[i]);
    switch (cmd.toUpperCase()) {
      case 'M':
        if (points.length > 1) runs.push({ points, closed: false });
        x = at(0); y = rel ? y + args[1] : args[1];
        points = [[x, y]];
        for (let i = 2; i + 1 < args.length; i += 2) { x = rel ? x + args[i] : args[i]; y = rel ? y + args[i + 1] : args[i + 1]; points.push([x, y]); }
        break;
      case 'L':
        for (let i = 0; i + 1 < args.length; i += 2) { x = rel ? x + args[i] : args[i]; y = rel ? y + args[i + 1] : args[i + 1]; points.push([x, y]); }
        break;
      case 'H':
        for (const a of args) { x = rel ? x + a : a; points.push([x, y]); }
        break;
      case 'V':
        for (const a of args) { y = rel ? y + a : a; points.push([x, y]); }
        break;
      case 'A':
        for (let i = 0; i + 6 < args.length; i += 7) {
          const ex = rel ? x + args[i + 5] : args[i + 5];
          const ey = rel ? y + args[i + 6] : args[i + 6];
          points.push(...arcPoints(x, y, Math.abs(args[i]), Math.abs(args[i + 1]), args[i + 4], ex, ey));
          x = ex; y = ey;
        }
        break;
      case 'C':
        for (let i = 0; i + 5 < args.length; i += 6) {
          const c1: Point = [rel ? x + args[i] : args[i], rel ? y + args[i + 1] : args[i + 1]];
          const c2: Point = [rel ? x + args[i + 2] : args[i + 2], rel ? y + args[i + 3] : args[i + 3]];
          const e: Point = [rel ? x + args[i + 4] : args[i + 4], rel ? y + args[i + 5] : args[i + 5]];
          points.push(...cubicPoints([x, y], c1, c2, e));
          x = e[0]; y = e[1];
        }
        break;
      case 'Z':
        if (points.length > 1) runs.push({ points, closed: true });
        if (points.length) { x = points[0][0]; y = points[0][1]; }
        points = points.length ? [[x, y]] : [];
        break;
      default:
        // A command this renderer does not emit. Leaving the shape alone is the honest
        // answer: a guessed curve is a silhouette that no longer fills its own box.
        return [];
    }
  }
  if (points.length > 1) runs.push({ points, closed: false });
  return runs;
}

/** A rounded rectangle, as the points of its outline. */
function roundedRect(x: number, y: number, w: number, h: number, r: number): Point[] {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr < 0.5) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const corner = (cx: number, cy: number, from: number): Point[] => {
    const steps = Math.max(3, Math.min(8, Math.ceil((rr * Math.PI) / 2 / STEP)));
    const out: Point[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = from + (Math.PI / 2) * (i / steps);
      out.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
    return out;
  };
  return [
    ...corner(x + w - rr, y + rr, -Math.PI / 2),
    ...corner(x + w - rr, y + h - rr, 0),
    ...corner(x + rr, y + h - rr, Math.PI / 2),
    ...corner(x + rr, y + rr, Math.PI),
  ];
}

/** What must not be drawn by hand: a fill is a fill, and a wobbly one reads as a mistake. */
const CRISP = /pd-(band|index|region|hatch|grat|ground|icon)/;

/**
 * The same drawing, in ink.
 *
 * Takes the markup a renderer just produced for one piece — rectangles, circles and paths —
 * and returns it drawn by hand. Anything it cannot read it leaves exactly as it was, which
 * is the only safe failure: a crisp shape among hand-drawn ones is visible and fixable, a
 * guessed one is a silhouette that quietly stopped fitting its box.
 */
/** One path's geometry, re-drawn by hand. Returns the original when it cannot read it. */
export function inkPath(d: string, seed: string, roughness = 1): string {
  const runs = pathPoints(d);
  if (!runs.length) return d;
  const pen = hand(seed, roughness);
  return runs.map((r) => (r.closed ? pen.polygon(r.points) : pen.polyline(r.points))).join(' ');
}

export function inked(svg: string, seed: string, roughness = 1): string {
  const pen = hand(seed, roughness);
  const bare = (s: string) => s.replace(/\s(x|y|width|height|rx|ry|cx|cy|r|d)="[^"]*"/g, ' ');
  /*
   * The attribute has to be anchored to a space.
   * `marker-end="…"` ends in `d="`, and an unanchored search for the path data found *that*
   * — so every arrow in the drawing was handed the string `url(#…-arrow)` as its geometry,
   * failed to parse, and was silently left crisp while every box around it went to ink.
   * `rx="8"` hides an `x="8"` the same way.
   */
  const num = (s: string, k: string) => Number((new RegExp(`(?:^|\\s)${k}="(-?[\\d.]+)"`).exec(s) ?? [])[1]);

  /*
   * A shape becomes two: the fill and the ink.
   *
   * A hand-drawn outline is eight separate strokes that cross at the corners, and there is
   * no sensible way to fill that — the browser will try, and what comes out is a shape with
   * holes where the passes overlap. Excalidraw has the same problem and the same answer:
   * fill the true outline, then lay the ink on top of it.
   *
   * The overrides have to be inline `style`, not attributes. The sheet sets fill and stroke
   * by class, and a declaration beats a presentation attribute — `fill="none"` on these
   * would be silently ignored and every piece would come out filled twice.
   */
  const split = (attrs: string, truth: string, ink: string) =>
    `<path${attrs} d="${truth}" style="stroke:none" />`
    + `<path${attrs} d="${ink}" style="fill:none;stroke-linecap:round;stroke-linejoin:round" />`;

  const closed = (points: readonly Point[]) => `M${points.map((q) => `${n(q[0])} ${n(q[1])}`).join('L')}Z`;

  /*
   * The order of these three is the whole correctness of the function.
   *
   * A rectangle becomes two paths, and a path is what the next rule looks for. Run the other
   * way round, every box was inked, turned into a path, and then inked **again** — the rough
   * outline flattened back into points and roughened on top of itself. Nothing looked wrong.
   * The drawing was fourteen times the bytes it should have been, and every frame of a drag
   * paid for it.
   */
  return svg
    .replace(/<path\b([^>]*?)\sd="([^"]+)"([^>]*)\/>/g, (whole, a: string, d: string, b: string) => {
      if (CRISP.test(a + b)) return whole;
      const runs = pathPoints(d);
      if (!runs.length) return whole;
      const ink = runs.map((r) => (r.closed ? pen.polygon(r.points) : pen.polyline(r.points))).join(' ');
      // An open run — a lid, a rule down a conduit, an arrow — carries no fill to preserve.
      if (!runs.some((r) => r.closed)) return `<path${a} d="${ink}"${b} style="fill:none;stroke-linecap:round;stroke-linejoin:round"/>`;
      return split(`${a.trimEnd()}${b.trimEnd()}`, runs.filter((r) => r.closed).map((r) => closed(r.points)).join(''), ink);
    })
    .replace(/<rect\b([^>]*)\/>/g, (whole, a: string) => {
      if (CRISP.test(a)) return whole;
      const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((k) => num(a, k));
      if ([x, y, w, h].some(Number.isNaN)) return whole;
      const r = num(a, 'rx');
      const points = roundedRect(x, y, w, h, Number.isNaN(r) ? 0 : r);
      return split(bare(a), closed(points), pen.polygon(points));
    })
    .replace(/<circle\b([^>]*)\/>/g, (whole, a: string) => {
      if (CRISP.test(a)) return whole;
      const [cx, cy, r] = ['cx', 'cy', 'r'].map((k) => num(a, k));
      if ([cx, cy, r].some(Number.isNaN)) return whole;
      const steps = 24;
      const points: Point[] = Array.from({ length: steps }, (_, i) => {
        const t = (i / steps) * Math.PI * 2;
        return [cx + r * Math.cos(t), cy + r * Math.sin(t)] as Point;
      });
      return split(bare(a), closed(points), pen.ellipse(cx, cy, r, r));
    });
}
