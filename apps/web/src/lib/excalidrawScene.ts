/**
 * The typed model, as a scene Excalidraw itself draws.
 *
 * This is a different bargain from `canvasModel.ts`, and the difference is the whole point.
 * There, elements were **hit boxes**: invisible things a pointer could grab while the engine
 * painted the picture underneath. Here they are the picture. Excalidraw renders them with
 * its own Rough.js, its own fonts and its own toolbar, which is what «be Excalidraw» means.
 *
 * What has to survive the trip is the vocabulary. This catalogue tells a store from a
 * service by its **silhouette** — fourteen forms, declared per class in `SKINS` — and
 * Excalidraw draws three: a rectangle, a diamond and an ellipse. So the eleven it does not
 * have are handed to it as closed `line` elements, sampled from the very outline the engine
 * would have drawn. Excalidraw renders those with the same hand as everything else, so a
 * cylinder is still a cylinder and it is still Excalidraw drawing it.
 *
 * The tones come from the engine's sheet, the one place a colour is written. A piece is
 * never told apart by colour alone — the shape says what it is and the tone agrees with it.
 */
import {
  ADVANCE, paints, SKINS, TONES, pathPoints, renderTyped, sizeOf, wrap,
  type DiagramEdge, type DiagramModel, type DiagramNode, type DiagramSkin, type SkinRole,
} from '@laru/diagrams';
import { instantiate, itemFor, type Templates } from './libraryScene.ts';

/** What Excalidraw needs to be handed. Kept loose on purpose: its element types are enormous. */
type Element = Record<string, unknown>;

/** Excalidraw's own three. Everything else is a polygon of points. */
const NATIVE: Partial<Record<SkinRole['form'], 'rectangle' | 'diamond' | 'ellipse'>> = {
  rect: 'rectangle',
  rounded: 'rectangle',
  boundary: 'rectangle',
  entity: 'rectangle',
  class: 'rectangle',
  diamond: 'diamond',
  terminal: 'ellipse',
};

const seedOf = (id: string): number => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  // Excalidraw mints seeds in [0, 2^31). Ours is the piece's id, so a drawing is stable.
  return (h >>> 1) % 2147483647;
};

let counter = 0;
const nextId = (id: string) => `${id}-${(counter += 1).toString(36)}`;

/** Identity and nothing else, for an element whose whole look comes from somewhere else. */
const mint = (id: string): Element => ({
  id: nextId(id), seed: seedOf(id), version: 1, versionNonce: 1, isDeleted: false, updated: 1, angle: 0,
});

const base = (id: string, role: SkinRole, extra: Element): Element => {
  const tone = TONES[role.tone as keyof typeof TONES] ?? TONES.step;
  return {
    id: nextId(id),
    seed: seedOf(id),
    versionNonce: 1,
    version: 1,
    isDeleted: false,
    angle: 0,
    strokeColor: tone.stroke,
    backgroundColor: tone.fill,
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: role.form === 'boundary' ? 'dashed' : 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
    ...extra,
  };
};

/**
 * The outline of a form Excalidraw does not have, as the points it takes.
 *
 * Read off the engine's own silhouette rather than re-derived, for the reason the engine's
 * renderer gives for having one `outline()`: a second copy of a shape drifts from the first,
 * and this catalogue already paid for that once.
 */
function silhouette(svg: string, x: number, y: number): Array<[number, number]> | undefined {
  const d = /<path\b[^>]*?\sd="([^"]+)"/.exec(svg)?.[1];
  const run = d ? pathPoints(d).find((r) => r.closed) : undefined;
  if (!run || run.points.length < 3) return undefined;
  return run.points.map(([px, py]) => [px - x, py - y] as [number, number]);
}

export interface Scene {
  elements: Element[];
  /** What the drawing is called, for the editor's own title. */
  name: string;
}

/**
 * The model as a scene.
 *
 * The geometry is the engine's: placement solved it, the router traced the arrows, and the
 * composition pass already judged the result. Excalidraw is handed the answer and asked to
 * draw it — not asked to lay it out, which it has no way of doing well for a typed diagram.
 */
