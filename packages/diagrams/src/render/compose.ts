/**
 * Whether the drawing can be read, measured on the drawing rather than recommended in prose.
 *
 * The standard used to carry rules like «if a label lands on top of another box, move it
 * with UpdateRelStyle»: the standard compensating for a renderer that placed labels at the
 * midpoint and dodged nothing. This is the other way round. The renderer reports where every
 * piece and every label ended up, and this pass says what cannot be read and what to do
 * about it — by measurement, in pixels, on the viewport the reader actually has.
 *
 * Every diagnostic answers three questions in the same shape, so an agent can act without
 * reading prose: what it is about (`subject`), what was measured (`evidence`), and what may
 * be changed (`supportedFixes`).
 */
import type { DiagramModel } from '../model.ts';
import type { Rendered } from './boxes.ts';

export type CompositionCode =
  | 'label-over-node'
  | 'label-over-label'
  | 'text-outside-piece'
  | 'font-too-small'
  | 'ambiguous-corridor'
  | 'edge-through-node'
  | 'node-straddles-boundary';

export interface CompositionDiagnostic {
  code: CompositionCode;
  severity: 'error' | 'warning';
  /** What the complaint is about: a piece, an arrow, or the drawing as a whole. */
  subject: { id?: string; other?: string; scope: 'node' | 'edge' | 'boundary' | 'diagram' };
  /** What was measured. Numbers, so the next attempt can aim rather than guess. */
  evidence: Record<string, number | string>;
  /** What may be changed to fix it. One of these, not a rewrite. */
  supportedFixes: string[];
}

export interface ComposeOptions {
  /**
   * How wide the drawing gets on the reader's screen. The default is what a 1440 desktop
   * leaves once the menu and the document panel have taken their share; a diagram that is
   * only ever exported can be judged against a wider one.
   */
  availableWidth?: number;
  /** Below this, on screen, letters are there and nobody can tell them apart. */
  minFontPx?: number;
  /** Two arrows closer than this, running the same way, cannot be told apart. */
  corridor?: number;
}

interface Box { x: number; y: number; w: number; h: number }

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const overlapArea = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

const contains = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/**
 * Which boxes touch which, as index pairs, without asking every box about every other.
 *
 * The plain double loop is right and was fine for a drawing of forty pieces. On the map of a
 * real catalogue it is not: 1325 arrows means 878 000 pairs of labels, and that pass alone
 * blocked the browser for seconds. Every box is filed in the cells of a coarse grid, and a
 * box is then compared only with those sharing a cell — anything further away cannot touch
 * it, which is arithmetic and not an estimate.
 *
 * The pairs come back in exactly the order the double loop would have produced them, so the
 * diagnostics are the same diagnostics in the same order. What changed is the work.
 */
function touching(as: Box[], bs: Box[], same: boolean): Array<[number, number]> {
  const CELL = 256;
  const cells = (b: Box): string[] => {
    const out: string[] = [];
    for (let cx = Math.floor(b.x / CELL); cx <= Math.floor((b.x + b.w) / CELL); cx++) {
      for (let cy = Math.floor(b.y / CELL); cy <= Math.floor((b.y + b.h) / CELL); cy++) out.push(`${cx},${cy}`);
    }
    return out;
  };
  const grid = new Map<string, number[]>();
  for (let j = 0; j < bs.length; j++) {
    for (const k of cells(bs[j])) {
      const at = grid.get(k);
      if (at) at.push(j); else grid.set(k, [j]);
    }
  }
  const hits: Array<[number, number]> = [];
  const seen = new Set<number>();
  for (let i = 0; i < as.length; i++) {
    seen.clear();
    for (const k of cells(as[i])) {
      for (const j of grid.get(k) ?? []) {
        if (seen.has(j)) continue;
        seen.add(j);
        if (same && j <= i) continue;
        if (!overlaps(as[i], bs[j])) continue;
        hits.push([i, j]);
      }
    }
  }
  return hits.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

/** Points along a path, evenly enough to compare two of them. */
function samples(line: Rendered['lines'][number], per = 8): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i + 1 < line.points.length; i++) {
    for (let t = 0; t <= per; t++) {
      const u = t / per;
      out.push({ x: line.points[i].x + (line.points[i + 1].x - line.points[i].x) * u, y: line.points[i].y + (line.points[i + 1].y - line.points[i].y) * u });
    }
  }
  return out;
}

