/**
 * The family of boxes, arrows and nested boundaries: the geometry behind two thirds of the
 * classes of the standard, from the four C4 levels to every landscape.
 *
 * It receives a model that already knows where its pieces go and returns SVG as a string.
 * Nothing here reaches for a DOM, so the same model produces the same bytes in Node, in a
 * test and in a browser — which is what lets a snapshot mean something and an export be the
 * same drawing that was on screen.
 *
 * Everything about how it looks — the tones, the type scale, the register of the sheet —
 * lives in `sheet.ts`, which the sequence renderer reads too. The stylesheet is written
 * INTO the SVG from there: an export goes out through a `data:` URI where no external CSS,
 * font or asset resolves, so a drawing styled from outside came out as black rectangles in
 * every PNG while looking right on screen.
 */
import { childrenOf, groupOf, roomIn, sizeOf, type DiagramEdge, type DiagramModel, type DiagramNode } from '../model.ts';
import type { DiagramSkin, SkinEdge, SkinRole } from '../kinds.ts';
import { ADVANCE, esc, textWidth, wrap } from './text.ts';
import { INK, inkPath, inked } from './hand.ts';
import { clear, labelAt, labelSpots, path as toPath, route, type Point, type Side } from './route.ts';
import {
  SIZE, hatchTile, registerOf, styleBlock,
  scopeOf,
} from './sheet.ts';

interface Box { x: number; y: number; w: number; h: number }

export interface RenderOptions {
  /** Space left around the drawing, so a boundary does not touch the edge. */
  padding?: number;
  /** Point size of a piece's name. Everything else is derived from it. */
  fontSize?: number;
  /**
   * The drawings each piece may carry, by name, as the inner markup of an SVG.
   *
   * The engine has no way to fetch anything and no idea what an icon pack is; whoever
   * renders hands it the bodies it may need. A map of a catalogue leans on this: the rule
   * here is that a type is never told apart by colour alone, and the icon is what tells it.
   */
  icons?: Record<string, { body: string; width?: number; height?: number }>;
  /**
   * What a screen reader calls this drawing when the model carries no title of its own — a
   * derived map has none, and «application-landscape» is a class name, not a name.
   */
  name?: string;
  /**
   * How hand-drawn the ink is, on Excalidraw's own scale: 0 is its «architect», 1 what a
   * freshly drawn shape carries, 2 its «cartoonist». `false` puts the ruler back.
   *
   * The default is the hand, everywhere — the page, the editor, the captures and the static
   * site — because a drawing that is edited in one hand and read in another is two drawings.
   *
   * The wobble is seeded by each piece's own id, so a drawing looks the same for ever and
   * adding a box does not re-draw the ones around it. That is not a nicety: it is what lets
   * a diff of a capture still mean something.
   */
  hand?: number | false;
  /**
   * Where the hand's font file is, for a drawing that will be opened outside the app.
   *
   * The web loads Excalifont from its own stylesheet, so it passes nothing. A capture does
   * not have a stylesheet: opened on its own it would fall back to the interface face and
   * stop being a picture of what the reader sees. Given a URL — relative to wherever the
   * SVG lands — the sheet carries an `@font-face` of its own and the file travels once,
   * beside the captures, instead of a copy inside each of them.
   */
  fontSrc?: string;
  /**
   * Prefix for the ids this SVG defines. Two drawings on one page — which is every
   * architecture document — otherwise share whichever arrowhead the browser parsed first,
   * with no error and the wrong arrows.
   */
  idPrefix?: string;
}

export interface Rendered {
  svg: string;
  /** The box the drawing occupies, which is what the viewer scales to. */
  viewBox: [number, number, number, number];
  /** Where every piece and every label ended up, for the composition pass to judge. */
  boxes: Array<{
    id: string;
    kind: 'node' | 'label';
    /** The geometry of its role, so composition knows a boundary from a piece. */
    form: SkinRole['form'] | 'label';
    x: number; y: number; w: number; h: number;
    fontSize: number;
    /**
     * What was actually written inside, and the room it was given.
     *
     * The renderer wraps to `room`, so `w` only exceeds it when a single word is longer than
     * the piece is wide — a class name, a path, an identifier — and no wrap can save it.
     * Nothing measured that before, which is how one piece in six ended up with its name
     * hanging outside its own box while the composition pass reported no errors at all.
     */
    wrote?: { w: number; h: number; room: number };
  }>;
  /** The path each arrow took, so composition can look for corridors and crossings. */
  lines: Array<{ id: string; points: Point[] }>;
}

const TITLE_SIZE = SIZE.NAME;
const SUB_SIZE = SIZE.SUB;
const LABEL_SIZE = SIZE.LABEL;
/** How big a piece's icon is drawn, in the same units as everything else. */
const ICON = 18;
/**
 * How much of a person's box the head and shoulders take.
 *
 * One number, used by the silhouette and by the line that centres the writing under it.
 * They were two numbers once and disagreed, so the name came out floating in the air beside
 * the head instead of on the body.
 */
