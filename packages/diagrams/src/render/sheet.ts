/**
 * The sheet: the one place any colour, size or weight in a drawing is written.
 *
 * A drawing of this engine is a map sheet, not a slide. That is a decision with a reason.
 * The palette before it was the C4 blue at eight lightnesses, so a data flow, a network, a
 * deployment and a container diagram came out as the same blue boxes, and the only thing
 * that told them apart was the title — which is exactly the thing a reader does not read.
 * A map answers that differently: the sheet says what it is in its own margin, the ground
 * is ruled the way that kind of ground is ruled, and colour belongs to what a thing *is*
 * rather than to how deep it sits in a hierarchy.
 *
 * And every value here is the app's own. The first draft of this sheet was warm — cream
 * paper, ochre, terracotta — which read as a warm rectangle pasted onto a cool interface,
 * and the owner said so. So the ground is `--surface`, the ruling is `--line`, the furniture
 * is `--line-2`, a title is `--ink`, and a tone takes the semantic pair the product already
 * uses for that meaning: `--ok` for something running, `--err` for a controlled crossing,
 * `--accent` for the subject of the sheet. Where the app has no token for a meaning — a
 * person, a store, a component — the value is mixed from the ones it does have rather than
 * invented, because the whole argument for cohesion is that the numbers come from one file.
 *
 * So there are two axes here and they are independent:
 *
 *   - the TONE of a piece — what it is on the ground (a store, a gate, a person). The skin
 *     of a class names it; this file gives it ink. Eleven tones across eight hues, because
 *     six lightnesses of one hue is not a vocabulary.
 *   - the REGISTER of a sheet — which family of question the drawing answers. It colours
 *     the routes and rules the ground, and it is derived from `model.kind`, never declared.
 *
 * Both renderers read this file, which is the other half of the reason it exists: boxes and
 * sequences each carried their own hand-copied stylesheet, with the same hexes typed twice
 * and drifting — a note was the only warm colour in the product and lived in neither palette.
 *
 * Everything is written INTO the SVG. An export leaves through a `data:` URI where no
 * external stylesheet, font or asset resolves, so a drawing styled from outside came out as
 * black rectangles in every PNG while looking right on screen.
 */
import type { DiagramKind } from '../kinds.ts';

/** What a piece is on the ground. The skin names one of these; only this file knows its ink. */
export interface Tone {
  /** The flat tint the piece is filled with: light, so the ink on it can be dark. */
  fill: string;
  /** Its keyline — a much darker relative of the same tint. */
  stroke: string;
  /** What is written on it. Every pair here clears 10:1. */
  ink: string;
  /**
   * The solid mark that types the piece at a glance: the band down the left edge of a box,
   * the header of an entity. At small sizes the tint is nearly paper, and this is what is
   * still visible.
   */
  band: string;
}

/**
 * The tones, and the whole argument for the redesign in one table.
 *
 * Eight hues, not one. A component stops being a lighter database, a person stops being a
 * darker system, and a decision is the only red on any sheet. The contrast figure after
 * each is ink on fill, measured, and the floor across the table is 10.4:1 — the old palette
 * put white on `#85bbf0` at 2.1:1 and called it a component.
 */
