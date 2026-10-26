/**
 * The visual model of a diagram: pieces with a position, links between them and the
 * round trip to the Mermaid the standard demands.
 *
 * There is no React and no DOM here on purpose: the editor drags boxes around, but what
 * decides which code comes out — and whether that code meets the standard — is this
 * file, which runs the same in a browser, in a test and in the CLI. The rules of the
 * standard live in `packages/core/src/diagrams.ts`; this package cannot import the core,
 * so its checks are replicated below (`CHECKS`) and the text of each rule arrives in the
 * `StandardFacts` it is handed.
 */
import type { DiagramKind, DiagramSkin, SkinRole, StandardFacts, StandardFacts as DiagramStandard } from './kinds.ts';

export type { DiagramKind } from './kinds.ts';
import { ADVANCE, textWidth, wrap } from './render/text.ts';
import { DIAGRAM_KINDS, SKINS } from './kinds.ts';
export { DIAGRAM_KINDS } from './kinds.ts';

/* ---------------------------------------------------------------------------------- */
/* Families: what can be built by dragging boxes and what cannot                        */
/* ---------------------------------------------------------------------------------- */

/** How each class is drawn and read back. `text` = text editing only. */
export type DiagramFamily = 'c4' | 'flow' | 'state' | 'er' | 'text';

export const FAMILY: Record<DiagramKind, DiagramFamily> = {
  'domain-map': 'flow', 'value-stream': 'flow',
  'process-landscape': 'flow', process: 'flow',
  sequence: 'text', // the order of the messages is not a position on a canvas
  state: 'state',
  'data-landscape': 'flow', 'data-model': 'er', 'data-flow': 'flow', 'data-lineage': 'flow',
  'application-landscape': 'flow',
  'c4-landscape': 'c4', 'c4-context': 'c4', 'c4-container': 'c4', 'c4-component': 'c4',
  'c4-code': 'c4', // a class box with its band and its fields, placed like every other level
  integration: 'flow', dependency: 'flow', packages: 'flow',
  // A roadmap is boxes on a canvas after all — the calendar is what decides their x, which
  // is a placement like any other. It is the one class whose positions must not be proposed.
  roadmap: 'flow',
  lifecycle: 'flow', versioning: 'text', // gitGraph: a history of commits, not a graph
  capabilities: 'flow',
  // quadrantChart: points on two axes
  'stack-map': 'flow',
  deployment: 'flow', 'environment-map': 'flow', network: 'flow',
};

/** Why a class cannot be built by dragging pieces. */
export const NOT_VISUAL_REASON: Record<string, string> = {
  sequence: 'sequenceDiagram',
  versioning: 'gitGraph',
};

export const isVisual = (kind: DiagramKind): boolean => FAMILY[kind] !== 'text';

/** The dialect of each class, duplicated from the core so we can generate without asking. */
export const DIALECT_OF: Record<DiagramKind, string> = {
  'domain-map': 'flowchart', 'value-stream': 'flowchart',
  'process-landscape': 'flowchart', process: 'flowchart', sequence: 'sequenceDiagram', state: 'stateDiagram-v2',
  'data-landscape': 'flowchart', 'data-model': 'erDiagram', 'data-flow': 'flowchart', 'data-lineage': 'flowchart',
  'application-landscape': 'flowchart',
  'c4-landscape': 'C4Context', 'c4-context': 'C4Context', 'c4-container': 'C4Container', 'c4-component': 'C4Component', 'c4-code': 'classDiagram',
  integration: 'flowchart', dependency: 'flowchart', packages: 'flowchart',
  roadmap: 'gantt', lifecycle: 'flowchart', versioning: 'gitGraph', capabilities: 'flowchart',
  'stack-map': 'flowchart',
  deployment: 'flowchart', 'environment-map': 'flowchart', network: 'flowchart',
};

/**
 * Dialects that accept `title` as a keyword. In the rest it goes in the frontmatter
 * `--- title: … ---`, which is how Mermaid titles a `flowchart`: written as a keyword it
 * does not compile. The standard accepts both forms.
 */
const TITLE_KEYWORD = new Set(['C4Context', 'C4Container', 'C4Component', 'sequenceDiagram', 'erDiagram', 'stateDiagram-v2']);

/* ---------------------------------------------------------------------------------- */
/* The model                                                                            */
/* ---------------------------------------------------------------------------------- */

/** An editable field of a piece. */
export type NodeField = 'name' | 'technology' | 'description' | 'attributes' | 'icon';

export interface DiagramNode {
  id: string;
  /** The shape from the standard: `Container`, `ContainerDb`, `rect`, `diamond`, `entity`… */
  shape: string;
  name: string;
  technology?: string;
  description?: string;
  /** Fields of a data-model entity: `uuid id PK`. */
  attributes?: string[];
  /** Iconify name of an icon node (`logos:kubernetes`). */
  icon?: string;
  /** The one the reader was pointed at, drawn heavier so the eye finds it. */
  emphasis?: boolean;
  /**
   * The frame this piece belongs to, when the source said so.
   *
   * Geometry is what decides membership once a drawing is placed — a box inside the frame
   * is inside it, whatever anybody wrote — but a drawing that has not been placed yet has
   * no geometry to read, and the layout has to know what goes where. It used to live in a
   * side table keyed by the model object, which a `structuredClone` and a trip through JSON
   * both threw away: every piece came out of its frame and the frame was drawn empty.
   */
  parent?: string;
  /**
   * The document this piece is, when it is one. A drawing whose boxes are documents is the
   * difference between a picture of the system and a way into it, and an id is exact where
   * matching a box by its name is a guess.
   */
  ref?: string;
  x: number; y: number;
  /** Boundaries and subgraphs only: how much they cover. Whatever falls inside is inside. */
  w?: number; h?: number;
}

export interface DiagramEdge {
  id: string;
  from: string; to: string;
  label?: string;
  technology?: string;
  /** Entity-relationship cardinalities (`||`, `}o`, `o{`…). */
  fromCard?: string; toCard?: string;
  /**
   * The way this arrow goes, when its author decided it — and only then.
   *
   * The router avoids the other boxes and looks for a lane of its own, which is more than any
   * author wants to redo by hand, so a plain drag does NOT write a route here: it moves the
   * piece and the router draws again. What does write one is pinning a corner in the editor,
   * which is a decision, and a decision nobody can recover from the positions alone.
   *
   * Written as absolute points, ends included. A derived class never carries one, for the same
   * reason it never carries positions.
   */
  points?: Array<{ x: number; y: number }>;
}

export type Direction = 'TD' | 'TB' | 'LR' | 'RL' | 'BT';

/**
 * A way through a drawing: the pieces that matter for one question, and why.
 *
 * A container diagram answers a dozen questions at once and a reader arrives with one of
 * them. A view names that question, lists the pieces that answer it, and the viewer fades
 * the rest — the same drawing, read one path at a time, instead of a second diagram that
 * says almost the same thing and goes stale on its own.
 */
export interface DiagramView {
  name: string;
  /** What this view is for, in one sentence. */
  note?: string;
  /** The pieces it keeps lit, by id. */
  ids: string[];
}

export interface DiagramModel {
  kind: DiagramKind;
  title: string;
  direction: Direction;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Ways through the drawing, each one a question and the pieces that answer it. */
  views?: DiagramView[];
  /** The `UpdateLayoutConfig(…)` the diagram came with, so rewriting it does not lose it. */
  layoutHint?: string;
  /** The `UpdateRelStyle(…)`/`UpdateElementStyle(…)`: they place labels, they do not restyle. */
  styleHints?: string[];
}

export const NODE_W = 190;
/** As wide as a piece may grow for a long name before the type is set smaller instead. */
export const NODE_W_MAX = 320;
export const NODE_H = 78;
export const GROUP_PAD = 26;

/**
 * How much room a piece takes on the canvas. Boundaries carry their own size.
 *
 * A box is as tall as what is written in it. It used to be 78 pixels whatever it said, and
 * a name that wrapped onto a second line pushed its technology and its description out
 * through the bottom edge — text on top of an arrow, on top of the next box, on top of
 * nothing. The renderer wraps with these same numbers, so both agree on the answer.
 */
export function sizeOf(n: DiagramNode): { w: number; h: number } {
  if (isGroupShape(n.shape)) return { w: n.w ?? 460, h: n.h ?? 300 };
  if (n.shape === 'entity') return { w: NODE_W + 30, h: NODE_H + 16 * Math.max(0, (n.attributes ?? []).length - 1) };
  if (n.shape === 'terminal') return { w: 96, h: 52 };
  const w = widthOf(n);
  /*
   * A diamond is only its full width across the middle and tapers to a point at top and
   * bottom, so writing that fills a box fills a diamond's corners with nothing and spills
   * out of its slanted sides. It gets the box its writing needs divided by the share of it
   * the silhouette actually offers.
   */
  const share = n.shape === 'diamond' ? 0.55 : n.shape === 'chevron' ? 0.8 : 1;
  return { w, h: Math.max(NODE_H, textHeight(n, roomIn(n.shape, w)) / share) };
}

/**
 * How wide a piece has to be for the longest thing written in it that cannot be broken.
 *
 * The width used to be 190 whatever the name said, and a name is very often one unbreakable
 * token — `AuthenticationServiceImpl.authenticate`, `GET /api/fraud-alerts/{id}`,
 * `user-management.component.ts`. No wrap can split those, so they simply hung out of both
 * sides of the box. Measured before this: 476 of 2936 pieces across ten catalogues, one in
 * six, and the composition pass had nothing to say about any of them.
 *
 * Capped, because a piece as wide as the screen is its own kind of unreadable: past the cap
 * the renderer sets that one name smaller, and past what even that can save, the composition
 * pass reports `text-outside-piece` and the name has to be shortened by whoever wrote it.
 */