const PERSON_CROWN = 0.34;
/** How much air a frame leaves around what it holds. */
const FRAME = 26;

/** The role the skin gives a shape, or a plain box when the class has no skin yet. */
function roleOf(skin: DiagramSkin | undefined, shape: string): SkinRole {
  const found = skin?.roles.find((r: SkinRole) => r.shape === shape);
  return found ?? { shape, form: 'rect', tone: 'step' };
}

/**
 * The outline of a piece, by the geometry its role asks for.
 *
 * Radii mean something here rather than being whatever each form was born with: 2 is a
 * fixed thing on the ground, 8 is a soft thing, a pill is a state. The census before this
 * was five different values across the corpus — 3, 4, 6, 10 and 12 — which is why two
 * drawings out of the same tool did not look like the same product.
 *
 * Every form fills exactly the box it is given. That is not a style rule: the box is what
 * placement solved for, what the arrows aim at and what the composition pass measures, so a
 * silhouette that grew or shrank would move all three without telling anyone.
 */
function outline(form: SkinRole['form'], x: number, y: number, w: number, h: number): string {
  switch (form) {
    case 'rounded':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" />`;
    case 'stadium':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" />`;
    case 'cylinder': {
      const r = Math.min(14, h / 5);
      return `<path d="M${x} ${y + r} a${w / 2} ${r} 0 0 1 ${w} 0 v${h - 2 * r} a${w / 2} ${r} 0 0 1 ${-w} 0 Z" />`
        + `<path class="pd-lid" d="M${x} ${y + r} a${w / 2} ${r} 0 0 0 ${w} 0" />`;
    }
    case 'queue':
    case 'pipe': {
      const r = Math.min(14, w / 8);
      // The near end of the tube is drawn as well as the far one. Without it a queue is a
      // rounded rectangle with a three pixel bulge once the drawing is scaled into a
      // reader's column, which is not a pipe.
      const body = `<path d="M${x + r} ${y} h${w - 2 * r} a${r} ${h / 2} 0 0 1 0 ${h} h${-(w - 2 * r)} a${r} ${h / 2} 0 0 1 0 ${-h} Z" />`
        + `<path class="pd-lid" d="M${x + r} ${y} a${r} ${h / 2} 0 0 0 0 ${h}" />`;
      if (form === 'queue') return body;
      // A conduit is the same tube seen from the side: two rules run the length of it.
      return body
        + `<path class="pd-lid" d="M${x + r} ${y + h * 0.34} H${x + w - r}" />`
        + `<path class="pd-lid" d="M${x + r} ${y + h * 0.66} H${x + w - r}" />`;
    }
    case 'person': {
      // Head and shoulders as one outline. It used to be a circle glued on a box, which
      // drew the head's lower arc straight across the chest, and the head was a fixed 20px
      // — two thirds of a short box and a third of a tall one.
      const r = Math.min(12, h * PERSON_CROWN * 0.46);
      const shoulder = y + h * PERSON_CROWN;
      const arm = w / 2 - r;
      return `<path d="M${x} ${y + h} V${shoulder} h${arm} a${r} ${r} 0 1 1 ${r * 2} 0 h${arm} V${y + h} Z" />`;
    }
    case 'hexagon': {
      const cut = Math.min(22, w / 5);
      return `<path d="M${x + cut} ${y} H${x + w - cut} L${x + w} ${y + h / 2} L${x + w - cut} ${y + h} H${x + cut} L${x} ${y + h / 2} Z" />`;
    }
    case 'diamond': {
      // Held to a readable proportion inside its box. A decision in a wide column came out
      // as a flat lozenge whose name ran straight through the slanted sides.
      const dw = Math.min(w, h * 1.55);
      const cx = x + w / 2, cy = y + h / 2;
      return `<path d="M${cx} ${y} L${cx + dw / 2} ${cy} L${cx} ${y + h} L${cx - dw / 2} ${cy} Z" />`;
    }
    case 'terminal': {
      const r = Math.min(h, w) / 2;
      return `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${r}" />`;
    }
    case 'node': {
      // A host, a machine, a site: the map glyph for an installation, and the one
      // silhouette nothing else in the product uses. The bevel has to be big enough to
      // survive the drawing being scaled into a reader's column — at seven pixels it just
      // read as a soft corner, which is what `rounded` already means.
      const c = Math.min(13, h / 5, w / 8);
      return `<path d="M${x + c} ${y} H${x + w - c} L${x + w} ${y + c} V${y + h - c} L${x + w - c} ${y + h} H${x + c} L${x} ${y + h - c} V${y + c} Z" />`;
    }
    case 'chevron': {
      // A stage in time. The notch says which way the reading goes without an arrow.
      const c = Math.min(18, w / 6);
      return `<path d="M${x} ${y} H${x + w - c} L${x + w} ${y + h / 2} L${x + w - c} ${y + h} H${x} L${x + c} ${y + h / 2} Z" />`;
    }
    case 'document': {
      // A record, a published sheet, a facet: a page with a torn lower edge. On a catalogue
      // map it is what says «this is something somebody wrote» without reading the label.
      const curl = 12;
      return `<path d="M${x} ${y + 2} a2 2 0 0 1 2 -2 H${x + w - 2} a2 2 0 0 1 2 2 V${y + h - curl}`
        + ` c${-w * 0.26} ${curl} ${-w * 0.4} ${-curl} ${-w * 0.66} ${-curl * 0.2}`
        + ` c${-w * 0.2} ${curl * 0.6} ${-w * 0.28} ${curl * 0.4} ${-w * 0.34} ${curl * 0.2} Z" />`;
    }
    case 'entity':
    case 'class':
      // A table: the name on a filled band of its own, the fields listed under it.
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" />`
        + `<path class="pd-band" d="M${x + 2} ${y} h${w - 4} a2 2 0 0 1 2 2 v28 H${x} V${y + 2} a2 2 0 0 1 2 -2 Z" />`;
    case 'boundary':
      return `<rect class="pd-neat" x="${x}" y="${y}" width="${w}" height="${h}" rx="10" />`;
    case 'rect':
    default:
      // The band down the left edge is what types a box at a distance: the tint is close to
      // paper by design, so at a quarter zoom the fill says nothing and this still does.
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" />`
        + `<path class="pd-index" d="M${x + 1} ${y} h1.6 V${y + h} h-1.6 a1 1 0 0 1 -1 -1 V${y + 1} a1 1 0 0 1 1 -1 Z" />`;
  }
}