export const TONES: Record<string, Tone> = {
  /** The territory this sheet is about: the own system, the start of a process. The app's accent. */
  subject: { fill: '#1b2a4a', stroke: '#4c82ff', ink: '#dbe6ff', band: '#4c82ff' },
  /** A human or a team. The only violet, so a person is never read as a service. */
  actor: { fill: '#2a2144', stroke: '#a98bf0', ink: '#ece3ff', band: '#a98bf0' },
  /** Beyond our neatline. Told apart by a broken keyline, not by its hue. */
  external: { fill: '#1e2025', stroke: '#80838b', ink: '#c1c4cb', band: '#80838b' },
  /** Something deployed and running: a container, a service, a host. The app's «ok» green. */
  runtime: { fill: '#16301f', stroke: '#2bb66b', ink: '#d4f5e1', band: '#2bb66b' },
  /** A piece inside something bigger: a component, a package, a class. */
  part: { fill: '#232850', stroke: '#a9b4ff', ink: '#e3e7ff', band: '#a9b4ff' },
  /** Data at rest: a database, a bucket, an entity. */
  store: { fill: '#0f2f35', stroke: '#6fdbe8', ink: '#d5f6fa', band: '#4fc4d3' },
  /** Something data travels through: a queue, a broker, a bus. The road colour. */
  channel: { fill: '#3a2a0f', stroke: '#f5a524', ink: '#ffe9c2', band: '#f5a524' },
  /** A unit of work done in order. The quiet majority, and the default for an unskinned shape. */
  step: { fill: '#262a31', stroke: '#80838b', ink: '#ebedef', band: '#80838b' },
  /** A controlled crossing: a decision, a gateway, a firewall. The only red. */
  gate: { fill: '#3a1c1f', stroke: '#ec5b60', ink: '#ffd5d7', band: '#ec5b60' },
  /** A grouping that means nothing of its own — a lane, a «these go together». No tint. */
  frame: { fill: 'none', stroke: '#4a4e57', ink: '#c1c4cb', band: '#80838b' },
  /** A territory that means something: a trust zone, a VPC, an environment, a C4 boundary. */
  zone: { fill: '#1b1e24', stroke: '#4a5360', ink: '#c1c4cb', band: '#4a5360' },
};

export type ToneName = keyof typeof TONES;

/** The ground of every sheet: the app's own surface, so a drawing sits in the interface and not on a page pasted onto it. */
export const PAPER = '#16181D';
/** The graticule ruled on it: texture at 1.16:1, which is under the threshold of content. */
export const GRATICULE = '#23262C';
/** The furniture — neatline, corner ticks, the rule under the title. */
export const FURNITURE = '#3A3E46';
/** What a title is written in. */
export const TITLE_INK = '#EBEDEF';

/**
 * How a sheet of this family is ruled, and what colour its roads are.
 *
 * `hatch` is the rhythm of the region texture, drawn by `hatchTile` below. The angles are
 * chosen to be told apart at a glance and never to collide: business leans one way,
 * infrastructure the other, data is ruled flat like water, application is cross-hatched
 * like built-up ground.
 */
export interface Register {
  /** Which family this is, which is also what scopes its stylesheet. */
  name: string;
  /** The colour of every route on this sheet, and of its sheet label. */
  route: string;
  hatch: 'lean' | 'lean-dashed' | 'flat' | 'cross' | 'stipple' | 'lean-back';
  /** The side of the hatch tile, in user units. */
  pitch: number;
}

export const REGISTERS: Record<string, Register> = {
  business: { name: 'business', route: '#F5A524', hatch: 'lean', pitch: 8 },
  process: { name: 'process', route: '#C1C4CB', hatch: 'lean-dashed', pitch: 8 },
  data: { name: 'data', route: '#6FDBE8', hatch: 'flat', pitch: 6 },
  application: { name: 'application', route: '#7CB0FF', hatch: 'cross', pitch: 10 },
  technology: { name: 'technology', route: '#A9B4FF', hatch: 'stipple', pitch: 8 },
  infrastructure: { name: 'infrastructure', route: '#5FD393', hatch: 'lean-back', pitch: 7 },
};

export type RegisterName = keyof typeof REGISTERS;

/**
 * Which family a class belongs to. The same six layers the catalogue is organised by, so a
 * reader who knows the menu already knows the sheets.
 */
