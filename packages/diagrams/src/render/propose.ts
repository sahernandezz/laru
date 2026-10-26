/**
 * A placement to start from, when nobody wrote one.
 *
 * Two cases need it and neither has an author: a class the catalogue generates, and a
 * Mermaid diagram being migrated, whose source never said where anything went. Neither is
 * a drawing somebody decided; both need somewhere to begin.
 *
 * The plan called for a solver here. Two measurements said no. On landscapes of 8 to 45
 * pieces the layout this package already had produced zero complaints once the arrows were
 * routed. On the three real C4 levels of an application, ELK produced two to three times
 * MORE complaints than that same layout, because it packs for compactness and leaves the
 * labels nowhere to go — the same conclusion Archify reached with a blind rating, arrived
 * at here by measuring instead.
 *
 * So what proposes is the plain layout, and what improves it is the composition pass used
 * as the objective: spread the grid, keep whichever spread reads best, and report what is
 * left rather than pretend it is finished. A machine cannot recover a decision nobody made.
 */
import { layout, sizeOf, type Direction, type DiagramModel } from '../model.ts';
import type { StandardFacts } from '../kinds.ts';
import { renderBoxes } from './boxes.ts';
import { composition, type ComposeOptions, type CompositionDiagnostic } from './compose.ts';

/**
 * How much to pull the grid apart, in the order they are tried.
 *
 * Height is cheap and width is not: a drawing gets the width of the reader's column and
 * scrolls downwards for free, so growing tall costs nothing and growing wide shrinks every
 * letter in the picture. That is why the ladder pulls the rows apart first and the columns
 * only when the rows were not enough — measured, not assumed: on the real architectures of
 * the nine catalogues the wide spreads cleared the overlaps and then failed the font.
 */
const SPREADS: Array<[number, number]> = [
  [1, 1], [1, 1.5], [1, 2.1], [1.2, 1.6], [1.2, 2.4],
  [1.5, 1.5], [1.5, 2.4], [1.8, 1.8], [2.4, 2.4],
];

/**
 * How many pieces to try side by side. Fewer columns makes the drawing narrower and taller,
 * which is the trade the reader wants: a narrow drawing keeps its letters.
 */
const PER_ROW = [4, 3, 2];

/** How many of the laid-out rungs are actually painted and measured. */
const PAINTED = 8;

/**
 * Past this many arrows, even a single painted rung is seconds, and the drawing it would
 * produce is a ball of wool nobody can read. Measured: 600 arrows is 1.1 s to paint and
 * measure once, 1325 is 5.6 s.
 */
export const AFFORDABLE_EDGES = 240;

/**
 * Whether a drawing is small enough to be worth placing at all.
 *
 * `propose` keeps its ladder within a budget whatever it is handed, but a budget can only
 * divide the rungs — it cannot make the first one cheap. So a caller that has something
 * smaller it could draw instead should ask this before paying, and draw that.
 */
export const worthPlacing = (model: Pick<DiagramModel, 'edges'>): boolean => model.edges.length <= AFFORDABLE_EDGES;

/**
 * What one painted rung costs, in units of the smallest drawing that is worth measuring.
 *
 * Measured, holding the pieces fixed and growing the arrows, on the map of a real catalogue:
 *
 *     arrows   150   200   239   300    600    1325
 *     one rung 100   164   272   356   1104    5623   ms
 *
 * which is the square of the arrows divided by about 250, to within a tenth across the whole
 * range. It is a shape, not a stopwatch: the constant is whatever this machine happened to
 * be, and only the ratio between two drawings is used. Nothing here reads a clock, because a
 * placement that depended on how fast the machine was would stop being the same drawing
 * twice, and this package promises that it is.
 */
const paintCost = (model: Pick<DiagramModel, 'edges'>): number => (model.edges.length * model.edges.length) / 250;

/**
 * How many rungs a drawing can afford.
 *
 * The ladder was eight rungs for every drawing, which was seventy milliseconds on the map of
 * forty-five pieces it was written for and ninety-two seconds on the map of a real
 * catalogue. The first attempt at a fix put a step at 240 arrows, and a step was the wrong
 * shape entirely: measured either side of it, 239 arrows cost 1706 ms and 241 cost 241 — the
 * guard made the middle-sized drawing seven times slower than the large one it was there to
 * protect, which is the opposite of the point.
 *
 * So it is a budget divided by what a rung costs, which falls off smoothly and has no line
 * to be on the wrong side of: eight rungs while they are cheap, fewer as they stop being,
 * never fewer than one. A drawing so large that even one rung is slow is not a layout
 * problem and no ladder can help it — that is what `worthPlacing` is for, and it is the
 * caller who can answer it, because only the caller knows whether it has something smaller
 * to draw instead.
 */
const LADDER_BUDGET = 300;
export const rungsFor = (model: Pick<DiagramModel, 'edges'>): number =>
  Math.max(1, Math.min(PAINTED, Math.floor(LADDER_BUDGET / Math.max(1, paintCost(model)))));

export interface Proposal {
  /** The model, placed. Mutated from the one handed in. */
  model: DiagramModel;
  /** What the composition pass still says about it. Empty means it is ready as it stands. */
  remaining: CompositionDiagnostic[];
  /** True when nothing is left to fix, so a caller can tell a finished drawing from a draft. */
  accepted: boolean;
  /** Which spread won, for whoever wants to know why it looks like that. */
  spread: [number, number];
  /** How many pieces the winning grid put side by side. */
  perRow: number;
}