export function widthOf(n: DiagramNode): number {
  const words = String(n.name ?? '').replace(/<br\s*\/?>/gi, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return NODE_W;
  const longest = Math.max(...words.map((w) => textWidth(w, TITLE_PX, ADVANCE.name)));
  /*
   * Asked of the silhouette, not of the bounding box: a diamond only offers about half its
   * width to writing, so the width it needs is not the width a rectangle would need. Getting
   * this wrong the other way round made decisions grow downwards instead of sideways — a
   * tall thin lozenge with four lines stacked in it, where a flowchart wants a wide flat one.
   */
  const needed = n.shape === 'diamond' ? longest / 0.54 : n.shape === 'chevron' ? longest + 56 : longest + 20;
  return Math.round(Math.min(NODE_W_MAX, Math.max(NODE_W, needed + 4)));
}

/** The font the renderer uses when nobody says otherwise, and the sizes derived from it. */
const FONT_PX = 15;
const TITLE_PX = FONT_PX * 1.15;
const SUB_PX = FONT_PX * 0.78;

/** How tall the writing inside a piece ends up being, wrapped the way the renderer wraps it. */
/**
 * How much of a piece's width the writing actually gets, by silhouette.
 *
 * The one number both sides have to agree on. The renderer wrapped a diamond's name into
 * 54% of its width and this function wrapped it into all of it minus twenty, so the height
 * was computed for fewer lines than got painted and the last one came out through the point
 * at the bottom.
 */
export function roomIn(shape: string, width: number): number {
  if (shape === 'diamond') return width * 0.54;
  if (shape === 'chevron') return width - 56;
  return width - 20;
}

function textHeight(n: DiagramNode, inner: number): number {
  const name = wrap(n.name, inner, TITLE_PX, ADVANCE.name).length;
  // Set in tracked capitals, which is half again as wide per character as the estimate for
  // a name — and it was never wrapped at all, so a long one ran out of the side of the box.
  const tech = n.technology ? wrap(n.technology.toUpperCase(), inner, SUB_PX, ADVANCE.caps).length : 0;
  const description = n.description ? Math.min(3, wrap(n.description, inner, SUB_PX, ADVANCE.body).length) : 0;
  // A person carries a head above its body and the writing goes below it.
  const crown = n.shape.startsWith('Person') ? 20 : 0;
  return 26 + crown + (n.icon ? 8 : 0) + name * TITLE_PX * 1.2 + (tech + description) * SUB_PX * 1.35;
}

/**
 * A model written the way it goes into a document: one piece per line.
 *
 * Indented JSON turns a twelve-node drawing into ninety lines of Markdown and a diff nobody
 * reads; one line per piece is a third of that and is what a person scans anyway. The same
 * formatter writes the templates of the standard, what the compiler migrates and what the
 * editor saves, so every typed block in a catalogue looks the same.
 */
export function writeModel(model: object): string {
  const fields = model as Record<string, unknown>;
  const rows = (key: string) => {
    const list = fields[key];
    if (!Array.isArray(list)) return undefined;
    return `"${key}": [\n${list.map((item) => `  ${JSON.stringify(item)}`).join(',\n')}\n]`;
  };
  const scalars = Object.entries(fields)
    .filter(([, v]) => !Array.isArray(v) && v !== undefined)
    .map(([k, v]) => `"${k}": ${JSON.stringify(v)}`);
  const lists = ['participants', 'rows', 'nodes', 'edges', 'views'].map(rows).filter(Boolean) as string[];
  return `{\n${[...scalars, ...lists].join(',\n')}\n}`;
}

export const isGroupShape = (shape: string) => shape === 'group' || shape.endsWith('_Boundary');

/**
 * The pieces a boundary holds.
 *
 * What the model says, when it says it: `parent` is the author's statement and it wins.
 * Only where nobody said anything does geometry decide — a hand-placed drawing with no
 * parents still reads as «this box is inside that frame», and it should.
 */
export function childrenOf(model: DiagramModel, group: DiagramNode): DiagramNode[] {
  const declared = model.nodes.filter((n) => n.parent === group.id && n.id !== group.id);
  if (declared.length > 0) return declared;
  const g = sizeOf(group);
  return model.nodes.filter((n) => {
    if (n.id === group.id || isGroupShape(n.shape) || n.parent) return false;
    const s = sizeOf(n);
    const cx = n.x + s.w / 2, cy = n.y + s.h / 2;
    return cx >= group.x && cx <= group.x + g.w && cy >= group.y && cy <= group.y + g.h;
  });
}

/** The boundary a piece sits in, if any. */
export function groupOf(model: DiagramModel, node: DiagramNode): DiagramNode | undefined {
  if (isGroupShape(node.shape)) return undefined;
  return model.nodes.filter(isGroup).find((g) => childrenOf(model, g).some((c) => c.id === node.id));
}
const isGroup = (n: DiagramNode) => isGroupShape(n.shape);

/* ---------------------------------------------------------------------------------- */
/* The shapes of each family                                                            */
/* ---------------------------------------------------------------------------------- */

export interface ShapeSpec { shape: string; family: DiagramFamily; fields: NodeField[]; group?: boolean }

const C4_SHAPES: Record<string, NodeField[]> = {
  Person: ['name', 'description'],
  Person_Ext: ['name', 'description'],
  System: ['name', 'description'],
  System_Ext: ['name', 'description'],
  SystemDb: ['name', 'description'],
  SystemQueue: ['name', 'description'],
  SystemDb_Ext: ['name', 'description'],
  SystemQueue_Ext: ['name', 'description'],
  Container: ['name', 'technology', 'description'],
  ContainerDb: ['name', 'technology', 'description'],
  ContainerQueue: ['name', 'technology', 'description'],
  Container_Ext: ['name', 'technology', 'description'],
  ContainerDb_Ext: ['name', 'technology', 'description'],
  ContainerQueue_Ext: ['name', 'technology', 'description'],
  Component: ['name', 'technology', 'description'],
  ComponentDb: ['name', 'technology', 'description'],
  ComponentQueue: ['name', 'technology', 'description'],
  Component_Ext: ['name', 'technology', 'description'],
  ComponentDb_Ext: ['name', 'technology', 'description'],
  Container_Boundary: ['name'],
  System_Boundary: ['name'],
  Enterprise_Boundary: ['name'],
};
/** How many arguments each C4 shape takes when written out. */
const c4Arity = (shape: string) => (isGroupShape(shape) ? 2 : (C4_SHAPES[shape] ?? []).includes('technology') ? 4 : 3);

const FLOW_SHAPES: Record<string, NodeField[]> = {
  rect: ['name'], stadium: ['name'], diamond: ['name'], cylinder: ['name'],
  round: ['name'], hexagon: ['name'], icon: ['name', 'icon'], group: ['name'],
};
/** How each `flowchart` shape is written. */
const FLOW_SYNTAX: Record<string, [string, string]> = {
  rect: ['["', '"]'], stadium: ['(["', '"])'], diamond: ['{"', '"}'], cylinder: ['[("', '")]'],
  round: ['("', '")'], hexagon: ['{{"', '"}}'],
};

export function shapeSpec(shape: string, family: DiagramFamily): ShapeSpec {
  if (family === 'c4') return { shape, family, fields: C4_SHAPES[shape] ?? ['name'], group: isGroupShape(shape) };
  if (family === 'flow') return { shape, family, fields: FLOW_SHAPES[shape] ?? ['name'], group: shape === 'group' };
  if (family === 'state') return { shape, family, fields: shape === 'terminal' ? [] : ['name', 'description'] };
  return { shape, family, fields: ['name', 'attributes'] };
}

/* ---------------------------------------------------------------------------------- */
/* The palette: it comes from the legend and the template of the standard               */
/* ---------------------------------------------------------------------------------- */

export interface PaletteItem { shape: string; label: string; hint: string; fields: NodeField[]; group: boolean }

/** "A decision: two paths come out of it" → "Decision". The short name of the piece. */
export function labelFromMeans(means: string): string {
  const first = means.split(/[:.]/)[0].trim();
  const withoutArticle = first.replace(/^(A|An|The|Each|Every|Un|Una|Unos|Unas|El|La|Los|Las|Cada)\s+/i, '');
  return withoutArticle ? withoutArticle.charAt(0).toUpperCase() + withoutArticle.slice(1) : first;
}

/** The `flowchart` shape a legend entry describes, recognised by its syntax. */
function flowShapeOfLegend(raw: string): string | undefined {
  const s = raw.replace(/`/g, '').trim();
  if (/^subgraph/.test(s)) return 'group';
  if (/@\{\s*icon/.test(s)) return 'icon';
  if (/^\[\(.*\)\]$/.test(s)) return 'cylinder';
  if (/^\(\[.*\]\)$/.test(s)) return 'stadium';
  if (/^\{\{.*\}\}$/.test(s)) return 'hexagon';
  if (/^\{.*\}$/.test(s)) return 'diamond';
  if (/^\[.*\]$/.test(s)) return 'rect';
  if (/^\(.*\)$/.test(s)) return 'round';
  return undefined;
}

/**
 * The pieces a diagram class offers. They are read from its legend — the legend is what
 * says what each shape means — and completed with the shapes its template uses, because
 * the template is the canonical example (level 2 draws people even though its legend
 * never names them). None of this is invented here.
 */
export function paletteFor(std: DiagramStandard, others?: Record<DiagramKind, DiagramStandard>): PaletteItem[] {
  const family = FAMILY[std.kind];
  if (family === 'text') return [];
  const out: PaletteItem[] = [];
  const push = (shape: string, hint: string, label?: string) => {
    if (out.some((p) => p.shape === shape)) return;
    const spec = shapeSpec(shape, family);
    out.push({ shape, label: label ?? labelFromMeans(hint || shape), hint, fields: spec.fields, group: !!spec.group });
  };

  if (family === 'c4') {
    for (const l of std.legend) {
      const shape = clean(l.shape);
      if (shape in C4_SHAPES) push(shape, l.means, shape);
    }
    // The template is the canonical example: level 2 draws people its legend never names.
    for (const m of std.template.matchAll(/^\s*(\w+)\s*\(/gm)) {
      const shape = m[1];
      if (shape in C4_SHAPES) push(shape, meansOf(shape, std, others), shape);
    }
    return out;
  }
  if (family === 'flow') {
    for (const l of std.legend) {
      const shape = flowShapeOfLegend(l.shape);
      if (shape) push(shape, l.means);
    }
    for (const shape of flowShapesInTemplate(std.template)) push(shape, meansOfFlowShape(shape, std, others));
    // The box is the base shape of a flowchart: when this class does not name it, its
    // meaning is borrowed from the class that does (the process standard).
    push('rect', meansOfFlowShape('rect', std, others));
    return out;
  }
  if (family === 'state') {
    const transition = std.legend.find((l) => clean(l.shape) === '-->');
    push('state', transition ? 'A state in the life cycle.' : 'A state.');
    const terminal = std.legend.find((l) => l.shape.includes('[*]'));
    push('terminal', terminal?.means ?? 'Start and end state.', '[*]');
    return out;
  }
  const keys = std.legend.find((l) => /PK/.test(l.shape));
  push('entity', keys?.means ?? 'An entity with its fields and its keys.', 'Entity');
  return out;
}

const clean = (shape: string) => shape.replace(/`/g, '').trim();

/** What a class says a shape means; when it does not name it, what another class says. */
function meansOf(shape: string, std: DiagramStandard, others?: Record<DiagramKind, DiagramStandard>): string {
  const lookup = (s: DiagramStandard) => s.legend.find((l) => clean(l.shape) === shape)?.means;
  return lookup(std) ?? Object.values(others ?? {}).map(lookup).find(Boolean) ?? '';
}

/** The same, but matching on the syntax the legend uses to write each flowchart shape. */
function meansOfFlowShape(shape: string, std: DiagramStandard, others?: Record<DiagramKind, DiagramStandard>): string {
  const lookup = (s: DiagramStandard) => s.legend.find((l) => flowShapeOfLegend(l.shape) === shape)?.means;
  return lookup(std) ?? Object.values(others ?? {}).map(lookup).find(Boolean) ?? shape;
}

/** The `flowchart` shapes present in a piece of code, in order of appearance. */
function flowShapesInTemplate(code: string): string[] {
  const out: string[] = [];
  const add = (s: string) => { if (!out.includes(s)) out.push(s); };
  for (const line of code.split('\n')) {
    if (/^\s*subgraph\b/.test(line)) add('group');
    if (/@\{\s*icon/.test(line)) add('icon');
    if (/\(\[[^\]]*\]\)/.test(line)) add('stadium');
    if (/\[\([^)]*\)\]/.test(line)) add('cylinder');
    if (/\{\{[^}]*\}\}/.test(line)) add('hexagon');
    else if (/\w\{[^}]*\}/.test(line) && !/@\{/.test(line)) add('diamond');
    if (/\w\[[^[(]/.test(line)) add('rect');
  }
  return out;
}

/* ---------------------------------------------------------------------------------- */
/* Creating and changing                                                                */
/* ---------------------------------------------------------------------------------- */

const ASCII = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
/** A Mermaid-safe identifier built from a name. */
export function slug(name: string, fallback = 'n'): string {
  const s = ASCII(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(s) ? s.slice(0, 28) : `${fallback}${s ? `_${s.slice(0, 24)}` : ''}`;
}
export function uniqueId(model: DiagramModel, base: string): string {
  const used = new Set(model.nodes.map((n) => n.id));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

export function emptyModel(kind: DiagramKind, title = ''): DiagramModel {
  return { kind, title, direction: kind === 'packages' || kind === 'deployment' || kind === 'capabilities' ? 'TB' : 'TD', nodes: [], edges: [] };
}

/** Adds a palette piece at a position on the canvas. */
export function addNode(model: DiagramModel, item: PaletteItem, x: number, y: number, name: string): DiagramModel {
  const id = uniqueId(model, slug(name || item.label));
  const node: DiagramNode = { id, shape: item.shape, name, x: Math.round(x), y: Math.round(y) };
  if (item.group) { node.w = 460; node.h = 300; }
  if (item.shape === 'entity') node.attributes = ['uuid id PK'];
  if (item.shape === 'icon') node.icon = 'logos:kubernetes';
  return { ...model, nodes: [...model.nodes, node] };
}

export function addEdge(model: DiagramModel, from: string, to: string): DiagramModel {
  if (from === to) return model;
  if (model.edges.some((e) => e.from === from && e.to === to)) return model;
  const edge: DiagramEdge = { id: `e${model.edges.length + 1}_${from}_${to}`, from, to, label: '' };
  if (FAMILY[model.kind] === 'er') { edge.fromCard = '||'; edge.toCard = 'o{'; edge.label = 'tiene'; }
  return { ...model, edges: [...model.edges, edge] };
}

export function removeNode(model: DiagramModel, id: string): DiagramModel {
  return { ...model, nodes: model.nodes.filter((n) => n.id !== id), edges: model.edges.filter((e) => e.from !== id && e.to !== id) };
}

/* ---------------------------------------------------------------------------------- */
/* From the model to Mermaid                                                            */
/* ---------------------------------------------------------------------------------- */

const q = (s: string | undefined) => (s ?? '').replace(/"/g, '\'').replace(/\r?\n/g, ' ').trim();
const plain = (s: string | undefined) => q(s).replace(/[|{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();

/** The Mermaid code of the model, in the dialect its class's standard demands. */
export function toMermaid(model: DiagramModel): string {
  // A roadmap is a drawing of boxes like any other, but its family is the calendar: the
  // dates it carries are what it is about, so it is written out by a hand of its own.
  if (model.kind === 'roadmap') return toGantt(model);
  /*
   * `c4-code` sits in the C4 family because that is where it belongs on the sheet, but its
   * dialect is `classDiagram` and the C4 writer speaks `class(id, "Name", "")` — so «copy as
   * Mermaid» handed the author C4 syntax under a `classDiagram` header, which is neither
   * dialect, and dropped every field on the way out.
   */
  if (model.kind === 'c4-code') return toClassDiagram(model);
  switch (FAMILY[model.kind]) {
    case 'c4': return toC4(model);
    case 'flow': return toFlow(model);
    case 'state': return toState(model);
    case 'er': return toEr(model);
    default: return '';
  }
}

/**
 * A class diagram, written back as `classDiagram`.
 *
 * The fields travel as they are carried — `attributes` is a list of `string id` lines — with
 * the `+` Mermaid marks visibility with, because that is what its own reader expects back.
 */
function toClassDiagram(model: DiagramModel): string {
  const { head, inner } = titleLines(model);
  const L = [...head, 'classDiagram', ...inner];
  for (const n of model.nodes) {
    const fields = n.attributes ?? [];
    if (!fields.length) { L.push(`    class ${n.name}`); continue; }
    L.push(`    class ${n.name} {`);
    for (const f of fields) L.push(`        ${f.startsWith('+') || f.startsWith('-') ? f : `+${f}`}`);
    L.push('    }');
  }
  const nameOf = (id: string) => model.nodes.find((n) => n.id === id)?.name ?? id;
  for (const e of model.edges) {
    const from = e.fromCard ? ` "${e.fromCard}"` : '';
    const to = e.toCard ? ` "${e.toCard}"` : '';
    L.push(`    ${nameOf(e.from)}${from} -->${to} ${nameOf(e.to)}${e.label ? ` : ${e.label}` : ''}`);
  }
  return L.join('\n');
}

/** The title, as a keyword or as frontmatter depending on what the dialect accepts. */
function titleLines(model: DiagramModel): { head: string[]; inner: string[] } {
  const t = q(model.title);
  if (!t) return { head: [], inner: [] };
  if (TITLE_KEYWORD.has(DIALECT_OF[model.kind])) return { head: [], inner: [`    title ${t}`] };
  return { head: ['---', `title: ${t}`, '---'], inner: [] };
}

function c4Args(n: DiagramNode): string {
  const parts = [n.id, `"${q(n.name)}"`];
  if (c4Arity(n.shape) === 4) parts.push(`"${q(n.technology)}"`);
  if (!isGroupShape(n.shape)) parts.push(`"${q(n.description)}"`);
  return parts.join(', ');
}

function toC4(model: DiagramModel): string {
  const { head, inner } = titleLines(model);
  const L = [...head, DIALECT_OF[model.kind], ...inner];
  const inside = new Set<string>();
  for (const n of model.nodes) {
    if (isGroupShape(n.shape)) {
      const children = childrenOf(model, n);
      L.push(`    ${n.shape}(${c4Args(n)}) {`);
      for (const c of children) { inside.add(c.id); L.push(`        ${c.shape}(${c4Args(c)})`); }
      L.push('    }');
    }
  }
  for (const n of model.nodes) {
    if (isGroupShape(n.shape) || inside.has(n.id)) continue;
    L.push(`    ${n.shape}(${c4Args(n)})`);
  }
  for (const e of model.edges) {
    const tech = q(e.technology);
    L.push(`    Rel(${e.from}, ${e.to}, "${q(e.label)}"${tech ? `, "${tech}"` : ''})`);
  }
  // Past four top-level boxes the labels overlap: the standard asks to spread the rows.
  for (const h of model.styleHints ?? []) L.push(`    ${h}`);
  const boxes = model.nodes.filter((n) => /^(System|Person)/.test(n.shape) && !isGroupShape(n.shape)).length;
  if (model.layoutHint) L.push(`    ${model.layoutHint}`);
  else if (boxes > 4) L.push('    UpdateLayoutConfig($c4ShapeInRow="3")');
  return L.join('\n');
}

function flowNodeDef(n: DiagramNode): string {
  if (n.shape === 'icon') return `${n.id}@{ icon: "${q(n.icon) || 'logos:kubernetes'}", form: "square", label: "${q(n.name)}", pos: "b" }`;
  const [open, close] = FLOW_SYNTAX[n.shape] ?? FLOW_SYNTAX.rect;
  return `${n.id}${open}${q(n.name)}${close}`;
}

function toFlow(model: DiagramModel): string {
  const { head } = titleLines(model);
  const L = [...head, `${DIALECT_OF[model.kind]} ${model.direction}`];
  const inside = new Set<string>();
  for (const g of model.nodes.filter(isGroup)) {
    const children = childrenOf(model, g);
    L.push(`    subgraph ${g.id}["${q(g.name)}"]`);
    for (const c of children) { inside.add(c.id); L.push(`        ${flowNodeDef(c)}`); }
    L.push('    end');
  }
  for (const n of model.nodes) {
    if (isGroup(n) || inside.has(n.id)) continue;
    L.push(`    ${flowNodeDef(n)}`);
  }
  for (const e of model.edges) {
    const label = plain(e.label);
    L.push(`    ${e.from} -->${label ? `|${label}|` : ''} ${e.to}`);
  }
  return L.join('\n');
}

function toState(model: DiagramModel): string {
  const { head, inner } = titleLines(model);
  const L = [...head, DIALECT_OF[model.kind], ...inner];
  const ref = (id: string) => (model.nodes.find((n) => n.id === id)?.shape === 'terminal' ? '[*]' : id);
  for (const n of model.nodes) {
    if (n.shape === 'terminal') continue;
    // The alias is only needed when the name cannot double as the identifier.
    if (n.name && n.name !== n.id) L.push(`    state "${q(n.name)}" as ${n.id}`);
    if (q(n.description)) L.push(`    ${n.id}: ${q(n.description)}`);
  }
  for (const e of model.edges) {
    const label = q(e.label);
    L.push(`    ${ref(e.from)} --> ${ref(e.to)}${label ? `: ${label}` : ''}`);
  }
  return L.join('\n');
}

/** The name of an entity as `erDiagram` writes it. */
const erId = (n: DiagramNode) => n.id.toUpperCase();

function toEr(model: DiagramModel): string {
  const { head, inner } = titleLines(model);
  const L = [...head, DIALECT_OF[model.kind], ...inner];
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  for (const e of model.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    L.push(`    ${erId(a)} ${e.fromCard ?? '||'}--${e.toCard ?? 'o{'} ${erId(b)} : ${plain(e.label) || 'relaciona'}`);
  }
  for (const n of model.nodes) {
    const fields = (n.attributes ?? []).filter((a) => a.trim());
    if (!fields.length) continue;
    L.push(`    ${erId(n)} {`);
    for (const a of fields) L.push(`        ${plain(a)}`);
    L.push('    }');
  }
  return L.join('\n');
}

/** What each state of a task is called on the way out. The reverse of `GANTT_STATES`. */
const GANTT_MARKER: Record<string, string> = { milestone: 'done', active: 'active', risk: 'crit' };

/**
 * A roadmap, written back as `gantt`.
 *
 * The dates go out as they came in — they are carried whole on the piece, not rebuilt from
 * where it ended up on the canvas — so the only thing the positions decide is the order.
 * The ids are always written: they are what a task is called, and leaving them out would
 * make the next read invent new ones.
 */
function toGantt(model: DiagramModel): string {
  const L = ['gantt'];
  if (q(model.title)) L.push(`    title ${label(model.title)}`);
  L.push('    dateFormat YYYY-MM-DD');
  /*
   * A task drawn on the canvas has no dates: nothing in the editor asks for one, and the
   * adoption pass builds a piece out of a box and a name. Writing its empty date anyway
   * produced `… :active, nuevo, , 1d` — a line this file's own reader rejects, so a roadmap
   * that went out through Mermaid and came back lost every task added by hand.
   *
   * It is given the day its position says instead, read off the tasks that do carry one:
   * the x of a roadmap IS its date, which is the whole reason this class does not let
   * anything propose a placement for it. With no dated task anywhere there is no scale to
   * read, and the task is left out rather than written broken — `modelIssues` is what tells
   * the author, which is the one place they are already looking.
   */
  const dated = model.nodes.filter((n) => ganttDay(n.attributes?.[0] ?? '') !== undefined);
  const task = (n: DiagramNode, indent: string) => {
    const [start, span = '1d'] = n.attributes ?? [];
    const day = start ?? dayFromX(n.x, dated);
    if (day === undefined) return;
    L.push(`${indent}${label(n.name)} :${GANTT_MARKER[n.shape] ?? 'active'}, ${n.id}, ${day}, ${span}`);
  };
  for (const n of model.nodes) {
    if (n.shape === 'phase') {
      L.push(`    section ${label(n.name)}`);
      for (const c of model.nodes.filter((x) => x.parent === n.id)) task(c, '        ');
    } else if (!n.parent) task(n, '    ');
  }
  return L.join('\n');
}

/**
 * The day a task sits on, read from where it was put.
 *
 * The reader placed every task at `(day − first) × scale`, so two tasks that carry a date
 * are enough to invert it. One is enough too, at the scale the reader used; none is not, and
 * then there is no timeline to speak of and the caller leaves the task out.
 */
function dayFromX(x: number, dated: DiagramNode[]): string | undefined {
  if (!dated.length) return undefined;
  const at = dated.map((n) => ({ x: n.x, day: ganttDay(n.attributes![0])! })).sort((a, b) => a.x - b.x);
  const first = at[0];
  const last = at[at.length - 1];
  const scale = last.x === first.x ? PX_PER_DAY : (last.x - first.x) / (last.day - first.day);
  const day = Math.round(first.day + (x - first.x) / (scale || PX_PER_DAY));
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** A colon is what separates a task from its dates: one inside the name would split it. */
const label = (s: string) => plain(s).replace(/:/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------------------------------------------------------------------------------- */
/* From Mermaid back to the model                                                       */
/* ---------------------------------------------------------------------------------- */

export interface ParseResult {
  model: DiagramModel;
  /** Lines the visual editor cannot represent: rewriting would drop them. */
  unsupported: string[];
  /** What is understood but comes back written differently. */
  notes: string[];
}

/** Splits an argument list on its top-level commas, respecting quotes. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false, depth = 0;
  for (const ch of s) {
    if (ch === '"') { quoted = !quoted; cur += ch; continue; }
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (ch === ',' && !quoted && depth <= 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((a) => a.trim().replace(/^"|"$/g, '').trim());
}

/** Strips the frontmatter and returns whatever title it carried. */
function stripFrontmatter(code: string): { code: string; title: string } {
  const m = /^\s*---\s*\n([\s\S]*?)\n---\s*\n/.exec(code);
  if (!m) return { code, title: '' };
  const title = /(^|\n)\s*title:\s*(.+)/.exec(m[1])?.[2]?.trim() ?? '';
  return { code: code.slice(m[0].length), title };
}

/**
 * Rebuilds the pieces of an already-written diagram so it can go on being edited with the
 * mouse. Whatever is not understood comes back in `unsupported`: the editor shows it and
 * offers to carry on by hand, because silently losing half an architecture is not an option.
 */
export function fromMermaid(code: string, kind: DiagramKind): ParseResult | null {
  const family = FAMILY[kind];
  // A `gantt` is a drawing of pieces even though its class is still edited as text: it is
  // read here, with everybody else, so the migration and the editor ask the same reader.
  if (family === 'text' && kind !== 'roadmap') return null;
  const fm = stripFrontmatter(code);
  const model = emptyModel(kind, fm.title);
  const ctx: ParseResult = { model, unsupported: [], notes: [] };
  const lines: string[] = [];
  for (const raw of fm.code.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // `%%{init}%%` directives change how it is drawn: they cannot be dropped in silence.
    if (line.startsWith('%%{')) { ctx.unsupported.push(line); continue; }
    if (line.startsWith('%%')) { ctx.notes.push(line); continue; }
    lines.push(line);
  }
  if (kind === 'roadmap') parseGantt(lines, ctx);
  else if (family === 'c4') parseC4(lines, ctx);
  else if (family === 'flow') parseFlow(lines, ctx);
  else if (family === 'state') parseState(lines, ctx);
  else parseEr(lines, ctx);
  // A roadmap places itself: the dates are the x and the phases the y. Laying it out on a
  // grid would throw away the one thing a timeline says.
  if (kind !== 'roadmap') layout(ctx.model);
  /*
   * Said again in the vocabulary of the class, here rather than at each call site.
   *
   * It was two calls in the core and none in the editor, which is four ways into this
   * function that never got it: opening a drawing, switching to visual, applying the
   * standard's template and accepting the parse notice. A `domain-map` written in Mermaid
   * therefore compiled in the manual and refused to compile in the editor — same reader,
   * same class, two answers. The reader speaks Mermaid and only it knows it has finished.
   */
  ctx.notes.push(...fitToSkin(ctx.model, SKINS[kind]));
  return ctx;
}

/**
 * What else will do, when a class does not draw the shape that was read, nearest first.
 *
 * Keyed by the generic names the reader emits, because those are Mermaid's vocabulary and
 * Mermaid is the only thing it has ever read. The lists are forms, never shapes: a form is
 * geometry and means the same on every sheet, while a shape is the name one class gives one
 * of its roles and means nothing on the next.
 *
 * Every row is the form that was read, then the rest of that form's family. A box is a box
 * however its corners are cut — which is why a chevron is in there, and it has to be: two
 * classes draw nothing but chevrons, and a family that did not close over itself would
 * leave them with no box at all. Across families nothing answers: a store is not a box, a
 * gate is not a box, and nothing whatever is a frame.
 */
const NEAREST: Record<string, Array<SkinRole['form']>> = {
  rect: ['rect', 'rounded', 'node', 'stadium', 'document', 'chevron'],
  round: ['rounded', 'rect', 'node', 'stadium', 'document', 'chevron'],
  stadium: ['stadium', 'rounded', 'rect', 'node', 'document', 'chevron'],
  // An icon node is a square with a glyph on it: what the glyph says is the model's business.
  icon: ['rect', 'rounded', 'node', 'stadium', 'document', 'chevron'],
  cylinder: ['cylinder', 'queue', 'pipe'],
  diamond: ['diamond', 'hexagon'],
  hexagon: ['hexagon', 'diamond'],
  group: ['boundary'],
};

/**
 * A model read in Mermaid's vocabulary, said again in the vocabulary of its class.
 *
 * The reader has never heard of a class: it reports the geometry it saw — `rect`, `icon`,
 * `cylinder` — while a skin names its roles after what a piece *is* on that sheet:
 * `container`, `store`, `facet`, `step`. Where the two spell it the same the shape already
 * is the role and nothing is touched. Where they do not, the role is the one whose **form**
 * is what the reader saw, or the nearest form the class actually draws — in a domain map a
 * box with an icon is a `container`, and no table of per-class translations is needed to
 * know it, because the skin already said which of its roles is a box.
 *
 * A piece nothing answers for is left exactly as it was, for whoever is compiling to refuse
 * with its name in the message. And what was changed comes back as notes: this is the one
 * place a drawing is rewritten on the way in, so it is the one place that has to say so.
 */
export function fitToSkin(model: DiagramModel, skin: DiagramSkin | undefined): string[] {
  if (!skin) return [];
  const declared = (shape: string) => skin.roles.some((r) => r.shape === shape);
  const fitted = new Map<string, string>();
  for (const node of model.nodes) {
    if (declared(node.shape)) continue;
    const role = fitted.get(node.shape)
      ?? (NEAREST[node.shape] ?? []).map((form) => skin.roles.find((r) => r.form === form)?.shape).find(Boolean);
    if (!role) continue;
    fitted.set(node.shape, role);
    node.shape = role;
  }
  return [...fitted].map(([from, to]) => `${from} drawn as \`${to}\`, which is what this class has`);
}

function parseC4(lines: string[], ctx: ParseResult): void {
  const { model } = ctx;
  const inGroup: Record<string, string[]> = {};
  let group: DiagramNode | undefined;
  for (const line of lines) {
    if (/^(C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/.test(line)) continue;
    if (/^UpdateLayoutConfig\b/.test(line)) { model.layoutHint = line; continue; }
    // Placement tweaks are kept verbatim: they are not pieces, but losing them skews the drawing.
    if (/^Update(Rel|Element|Boundary)Style\b/.test(line)) { model.styleHints = [...(model.styleHints ?? []), line]; continue; }
    const t = /^title\s+(.*)$/.exec(line);
    if (t) { model.title = t[1].trim(); continue; }
    if (line === '}') { group = undefined; continue; }
    const boundary = /^(\w*_Boundary)\s*\((.*)\)\s*\{?$/.exec(line);
    if (boundary) {
      const args = splitArgs(boundary[2]);
      group = { id: args[0] || slug(args[1] ?? 'group'), shape: boundary[1], name: args[1] ?? '', x: 0, y: 0, w: 460, h: 300 };
      model.nodes.push(group);
      inGroup[group.id] = [];
      continue;
    }
    const rel = /^(Bi)?Rel(_[UDLR]|_Back|_Neighbor)?\s*\((.*)\)$/.exec(line);
    if (rel) {
      const args = splitArgs(rel[3]);
      if (rel[1] || rel[2]) ctx.notes.push(line);
      model.edges.push({ id: `e${model.edges.length + 1}`, from: args[0], to: args[1], label: args[2] ?? '', technology: args[3] });
      continue;
    }
    const node = /^(\w+)\s*\((.*)\)$/.exec(line);
    if (node && node[1] in C4_SHAPES) {
      const args = splitArgs(node[2]);
      const hasTech = c4Arity(node[1]) === 4;
      model.nodes.push({
        id: args[0], shape: node[1], name: args[1] ?? '',
        technology: hasTech ? args[2] : undefined,
        description: hasTech ? args[3] : args[2],
        x: 0, y: 0,
      });
      if (group) inGroup[group.id].push(args[0]);
      continue;
    }
    ctx.unsupported.push(line);
  }
  markGroups(model, inGroup);
}

/** Reads one end of an arrow: it may carry the node definition attached. */
function parseFlowEndpoint(raw: string, ctx: ParseResult): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const iconNode = /^(\w[\w-]*)@\{(.*)\}$/.exec(s);
  if (iconNode) {
    const body = iconNode[2];
    const icon = /icon:\s*"([^"]*)"/.exec(body)?.[1] ?? '';
    const label = /label:\s*"([^"]*)"/.exec(body)?.[1] ?? iconNode[1];
    upsert(ctx, { id: iconNode[1], shape: 'icon', name: label, icon, x: 0, y: 0 });
    return iconNode[1];
  }
  const shapes: Array<[RegExp, string]> = [
    [/^(\w[\w-]*)\(\[(.*)\]\)$/, 'stadium'],
    [/^(\w[\w-]*)\[\((.*)\)\]$/, 'cylinder'],
    [/^(\w[\w-]*)\{\{(.*)\}\}$/, 'hexagon'],
    [/^(\w[\w-]*)\{(.*)\}$/, 'diamond'],
    [/^(\w[\w-]*)\[(.*)\]$/, 'rect'],
    [/^(\w[\w-]*)\((.*)\)$/, 'round'],
  ];
  for (const [re, shape] of shapes) {
    const m = re.exec(s);
    if (m) { upsert(ctx, { id: m[1], shape, name: m[2].replace(/^"|"$/g, ''), x: 0, y: 0 }); return m[1]; }
  }
  if (/^[\w-]+$/.test(s)) { upsert(ctx, { id: s, shape: 'rect', name: s, x: 0, y: 0 }); return s; }
  return undefined;
}

function upsert(ctx: ParseResult, node: DiagramNode): void {
  const existing = ctx.model.nodes.find((n) => n.id === node.id);
  if (!existing) { ctx.model.nodes.push(node); return; }
  // A full definition beats the bare mention that only carried the identifier.
  if (existing.shape === 'rect' && existing.name === existing.id && node.name !== node.id) { existing.shape = node.shape; existing.name = node.name; existing.icon = node.icon; }
}

function parseFlow(lines: string[], ctx: ParseResult): void {
  const { model } = ctx;
  const stack: DiagramNode[] = [];
  const inGroup: Record<string, string[]> = {};
  // A chain is written on one line and read as several, whatever kind of arrow joins it.
  const hops = lines.flatMap((line) => splitHops(line) ?? [line]);
  for (const line of hops) {
    const header = /^(flowchart|graph)\s+(TD|TB|LR|RL|BT)?/.exec(line);
    if (header) { if (header[2]) model.direction = header[2] as Direction; continue; }
    if (/^title\s+/.test(line)) { model.title = line.replace(/^title\s+/, '').trim(); continue; }
    const sub = /^subgraph\s+(?:([\w-]+)\s*(?:\[(.*)\])?|(.+))$/.exec(line);
    if (sub) {
      const id = sub[1] ?? slug(sub[3] ?? 'group');
      const name = (sub[2] ?? sub[3] ?? id).replace(/^"|"$/g, '');
      const g: DiagramNode = { id, shape: 'group', name, x: 0, y: 0, w: 460, h: 300 };
      // A subgraph inside another belongs to it: a VPC inside a region is inside the region.
      const holder = stack[stack.length - 1];
      if (holder) inGroup[holder.id].push(g.id);
      model.nodes.push(g);
      stack.push(g);
      inGroup[g.id] = [];
      continue;
    }
    if (line === 'end') { stack.pop(); continue; }
    if (/^direction\s+/.test(line)) { ctx.notes.push(line); continue; }
    /*
     * Colours and stroke widths are not lost, they are superseded: the skin of the class
     * decides how a piece is drawn, which is the whole point of the engine. They come back
     * as notes so whoever migrates sees what stopped being theirs to choose.
     */
    if (/^(classDef|class|style|linkStyle)\b/.test(line)) { ctx.notes.push(line); continue; }
    if (/^(click|accTitle|accDescr)\b/.test(line)) { ctx.unsupported.push(line); continue; }
    // Form `A -- "text" --> B`: quoted first, because a label may have a hyphen in it.
    const quoted = /^(.*?)\s*--\s*"([^"]*)"\s*-{2,3}>\s*(.*)$/.exec(line);
    if (quoted) {
      const from = parseFlowEndpoint(quoted[1], ctx);
      const to = parseFlowEndpoint(quoted[3], ctx);
      if (from && to) {
        model.edges.push({ id: `e${model.edges.length + 1}`, from, to, label: quoted[2].trim() });
        const g = stack[stack.length - 1];
        if (g) inGroup[g.id].push(from, to);
        continue;
      }
    }
    // Form `A -.text.-> B`: a dotted arrow carrying its label between the dots.
    const dotted = /^(.*?)\s*-\.\s*([^.]*?)\s*\.-{1,2}>\s*(.*)$/.exec(line);
    if (dotted && dotted[2]) {
      const from = parseFlowEndpoint(dotted[1], ctx);
      const to = parseFlowEndpoint(dotted[3], ctx);
      if (from && to) {
        model.edges.push({ id: `e${model.edges.length + 1}`, from, to, label: dotted[2].replace(/^"|"$/g, '').trim() });
        const g = stack[stack.length - 1];
        if (g) inGroup[g.id].push(from, to);
        continue;
      }
    }
    // Form `A -- text --> B`: the label travels between the dashes, before the arrowhead.
    const withText = /^(.*?)\s*--\s*([^->|]+?)\s*-{2,3}>\s*(.*)$/.exec(line);
    if (withText) {
      const from = parseFlowEndpoint(withText[1], ctx);
      const to = parseFlowEndpoint(withText[3], ctx);
      if (from && to) {
        model.edges.push({ id: `e${model.edges.length + 1}`, from, to, label: withText[2].replace(/^"|"$/g, '').trim() });
        const g = stack[stack.length - 1];
        if (g) inGroup[g.id].push(from, to);
        continue;
      }
    }
    const arrow = /^(.*?)\s*(<-{2,3}>|-{2,3}>|-\.->|={2,3}>|-{2,3}|-\.-)\s*(?:\|([^|]*)\|)?\s*(.*)$/.exec(line);
    if (arrow && /[->=.]/.test(arrow[2])) {
      const left = arrow[1], label = arrow[3] ?? '', right = arrow[4];
      if (!/^-{2,3}>$/.test(arrow[2])) ctx.notes.push(line);
      const from = parseFlowEndpoint(left, ctx);
      const to = parseFlowEndpoint(right, ctx);
      if (from && to) {
        model.edges.push({ id: `e${model.edges.length + 1}`, from, to, label: label.replace(/^"|"$/g, '').trim() });
        const g = stack[stack.length - 1];
        if (g) { inGroup[g.id].push(from, to); }
        continue;
      }
      ctx.unsupported.push(line);
      continue;
    }
    const id = parseFlowEndpoint(line, ctx);
    if (id) { const g = stack[stack.length - 1]; if (g) inGroup[g.id].push(id); continue; }
    ctx.unsupported.push(line);
  }
  markGroups(model, inGroup);
}

/**
 * Cuts a line into one hop each, so every form of arrow can be written in a chain.
 *
 * `a --> b --> c` was already handled, but only for the bare arrow, on the grounds that
 * «a chain with a label on it is not a thing anybody writes». Seven real drawings across
 * three catalogues write exactly that — `G -- No --> H[401] --> Z([Fin])` — and every one of
 * them was refused whole, with the reader naming the line it could not read.
 *
 * Splitting first means each form below only ever sees a single hop, which is what they were
 * written for. The scan is at bracket depth zero so an arrow inside a piece's label, which is
 * text and not a connector, is left alone.
 */
function splitHops(line: string): string[] | null {
  /*
   * The longest form first, or `-.->` is cut in half at its dot and the leading dash is left
   * behind as an endpoint of its own. What follows the head, when it is there, is a
   * `|label|`: it belongs to the connector and travels with the hop on its left.
   */
  const HEAD = /^(?:-\.-{1,2}>|\.-{1,2}>|-{2,3}>|={2,3}>)(?:\s*\|[^|]*\|)?/;
  const heads: Array<{ at: number; len: number }> = [];
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (c === '[' || c === '(' || c === '{') { depth++; continue; }
    if (c === ']' || c === ')' || c === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    const head = HEAD.exec(line.slice(i));
    if (head) { heads.push({ at: i, len: head[0].length }); i += head[0].length - 1; }
  }
  if (heads.length < 2) return null;

  // Each segment ends with the connector that closes it; what comes before is its endpoint.
  const TAIL = /\s*((?:--(?![->])[^>|]*|={2,3}|-{2,3})?\s*(?:-\.-{1,2}>|\.-{1,2}>|-{2,3}>|={2,3}>)(?:\s*\|[^|]*\|)?)\s*$/;
  const segments: string[] = [];
  let from = 0;
  for (const h of heads) { segments.push(line.slice(from, h.at + h.len)); from = h.at + h.len; }
  segments.push(line.slice(from));

  const hops: string[] = [];
  let left = '';
  for (let i = 0; i < segments.length; i++) {
    const last = i === segments.length - 1;
    const tail = last ? null : TAIL.exec(segments[i]);
    if (!last && !tail) return null;
    const end = (last ? segments[i] : segments[i].slice(0, tail!.index)).trim();
    if (!end) return null;
    if (i > 0) hops.push(`${left} ${end}`.trim());
    left = last ? '' : `${end} ${tail![1].trim()}`;
  }
  return hops.length ? hops : null;
}

/** Records which boundary each piece belonged to, so the layout respects it. */
function markGroups(model: DiagramModel, inGroup: Record<string, string[]>): void {
  const map: Record<string, string> = {};
  for (const [g, children] of Object.entries(inGroup)) for (const h of children) if (h !== g) map[h] = g;
  for (const n of model.nodes) if (map[n.id]) n.parent = map[n.id];
}

function parseState(lines: string[], ctx: ParseResult): void {
  const { model } = ctx;
  // `__inicio`/`__fin` are internal sentinel ids: they never reach the Mermaid, which
  // writes `[*]` for both ends, but they have to be stable so the edges can point at them.
  const terminal = (role: 'start' | 'end') => {
    const id = role === 'start' ? '__inicio' : '__fin';
    let n = model.nodes.find((x) => x.id === id);
    if (!n) { n = { id, shape: 'terminal', name: role === 'start' ? 'Start' : 'End', x: 0, y: 0 }; model.nodes.push(n); }
    return id;
  };
  const stateNode = (id: string, name?: string) => {
    let n = model.nodes.find((x) => x.id === id);
    if (!n) { n = { id, shape: 'state', name: name ?? id, x: 0, y: 0 }; model.nodes.push(n); }
    else if (name) n.name = name;
    return id;
  };
  for (const line of lines) {
    if (/^stateDiagram(-v2)?\b/.test(line)) continue;
    if (/^title\s+/.test(line)) { model.title = line.replace(/^title\s+/, '').trim(); continue; }
    const alias = /^state\s+"(.*)"\s+as\s+(\w+)$/.exec(line);
    if (alias) { stateNode(alias[2], alias[1]); continue; }
    if (/^state\s+\w+\s*\{/.test(line) || line === '}' || /^note\b/.test(line) || /^direction\b/.test(line)) { ctx.unsupported.push(line); continue; }
    const tr = /^(\[\*\]|\w+)\s*-->\s*(\[\*\]|\w+)\s*(?::\s*(.*))?$/.exec(line);
    if (tr) {
      const from = tr[1] === '[*]' ? terminal('start') : stateNode(tr[1]);
      const to = tr[2] === '[*]' ? terminal('end') : stateNode(tr[2]);
      model.edges.push({ id: `e${model.edges.length + 1}`, from, to, label: (tr[3] ?? '').trim() });
      continue;
    }
    const desc = /^(\w+)\s*:\s*(.*)$/.exec(line);
    if (desc) { const id = stateNode(desc[1]); const n = model.nodes.find((x) => x.id === id)!; n.description = desc[2]; continue; }
    ctx.unsupported.push(line);
  }
}

function parseEr(lines: string[], ctx: ParseResult): void {
  const { model } = ctx;
  const entity = (name: string) => {
    const id = slug(name, 'e');
    let n = model.nodes.find((x) => x.id === id);
    if (!n) { n = { id, shape: 'entity', name, attributes: [], x: 0, y: 0 }; model.nodes.push(n); }
    return n;
  };
  let openBlock: DiagramNode | undefined;
  for (const line of lines) {
    if (/^erDiagram\b/.test(line)) continue;
    if (/^title\s+/.test(line)) { model.title = line.replace(/^title\s+/, '').trim(); continue; }
    if (openBlock) {
      if (line === '}') { openBlock = undefined; continue; }
      openBlock.attributes = [...(openBlock.attributes ?? []), line];
      continue;
    }
    const block = /^([\w"]+)\s*\{$/.exec(line);
    if (block) { openBlock = entity(block[1].replace(/"/g, '')); continue; }
    const rel = /^([\w"]+)\s+((?:\|\||\}o|\|o|\}\|)(?:--|\.\.)(?:\|\||o\{|\|\{|o\|))\s+([\w"]+)\s*:\s*(.*)$/.exec(line);
    if (rel) {
      const a = entity(rel[1].replace(/"/g, '')), b = entity(rel[3].replace(/"/g, ''));
      const card = rel[2];
      const cut = card.indexOf('--') >= 0 ? card.indexOf('--') : card.indexOf('..');
      model.edges.push({
        id: `e${model.edges.length + 1}`, from: a.id, to: b.id,
        fromCard: cut > 0 ? card.slice(0, cut) : '||',
        toCard: cut > 0 ? card.slice(cut + 2) : 'o{',
        label: rel[4].replace(/^"|"$/g, '').trim(),
      });
      if (card.includes('..')) ctx.notes.push(line);
      continue;
    }
    ctx.unsupported.push(line);
  }
}

/* ------------------------------------ gantt ---------------------------------------- */

/** The markers a task can wear, and the piece each one makes it. */
const GANTT_STATES: Record<string, string> = { done: 'milestone', milestone: 'milestone', active: 'active', crit: 'risk' };

const DAY_MS = 86_400_000;
/** A fortnight comes out about a box wide… */
const PX_PER_DAY = 4;
/**
 * …and a two-year plan still fits across a screen instead of running off into the distance.
 *
 * The number is what the composition pass will accept: past this the whole drawing has to
 * be scaled down to the 820px a page gives it, and the labels come out too small to read.
 */
const SPAN_MAX = 1000;
const ROW_GAP = NODE_H + 18;
const PHASE_X = 24;
/** Room for the name of the phase above what it holds. */
const PHASE_HEAD = 22;

/**
 * The day a date names, counted from the epoch. Only the ISO format is read.
 *
 * `dateFormat` can say anything, and a format read wrong does not fail: it puts every bar
 * somewhere plausible and wrong. Refusing what is not `YYYY-MM-DD` is the honest answer.
 */
function ganttDay(text: string): number | undefined {
  const s = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? undefined : t / DAY_MS;
}

/** A length of time (`3d`, `2w`) or the day it ends on. Either is carried as it was written. */
const isSpan = (s: string) => /^\d+(\.\d+)?\s*(ms|s|m|h|d|w|M|y)$/.test(s.trim()) || ganttDay(s) !== undefined;

/**
 * A roadmap: phases with milestones on a calendar.
 *
 * The rest of the readers hand their pieces to `layout`, because Mermaid never wrote down
 * where anything goes. A `gantt` did: the date IS the position, so here the x comes from
 * the day and the y from the row inside the phase, and the start and the length travel on
 * the piece so that writing it back loses nothing. What the reader cannot turn into a day
 * is not guessed at — it goes to `unsupported`, like everywhere else.
 */
function parseGantt(lines: string[], ctx: ParseResult): void {
  const { model } = ctx;
  const dayOf = new Map<string, number>();
  const buckets: Array<{ phase?: DiagramNode; tasks: DiagramNode[] }> = [];
  let bucket: { phase?: DiagramNode; tasks: DiagramNode[] } | undefined;

  for (const line of lines) {
    if (/^gantt\b/i.test(line)) continue;
    const title = /^title\s+(.+)$/i.exec(line);
    if (title) { model.title = title[1].trim(); continue; }
    const format = /^dateFormat\s+(.+)$/i.exec(line);
    if (format) { if (format[1].trim() !== 'YYYY-MM-DD') ctx.unsupported.push(line); continue; }
    // How Mermaid labels its axis is an instruction to Mermaid: the engine draws its own.
    if (/^axisFormat\b/i.test(line)) { ctx.notes.push(line); continue; }
    const section = /^section\s+(.+)$/i.exec(line);
    if (section) {
      const name = section[1].trim();
      const phase: DiagramNode = { id: uniqueId(model, slug(name, 'p')), shape: 'phase', name, x: 0, y: 0 };
      model.nodes.push(phase);
      bucket = { phase, tasks: [] };
      buckets.push(bucket);
      continue;
    }
    const cut = line.indexOf(':');
    if (cut <= 0) { ctx.unsupported.push(line); continue; }
    const name = line.slice(0, cut).trim();
    const tags = line.slice(cut + 1).split(',').map((t) => t.trim()).filter(Boolean);
    const states: string[] = [];
    while (tags.length > 0 && GANTT_STATES[tags[0]]) states.push(tags.shift()!);
    // What is left is the id, the start and the length; the id is the only optional one.
    const day = tags.length >= 2 && tags.length <= 3 ? ganttDay(tags[tags.length - 2]) : undefined;
    if (day === undefined || !isSpan(tags[tags.length - 1])) { ctx.unsupported.push(line); continue; }
    const id = uniqueId(model, tags.length === 3 ? tags[0] : slug(name, 't'));
    // A `milestone` is written back as `done`: the class has four pieces and this is one.
    if (states.includes('milestone') && !states.includes('done')) ctx.notes.push(line);
    const shape = states.some((s) => GANTT_STATES[s] === 'milestone') ? 'milestone'
      : states.includes('crit') ? 'risk' : 'active';
    const node: DiagramNode = { id, shape, name, attributes: tags.slice(-2), x: 0, y: 0 };
    if (bucket?.phase) node.parent = bucket.phase.id;
    if (!bucket) { bucket = { tasks: [] }; buckets.push(bucket); }
    bucket.tasks.push(node);
    model.nodes.push(node);
    dayOf.set(id, day);
  }

  /*
   * The scale is decided once, with the whole plan in front of it: a fixed rate of pixels
   * per day, pulled in when the span is long enough that it would otherwise run off the
   * side of any screen. Every phase gets the same width, because they share one axis.
   */
  const days = [...dayOf.values()];
  const first = days.length > 0 ? Math.min(...days) : 0;
  const span = days.length > 0 ? Math.max(...days) - first : 0;
  const scale = Math.min(PX_PER_DAY, SPAN_MAX / Math.max(span, 1));
  const width = GROUP_PAD * 2 + Math.round(span * scale) + NODE_W;

  let y = 40;
  for (const b of buckets) {
    const top = b.phase ? y + GROUP_PAD + PHASE_HEAD : y;
    const left = PHASE_X + (b.phase ? GROUP_PAD : 0);
    b.tasks.forEach((n, i) => {
      n.x = left + Math.round(((dayOf.get(n.id) ?? first) - first) * scale);
      n.y = top + i * ROW_GAP;
    });
    const inner = Math.max(NODE_H, b.tasks.length * ROW_GAP - (ROW_GAP - NODE_H));
    if (b.phase) {
      b.phase.x = PHASE_X; b.phase.y = y;
      b.phase.w = width; b.phase.h = GROUP_PAD * 2 + PHASE_HEAD + inner;
      y += b.phase.h + 40;
    } else y = top + inner + 40;
  }
}

/* ---------------------------------------------------------------------------------- */
/* Automatic layout                                                                     */
/* ---------------------------------------------------------------------------------- */

/**
 * Mermaid keeps no positions: opening a hand-written diagram means laying the pieces out
 * from scratch. They go in bands — each boundary with its own inside — and, when there
 * are no boundaries, in levels following the arrows. From then on the mouse decides.
 */
/** What the caller may change about how the grid is built. */
export interface LayoutOptions {
  /**
   * How many pieces sit side by side before the row wraps. Width is what makes the letters
   * small — a drawing scrolls down for free and never sideways — so this is the knob a
   * placement search turns first.
   */
  perRow?: number;
}

export function layout(model: DiagramModel, opts: LayoutOptions = {}): void {
  const groups = model.nodes.filter(isGroup);
  const X0 = 40, Y0 = 40, GX = 40, GY = 40;
  const perRowOf = (count: number, cap: number) => Math.min(cap, Math.max(1, count));
  const childrenOfId = (id: string | undefined) => model.nodes.filter((n) => n.parent === id && n.id !== id);

  if (!groups.length) {
    layoutByLevels(model, model.nodes.filter((n) => !isGroup(n)), X0, Y0, opts.perRow ?? 4);
    return;
  }

  /**
   * Lays a row of pieces of whatever size, and says how much room they took.
   *
   * Sizes differ because a group is a piece too: a region holds a VPC and the VPC holds
   * three services. Rows of a fixed width would put the VPC where a box goes.
   */
  const placeGrid = (list: DiagramNode[], x0: number, y0: number, perRow: number): { w: number; h: number } => {
    let x = x0, y = y0, rowHeight = 0, width = 0, column = 0;
    for (const n of list) {
      const size = sizeOf(n);
      if (column === perRow) { x = x0; y += rowHeight + GY; rowHeight = 0; column = 0; }
      if (isGroup(n)) fill(n, x, y, perRow);
      else { n.x = x; n.y = y; }
      const placed = sizeOf(n);
      x += placed.w + GX;
      rowHeight = Math.max(rowHeight, placed.h);
      width = Math.max(width, x - x0 - GX);
      column++;
    }
    return { w: width, h: y + rowHeight - y0 };
  };

  /** A frame placed at a point, sized by what it ends up holding. Recursive: frames nest. */
  function fill(group: DiagramNode, x: number, y: number, cap: number): void {
    group.x = x; group.y = y;
    const children = childrenOfId(group.id);
    const inner = placeGrid(children, x + GROUP_PAD, y + GROUP_PAD + 22, perRowOf(children.length, cap));
    group.w = Math.max(320, inner.w + GROUP_PAD * 2);
    group.h = Math.max(180, inner.h + GROUP_PAD * 2 + 22);
  }

  const cap = opts.perRow ?? 3;
  const roots = model.nodes.filter((n) => !n.parent || !model.nodes.some((g) => g.id === n.parent && isGroup(g)));
  const people = roots.filter((n) => !isGroup(n) && /^Person/.test(n.shape));
  const rootGroups = roots.filter(isGroup);
  const rest = roots.filter((n) => !isGroup(n) && !people.includes(n));

  let y = Y0;
  if (people.length) y += placeGrid(people, X0, y, opts.perRow ?? 4).h + GY;
  for (const g of rootGroups) { fill(g, X0, y, cap); y += sizeOf(g).h + GY; }
  if (rest.length) y += placeGrid(rest, X0, y, opts.perRow ?? 4).h + GY;
}

/** Spreads by levels following the arrows: sources on top, what depends on them below. */
function layoutByLevels(model: DiagramModel, nodeList: DiagramNode[], x0: number, y0: number, perRow = 4): void {
  const level = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const n of nodeList) { level.set(n.id, 0); incoming.set(n.id, 0); }
  for (const e of model.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  let queue = nodeList.filter((n) => (incoming.get(n.id) ?? 0) === 0).map((n) => n.id);
  if (!queue.length && nodeList.length) queue = [nodeList[0].id];
  const seen = new Set(queue);
  for (let step = 0; step < 40 && queue.length; step++) {
    const next: string[] = [];
    for (const id of queue) {
      for (const e of model.edges.filter((x) => x.from === id)) {
        const n = Math.max(level.get(e.to) ?? 0, (level.get(id) ?? 0) + 1);
        level.set(e.to, n);
        if (!seen.has(e.to)) { seen.add(e.to); next.push(e.to); }
      }
    }
    queue = next;
  }
  const byLevel = new Map<number, DiagramNode[]>();
  for (const n of nodeList) {
    const k = level.get(n.id) ?? 0;
    if (!byLevel.has(k)) byLevel.set(k, []);
    byLevel.get(k)!.push(n);
  }
  const horizontal = model.direction === 'LR' || model.direction === 'RL';
  /*
   * A level with eight pieces in one line is what makes a landscape unreadable, and a chain
   * of twenty-six levels is what makes a process six thousand pixels long. So a level wraps
   * inside itself, and the run of levels wraps too: past `PER_COLUMN` it starts a new
   * column beside the last, which is how somebody drawing a long procedure on paper does it.
   */
  const levels = [...byLevel.entries()].sort((a, b) => a[0] - b[0]);
  const PER_COLUMN = 8;
  const wraps = levels.length > PER_COLUMN && levels.every(([, list]) => list.length <= 2);
  const widest = Math.max(...nodeList.map((n) => sizeOf(n).w), NODE_W);

  let cursor = horizontal ? x0 : y0;
  let lane = 0;
  levels.forEach(([, list], index) => {
    if (wraps && index > 0 && index % PER_COLUMN === 0) {
      lane++;
      cursor = horizontal ? x0 : y0;
    }
    const shift = lane * (widest * (horizontal ? 1 : perRow) + 140);
    let used = 0;
    list.forEach((n, i) => {
      const s = sizeOf(n);
      const col = i % perRow, row = Math.floor(i / perRow);
      if (horizontal) {
        n.x = cursor + row * (widest + 90);
        n.y = y0 + col * (s.h + 40) + shift;
        used = Math.max(used, row * (widest + 90) + widest);
      } else {
        n.x = x0 + col * (widest + 60) + shift;
        n.y = cursor + row * (s.h + 70);
        used = Math.max(used, row * (s.h + 70) + s.h);
      }
    });
    cursor += used + (horizontal ? 90 : 70);
  });
}

/* ---------------------------------------------------------------------------------- */
/* The standard, checked in the browser                                                 */
/* ---------------------------------------------------------------------------------- */

export interface DiagramIssue { rule: string; severity: 'error' | 'warning'; text: string }

const countLines = (code: string, re: RegExp) => code.split('\n').filter((l) => re.test(l.trim())).length;

/** An exact replica of the checks in `packages/core/src/diagrams.ts`. */
const COMMON: Record<string, (c: string) => boolean> = {
  title: (c) => /^\s*title[:\s]\s*\S/m.test(c),
};

export const CHECKS: Record<DiagramKind, Record<string, (c: string) => boolean>> = {
  'domain-map': {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph)\b/m.test(c),
    domains: (c) => /\bsubgraph\b/.test(c),
    icons: (c) => /@\{\s*icon/.test(c) || /pd:/.test(c),
  },
  'value-stream': {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph)\s+(LR|RL)\b/m.test(c),
    value: (c) => !/-->/.test(c) || /--\s*[^>\-]+\s*-->|-->\s*\|/.test(c),
    handover: (c) => /\bsubgraph\b/.test(c) || /-->/.test(c),
  },
  'process-landscape': {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph)\b/m.test(c),
    hierarchy: (c) => /\bsubgraph\b/.test(c),
  },
  'data-landscape': {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph)\b/m.test(c),
    stores: (c) => /\[\(|\[\[|@\{\s*shape/.test(c),
  },
  'data-flow': {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph)\s+(LR|RL)\b/m.test(c),
    'what-travels': (c) => !/-->/.test(c) || /--\s*[^>\-]+\s*-->|-->\s*\|/.test(c),
  },
  'data-lineage': {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph)\s+(LR|RL)\b/m.test(c),
    chain: (c) => countLines(c, /-->/) >= 2,
  },
  'application-landscape': {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph)\b/m.test(c),
    grouping: (c) => /\bsubgraph\b/.test(c),
  },
  integration: {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph)\s+(LR|RL)\b/m.test(c),
    'labelled-edges': (c) => !/-->/.test(c) || /--\s*[^>\-]+\s*-->|-->\s*\|/.test(c),
    direction: (c) => /-->/.test(c),
  },
  dependency: {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph)\b/m.test(c),
    direction: (c) => /-->/.test(c),
  },
  roadmap: {
    ...COMMON,
    dialect: (c) => /^\s*(gantt|timeline)\b/m.test(c),
    dates: (c) => /\d{4}-\d{2}-\d{2}/.test(c) || /^\s*section\b/m.test(c),
  },
  lifecycle: {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph)\b/m.test(c),
    'six-stages': (c) => countLines(c, /-->/) >= 5,
  },
  'stack-map': {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph)\b/m.test(c),
    versions: (c) => /\d+\.\d+/.test(c),
  },
  'environment-map': {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph)\b/m.test(c),
    environments: (c) => /\bsubgraph\b/.test(c),
  },
  network: {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph)\b/m.test(c),
    zones: (c) => /\bsubgraph\b/.test(c),
    traffic: (c) => !/-->/.test(c) || /--\s*[^>\-]+\s*-->|-->\s*\|/.test(c),
  },
  'c4-landscape': {
    ...COMMON,
    dialect: (c) => /^\s*C4Context\b/m.test(c),
    several: (c) => countLines(c, /^System\s*\(/) !== 1,
    boundary: (c) => /Enterprise_Boundary|System_Ext/.test(c),
  },
  'c4-context': {
    ...COMMON,
    dialect: (c) => /^\s*C4Context\b/m.test(c),
    'one-system': (c) => countLines(c, /^System(_Boundary)?\s*\(/) === 1,
    people: (c) => /\bPerson(_Ext)?\s*\(/.test(c),
    technology: (c) => !/^\s*Rel\w*\([^)]*\)\s*$/m.test(c) || /Rel\w*\([^)]*,[^)]*,[^)]*,[^)]*\)/.test(c),
  },
  'c4-container': {
    ...COMMON,
    dialect: (c) => /^\s*C4Container\b/m.test(c),
    boundary: (c) => /_Boundary\s*\(/.test(c),
    technology: (c) => !/Container\w*\(/.test(c) || /Container\w*\([^)]*,[^)]*,[^)]*,/.test(c),
    data: (c) => !/(postgres|mysql|mongo|base de datos|database|kafka|rabbit|cola)/i.test(c) || /(ContainerDb|ContainerQueue|SystemDb|SystemQueue)/.test(c),
  },
  'c4-component': {
    ...COMMON,
    dialect: (c) => /^\s*(C4Component|flowchart)\b/m.test(c),
    'one-container': (c) => countLines(c, /^Container_Boundary\s*\(/) <= 1,
  },
  'c4-code': { ...COMMON, dialect: (c) => /^\s*classDiagram\b/m.test(c) },
  process: {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph|stateDiagram(-v2)?)\b/m.test(c),
    direction: (c) => /^\s*(flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/m.test(c) || /stateDiagram/.test(c),
    decisions: (c) => !/\{[^}]+\}/.test(c) || /--?>\|/.test(c),
  },
  sequence: {
    ...COMMON,
    dialect: (c) => /^\s*sequenceDiagram\b/m.test(c),
    participants: (c) => /^\s*participant\s+\w+\s+as\s+\S|^\s*participant\s+[A-Za-zÁÉÍÓÚÑ][\w\s]{2,}/m.test(c),
    errors: (c) => /\b(alt|opt|critical|break)\b/.test(c),
  },
  state: {
    ...COMMON,
    dialect: (c) => /^\s*stateDiagram(-v2)?\b/m.test(c),
    start: (c) => /\[\*\]\s*-->/.test(c),
    transitions: (c) => /-->\s*\w+\s*:/.test(c),
  },
  'data-model': {
    ...COMMON,
    dialect: (c) => /^\s*erDiagram\b/m.test(c),
    cardinality: (c) => /\|\|--|\}o--|\|o--|\}\|--/.test(c),
    keys: (c) => /\bPK\b/.test(c),
  },
  deployment: {
    ...COMMON,
    dialect: (c) => !/^\s*architecture-beta\b/m.test(c),
    icons: (c) => /icon:\s*"/.test(c),
    boundaries: (c) => /\bsubgraph\b/.test(c),
  },
  versioning: {
    ...COMMON,
    dialect: (c) => /^\s*gitGraph\b/m.test(c),
    tags: (c) => /tag:/.test(c),
  },
  packages: {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph|C4Component|classDiagram)\b/m.test(c),
    layers: (c) => /\bsubgraph\b/.test(c),
  },
  capabilities: {
    ...COMMON,
    dialect: (c) => /^\s*(flowchart|graph)\b/m.test(c),
  },
};