const REGISTER_OF: Partial<Record<DiagramKind, RegisterName>> = {
  'domain-map': 'business',
  'value-stream': 'business',
  capabilities: 'business',
  'process-landscape': 'process',
  process: 'process',
  sequence: 'process',
  state: 'process',
  lifecycle: 'process',
  'data-landscape': 'data',
  'data-model': 'data',
  'data-flow': 'data',
  'data-lineage': 'data',
  'application-landscape': 'application',
  'c4-landscape': 'application',
  'c4-context': 'application',
  'c4-container': 'application',
  'c4-component': 'application',
  'c4-code': 'application',
  integration: 'application',
  dependency: 'application',
  packages: 'application',
  roadmap: 'application',
  versioning: 'application',
  'stack-map': 'technology',
  deployment: 'infrastructure',
  'environment-map': 'infrastructure',
  network: 'infrastructure',
};

export function registerOf(kind: string): Register {
  return REGISTERS[REGISTER_OF[kind as DiagramKind] ?? 'application'];
}

/** What the margin of the sheet calls it: «DATA FLOW SHEET», from the class and nothing else. */
export function sheetLabel(kind: string): string {
  return `${kind.replace(/-/g, ' ')} sheet`.toUpperCase();
}

/**
 * The tile a region is textured with, as the body of a `<pattern>`.
 *
 * Written with literal attributes rather than classes on purpose: the pattern lives in
 * `<defs>`, which is a sibling of the groups that use it and not an ancestor, so a rule
 * like `.pd-zone .pd-hatch-line` matches nothing at all — silently, with the texture simply
 * absent. The colour is the register's route at low opacity, so the texture belongs to the
 * sheet without competing with what stands on it.
 */
export function hatchTile(reg: Register): string {
  const p = reg.pitch;
  const line = (d: string, dash = '') =>
    `<path d="${d}" stroke="${reg.route}" stroke-width="1" fill="none" opacity="0.07"${dash} />`;
  switch (reg.hatch) {
    case 'lean':
      return line(`M0 ${p} L${p} 0`);
    case 'lean-dashed':
      return line(`M0 ${p} L${p} 0`, ' stroke-dasharray="4 4"');
    case 'lean-back':
      return line(`M0 0 L${p} ${p}`);
    case 'flat':
      return line(`M0 ${p / 2} H${p}`);
    case 'cross':
      return line(`M0 ${p} L${p} 0`) + line(`M0 0 L${p} ${p}`);
    case 'stipple':
      return `<circle cx="${p / 2}" cy="${p / 2}" r="0.8" fill="${reg.route}" opacity="0.1" />`;
  }
}

/**
 * The face the width estimate in `text.ts` was calibrated against, so an export measures the
 * same text the estimate sized the boxes for.
 *
 * Excalifont is the hand Excalidraw writes in — SIL Open Font License 1.1, vendored with its
 * licence in `packages/diagrams/fonts/`. The fallbacks matter: a drawing opened where the
 * face never loaded still has to be readable, and a generic `cursive` is whatever that
 * machine decided cursive means. So the stack lands on the interface face instead, which is
 * what every box in this catalogue was measured against until today and is within three
 * hundredths of Excalifont on every style but one.
 */
export const FONT = "'Inter', ui-sans-serif, system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif";

/**
 * The type scale, as multiples of the base size.
 *
 * Three of these are load-bearing and marked so: they are the sizes the renderer reports
 * into `Rendered.boxes`, which is what the composition pass takes the minimum of before
 * projecting it onto the reader's column against a six pixel floor. Moving one moves the
 * width a drawing is allowed to reach, and forty-two real drawings sit within five percent
 * of that ceiling.
 *
 * Nothing here goes below `LABEL`. Differentiation is done with weight, tracking and case,
 * which cost no legibility — the earlier draft of this scale had three sizes under it and
 * defended them on the grounds that the composition pass does not measure them, which is an
 * argument about the validator rather than about whether a person can read the drawing.
 */
export const SIZE = {
  /** The title in the cartouche. */
  TITLE: 1.6,
  /** A piece's name. FROZEN: `model.ts` sizes the box from it. */
  NAME: 1.15,
  /** A description under the name. FROZEN: reported into `boxes`. */
  SUB: 0.78,
  /** An edge label, a boundary label, a technology line, a cardinality. FROZEN: the floor. */
  LABEL: 0.72,
} as const;