/**
 * How wide the drawing ends up, which is what decides how small its letters get.
 *
 * Asked of `sizeOf` and not of a literal. It used to fall back to 190 and 80, which were
 * already wrong for an entity and for a terminal, and became wrong for every piece once a
 * piece grew to fit its name. Nothing broke visibly — these two only rank the rungs of the
 * ladder — but a rung was being ranked on a drawing that was not the one it would paint.
 */
function width(model: DiagramModel): number {
  const xs = model.nodes.map((n) => n.x + sizeOf(n).w);
  return Math.max(...xs, 0) - Math.min(...model.nodes.map((n) => n.x), 0);
}

/**
 * How far a drawing is from the shape of a screen, which is what a reader scrolls least.
 *
 * Between two placements that read equally well, the squarer one wins. «Narrowest» was the
 * first tie-break and it produced maps nine thousand pixels tall: technically readable,
 * because height is free, and nobody wants to scroll a column of forty boxes.
 */
function awkwardness(model: DiagramModel): number {
  const w = width(model);
  const ys = model.nodes.map((n) => n.y + sizeOf(n).h);
  const h = Math.max(...ys, 0) - Math.min(...model.nodes.map((n) => n.y), 0);
  if (w <= 0 || h <= 0) return 0;
  return Math.abs(Math.log(w / h) - Math.log(1.4));
}

function spread(model: DiagramModel, fx: number, fy: number): void {
  for (const n of model.nodes) {
    n.x = Math.round(n.x * fx);
    n.y = Math.round(n.y * fy);
    /*
     * A boundary carries its own size, so it has to grow with what it holds. Scaling the
     * width and not the height pulled the pieces down out of the frame that was supposed to
     * contain them — and geometry is what decides membership, so they stopped being inside
     * it without anything complaining.
     */
    if (n.w !== undefined) n.w = Math.round(n.w * fx);
    if (n.h !== undefined) n.h = Math.round(n.h * fy);
  }
  /*
   * A proposal is a new arrangement, and a route pinned against the old one no longer means
   * anything: scaled it would go through the boxes it used to avoid. Dropped, and the router
   * draws again — which is what proposing a placement is for.
   */
  for (const e of model.edges) delete e.points;
}

export function propose(
  model: DiagramModel,
  facts: Pick<StandardFacts, 'kind'> & { maxNodes?: number; skin?: import('../kinds.ts').DiagramSkin },
  opts: ComposeOptions = {},
): Proposal {
  /*
   * A roadmap is the one drawing whose placement is not a question. Its x is a date and its
   * y is the row in its phase, so any grid this function is proud of is a grid that has
   * thrown the calendar away — every milestone still on the canvas, in an order that means
   * nothing. It is handed straight back.
   */
  if (facts.kind === 'roadmap') {
    const painted = facts.skin ? renderBoxes(model, facts.skin) : undefined;
    const remaining = painted ? composition(painted, model) : [];
    return { model, remaining, accepted: remaining.length === 0, spread: [0, 0], perRow: 0 };
  }
  /*
   * The ladder is walked in two passes because the two halves cost very different things.
   *
   * Laying a grid out is arithmetic; painting it and measuring the result is not, and doing
   * that twenty-seven times for a map of forty-five pieces took two seconds. So every rung
   * is laid out first — cheap — and sorted by how close it comes to the shape of a screen;
   * only then is each one painted, in that order, until one comes out clean. The first
   * clean one is then also the best-shaped clean one, which is what «narrowest wins» never
   * gave: it produced columns nine thousand pixels tall.
   *
   * The direction the source asked for is tried before the other one, and only loses when
   * it does not compose or comes out badly shaped.
   */
  const flipped: Direction = model.direction === 'LR' || model.direction === 'RL' ? 'TD' : 'LR';
  const rungs: Array<{ model: DiagramModel; spread: [number, number]; perRow: number; shape: number }> = [];
  for (const [d, direction] of [model.direction, flipped].entries()) {
    for (const perRow of PER_ROW) {
      for (const [fx, fy] of SPREADS) {
        const candidate = structuredClone(model);
        candidate.direction = direction;
        layout(candidate, { perRow });
        for (const n of candidate.nodes) {
          n.x = Math.round(n.x); n.y = Math.round(n.y);
          if (n.h !== undefined) n.h = Math.round(n.h);
          if (n.w !== undefined) n.w = Math.round(n.w);
        }
        if (fx !== 1 || fy !== 1) spread(candidate, fx, fy);
        rungs.push({ model: candidate, spread: [fx, fy], perRow, shape: awkwardness(candidate) + d * 0.05 });
      }
    }
  }
  rungs.sort((a, b) => a.shape - b.shape);

  /*
   * Only the most promising few are painted. Painting and measuring a map of forty-five
   * pieces costs about seventy milliseconds; twenty-seven of those is two seconds of
   * somebody's afternoon for a drawing that was already fine on the second rung.
   */
  let best: Proposal | null = null;
  for (const rung of rungs.slice(0, rungsFor(model))) {
    const remaining = composition(renderBoxes(rung.model, facts.skin), rung.model, opts)
      .filter((d) => d.severity === 'error');
    const proposal: Proposal = { model: rung.model, remaining, accepted: remaining.length === 0, spread: rung.spread, perRow: rung.perRow };
    if (!best || remaining.length < best.remaining.length) best = proposal;
    if (proposal.accepted) break;
  }

  // Whatever won is copied back, so the caller keeps the object it handed in.
  const winner = best!;
  model.direction = winner.model.direction;
  model.nodes.forEach((n, i) => {
    const placed = winner.model.nodes[i];
    n.x = placed.x; n.y = placed.y;
    if (placed.w !== undefined) n.w = placed.w;
    if (placed.h !== undefined) n.h = placed.h;
  });
  return { ...winner, model };
}