/** The box a path fits in, so two that are nowhere near each other cost one comparison. */
function span(pts: Array<{ x: number; y: number }>): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

/** How far apart two boxes are — zero when they touch. A lower bound on any two points inside. */
function boxGap(a: ReturnType<typeof span>, b: ReturnType<typeof span>): number {
  const dx = Math.max(0, Math.max(a.x0 - b.x1, b.x0 - a.x1));
  const dy = Math.max(0, Math.max(a.y0 - b.y1, b.y0 - a.y1));
  return Math.hypot(dx, dy);
}

/** How close two paths get to each other at their closest, from samples taken once. */
function nearest(a: Array<{ x: number; y: number }>, b: Array<{ x: number; y: number }>): number {
  let min = Infinity;
  for (const p of a) for (const q of b) min = Math.min(min, Math.hypot(p.x - q.x, p.y - q.y));
  return min;
}

/** The direction of an arrow end to end, so two that merely cross are not called a corridor. */
const angleOf = (l: Rendered['lines'][number]): number => {
  const a = l.points[0];
  const b = l.points[l.points.length - 1];
  return Math.atan2(b.y - a.y, b.x - a.x);
};

export function composition(
  rendered: Rendered,
  model: Pick<DiagramModel, 'kind'> & Partial<DiagramModel>,
  opts: ComposeOptions = {},
): CompositionDiagnostic[] {
  const availableWidth = opts.availableWidth ?? 820;
  const minFontPx = opts.minFontPx ?? 6;
  const corridor = opts.corridor ?? 24;
  const out: CompositionDiagnostic[] = [];

  const labels = rendered.boxes.filter((b) => b.kind === 'label');
  const pieces = rendered.boxes.filter((b) => b.kind === 'node' && b.form !== 'boundary');
  const boundaries = rendered.boxes.filter((b) => b.form === 'boundary');

  /*
   * A label on top of a box is the failure everybody has seen and nobody can fix from the
   * source, because the source never said where the label goes.
   */
  for (const [li, pi] of touching(labels, pieces, false)) {
    {
      const label = labels[li];
      const piece = pieces[pi];
      out.push({
        code: 'label-over-node',
        severity: 'error',
        subject: { id: label.id, other: piece.id, scope: 'edge' },
        evidence: { overlapPx: Math.round(overlapArea(label, piece)), labelX: Math.round(label.x), labelY: Math.round(label.y), nodeX: piece.x, nodeY: piece.y },
        supportedFixes: [
          `move the label of "${label.id}" off the box with labelDx or labelDy`,
          `move "${piece.id}" so the arrow has room`,
          'shorten the label',
        ],
      });
    }
  }

  for (const [i, j] of touching(labels, labels, true)) {
    {
      out.push({
        code: 'label-over-label',
        severity: 'error',
        subject: { id: labels[i].id, other: labels[j].id, scope: 'edge' },
        evidence: { overlapPx: Math.round(overlapArea(labels[i], labels[j])) },
        supportedFixes: [`separate the labels of "${labels[i].id}" and "${labels[j].id}" with labelDy`, 'drop one: two arrows between the same pair rarely need two labels'],
      });
    }
  }

  /*
   * The writing has to fit the thing it is written in.
   *
   * This was missing, and it is the one a reader notices first: a piece whose name is one
   * long unbreakable token — a class, a route, a file — cannot be wrapped into a box of
   * fixed width, so the name simply hung out of both sides of it. Measured over ten real
   * catalogues before this check existed: 476 of 2936 pieces, one in six, while the
   * composition pass reported no errors at all.
   *
   * It is reported against the room the renderer gave the text, not against the box, because
   * a diamond and a chevron only offer part of their width to writing.
   */
  for (const piece of rendered.boxes) {
    if (piece.kind !== 'node' || !piece.wrote) continue;
    /*
     * A diamond and a chevron are only as tall as their box in the middle: writing that
     * fills the box top to bottom is already outside the slanted sides, so they are held to
     * the share of the height their silhouette actually offers.
     */
    const headroom = piece.form === 'diamond' ? piece.h * 0.55 : piece.form === 'chevron' ? piece.h * 0.8 : piece.h - 16;
    const wide = piece.wrote.w - piece.wrote.room;
    const tall = piece.wrote.h - headroom;
    const over = Math.max(wide, tall);
    if (over <= 1) continue;
    out.push({
      code: 'text-outside-piece',
      severity: 'error',
      subject: { id: piece.id, scope: piece.form === 'boundary' ? 'boundary' : 'node' },
      evidence: {
        needsPx: Math.round(wide > tall ? piece.wrote.w : piece.wrote.h),
        roomPx: Math.round(wide > tall ? piece.wrote.room : headroom),
        overflowPx: Math.round(over),
        axis: wide > tall ? 'width' : 'height',
        form: piece.form,
      },
      supportedFixes: [
        `shorten the name of "${piece.id}": the longest word in it does not fit and no wrap can break it`,
        `give "${piece.id}" a w of at least ${Math.round(piece.wrote.w + (piece.w - piece.wrote.room))}`,
        'move the detail out of the name and into the description',
      ],
    });
  }

  /*
   * The check the standard could never make: what the reader ends up with. A drawing wider
   * than the space it gets is scaled down, and the smallest text goes with it.
   */
  const viewBoxWidth = rendered.viewBox[2];
  const scale = Math.min(1, availableWidth / viewBoxWidth);
  const smallest = rendered.boxes.reduce((min, b) => Math.min(min, b.fontSize), Infinity);
  if (Number.isFinite(smallest)) {
    const projected = smallest * scale;
    if (projected < minFontPx) {
      out.push({
        code: 'font-too-small',
        severity: 'error',
        subject: { scope: 'diagram' },
        evidence: {
          viewBoxWidth: Math.round(viewBoxWidth), availableWidth, scale: Number(scale.toFixed(2)),
          sourceFontPx: Number(smallest.toFixed(1)), projectedFontPx: Number(projected.toFixed(2)), minimumProjectedFontPx: minFontPx,
        },
        supportedFixes: [
          `narrow the drawing to ${Math.round(smallest * availableWidth / minFontPx)}px or less`,
          'split it: fewer pieces, or one boundary per diagram',
          'shorten the longest labels so the boxes can be narrower',
        ],
      });
    }
  }

  /*
   * Every pair of arrows, which is the one place in this pass that grows with the square of
   * the drawing — and the drawing it met was a map of a real catalogue: 1325 arrows, 878 000
   * pairs. Two things made that 12.5 seconds of a blocked browser, and neither was the
   * comparison itself.
   *
   * The samples were taken inside the loop, so a path was re-sampled once for every other
   * path it was compared against: 1.75 million allocations where 1325 would do. They are
   * taken once here, with the box each one fits in.
   *
   * And nothing cheap ran before the expensive thing. Two arrows whose boxes are further
   * apart than the corridor cannot be within it — that is arithmetic, not an estimate — so
   * one subtraction now answers for the pairs that used to cost three hundred square roots
   * each. The diagnostics that come out are the same ones; only the work is gone.
   */
  const paths = rendered.lines.map((l) => { const pts = samples(l); return { line: l, pts, box: span(pts), angle: angleOf(l) }; });
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const a = paths[i];
      const b = paths[j];
      const apart = Math.abs(a.angle - b.angle);
      const parallel = apart < 0.2 || Math.abs(apart - Math.PI) < 0.2;
      if (!parallel) continue;
      if (boxGap(a.box, b.box) >= corridor) continue;
      const distance = nearest(a.pts, b.pts);
      if (distance >= corridor) continue;
      out.push({
        code: 'ambiguous-corridor',
        severity: 'warning',
        subject: { id: a.line.id, other: b.line.id, scope: 'edge' },
        evidence: { distancePx: Math.round(distance), corridorPx: corridor },
        supportedFixes: [`route "${a.line.id}" out of another side of its box`, `move one of the two pieces so the arrows separate`],
      });
    }
  }

  /*
   * An arrow through a box is the failure that made every label complaint on a landscape of
   * forty-five pieces: the reader follows a line that appears to touch three things on its
   * way. The router avoids it where it can, and says so here where it cannot.
   */
  /*
   * The same shape of mistake twice over, and on the same real map both were seconds.
   *
   * The edge an arrow belongs to was looked up with a linear scan of every edge in the
   * model — inside the loop over pieces, so a drawing of 1325 arrows and 161 pieces ran that
   * scan two hundred thousand times. It is a lookup; it is a map, built once.
   *
   * And an arrow was sampled against a piece before anything asked whether the two were
   * anywhere near each other. A segment cannot pass through a box its own span does not
   * reach, so that question is answered with four comparisons instead of twenty-five
   * interpolations.
   */
  const edgeOf = new Map((model.edges ?? []).map((e) => [e.id, e]));
  for (const line of rendered.lines) {
    const reach = span(line.points);
    const ends = edgeOf.get(line.id);
    for (const piece of pieces) {
      // A sequence carries rows and not edges: the pass measures the drawing, not the shape of the model.
      if (ends && (ends.from === piece.id || ends.to === piece.id)) continue;
      const box = { x: piece.x - 4, y: piece.y - 4, w: piece.w + 8, h: piece.h + 8 };
      if (reach.x1 < box.x || reach.x0 > box.x + box.w || reach.y1 < box.y || reach.y0 > box.y + box.h) continue;
      let through = false;
      for (let i = 0; i + 1 < line.points.length && !through; i++) {
        const a = line.points[i];
        const b = line.points[i + 1];
        // Sampling is enough here: a segment that clips a corner of a box still reads badly.
        for (let t = 0; t <= 24 && !through; t++) {
          const u = t / 24;
          const x = a.x + (b.x - a.x) * u;
          const y = a.y + (b.y - a.y) * u;
          if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) through = true;
        }
      }
      if (!through) continue;
      out.push({
        code: 'edge-through-node',
        severity: 'error',
        subject: { id: line.id, other: piece.id, scope: 'edge' },
        evidence: { corners: line.points.length - 2, nodeX: piece.x, nodeY: piece.y },
        supportedFixes: [
          `move "${piece.id}" out of the way between the two ends`,
          `route "${line.id}" out of another side of its box`,
        ],
      });
    }
  }

  /*
   * Half inside a boundary is the one that misleads without looking wrong: the reader takes
   * the piece to be in the zone, or out of it, and it is neither.
   */
  for (const piece of pieces) {
    for (const boundary of boundaries) {
      if (!overlaps(piece, boundary) || contains(boundary, piece)) continue;
      out.push({
        code: 'node-straddles-boundary',
        severity: 'error',
        subject: { id: piece.id, other: boundary.id, scope: 'node' },
        evidence: { overlapPx: Math.round(overlapArea(piece, boundary)) },
        supportedFixes: [`move "${piece.id}" fully inside "${boundary.id}", or fully out`, `grow "${boundary.id}" so it holds it`],
      });
    }
  }

  return out;
}