export function toScene(model: DiagramModel, templates?: Templates): Scene {
  counter = 0;
  const skin: DiagramSkin | undefined = SKINS[model.kind as keyof typeof SKINS];
  // A drawing nobody has started is not a failure: the engine refuses to paint one, and the
  // editor opens on an empty canvas waiting for the first piece.
  if (!model.nodes?.length || !paints(model)) return { elements: [], name: model.title || model.kind };
  const painted = renderTyped(model, { idPrefix: 'x', hand: false });
  const boxOf = new Map(painted.boxes.filter((b) => b.kind === 'node').map((b) => [b.id, b]));
  const elements: Element[] = [];
  const byModel = new Map<string, Element>();

  // The boundaries first: they go underneath what they hold, and z-order here is array order.
  const order = [...model.nodes].sort((a, b) => {
    const fa = skin?.roles.find((r) => r.shape === a.shape)?.form === 'boundary' ? 0 : 1;
    const fb = skin?.roles.find((r) => r.shape === b.shape)?.form === 'boundary' ? 0 : 1;
    return fa - fb;
  });

  for (const node of order) {
    const role = skin?.roles.find((r) => r.shape === node.shape) ?? { shape: node.shape, form: 'rect' as const, tone: 'step' as const };
    const box = boxOf.get(node.id) ?? { x: node.x, y: node.y, ...sizeOf(node) };

    /*
     * The library first, when the class has one and it has an item for this shape. This is
     * the whole point of installing it: a person is drawn with the library's person, in its
     * blues, with its three caption lines — not with a silhouette of ours while the library
     * waits unused in a panel. The box is still the engine's; only the drawing is theirs.
     */
    const tpl = templates?.get(itemFor(node.shape, node.technology) ?? '');
    if (tpl) {
      const drawn = instantiate(tpl, box, node, node.id, mint, role.form === 'boundary');
      byModel.set(node.id, drawn[0]);
      elements.push(...drawn);
      continue;
    }

    const native = NATIVE[role.form];
    const group = [`g-${node.id}`];
    /** The box that carries the piece's identity, and the outline drawn over it if any. */
    let shape: Element;
    let outline: Element | undefined;
    const anchor = (extra: Element = {}) => base(node.id, role, {
      type: 'rectangle', x: box.x, y: box.y, width: box.w, height: box.h, groupIds: group,
      customData: { role: role.form === 'boundary' ? 'boundary' : 'piece', modelId: node.id },
      ...extra,
    });

    if (native) {
      shape = base(node.id, role, {
        type: native, x: box.x, y: box.y, width: box.w, height: box.h, groupIds: group,
        roundness: role.form === 'rounded' || role.form === 'boundary' ? { type: 3 } : null,
        customData: { role: role.form === 'boundary' ? 'boundary' : 'piece', modelId: node.id },
      });
    } else {
      /*
       * A form Excalidraw has no name for. It becomes a closed line through the engine's own
       * outline — which Excalidraw draws with the same hand as its own shapes, so the piece
       * is still recognisable as what it is rather than becoming another rectangle.
       */
      const points = silhouette(painted.svg.slice(painted.svg.indexOf(`data-id="${node.id}"`)), box.x, box.y);
      if (!points) {
        // Nothing to trace: a plain box, which is at least where the piece is.
        shape = anchor();
      } else {
        /*
         * The outline does not carry the piece's identity; a transparent box exactly the size
         * the engine placed does, underneath it — the same arrangement a piece drawn from a
         * library gets, where the mark could not sit on a person's head either.
         *
         * Because a line's first point is its origin and Excalidraw enforces that: handed a
         * polygon starting anywhere else it shifts the element and subtracts the difference,
         * and a queue's outline starts fourteen pixels in at the far side of its cap. Keeping
         * that offset and subtracting it on the way back worked until somebody resized —
         * Excalidraw scales the points and folds the offset into the origin, so a fixed
         * subtraction came back short by the scale and the piece jumped sideways.
         */
        const [ox, oy] = points[0];
        shape = anchor({ strokeColor: 'transparent', backgroundColor: 'transparent', roughness: 0 });
        outline = base(`${node.id}-art`, role, {
          type: 'line', x: box.x + ox, y: box.y + oy, width: box.w, height: box.h, groupIds: group,
          points: [...points, points[0]].map(([px, py]) => [px - ox, py - oy]),
          lastCommittedPoint: null, startBinding: null, endBinding: null,
          startArrowhead: null, endArrowhead: null, polygon: true,
          customData: { role: 'art', modelId: node.id },
        });
      }
    }
    byModel.set(node.id, shape);
    elements.push(shape);
    if (outline) elements.push(outline);

    if (!node.name) continue;
    const tone = TONES[role.tone as keyof typeof TONES] ?? TONES.step;
    /*
     * What a piece says is its name, the technology it runs on and what it does — the three
     * the model declares and the three the engine paints. Only the name used to reach the
     * scene, so a container that reads «API Gateway / [Spring Boot] / charges the card» in
     * the viewer became a box with two words in it the moment it was opened for editing,
     * and the drawing looked poorer in the editor than in the page it came from.
     */
    const said: Array<{ of: string; text: string; size: number; advance: number }> = [
      { of: 'name', text: node.name, size: 16, advance: ADVANCE.name },
    ];
    if (role.form !== 'boundary') {
      if (node.technology) said.push({ of: 'technology', text: `[${node.technology}]`, size: 12, advance: ADVANCE.label });
      if (node.description) said.push({ of: 'description', text: node.description, size: 12, advance: ADVANCE.body });
    }
    /*
     * Wrapped with the engine's own numbers, because the engine's own numbers are what
     * decided how wide and how tall this box is. An unwrapped description is one long line
     * that runs out of both sides of the piece — Excalidraw only re-wraps text that is bound
     * to a container, and a piece that says three things cannot bind any of them.
     */
    const room = Math.max(24, box.w - 16);
    const lines = said.map((l) => {
      const rows = wrap(l.text, room, l.size, l.advance);
      // `text` is what is drawn and `originalText` is what was said: the model gets the
      // second one back, or a description would gain a line break every time it is opened.
      return { ...l, text: rows.join('\n'), said: l.text, rows: rows.length };
    });

    /*
     * A `line` cannot hold bound text in Excalidraw — only its three shapes and an arrow can
     * — so the name is its own element, grouped with the silhouette. Grouped, it moves with
     * it, which is the behaviour a bound label would have given anyway. And a piece with
     * more than one line cannot bind either: Excalidraw centres a bound text in its
     * container, so the two lines underneath would be drawn straight through it.
     */
    const bindable = Boolean(native) && role.form !== 'boundary' && lines.length === 1;
    const tall = lines.reduce((h, l) => h + l.rows * Math.round(l.size * 1.25) + 2, -2);
    let y = role.form === 'boundary' ? box.y + 6 : box.y + Math.max(6, (box.h - tall) / 2);

    for (const line of lines) {
      const height = line.rows * Math.round(line.size * 1.25);
      const text = base(`${node.id}-${line.of}`, role, {
        type: 'text',
        x: box.x + 8,
        y: bindable ? box.y + box.h / 2 - 12 : y,
        width: room,
        height: bindable ? 25 : height,
        text: line.text,
        originalText: line.said,
        fontSize: line.size,
        fontFamily: 5,
        textAlign: role.form === 'boundary' ? 'left' : 'center',
        verticalAlign: 'middle',
        strokeColor: tone.ink,
        backgroundColor: 'transparent',
        containerId: bindable ? shape.id : null,
        lineHeight: 1.25,
        groupIds: bindable ? [] : group,
        customData: { role: line.of, modelId: node.id },
      });
      if (bindable) (shape as { boundElements: unknown[] }).boundElements = [{ id: text.id, type: 'text' }];
      elements.push(text);
      y += height + 2;
    }
  }

  for (const edge of model.edges) {
    const line = painted.lines.find((l) => l.id === edge.id);
    const from = byModel.get(edge.from);
    const to = byModel.get(edge.to);
    if (!line || line.points.length < 2 || !from || !to) continue;
    const head = line.points[0];
    /*
     * The route is the engine's, point for point. Excalidraw would re-trace it between the
     * two boxes it is bound to and see nothing else in the drawing; this router avoids every
     * piece and looks for a free lane, and that is the difference between a diagram you can
     * read and a diagram of crossed wires.
     */
    elements.push(base(edge.id, { shape: '', form: 'rect', tone: 'step' }, {
      type: 'arrow',
      x: head.x,
      y: head.y,
      width: Math.max(...line.points.map((p) => p.x)) - Math.min(...line.points.map((p) => p.x)),
      height: Math.max(...line.points.map((p) => p.y)) - Math.min(...line.points.map((p) => p.y)),
      points: line.points.map((p) => [p.x - head.x, p.y - head.y]),
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      strokeWidth: 1,
      roughness: 1,
      lastCommittedPoint: null,
      startBinding: { elementId: from.id, focus: 0, gap: 1 },
      endBinding: { elementId: to.id, focus: 0, gap: 1 },
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: false,
      customData: { role: 'edge', modelId: edge.id },
    }));

    const label = [edge.label, edge.technology && `[${edge.technology}]`].filter(Boolean).join(' ');
    if (!label) continue;
    const at = painted.boxes.find((b) => b.kind === 'label' && b.id === edge.id);
    if (!at) continue;
    elements.push(base(`${edge.id}-l`, { shape: '', form: 'rect', tone: 'step' }, {
      type: 'text', x: at.x, y: at.y, width: at.w, height: at.h,
      text: label, originalText: label, fontSize: 12, fontFamily: 5,
      textAlign: 'center', verticalAlign: 'top', strokeColor: '#1e1e1e',
      backgroundColor: 'transparent', containerId: null, lineHeight: 1.25,
      // Marked like everything else. It is read back by nobody, but an unmarked element is
      // one the adoption pass would one day mistake for a piece somebody drew by hand.
      customData: { role: 'edgeLabel', modelId: edge.id },
    }));
  }

  return { elements, name: model.title || model.kind };
}