/** The ids of the rules the code breaks, without needing the API. */
export function failingRules(code: string, kind: DiagramKind): string[] {
  return Object.entries(CHECKS[kind]).filter(([, check]) => !check(code)).map(([id]) => id);
}

/**
 * The breaches of the standard, with the text the API serves. It is the same count
 * `lintDiagram` makes in the core, so what you see while editing is what the lint will say.
 */
export function lintDiagram(code: string, std: DiagramStandard): DiagramIssue[] {
  const failing = new Set(failingRules(code, std.kind));
  const issues: DiagramIssue[] = std.rules
    .filter((r) => failing.has(r.id))
    .map((r) => ({ rule: r.id, severity: r.severity, text: r.text }));
  const nodeList = code.replace(/\{[^{}]*\}/gs, '').split('\n').filter((l) => /^\s*\w+[\s([]/.test(l)).length;
  if (nodeList > std.maxNodes * 2 && !issues.some((i) => i.rule === 'size')) {
    issues.push({ rule: 'size', severity: 'warning', text: `Looks too big to be read at a glance (recommended maximum: ${std.maxNodes} elements).` });
  }
  return issues;
}

/* ---------------------------------------------------------------------------------- */
/* Warnings piece by piece                                                              */
/* ---------------------------------------------------------------------------------- */

export interface ModelIssue { nodeId?: string; edgeId?: string; text: string; severity: 'error' | 'warning' }

const DATA_HINTS = /(postgres|mysql|mongo|oracle|redis|base de datos|database|kafka|rabbit|sqs|cola|queue|bus)/i;

/**
 * What each individual piece is missing. The standard's lint says "every container
 * declares its technology"; this says which one has not, which is what you need to fix it
 * without hunting for it.
 */
export function modelIssues(model: DiagramModel, maxNodes: number): ModelIssue[] {
  const out: ModelIssue[] = [];
  const family = FAMILY[model.kind];
  const name = (n: DiagramNode) => n.name || n.id;
  for (const n of model.nodes) {
    if (!n.name.trim()) out.push({ nodeId: n.id, severity: 'error', text: `The piece «${n.id}» has no name.` });
    const spec = shapeSpec(n.shape, family);
    if (spec.fields.includes('technology') && !n.technology?.trim()) {
      out.push({ nodeId: n.id, severity: 'error', text: `«${name(n)}» does not say which technology it runs on: the standard asks for it on every ${n.shape}.` });
    }
    if (family === 'c4' && /^(Container|Component)$/.test(n.shape) && DATA_HINTS.test(`${n.name} ${n.technology ?? ''} ${n.description ?? ''}`)) {
      out.push({ nodeId: n.id, severity: 'warning', text: `«${name(n)}» looks like a store or a queue: it goes as ${n.shape}Db or ${n.shape}Queue, not as a plain box.` });
    }
    if (n.shape === 'entity' && !(n.attributes ?? []).some((a) => /\bPK\b/.test(a))) {
      out.push({ nodeId: n.id, severity: 'warning', text: `«${name(n)}» declares no primary key (PK).` });
    }
    if (n.shape === 'icon' && !n.icon?.trim()) out.push({ nodeId: n.id, severity: 'warning', text: `«${name(n)}» declares no icon.` });
  }
  if (model.kind === 'c4-landscape') {
    const own = model.nodes.filter((n) => n.shape === 'System').length;
    if (own <= 1) out.push({ severity: 'warning', text: 'A landscape draws several systems of our own: with just one, what fits is a context diagram.' });
  }
  if (family === 'c4' && model.kind === 'c4-context') {
    const own = model.nodes.filter((n) => n.shape === 'System').length;
    if (own === 0) out.push({ severity: 'error', text: 'There is no system of our own: a context needs exactly one.' });
    if (own > 1) out.push({ severity: 'error', text: `There are ${own} systems of our own: only one is documented here, the rest go as System_Ext.` });
    if (!model.nodes.some((n) => /^Person/.test(n.shape))) out.push({ severity: 'warning', text: 'There is no person: a system nobody uses has no context.' });
  }
  const connected = new Set(model.edges.flatMap((e) => [e.from, e.to]));
  for (const n of model.nodes) {
    if (isGroupShape(n.shape) || n.shape === 'terminal') continue;
    if (model.nodes.length > 1 && !connected.has(n.id)) out.push({ nodeId: n.id, severity: 'warning', text: `«${name(n)}» is loose: no arrow joins it to anything.` });
  }
  const nameOf = (id: string) => { const n = model.nodes.find((x) => x.id === id); return n ? name(n) : id; };
  for (const e of model.edges) {
    const ends = `${nameOf(e.from)} → ${nameOf(e.to)}`;
    if (!e.label?.trim()) out.push({ edgeId: e.id, severity: 'warning', text: `The link «${ends}» does not say what goes through it.` });
    else if (family === 'c4' && !e.technology?.trim()) out.push({ edgeId: e.id, severity: 'warning', text: `The link «${ends}» does not say which technology carries it.` });
  }
  const decisions = model.nodes.filter((n) => n.shape === 'diamond');
  for (const d of decisions) {
    const outgoing = model.edges.filter((e) => e.from === d.id);
    if (outgoing.length < 2) out.push({ nodeId: d.id, severity: 'warning', text: `The decision «${name(d)}» has ${outgoing.length === 1 ? 'a single way out' : 'no way out'}: a decision splits into two or more.` });
    if (outgoing.some((e) => !e.label?.trim())) out.push({ nodeId: d.id, severity: 'error', text: `Some branch out of «${name(d)}» is unlabelled.` });
  }
  const pieces = model.nodes.filter((n) => !isGroupShape(n.shape)).length;
  if (pieces > maxNodes) out.push({ severity: 'warning', text: `${pieces} elements: above ${maxNodes} the diagram stops reading and has to be split.` });
  return out;
}

/* ---------------------------------------------------------------------------------- */
/* The diagrams that already live inside a document                                     */
/* ---------------------------------------------------------------------------------- */

export interface MermaidBlock {
  /** Position of the whole block within the body, fences included. */
  start: number; end: number;
  code: string;
  /** Which fence it came out of: the drawing is the same question, the syntax is not. */
  lang: 'mermaid' | 'pd-diagram';
}

/** The drawings of a Markdown body, in order and with their exact place. */
export function mermaidBlocks(body: string): MermaidBlock[] {
  const out: MermaidBlock[] = [];
  // Both fences: what the editor is after is the drawing, not the syntax it came in.
  const re = /^[ \t]*```(mermaid|pd-diagram)[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    out.push({ start: m.index, end: m.index + m[0].length, code: m[2].replace(/\s+$/, ''), lang: m[1] as MermaidBlock['lang'] });
  }
  return out;
}

/** The dialect of a block, read from its first non-empty line (as the core does). */
export function detectDialect(code: string): string {
  const withoutFrontmatter = stripFrontmatter(code).code;
  const first = withoutFrontmatter.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('%%')) ?? '';
  const m = /^(C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|classDiagram|erDiagram|sequenceDiagram|stateDiagram-v2|stateDiagram|gitGraph|flowchart|graph|architecture-beta|mindmap|timeline|journey|pie|quadrantChart|requirementDiagram|sankey-beta|xychart-beta|block-beta)\b/.exec(first);
  return m?.[1] ?? 'unknown';
}

/**
 * Which class of diagram a piece of written code is. When the dialect serves several
 * classes — any `flowchart` could be a process, a deployment, packages or capabilities —
 * the one the document type expects wins.
 */
export function kindOfCode(code: string, expected: DiagramKind[] = []): DiagramKind | undefined {
  // A typed block says its class outright, which is the whole point of it.
  if (code.trimStart().startsWith('{')) {
    try {
      const kind = (JSON.parse(code) as { kind?: string }).kind;
      return DIAGRAM_KINDS.includes(kind as DiagramKind) ? (kind as DiagramKind) : undefined;
    } catch {
      return undefined;
    }
  }
  const dialect = detectDialect(code);
  const alias: Record<string, string> = { graph: 'flowchart', stateDiagram: 'stateDiagram-v2' };
  const wanted = alias[dialect] ?? dialect;
  const all = (Object.keys(DIALECT_OF) as DiagramKind[]).filter((k) => DIALECT_OF[k] === wanted);
  if (!all.length) return undefined;
  const candidates = all.filter((k) => expected.includes(k));
  const list = candidates.length ? candidates : all;
  if (list.length === 1) return list[0];
  // Several classes share a dialect (every `flowchart`, or the context and the landscape):
  // the one that breaks the fewest rules wins, which is what really tells them apart.
  const cost = (k: DiagramKind) => Object.entries(CHECKS[k])
    .filter(([id, check]) => id !== 'title' && !check(code))
    .reduce((acc, [id]) => acc + (ruleSeverity(k, id) === 'error' ? 3 : 1), 0);
  return [...list].sort((a, b) => cost(a) - cost(b) || list.indexOf(a) - list.indexOf(b))[0];
}

/** How severely the core treats a rule, so the tie-break can weigh it. */
function ruleSeverity(kind: DiagramKind, rule: string): 'error' | 'warning' {
  const errorRules: Record<string, string[]> = {
    'c4-landscape': ['dialect'], 'c4-context': ['dialect', 'one-system'], 'c4-container': ['dialect', 'boundary', 'technology'],
    'c4-component': [], 'c4-code': ['dialect'], process: ['dialect'], sequence: ['dialect'], state: ['dialect'],
    'data-model': ['dialect', 'cardinality'], deployment: ['dialect'], versioning: ['dialect'], packages: ['dialect'], capabilities: ['dialect'],
  };
  return errorRules[kind]?.includes(rule) ? 'error' : 'warning';
}

/** The classes the standard proposes for a document type, from its `usedIn`. */
export function kindsForDocType(standards: Record<DiagramKind, DiagramStandard> | null, type: string): DiagramKind[] {
  if (!standards) return [];
  return (Object.keys(standards) as DiagramKind[]).filter((k) => (standards[k].usedIn as string[]).includes(type));
}

/* ---------------------------------------------------------------------------------- */
/* The dialects that are not a canvas: they are edited as rows                          */
/* ---------------------------------------------------------------------------------- */

/**
 * `sequenceDiagram`, `gitGraph` and `classDiagram` are not graphs of boxes you can drag:
 * they are lists. A sequence is a list of messages in order; a gitGraph, a history of
 * commits; a class diagram, a list of classes with their fields. That is why they are
 * edited as rows — add, move and delete — and not on a canvas.
 *
 * As in the rest of the file: no React here, so all three round trips can be tested in Node.
 */
export type RowFamily = 'sequence' | 'git' | 'class';

export const ROW_FAMILY: Partial<Record<DiagramKind, RowFamily>> = {
  sequence: 'sequence',
  versioning: 'git',
  'c4-code': 'class',
};

export const rowFamilyOf = (kind: DiagramKind): RowFamily | undefined => ROW_FAMILY[kind];
export const isRowEditable = (kind: DiagramKind): boolean => !!ROW_FAMILY[kind];

/** What the row editor did not understand: it is kept verbatim and flagged. */
export interface RowParse<T> { model: T; unsupported: string[] }

const unquoted = (s: string) => s.trim().replace(/^"(.*)"$/, '$1');

/* --------------------------------- sequence ---------------------------------------- */

export interface SequenceParticipant {
  id: string;
  label: string;
  /** `actor` instead of `participant`: drawn as a stick figure. */
  actor: boolean;
  /** Whether it came declared. Those that only show up in a message are not declared back. */
  declared: boolean;
}

export type SequenceRow =
  | { kind: 'message'; from: string; to: string; arrow: string; text: string }
  | { kind: 'block'; keyword: string; text: string }
  | { kind: 'note'; placement: string; who: string; text: string }
  | { kind: 'raw'; text: string };

export interface SequenceModel {
  title: string;
  autonumber: boolean;
  participants: SequenceParticipant[];
  rows: SequenceRow[];
}

/** The arrows of the dialect, from the most used to the most obscure. */
export const SEQUENCE_ARROWS = ['->>', '-->>', '->', '-->', '-x', '--x', '-)', '--)'];
/** The words that open, continue or close a block. */
export const SEQUENCE_BLOCKS = ['alt', 'else', 'opt', 'loop', 'par', 'and', 'critical', 'option', 'break', 'end'];
const OPENS = new Set(['alt', 'opt', 'loop', 'par', 'critical', 'break', 'rect', 'box']);
const CONTINUES = new Set(['else', 'and', 'option']);

export const emptySequence = (title = ''): SequenceModel => ({ title, autonumber: false, participants: [], rows: [] });

export function parseSequence(code: string): RowParse<SequenceModel> {
  const fm = stripFrontmatter(code);
  const model = emptySequence(fm.title);
  const unsupported: string[] = [];
  const known = (id: string) => model.participants.some((p) => p.id === id);
  const ensure = (id: string) => { if (id && !known(id)) model.participants.push({ id, label: id, actor: false, declared: false }); };

  for (const raw of fm.code.split('\n')) {
    const line = raw.trim();
    if (!line || /^sequenceDiagram\b/.test(line)) continue;
    if (line.startsWith('%%')) { unsupported.push(line); continue; }
    const titleMatch = /^title\s+(.*)$/.exec(line);
    if (titleMatch) { model.title = titleMatch[1].trim(); continue; }
    if (/^autonumber\b/.test(line)) { model.autonumber = true; continue; }
    const part = /^(participant|actor)\s+(.+)$/.exec(line);
    if (part) {
      const body = part[2];
      const alias = /^(\S+)\s+as\s+(.+)$/.exec(body);
      const id = unquoted(alias ? alias[1] : body);
      const existing = model.participants.find((p) => p.id === id);
      const fresh: SequenceParticipant = { id, label: unquoted(alias ? alias[2] : body), actor: part[1] === 'actor', declared: true };
      if (existing) Object.assign(existing, fresh); else model.participants.push(fresh);
      continue;
    }
    const note = /^note\s+(over|left of|right of)\s+([^:]+):\s*(.*)$/i.exec(line);
    if (note) {
      for (const q of note[2].split(',')) ensure(unquoted(q));
      model.rows.push({ kind: 'note', placement: note[1].toLowerCase(), who: note[2].trim(), text: note[3].trim() });
      continue;
    }
    const block = new RegExp(`^(${SEQUENCE_BLOCKS.join('|')})\\b\\s*(.*)$`).exec(line);
    if (block) { model.rows.push({ kind: 'block', keyword: block[1], text: block[2].trim() }); continue; }
    const message = new RegExp(`^([\\w"']+)\\s*(${SEQUENCE_ARROWS.map((a) => a.replace(/[-)]/g, '\\$&')).join('|')})([+-]?)\\s*([\\w"']+)\\s*:\\s*(.*)$`).exec(line);
    if (message) {
      const from = unquoted(message[1]), to = unquoted(message[4]);
      ensure(from); ensure(to);
      model.rows.push({ kind: 'message', from, to, arrow: message[2], text: message[5].trim() });
      continue;
    }
    model.rows.push({ kind: 'raw', text: line });
    unsupported.push(line);
  }
  return { model, unsupported };
}

export function toSequence(model: SequenceModel): string {
  const L = ['sequenceDiagram'];
  if (model.title.trim()) L.push(`    title ${model.title.trim()}`);
  if (model.autonumber) L.push('    autonumber');
  for (const p of model.participants) {
    if (!p.declared) continue;
    const word = p.actor ? 'actor' : 'participant';
    L.push(`    ${word} ${p.id}${p.label && p.label !== p.id ? ` as ${p.label}` : ''}`);
  }
  let level = 1;
  for (const r of model.rows) {
    if (r.kind === 'block' && (r.keyword === 'end' || CONTINUES.has(r.keyword))) level = Math.max(1, level - 1);
    const indent = '    '.repeat(level);
    if (r.kind === 'message') L.push(`${indent}${r.from}${r.arrow}${r.to}: ${r.text}`);
    else if (r.kind === 'note') L.push(`${indent}Note ${r.placement} ${r.who}: ${r.text}`);
    else if (r.kind === 'raw') L.push(`${indent}${r.text}`);
    else L.push(`${indent}${r.keyword}${r.text ? ` ${r.text}` : ''}`);
    if (r.kind === 'block' && (OPENS.has(r.keyword) || CONTINUES.has(r.keyword))) level++;
  }
  return L.join('\n');
}

/* ---------------------------------- gitGraph --------------------------------------- */

export type GitRow =
  | { kind: 'commit'; id: string; tag: string; type: string }
  | { kind: 'branch'; name: string }
  | { kind: 'checkout'; name: string }
  | { kind: 'merge'; name: string; tag: string }
  | { kind: 'cherry-pick'; id: string }
  | { kind: 'raw'; text: string };

export interface GitModel {
  title: string;
  /** The title came as a keyword (`title X`) rather than frontmatter: that is respected. */
  titleKeyword: boolean;
  rows: GitRow[];
}

export const GIT_ROW_KINDS: Array<GitRow['kind']> = ['commit', 'branch', 'checkout', 'merge', 'cherry-pick'];
export const GIT_COMMIT_TYPES = ['NORMAL', 'HIGHLIGHT', 'REVERSE'];

export const emptyGit = (title = ''): GitModel => ({ title, titleKeyword: false, rows: [] });

/** The branches that exist at a given point: the main one plus any that were created. */
export function gitBranches(model: GitModel): string[] {
  const out = ['main'];
  for (const r of model.rows) if (r.kind === 'branch' && r.name && !out.includes(r.name)) out.push(r.name);
  return out;
}

export function parseGit(code: string): RowParse<GitModel> {
  const fm = stripFrontmatter(code);
  const model = emptyGit(fm.title);
  const unsupported: string[] = [];
  // `id: "feat: endpoint"` has spaces and colons inside the quotes: they have to be honoured.
  const field = (line: string, key: string) => {
    const m = new RegExp(`\\b${key}:\\s*(?:"([^"]*)"|(\\S+))`).exec(line);
    return m ? (m[1] ?? m[2] ?? '') : '';
  };
  for (const raw of fm.code.split('\n')) {
    const line = raw.trim();
    if (!line || /^gitGraph\b/.test(line)) continue;
    if (line.startsWith('%%')) { unsupported.push(line); continue; }
    const titleMatch = /^title\s+(.*)$/.exec(line);
    if (titleMatch) { model.title = titleMatch[1].trim(); model.titleKeyword = true; continue; }
    if (/^commit\b/.test(line)) {
      model.rows.push({ kind: 'commit', id: field(line, 'id'), tag: field(line, 'tag'), type: field(line, 'type') });
      continue;
    }
    const branch = /^branch\s+(\S+)/.exec(line);
    if (branch) { model.rows.push({ kind: 'branch', name: branch[1] }); continue; }
    const checkoutRow = /^checkout\s+(\S+)/.exec(line);
    if (checkoutRow) { model.rows.push({ kind: 'checkout', name: checkoutRow[1] }); continue; }
    const mergeRow = /^merge\s+(\S+)/.exec(line);
    if (mergeRow) { model.rows.push({ kind: 'merge', name: mergeRow[1], tag: field(line, 'tag') }); continue; }
    if (/^cherry-pick\b/.test(line)) { model.rows.push({ kind: 'cherry-pick', id: field(line, 'id') }); continue; }
    model.rows.push({ kind: 'raw', text: line });
    unsupported.push(line);
  }
  return { model, unsupported };
}

export function toGit(model: GitModel): string {
  const L: string[] = [];
  const titleMatch = model.title.trim();
  if (titleMatch && !model.titleKeyword) L.push('---', `title: ${titleMatch}`, '---');
  L.push('gitGraph');
  if (titleMatch && model.titleKeyword) L.push(`    title ${titleMatch}`);
  for (const r of model.rows) {
    if (r.kind === 'commit') {
      const parts = [r.id && `id: "${r.id}"`, r.tag && `tag: "${r.tag}"`, r.type && r.type !== 'NORMAL' && `type: ${r.type}`].filter(Boolean);
      L.push(`    commit${parts.length ? ` ${parts.join(' ')}` : ''}`);
    } else if (r.kind === 'branch') L.push(`    branch ${r.name}`);
    else if (r.kind === 'checkout') L.push(`    checkout ${r.name}`);
    else if (r.kind === 'merge') L.push(`    merge ${r.name}${r.tag ? ` tag: "${r.tag}"` : ''}`);
    else if (r.kind === 'cherry-pick') L.push(`    cherry-pick id: "${r.id}"`);
    else L.push(`    ${r.text}`);
  }
  return L.join('\n');
}

/* -------------------------------- classDiagram ------------------------------------- */

export interface ClassBox { name: string; stereotype: string; members: string[] }
export interface ClassRelation { from: string; to: string; arrow: string; label: string; fromCard: string; toCard: string }
export interface ClassModel {
  title: string;
  /** The title came as a keyword (`title X`) rather than frontmatter: that is respected. */
  titleKeyword: boolean;
  classes: ClassBox[];
  relations: ClassRelation[];
  extra: string[];
}

/** The links of the dialect, with what each one means in the standard. */
export const CLASS_ARROWS: Array<{ arrow: string; means: string }> = [
  { arrow: '<|--', means: 'inherits from' },
  { arrow: '*--', means: 'composition' },
  { arrow: 'o--', means: 'aggregation' },
  { arrow: '-->', means: 'associates' },
  { arrow: '--', means: 'relation' },
  { arrow: '..>', means: 'depends on' },
  { arrow: '..|>', means: 'implements' },
];

export const emptyClass = (title = ''): ClassModel => ({ title, titleKeyword: false, classes: [], relations: [], extra: [] });

export function parseClass(code: string): RowParse<ClassModel> {
  const fm = stripFrontmatter(code);
  const model = emptyClass(fm.title);
  const unsupported: string[] = [];
  const classBox = (name: string): ClassBox => {
    let c = model.classes.find((x) => x.name === name);
    if (!c) { c = { name, stereotype: '', members: [] }; model.classes.push(c); }
    return c;
  };
  let openBlock: ClassBox | undefined;
  const arrows = CLASS_ARROWS.map((a) => a.arrow).sort((a, b) => b.length - a.length).map((a) => a.replace(/[|*.>-]/g, '\\$&'));

  for (const raw of fm.code.split('\n')) {
    const line = raw.trim();
    if (!line || /^classDiagram(-v2)?\b/.test(line)) continue;
    if (line.startsWith('%%')) { unsupported.push(line); continue; }
    if (openBlock) {
      if (line === '}') { openBlock = undefined; continue; }
      openBlock.members.push(line);
      continue;
    }
    const titleMatch = /^title\s+(.*)$/.exec(line);
    if (titleMatch) { model.title = titleMatch[1].trim(); model.titleKeyword = true; continue; }
    const block = /^class\s+([\w~<>[\]]+)\s*\{$/.exec(line);
    if (block) { openBlock = classBox(block[1]); continue; }
    const alone = /^class\s+([\w~<>[\]]+)\s*$/.exec(line);
    if (alone) { classBox(alone[1]); continue; }
    const stereotypeLine = /^<<(.+)>>\s+(\w+)$/.exec(line);
    if (stereotypeLine) { classBox(stereotypeLine[2]).stereotype = stereotypeLine[1]; continue; }
    const rel = new RegExp(`^([\\w~]+)\\s*(?:"([^"]*)"\\s*)?(${arrows.join('|')})\\s*(?:"([^"]*)"\\s*)?([\\w~]+)\\s*(?::\\s*(.*))?$`).exec(line);
    if (rel) {
      classBox(rel[1]); classBox(rel[5]);
      model.relations.push({ from: rel[1], to: rel[5], arrow: rel[3], label: (rel[6] ?? '').trim(), fromCard: rel[2] ?? '', toCard: rel[4] ?? '' });
      continue;
    }
    const memberLine = /^([\w~]+)\s*:\s*(.+)$/.exec(line);
    if (memberLine) { classBox(memberLine[1]).members.push(memberLine[2].trim()); continue; }
    model.extra.push(line);
    unsupported.push(line);
  }
  return { model, unsupported };
}

export function toClass(model: ClassModel): string {
  const L: string[] = [];
  const titleMatch = model.title.trim();
  if (titleMatch && !model.titleKeyword) L.push('---', `title: ${titleMatch}`, '---');
  L.push('classDiagram');
  if (titleMatch && model.titleKeyword) L.push(`    title ${titleMatch}`);
  for (const c of model.classes) {
    const fields = c.members.map((m) => m.trim()).filter(Boolean);
    if (fields.length) {
      L.push(`    class ${c.name} {`);
      if (c.stereotype) L.push(`        <<${c.stereotype}>>`);
      for (const m of fields) L.push(`        ${m}`);
      L.push('    }');
    } else {
      L.push(`    class ${c.name}`);
      if (c.stereotype) L.push(`    <<${c.stereotype}>> ${c.name}`);
    }
  }
  for (const r of model.relations) {
    const leftCard = r.fromCard ? ` "${r.fromCard}"` : '';
    const rightCard = r.toCard ? `"${r.toCard}" ` : '';
    L.push(`    ${r.from}${leftCard} ${r.arrow} ${rightCard}${r.to}${r.label ? ` : ${r.label}` : ''}`);
  }
  for (const e of model.extra) L.push(`    ${e}`);
  return L.join('\n');
}

/* ---------------------------------------------------------------------------------- */
/* Who decides where a piece goes                                                       */
/* ---------------------------------------------------------------------------------- */

/**
 * A diagram of one class carries its positions, and one of another must not.
 *
 * The distinction is the conclusion of an experiment somebody else already paid for: a
 * blind rating of stock Mermaid against auto-layout with a good skin found the two
 * indistinguishable, and only hand-decided placement rated well. Where something is put —
 * what sits inside a boundary, what is deliberately off to one side — carries meaning that
 * no solver infers, so an authored diagram keeps its positions.
 *
 * The twelve derived classes have no author: they are built from the catalogue, and a
 * landscape of forty applications is nobody's drawing. There the solver is not the worse
 * option, it is the only one, and a position written by hand would be overwritten on the
 * next scan — which is why one is an error rather than a preference.
 */
export function positionIssues(model: DiagramModel, facts: Pick<StandardFacts, 'kind' | 'origin'>): ModelIssue[] {
  const placed = model.nodes.filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y));
  if (facts.origin === 'derived') {
    // A pinned route is a placement decision too, and a derived drawing has no author to
    // have made one: it would be overwritten on the next scan, exactly like a position.
    const routed = model.edges.filter((e) => e.points?.length);
    if (routed.length > 0) {
      return [{
        severity: 'error',
        text: `A "${facts.kind}" is built from the catalogue and routed by the engine: ${routed.length} of its arrows carry a route that the next scan would overwrite.`,
      }];
    }
    return placed.length === 0 ? [] : [{
      severity: 'error',
      text: `A "${facts.kind}" is built from the catalogue and placed by the engine: ${placed.length} of its ${model.nodes.length} pieces carry a position that the next scan would overwrite.`,
    }];
  }
  const loose = model.nodes.filter((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y));
  return loose.length === 0 ? [] : loose.map((n) => ({
    nodeId: n.id,
    severity: 'error' as const,
    text: `"${n.name || n.id}" has no position. In a "${facts.kind}" the placement is part of what is being said; ask for a proposal and accept it, but do not leave it to be guessed at render time.`,
  }));
}

/** Something wrong with a model, addressed by where it is inside it. */
export interface ModelError {
  /** `nodes[2].id`, `edges[0].to`. Whoever writes it prefixes its own path. */
  path: string;
  message: string;
}

/**
 * Everything wrong with a model, before it is written or painted.
 *
 * It answers by position inside the model rather than by prose, so a writer that filled a
 * structure gets back the cell to fix instead of the diagram to redo. Composition — labels
 * that overlap, text too small to read once projected — is a separate pass that needs the
 * drawing placed; this one only asks whether the model is a model.
 */
export function modelErrors(
  model: DiagramModel,
  facts: Pick<StandardFacts, 'kind' | 'origin' | 'maxNodes'>,
  allowed?: readonly DiagramKind[],
): ModelError[] {
  const errors: ModelError[] = [];
  if (!DIAGRAM_KINDS.includes(model.kind)) {
    errors.push({ path: 'kind', message: `"${model.kind}" is not a class of diagram; the standard has ${DIAGRAM_KINDS.length}` });
    return errors;
  }
  if (allowed && allowed.length > 0 && !allowed.includes(model.kind)) {
    errors.push({ path: 'kind', message: `a "${model.kind}" does not belong in this type of document; it takes ${allowed.join(', ')}` });
  }

  if (!Array.isArray(model.nodes) || model.nodes.length === 0) {
    errors.push({ path: 'nodes', message: 'a diagram with no pieces in it draws nothing' });
    return errors;
  }

  const seen = new Set<string>();
  model.nodes.forEach((node, i) => {
    if (!node.id) { errors.push({ path: `nodes[${i}].id`, message: 'every piece needs an id, and it is what the arrows point at' }); return; }
    if (seen.has(node.id)) errors.push({ path: `nodes[${i}].id`, message: `"${node.id}" is used by another piece; an id names one thing` });
    seen.add(node.id);
    if (!node.name) errors.push({ path: `nodes[${i}].name`, message: 'a piece with no name is a box nobody can read' });
  });

  model.edges.forEach((edge, i) => {
    for (const end of ['from', 'to'] as const) {
      const id = edge[end];
      if (!id) errors.push({ path: `edges[${i}].${end}`, message: 'an arrow needs both ends' });
      else if (!seen.has(id)) errors.push({ path: `edges[${i}].${end}`, message: `"${id}" is not a piece of this diagram` });
    }
  });

  if (model.nodes.length > facts.maxNodes) {
    errors.push({
      path: 'nodes',
      message: `${model.nodes.length} pieces, and a "${facts.kind}" stops being read at ${facts.maxNodes}: split it, or filter it by what the reader came for`,
    });
  }

  for (const [i, view] of (model.views ?? []).entries()) {
    if (!view.name) errors.push({ path: `views[${i}].name`, message: 'a view without a name is a button nobody can read' });
    if (!Array.isArray(view.ids) || view.ids.length === 0) errors.push({ path: `views[${i}].ids`, message: 'a view lights some pieces up: say which' });
    for (const [j, id] of (view.ids ?? []).entries()) {
      if (!seen.has(id)) errors.push({ path: `views[${i}].ids[${j}]`, message: `"${id}" is not a piece of this diagram` });
    }
  }

  for (const issue of positionIssues(model, facts)) {
    const i = issue.nodeId ? model.nodes.findIndex((n) => n.id === issue.nodeId) : -1;
    errors.push({ path: i >= 0 ? `nodes[${i}].x` : 'nodes', message: issue.text });
  }
  return errors;
}