/** Which side of each box the arrow uses: the one that faces the other. */
function sides(from: Box, to: Box): { a: Side; b: Side } {
  const dx = (to.x + to.w / 2) - (from.x + from.w / 2);
  const dy = (to.y + to.h / 2) - (from.y + from.h / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? { a: 'right', b: 'left' } : { a: 'left', b: 'right' };
  return dy > 0 ? { a: 'bottom', b: 'top' } : { a: 'top', b: 'bottom' };
}

/** Every way round, in the order a person would try them: facing sides first. */
function sideOptions(pref: { a: Side; b: Side }): Array<{ a: Side; b: Side }> {
  const opposite: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
  const across: Side[] = pref.a === 'left' || pref.a === 'right' ? ['top', 'bottom'] : ['left', 'right'];
  const out = [pref];
  for (const a of across) out.push({ a, b: opposite[a] });
  for (const a of across) out.push({ a, b: pref.b });
  for (const b of across) out.push({ a: pref.a, b: opposite[b] });
  return out;
}

/**
 * Which sides this arrow actually uses: the facing ones unless something is in the way.
 *
 * Two boxes in the same column with a third between them face each other through it, and
 * no amount of routing gets round a box that sits exactly in the doorway. Coming out of
 * the side instead costs one corner and crosses nothing, which is what a person drawing it
 * would do without thinking. Probed from the middle of each side; the seats are shared out
 * afterwards, once every arrow knows which side it is on.
 */
function chooseSides(from: Box, to: Box, obstacles: Array<Box & { id: string }>, ends: [string, string]): { a: Side; b: Side } {
  let best: { sides: { a: Side; b: Side }; crossed: number } | undefined;
  for (const option of sideOptions(sides(from, to))) {
    const path = route(port(from, option.a, 0, 1), port(to, option.b, 0, 1), obstacles, ends, [], option);
    if (clear(path, obstacles, ends)) return option;
    const crossed = path.length;
    if (!best || crossed < best.crossed) best = { sides: option, crossed };
  }
  return best!.sides;
}

/**
 * Where on that side the arrow leaves, given how many others leave from it.
 *
 * Every arrow used to leave from the middle of its side, so two arrows going the same way
 * out of the same box started at the same pixel and ran on top of each other the whole way.
 * The reader then cannot tell which label belongs to which, and the composition pass said
 * so on nearly every real drawing. Spreading them across the side is what a person drawing
 * by hand does without thinking about it.
 */
function port(box: Box, side: Side, index: number, total: number): Point {
  const t = (index + 1) / (total + 1);
  if (side === 'left' || side === 'right') {
    return { x: side === 'right' ? box.x + box.w : box.x, y: box.y + box.h * t };
  }
  return { x: box.x + box.w * t, y: side === 'bottom' ? box.y + box.h : box.y };
}

/** Two rectangles that touch, with a little air between them so a near miss still counts. */
function overlaps(a: Box, b: Box, margin = 3): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

/**
 * Where this arrow's label goes: the first spot along it that lands on nothing.
 *
 * A label above the line is the reading convention, so that is tried first at every spot
 * before any of them is tried below. When the arrow is crowded end to end the label goes
 * back to the middle and the composition pass says so — a drawing that will not fit is a
 * placement to fix, not a label to hide.
 */
function labelPlace(
  points: Point[],
  w: number,
  size: number,
  obstacles: Array<Box & { id: string }>,
  placed: Rendered['boxes'],
): { at: Point; lift: number } {
  const labels = placed.filter((b) => b.kind === 'label');
  const spots = labelSpots(points);
  for (const lift of [-6, size + 8]) {
    for (const at of spots) {
      const box = { x: at.x - w / 2, y: at.y + lift - size, w, h: size * 1.3 };
      if (obstacles.some((o) => overlaps(box, o))) continue;
      if (labels.some((l) => overlaps(box, l))) continue;
      return { at, lift };
    }
  }
  return { at: labelAt(points), lift: -6 };
}

export function renderBoxes(model: DiagramModel, skin?: DiagramSkin, opts: RenderOptions = {}): Rendered {
  const pad = opts.padding ?? 40;
  const font = opts.fontSize ?? 15;
  const prefix = opts.idPrefix ?? 'pd';
  /*
   * The ink, or the ruler. Seeded per piece, so the same drawing comes out the same for
   * ever and adding one box does not re-draw the ones beside it.
   */
  const nib = opts.hand ?? INK;
  const ink = (d: string, seed: string) => (nib === false ? d : inkPath(d, seed, nib));
  const inkShape = (svg: string, seed: string) => (nib === false ? svg : inked(svg, seed, nib));
  const arrow = `${prefix}-arrow`;
  const hatch = `${prefix}-hatch`;
  /*
   * Which family of question this drawing answers. It colours every route and rules every
   * region, and it is derived from the class — never declared, so it cannot disagree with
   * the sheet's own name in the margin.
   */
  const reg = registerOf(model.kind);
  /*
   * A piece with no position produces NaN coordinates, and NaN makes a viewBox the browser
   * shows as an empty card with no error at all. Refusing is the loud version.
   */
  const unplaced = model.nodes.filter((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y));
  if (unplaced.length > 0) {
    throw new Error(`cannot draw "${model.kind}": ${unplaced.map((n) => n.id || '(no id)').join(', ')} ${unplaced.length === 1 ? 'has' : 'have'} no position`);
  }
  if (model.nodes.length === 0) throw new Error(`cannot draw "${model.kind}": it has no pieces`);
  const boxes: Rendered['boxes'] = [];
  const lines: Rendered['lines'] = [];

  /*
   * A frame is drawn around what it holds, not where its author said it went.
   *
   * A boundary is the one piece whose geometry is not a decision: it is «these things are
   * together». Trusting a hand-written `w`/`h` there is how a container ends up half
   * outside the system it belongs to — the commonest thing to get wrong when writing a
   * model by hand, and unnecessary, because the answer is already in the drawing.
   */
  const framed = new Map<string, Box>();
  const depthOf = (n: DiagramNode): number => {
    let depth = 0;
    for (let at = n; at.parent; depth++) {
      const up = model.nodes.find((p) => p.id === at.parent);
      if (!up || depth > 8) break;
      at = up;
    }
    return depth;
  };
  // Deepest first: a region is sized by the VPC it holds, and the VPC by its own contents.
  const frames = model.nodes.filter((n) => roleOf(skin, n.shape).form === 'boundary').sort((a, b) => depthOf(b) - depthOf(a));
  for (const group of frames) {
    const held = childrenOf(model, group).filter((c) => c.parent === group.id);
    if (held.length === 0) continue;
    const inner = held.map((c) => framed.get(c.id) ?? { x: c.x, y: c.y, ...sizeOf(c) });
    // Wide enough for its own name as well as for what it holds: the name is set in tracked
    // capitals along the top, and a long one ran straight out of the frame it labels.
    const label = textWidth(group.name.toUpperCase(), font * LABEL_SIZE, ADVANCE.caps) + 34;
    const x = Math.min(...inner.map((r) => r.x)) - FRAME;
    // The name is read at the top left, the way a district is named on a map, so the room
    // for it is taken there. The frame is the same height it was; it sits 22px higher.
    const y = Math.min(...inner.map((r) => r.y)) - FRAME - 22;
    framed.set(group.id, {
      x, y,
      w: Math.max(Math.max(...inner.map((r) => r.x + r.w)) + FRAME - x, label),
      h: Math.max(...inner.map((r) => r.y + r.h)) + FRAME - y,
    });
  }
  const rect = (n: DiagramNode): Box => framed.get(n.id) ?? { x: n.x, y: n.y, ...sizeOf(n) };

  /*
   * Boundaries first and in one layer: they hold the others, so anything drawn after sits
   * on top of them without a z-index to argue about.
   */
  const groups = model.nodes.filter((n) => roleOf(skin, n.shape).form === 'boundary');
  const pieces = model.nodes.filter((n) => roleOf(skin, n.shape).form !== 'boundary');

  const out: string[] = [];

  for (const g of groups) {
    const r = rect(g);
    const role = roleOf(skin, g.shape);
    /*
     * A territory is drawn as ground — a flat tint, the sheet's own texture over it, then a
     * solid keyline — and a grouping that means nothing of its own gets none of that, only
     * a broken rule saying «these go together». That difference is carried by the keyline
     * alone, so it survives with no colour at all.
     */
    const territory = role.tone !== 'frame';
    out.push(`<g class="pd-boundary pd-${role.tone}" data-id="${esc(g.id)}">`);
    if (territory) {
      /*
       * The ground goes in a layer of its own, and that is not decoration either: a tone's
       * rule paints `.pd-zone > rect`, which reached the texture rectangle as readily as the
       * tint one and overwrote its pattern with a flat fill — a declaration beats the
       * `fill="url(#…)"` attribute. One level down, it does not match.
       */
      out.push('<g class="pd-terrain">');
      out.push(`<rect class="pd-region" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10" />`);
      /*
       * Only the outermost territory is textured. A region drawn inside a textured one lays
       * a second weave over the first and the ground starts competing with what stands on
       * it — the same reason an atlas hatches a country and then leaves its provinces to
       * the keyline.
       */
      if (!g.parent) out.push(`<rect class="pd-hatch" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10" fill="url(#${hatch})" />`);
      out.push('</g>');
    }
    out.push(outline('boundary', r.x, r.y, r.w, r.h));
    out.push(`<text class="pd-boundary-label pd-halo" x="${r.x + 16}" y="${r.y + 20}" font-size="${font * LABEL_SIZE}">${esc(g.name.toUpperCase())}</text>`);
    out.push('</g>');
    boxes.push({
      id: g.id, kind: 'node', form: 'boundary', ...r, fontSize: font * LABEL_SIZE,
      wrote: { w: textWidth(g.name.toUpperCase(), font * LABEL_SIZE, ADVANCE.caps), h: font * LABEL_SIZE, room: r.w - 32 },
    });
  }

  /*
   * Everything an arrow has to get around. A boundary is not an obstacle — arrows cross
   * into and out of zones all the time and that is the point of drawing the zone.
   */
  const obstacles = pieces.map((n) => ({ id: n.id, ...rect(n) }));

  /*
   * The arrows are laid out before any of them is drawn: which side each end leaves from,
   * and then how the ones sharing a side share it out between them. Order is the order of
   * the model, so the same drawing always comes out the same.
   */
  const routed = model.edges.map((edge) => {
    const from = model.nodes.find((n) => n.id === edge.from);
    const to = model.nodes.find((n) => n.id === edge.to);
    if (!from || !to) return undefined;
    return { edge, from, to, ...chooseSides(rect(from), rect(to), obstacles, [from.id, to.id]) };
  });
  const seats = new Map<string, string[]>();
  for (const r of routed) {
    if (!r) continue;
    for (const [node, side] of [[r.from.id, r.a], [r.to.id, r.b]] as const) {
      const key = `${node}/${side}`;
      if (!seats.has(key)) seats.set(key, []);
      seats.get(key)!.push(r.edge.id);
    }
  }
  const seat = (nodeId: string, side: Side, edgeId: string) => {
    const list = seats.get(`${nodeId}/${side}`) ?? [edgeId];
    return { index: Math.max(0, list.indexOf(edgeId)), total: list.length };
  };

  for (const r of routed) {
    if (!r) continue;
    const { edge, from, to } = r;
    const fs = seat(from.id, r.a, edge.id);
    const ts = seat(to.id, r.b, edge.id);
    const a = port(rect(from), r.a, fs.index, fs.total);
    const b = port(rect(to), r.b, ts.index, ts.total);
    /*
     * Looking for a free lane compares this arrow with every one already drawn, so on a
     * drawing with dozens of them it is the whole cost of the render — and on a drawing with
     * dozens of them there are no free lanes left to find.
     */
    /*
     * A route the author pinned is drawn as it was pinned; everything else is routed again.
     *
     * That asymmetry is the whole rule: dragging a box is «this goes here», not «and the
     * arrows go exactly like this», so the router keeps its say over obstacles and lanes. Only
     * a corner somebody fixed on purpose survives, because that is a decision and the
     * positions alone do not contain it. The ends are re-seated either way: the ports belong
     * to the engine, which shares out the arrows leaving one side.
     */
    const pinned = edge.points;
    const points = pinned && pinned.length >= 2
      ? [a, ...pinned.slice(1, -1).map((pt) => ({ x: pt.x, y: pt.y })), b]
      : route(a, b, obstacles, [from.id, to.id], model.edges.length <= 30 ? lines.map((l) => l.points) : [], { a: r.a, b: r.b });
    lines.push({ id: edge.id, points });
    /*
     * How this class draws a relation, taken from the skin rather than assumed: a data
     * model joins two tables with a plain line and says the cardinality at each end, and an
     * arrowhead there would be saying something the notation does not.
     */
    const stroke: SkinEdge | undefined = skin?.edges[0];
    const dashed = stroke?.stroke === 'dashed';
    const head = stroke?.head !== 'none';
    // A road that matters is drawn heavier. The model already says so at the ends, and a
    // sibling selector cannot reach from a node's group to an edge's, so it is decided here.
    const primary = from.emphasis || to.emphasis;
    const cls = ['pd-edge', dashed && 'pd-dashed', primary && 'pd-primary'].filter(Boolean).join(' ');
    out.push(`<g class="${cls}" data-id="${esc(edge.id)}" data-ends="${esc(from.id)} ${esc(to.id)}">`);
    /*
     * The casing is paper, laid under the line on the same geometry. It is what makes one
     * route crossing another readable without a bridge symbol, and what lifts the line work
     * off the keylines — before this a node's border and an edge were the same darkness at
     * the same weight, and a busy drawing read as one flat wire mesh.
     */
    /*
     * One ink for both. The casing is the same geometry laid underneath in paper, so if the
     * two were drawn by hand separately the white would show along the edge of the line —
     * the very effect the casing exists to avoid. The seed is the pair of ends rather than
     * `edge.id`, which is minted from a position in a list and moves when a list changes.
     */
    const d = ink(toPath(points), `${from.id}>${to.id}`);
    out.push(`<path class="pd-casing" d="${d}" />`);
    out.push(`<path class="pd-line" d="${d}"${head ? ` marker-end="url(#${arrow})"` : ''} />`);
    if (edge.fromCard || edge.toCard) {
      const size = font * LABEL_SIZE;
      const near = (p: Point, q: Point) => ({ x: p.x + (q.x - p.x) * 0.12, y: p.y + (q.y - p.y) * 0.12 - 6 });
      const first = near(points[0], points[1]);
      const last = near(points[points.length - 1], points[points.length - 2]);
      if (edge.fromCard) out.push(`<text class="pd-card pd-halo" x="${Math.round(first.x)}" y="${Math.round(first.y)}" font-size="${size}" text-anchor="middle">${esc(edge.fromCard)}</text>`);
      if (edge.toCard) out.push(`<text class="pd-card pd-halo" x="${Math.round(last.x)}" y="${Math.round(last.y)}" font-size="${size}" text-anchor="middle">${esc(edge.toCard)}</text>`);
    }
    const text = [edge.label, edge.technology && `[${edge.technology}]`].filter(Boolean).join(' ');
    if (text) {
      const size = font * LABEL_SIZE;
      const w = textWidth(text, size);
      const { at, lift } = labelPlace(points, w, size, obstacles, boxes);
      out.push(`<text class="pd-edge-label pd-halo" x="${Math.round(at.x)}" y="${Math.round(at.y + lift)}" font-size="${size}" text-anchor="middle">${esc(text)}</text>`);
      boxes.push({ id: edge.id, kind: 'label', form: 'label', x: at.x - w / 2, y: at.y + lift - size, w, h: size * 1.3, fontSize: size });
    }
    out.push('</g>');
  }

  for (const n of pieces) {
    const r = rect(n);
    const role = roleOf(skin, n.shape);
    const holds = groupOf(model, n);
    const attrs = [
      `class="pd-node pd-${role.tone}${n.emphasis ? ' pd-emphasis' : ''}"`,
      `data-id="${esc(n.id)}"`,
      n.ref ? `data-ref="${esc(n.ref)}"` : '',
      holds ? `data-inside="${esc(holds.id)}"` : '',
    ].filter(Boolean).join(' ');
    out.push(`<g ${attrs}>`);
    out.push(inkShape(outline(role.form, r.x, r.y, r.w, r.h), n.id));
    // The pack is named in the model (`pd:module`, `logos:aws-lambda`); the renderer looks up the name.
    const named = n.icon ?? role.icon;
    const art = named ? opts.icons?.[named.replace(/^[a-z-]+:/, '')] : undefined;
    if (art) {
      const scale = ICON / (art.width ?? 24);
      out.push(`<g class="pd-icon" transform="translate(${r.x + 11} ${r.y + 9}) scale(${scale.toFixed(3)})">${art.body}</g>`);
    }
    /*
     * An entity is a table and not a box with a sentence in it: its name sits on a bar of
     * its own and its fields are listed underneath, in the order they were written, because
     * that order is what a reader of a data model is looking for.
     */
    if (role.form === 'entity' || role.form === 'class') {
      out.push(`<text class="pd-name pd-oncolor" x="${r.x + r.w / 2}" y="${r.y + 21}" font-size="${font}" text-anchor="middle">${esc(n.name.toUpperCase())}</text>`);
      /*
       * Two columns, not one prose run. A field is a name and a type, and written as one
       * string the eye has to parse every line to find the name it came for; the key marker
       * that ends the line is the thing a reader of a data model is actually scanning for.
       */
      (n.attributes ?? []).slice(0, 12).forEach((attribute, i) => {
        const y = r.y + 48 + i * font * 1.2;
        const parts = attribute.trim().split(/\s+/);
        const key = parts.length > 2 && /^(PK|FK|UK)$/i.test(parts[parts.length - 1]) ? parts.pop()! : '';
        const type = parts.length > 1 ? parts.shift()! : '';
        const name = parts.join(' ');
        out.push(`<text class="pd-field" x="${r.x + 12}" y="${y}" font-size="${font * SUB_SIZE}">${esc(name)}</text>`);
        const right = [type, key].filter(Boolean).join(' ');
        if (right) out.push(`<text class="pd-type" x="${r.x + r.w - 12}" y="${y}" font-size="${font * LABEL_SIZE}" text-anchor="end">${esc(right)}</text>`);
      });
      out.push('</g>');
      boxes.push({ id: n.id, kind: 'node', form: role.form, ...r, fontSize: font * SUB_SIZE });
      continue;
    }
    if (role.form === 'terminal') {
      out.push('</g>');
      boxes.push({ id: n.id, kind: 'node', form: role.form, ...r, fontSize: font });
      continue;
    }
    // A diamond's writing has to stay inside the slanted sides, not inside its bounding box.
    const room = roomIn(role.form, r.w);
    /*
     * A name that is one long unbreakable token gets set smaller rather than hung outside
     * the piece. The piece has already grown as wide as it is allowed to; this is what
     * happens past that, and it stops at the size of a label — below that the drawing would
     * be trading one unreadable thing for another, and the composition pass says so instead.
     */
    const longest = Math.max(0, ...n.name.replace(/<br\s*\/?>/gi, ' ').split(/\s+/).filter(Boolean)
      .map((word) => textWidth(word, font * TITLE_SIZE, ADVANCE.name)));
    const nameSize = longest > room
      ? Math.max(font * LABEL_SIZE, font * TITLE_SIZE * (room / longest))
      : font * TITLE_SIZE;
    const lines = wrap(n.name, room, nameSize, ADVANCE.name);
    const tech = role.technology && n.technology ? n.technology.toUpperCase() : '';
    const descLines = n.description ? wrap(n.description, room, font * SUB_SIZE, ADVANCE.body).slice(0, 3) : [];
    const all = lines.length + (tech ? wrap(tech, room, font * LABEL_SIZE, ADVANCE.caps).length : 0) + descLines.length;
    // A person's head and shoulders take the top of the box, so the writing is centred in
    // the body below them — the same 0.52 the silhouette is drawn at, or the name floats in
    // the empty air beside the head.
    const crown = role.form === 'person' ? r.h * PERSON_CROWN : 0;
    let y = r.y + crown + (r.h - crown) / 2 - (all - 1) * font * 0.62;
    for (const line of lines) {
      out.push(`<text class="pd-name" x="${r.x + r.w / 2}" y="${y}" font-size="${nameSize.toFixed(2)}" text-anchor="middle">${esc(line)}</text>`);
      y += nameSize * 1.2;
    }
    // A little more air under the name than between the lines that follow it, so the name
    // and its detail read as one block. It used to be the other way round.
    const techLines = tech ? wrap(tech, room, font * LABEL_SIZE, ADVANCE.caps) : [];
    if (techLines.length) y += 3;
    for (const line of techLines) {
      out.push(`<text class="pd-tech" x="${r.x + r.w / 2}" y="${y}" font-size="${font * LABEL_SIZE}" text-anchor="middle">${esc(line)}</text>`);
      y += font * LABEL_SIZE * 1.35;
    }
    for (const line of descLines) {
      out.push(`<text class="pd-sub" x="${r.x + r.w / 2}" y="${y}" font-size="${font * SUB_SIZE}" text-anchor="middle">${esc(line)}</text>`);
      y += font * SUB_SIZE * 1.35;
    }
    out.push('</g>');
    const wrote = {
      w: Math.max(
        0,
        ...lines.map((l) => textWidth(l, nameSize, ADVANCE.name)),
        ...techLines.map((l) => textWidth(l, font * LABEL_SIZE, ADVANCE.caps)),
        ...descLines.map((l) => textWidth(l, font * SUB_SIZE, ADVANCE.body)),
      ),
      // The block of writing, top to bottom: every line that was painted at its own advance.
      h: lines.length * nameSize * 1.2
        + (techLines.length ? 3 + techLines.length * font * LABEL_SIZE * 1.35 : 0)
        + descLines.length * font * SUB_SIZE * 1.35,
      room,
    };
    boxes.push({ id: n.id, kind: 'node', form: role.form, ...r, fontSize: font * SUB_SIZE, wrote });
  }

  /*
   * The frame holds everything that was drawn, not only the pieces: a label that dodged to
   * one side and an arrow that took a channel around a box both sit outside the boxes, and
   * a viewBox measured on the boxes alone would cut them off with no error anywhere.
   */
  const all = [
    ...boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
    ...lines.flatMap((l) => l.points.map((pt) => ({ x: pt.x, y: pt.y, w: 0, h: 0 }))),
  ];
  const minX = Math.min(...all.map((r) => r.x), 0) - pad;
  const minY = Math.min(...all.map((r) => r.y), 0) - pad - (model.title ? font * 2 : 0);
  const maxX = Math.max(...all.map((r) => r.x + r.w), 0) + pad;
  const maxY = Math.max(...all.map((r) => r.y + r.h), 0) + pad;
  const viewBox: [number, number, number, number] = [minX, minY, maxX - minX, maxY - minY];

  /*
   * The cartouche: the title, a hairline under it, and the sheet's own name set small and
   * tracked at the right end of that rule — DEPLOYMENT SHEET, DATA FLOW SHEET. That line is
   * the plainest possible answer to «which of these am I looking at», it is read before any
   * shape or colour, and it costs nothing: the renderer already knows the class.
   */
  const ruleY = minY + font * 2.5;
  const cartouche = [
    model.title
      ? `<text class="pd-title" x="${minX + pad}" y="${minY + font * 2}" font-size="${font * SIZE.TITLE}">${esc(model.title)}</text>`
      : '',
  ].filter(Boolean).join('\n');
  const neat = '';

  /*
   * `width` and `height` as well as the viewBox: an SVG with only a viewBox has no intrinsic
   * size, and inside an `<img>` — which is how the PNG export loads it — that is a known way
   * to get nothing at all outside Chrome.
   */
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" width="${Math.round(viewBox[2])}" height="${Math.round(viewBox[3])}"`
      + ` viewBox="${viewBox.join(' ')}" class="pd-diagram ${scopeOf(reg)} pd-${esc(model.kind)}">`,
    `<title>${esc(model.title || opts.name || model.kind)}</title>`,
    styleBlock(reg, opts.fontSrc),
    /*
     * The ground, painted and not left to whoever opens the file. An exported SVG and a
     * captured one are looked at on their own, and on a dark page a transparent drawing is
     * dark ink on black. There is one theme here, and this is it.
     */
    `<rect class="pd-ground" x="${viewBox[0]}" y="${viewBox[1]}" width="${viewBox[2]}" height="${viewBox[3]}" />`,
    /*
     * The arrowhead is decoupled from the stroke: in the default `strokeWidth` units it grew
     * and shrank with the line weight, so a heavier route grew a blunter head. Swallow-tailed
     * rather than an equilateral blob, which is the survey convention and reads as a
     * direction rather than as a dot at this size.
     */
    `<defs>`
      + `<marker id="${esc(arrow)}" viewBox="0 0 10 8" refX="9.2" refY="4" markerWidth="10" markerHeight="8"`
      + ' markerUnits="userSpaceOnUse" orient="auto-start-reverse">'
      + '<path class="pd-head" d="M0 0 L9.6 4 L0 8 L1.6 4 Z" /></marker>'
      + `<pattern id="${esc(hatch)}" width="${reg.pitch}" height="${reg.pitch}" patternUnits="userSpaceOnUse">`
      + `${hatchTile(reg)}</pattern>`
      + '</defs>',
    /*
     * No graticule. It was ruled paper at a 40px tile, and it was there to say «this is a
     * sheet somebody drew on» — but the drawing says that now, in its own hand, and a grid
     * under a hand-drawn diagram reads as squared paper from a maths exercise book. What a
     * piece sits on is still the same forty-pixel stride; it is simply not printed.
     */
    neat,
    cartouche,
    ...out,
    '</svg>',
  ].filter(Boolean).join('\n');

  return { svg, viewBox, boxes, lines };
}

/** Whether the class of this model is one the box renderer knows how to draw. */
export function paintsBoxes(model: DiagramModel, skin?: DiagramSkin): boolean {
  if (!skin) return false;
  return model.nodes.every((n) => skin.roles.some((r: SkinRole) => r.shape === n.shape));
}

/** Everything a boundary holds, for the composition pass and for the viewer's dimming. */
export const inside = (model: DiagramModel, boundary: DiagramNode): DiagramNode[] => childrenOf(model, boundary);
export const holder = (model: DiagramModel, node: DiagramNode): DiagramNode | undefined => groupOf(model, node);

export type { DiagramEdge };