/* ---------------------------------------------------------------------------------- */
/* And back                                                                             */
/* ---------------------------------------------------------------------------------- */

interface Held { role?: string; modelId?: string }

/**
 * The scene back into the model, and only what the model can say.
 *
 * Deterministic on purpose: it starts from the model the scene was built from and patches
 * what moved, so a drawing opened and closed without a touch writes the same bytes. What
 * comes back is a position, a size the author actually gave, and a name — never a route.
 * Excalidraw re-traces a bound arrow from the two boxes it is tied to and can see nothing
 * else in the drawing; keeping that would replace a router that avoids every piece with one
 * that avoids two.
 *
 * A boundary is not read back at all: the engine grows it around what it holds, on every
 * paint, so whatever box it has here is a consequence and not a decision.
 */
export function fromScene(elements: readonly unknown[], model: DiagramModel): DiagramModel {
  const pieces = new Map<string, Record<string, number>>();
  /** What each piece says, by the slot it says it in: `name`, `technology`, `description`. */
  const said = new Map<string, Record<string, string>>();
  const SLOTS = new Set(['name', 'technology', 'description']);
  const says = (id: string, slot: string, text: string) =>
    said.set(id, { ...(said.get(id) ?? {}), [slot]: text });

  for (const raw of elements) {
    const el = raw as Record<string, unknown> & { customData?: Held };
    if (el.isDeleted) continue;
    const held = el.customData;
    if (!held?.modelId) continue;
    if (held.role === 'piece') pieces.set(held.modelId, el as never);
    else if (held.role && SLOTS.has(held.role)) says(held.modelId, held.role, String(el.originalText ?? el.text ?? ''));
  }
  // A name bound to one of Excalidraw's own three shapes carries the container's id, not ours.
  for (const raw of elements) {
    const el = raw as Record<string, unknown> & { containerId?: string };
    if (el.type !== 'text' || !el.containerId) continue;
    const owner = (elements as Array<Record<string, unknown> & { customData?: Held }>)
      .find((o) => o.id === el.containerId)?.customData?.modelId;
    if (owner) says(owner, 'name', String(el.originalText ?? el.text ?? ''));
  }

  const round = (v: unknown) => Math.round(Number(v) || 0);

  /*
   * What was drawn here, rather than compiled into here.
   *
   * Excalidraw will draw anything — a shape dragged out of the library, a rectangle typed
   * into existence — and none of it carries the marks that say which piece of the model it
   * is, because it is not one yet. Before this, «Insert» on a drawing made that way wrote
   * nothing at all and said nothing either: the model still had zero pieces, so there was
   * nothing to write.
   *
   * So a shape that nobody compiled becomes a piece. Its name is whatever text it carries —
   * bound to it, or grouped with it, which is how every library item in this catalogue is
   * built. Its shape is the class's own default, because Excalidraw has no way of saying
   * «this is a data store» and guessing from a silhouette would be worse than asking.
   */
  const known = new Set(model.nodes.map((n) => n.id));
  const adopted: DiagramNode[] = [];
  /** scene element id → the model piece it is (compiled, or adopted below), for the arrows drawn by hand */
  const drawnAs = new Map<string, string>();
  for (const el of elements as Array<Record<string, unknown> & { customData?: Held }>) {
    const h = el.customData;
    if (h?.modelId && h.role && h.role !== 'edge' && h.role !== 'edgeLabel') drawnAs.set(String(el.id), h.modelId);
  }
  const HOLDS = new Set(['rectangle', 'diamond', 'ellipse', 'line']);
  const all = elements as Array<Record<string, unknown> & { customData?: Held; groupIds?: string[]; containerId?: string }>;
  const fallback = skinShape(model.kind);

  if (fallback) {
    const textOf = (el: (typeof all)[number]): string => {
      const bound = all.find((o) => o.type === 'text' && o.containerId === el.id);
      const group = el.groupIds?.length
        ? all.find((o) => o.type === 'text' && o.groupIds?.some((g) => el.groupIds!.includes(g)))
        : undefined;
      const text = String((bound ?? group)?.originalText ?? (bound ?? group)?.text ?? '').trim();
      // Library items carry their own caption lines; the first is the name of the thing.
      return text.split('\n')[0].slice(0, 80);
    };
    const taken = new Set(known);
    /*
     * One piece per group, not one per element. Every item in every installed library is a
     * group of several shapes — a person is a head and a body, a database is a cylinder and
     * a lid — so counting elements turned a single thing dragged out of the panel into two
     * or three pieces in the model, each with the same name and none with the right box.
     */
    const done = new Set<string>();
    const num = (v: unknown) => Number(v) || 0;
    for (const el of all) {
      if (el.isDeleted || el.customData?.modelId || !HOLDS.has(String(el.type))) continue;
      // A line that is not a closed shape is a connector somebody drew, not a piece.
      if (el.type === 'line' && !el.polygon) continue;
      const g = el.groupIds?.[0];
      if (g) { if (done.has(g)) continue; done.add(g); }
      // The piece is as big as everything in its group, which is what the author sees.
      const kin = g ? all.filter((o) => !o.isDeleted && o.groupIds?.includes(g)) : [el];
      const x = Math.min(...kin.map((o) => num(o.x)));
      const y = Math.min(...kin.map((o) => num(o.y)));
      const name = textOf(el);
      const base = slugOf(name) || 'pieza';
      let id = base;
      for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
      taken.add(id);
      for (const o of kin) drawnAs.set(String(o.id), id);
      adopted.push({
        id, shape: fallback, name: name || id,
        x: round(x), y: round(y),
        w: round(Math.max(...kin.map((o) => num(o.x) + num(o.width))) - x),
        h: round(Math.max(...kin.map((o) => num(o.y) + num(o.height))) - y),
      });
    }
  }

  /*
   * What was deleted on the canvas is deleted in the model: a piece whose every compiled element is gone (its arrows go
   * with it), an arrow whose line is gone. A piece the scene never drew (nothing compiled for it) is left alone.
   */
  const drawn = new Set<string>(), alive = new Set<string>(), edgesDrawn = new Set<string>(), edgesAlive = new Set<string>();
  for (const el of all) {
    const h = el.customData;
    if (!h?.modelId) continue;
    if (h.role === 'edge') { edgesDrawn.add(h.modelId); if (!el.isDeleted) edgesAlive.add(h.modelId); }
    else if (h.role !== 'edgeLabel') { drawn.add(h.modelId); if (!el.isDeleted) alive.add(h.modelId); }
  }
  const gone = new Set([...drawn].filter((id) => !alive.has(id)));

  /*
   * An arrow drawn by hand between two pieces is an arrow of the model: its ends are the pieces it is bound to, its
   * label the text written on it. One with a loose end says nothing about the system and is left on the canvas only.
   */
  const drawnEdges: DiagramEdge[] = [];
  const edgeIds = new Set(model.edges.map((e) => e.id));
  for (const el of all) {
    if (el.isDeleted || el.type !== 'arrow' || el.customData?.modelId) continue;
    const b = el as typeof el & { startBinding?: { elementId?: string } | null; endBinding?: { elementId?: string } | null };
    const from = drawnAs.get(String(b.startBinding?.elementId ?? '')), to = drawnAs.get(String(b.endBinding?.elementId ?? ''));
    if (!from || !to || from === to || gone.has(from) || gone.has(to)) continue;
    const text = all.find((o) => !o.isDeleted && o.type === 'text' && o.containerId === el.id);
    let id = `${from}-${to}`;
    for (let i = 2; edgeIds.has(id); i++) id = `${from}-${to}-${i}`;
    edgeIds.add(id);
    const label = String(text?.originalText ?? text?.text ?? '').trim();
    drawnEdges.push({ id, from, to, ...(label ? { label } : {}) });
  }

  return {
    ...model,
    edges: [...model.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to) && (!edgesDrawn.has(e.id) || edgesAlive.has(e.id))), ...drawnEdges],
    nodes: [...model.nodes.filter((node) => !gone.has(node.id)).map((node) => {
      const el = pieces.get(node.id);
      if (!el) return node;
      const next = { ...node, x: round(el.x), y: round(el.y) };
      /*
       * Only the slots that are actually on the canvas are written back. A piece with no
       * description has no description element, and reading its absence as «the author
       * cleared it» would delete from the model what the drawing never had room to show.
       */
      const words = said.get(node.id);
      if (words?.name !== undefined && words.name !== node.name) next.name = words.name;
      if (words?.technology !== undefined) {
        const tech = words.technology.replace(/^\s*\[|\]\s*$/g, '').trim();
        if (tech !== (node.technology ?? '')) next.technology = tech || undefined;
      }
      if (words?.description !== undefined && words.description !== node.description) {
        next.description = words.description || undefined;
      }
      // A size travels only when the author had already given one: the engine widens a piece
      // to fit its own name, and writing every box back would freeze that calculation.
      if (node.w !== undefined) next.w = round(el.width);
      if (node.h !== undefined) next.h = round(el.height);
      return next;
    }), ...adopted],
  };
}

/**
 * The shape a class gives a piece nobody typed.
 *
 * A plain box, by preference. The first role a skin happens to declare is often `Person`,
 * and calling every shape somebody drags in a person is a worse guess than calling it a box:
 * a box is what the reader assumes when nothing says otherwise, and the inspector is one
 * click away for whoever meant something else.
 */
function skinShape(kind: string): string | undefined {
  const roles = SKINS[kind as keyof typeof SKINS]?.roles ?? [];
  for (const form of ['rect', 'rounded', 'node', 'stadium'] as const) {
    const found = roles.find((r) => r.form === form);
    if (found) return found.shape;
  }
  return roles.find((r) => r.form !== 'boundary')?.shape;
}

/** A readable id from a name, so a drawn piece is not `element-7` for ever. */
const slugOf = (name: string): string =>
  name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