/**
 * The stylesheet a drawing carries with it, for both families.
 *
 * `route` is the sheet's register colour, threaded in rather than left to a class, because
 * the roads, the arrowheads and the edge labels all have to agree and there is exactly one
 * of them per drawing.
 */
export function styleBlock(reg: Register, fontSrc?: string): string {
  /*
   * Every rule is scoped to the sheet's own register, and that is not tidiness.
   *
   * A drawing carries its stylesheet inside itself, and an SVG's `<style>` applies to the
   * WHOLE document it lands in, not to the SVG that holds it. An architecture page shows
   * four drawings; before this, the last one parsed repainted the other three, so a process
   * sheet came out with the routes of a container sheet — silently, because every class used
   * to share one palette and there was nothing left to disagree about.
   *
   * Scoping by register rather than by a per-drawing id keeps the bytes deterministic: two
   * process sheets emit the same stylesheet, which is what lets a snapshot mean something.
   */
  const at = `.pd-reg-${reg.name}`;
  const route = reg.route;
  /*
   * A tone's fill reaches PIECES, and `.pd-node` in the selector is what says so.
   *
   * Without it the rule was `.pd-zone > rect`, which also matched the keyline of a region —
   * a rect whose whole job is to be `fill: none` — and beat that rule on specificity. The
   * keyline is drawn after the ground it encloses, so a boundary quietly filled itself with
   * its own tint and painted over the texture underneath. Nothing was missing from the
   * markup, the ground layer simply never showed.
   */
  const tones = Object.entries(TONES).map(([tone, c]) => [
    `${at} .pd-node.pd-${tone} > rect, ${at} .pd-node.pd-${tone} > path, ${at} .pd-node.pd-${tone} > circle, ${at} .pd-node.pd-${tone} > ellipse { fill: ${c.fill}; stroke: ${c.stroke}; }`,
    `${at} .pd-${tone} text { fill: ${c.ink}; }`,
    `${at} .pd-${tone} .pd-icon { color: ${c.ink}; }`,
    /*
     * These four have to match the generic rule above for specificity and come after it.
     * They are the marks that are deliberately NOT the tint — the band, the index, the
     * ground and the keyline — and a rule of the form `.pd-zone > rect` outranks any plain
     * `.pd-band`, so each of them was silently repainted with the fill it exists to differ
     * from. Three separate symptoms, one cause: the band went flat, the keyline filled
     * itself in and hid the texture under it.
     */
    `${at} .pd-node.pd-${tone} > .pd-index, ${at} .pd-node.pd-${tone} > .pd-band { fill: ${c.band}; stroke: none; }`,
    `${at} .pd-boundary.pd-${tone} .pd-region { fill: ${c.fill}; stroke: none; }`,
    `${at} .pd-boundary.pd-${tone} > .pd-neat { fill: none; stroke: ${c.stroke}; }`,
    // What is written ON one of those solid marks, which is the one place ink is not the ink.
    `${at} .pd-${tone} .pd-oncolor { fill: #0F1216; }`,
  ].join('\n')).join('\n');
  const rules: Array<[string, string]> = [
    ['&', `font-family: ${FONT}`],
    ['.pd-icon', 'pointer-events: none'],
    ['.pd-ground', `fill: ${PAPER}; stroke: none`],
    // No `fill` here: a declaration beats the `fill="url(#…)"` attribute that carries the
    // pattern, and the ruling vanished with nothing to show for it.

    // A piece: one keyline weight, softened at the corners. The rounded join at 1.75px is
    // the cheapest tell there is that somebody drew this rather than generated it.
    ['.pd-node > rect, & .pd-node > path, & .pd-node > circle, & .pd-node > ellipse', 'stroke-width: 1.75; stroke-linejoin: round'],
    ['.pd-node > .pd-index, & .pd-node > .pd-band', 'stroke: none'],
    ['.pd-lid', 'fill: none; stroke-width: 1.2; opacity: 0.55'],
    ['.pd-external > rect, & .pd-external > path', 'stroke-dasharray: 5 3'],
    ['.pd-emphasis > rect, & .pd-emphasis > path, & .pd-emphasis > circle', `stroke: ${TITLE_INK}; stroke-width: 2.75`],

    // A region is ground: a flat tint, the register's texture over it, then the keyline.
    // A frame is not a territory and gets none of it — only a broken rule saying «together».
    ['.pd-region, & .pd-hatch', 'stroke: none'],
    ['.pd-neat', 'fill: none; stroke-width: 1.2'],
    ['.pd-frame > .pd-neat', 'stroke-dasharray: 5 4'],

    // Routes, with casings. The paper under the line is what makes one route crossing
    // another readable without a bridge symbol, and what lifts the line work off the
    // keylines — at the same weight and the same darkness they read as one flat wire mesh.
    ['.pd-casing', `fill: none; stroke: ${PAPER}; stroke-width: 4.5; stroke-linecap: round; stroke-linejoin: round`],
    ['.pd-line', `fill: none; stroke: ${route}; stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round`],
    ['.pd-primary .pd-casing', 'stroke-width: 6.5'],
    ['.pd-primary .pd-line', 'stroke-width: 2.75'],
    ['.pd-dashed .pd-line', 'stroke-dasharray: 7 5'],
    ['.pd-head', `fill: ${route}`],

    // Anything that crosses line work is knocked out of it. `paint-order` is a presentation
    // property of the same document, so it survives the `data:` URI an export goes through.
    ['.pd-halo', `paint-order: stroke fill; stroke: ${PAPER}; stroke-width: 3.5; stroke-linejoin: round`],

    ['.pd-edge-label', `fill: ${route}; font-weight: 600; letter-spacing: 0.015em`],
    ['.pd-boundary-label', 'font-weight: 600; letter-spacing: 0.12em'],
    ['.pd-card', 'fill: #9FB7E8; font-weight: 600; letter-spacing: 0.08em'],

    // The name of a piece, at last with a weight of its own: it rendered at 400 because no
    // rule named it in either stylesheet.
    ['.pd-name', 'font-weight: 600; letter-spacing: 0.005em'],
    ['.pd-tech', 'font-weight: 600; letter-spacing: 0.06em; opacity: 0.72'],
    ['.pd-sub', 'opacity: 0.78'],
    ['.pd-field', 'opacity: 0.88'],
    ['.pd-type', 'font-weight: 600; letter-spacing: 0.04em; opacity: 0.62'],

    ['.pd-title', `fill: ${TITLE_INK}; font-weight: 600; letter-spacing: 0.005em`],
    ['.pd-sheet', `fill: ${route}; font-weight: 600; letter-spacing: 0.14em`],
    ['.pd-furniture', `fill: none; stroke: ${FURNITURE}; stroke-width: 1.2`],
  ];
  /*
   * The face, when the drawing has to carry it. A capture opened on its own resolves no
   * external CSS, so either the file travels with it or the picture is not the one the
   * reader sees. An `@font-face` is not scoped to a register and must not be: a face is a
   * document-level thing, and declaring the same one twice is free.
   */
  const face = fontSrc
    ? `@font-face { font-family: 'Excalifont'; src: url('${fontSrc}') format('woff2'); font-weight: 400 700; font-display: block; }\n`
    : '';
  return [
    '<style>',
    face,
    ...rules.map(([sel, body]) => `${sel === '&' ? at : `${at} ${sel}`.replace(/&/g, at)} { ${body}; }`),
    tones,
    '</style>',
  ].join('\n');
}

/** The class that scopes a drawing's own stylesheet to itself. */
export const scopeOf = (reg: Register): string => `pd-reg-${reg.name}`;
