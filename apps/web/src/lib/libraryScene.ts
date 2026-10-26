/**
 * A piece drawn with the library's own item, instead of with a silhouette of ours.
 *
 * Installing a library so the author can drag a shape out of a panel is the small half of
 * what a library is for. The large half is this one: when the catalogue already knows a
 * piece is a person, an existing system or a database, the drawing should be made **of** the
 * library's own items — the same boxes, the same C4 blues, the same three caption lines —
 * and not of our shapes with the library sitting unused beside them.
 *
 * So a C4 item is read as a **template**: everything that is not writing is the silhouette,
 * and the three unbound texts are slots. The item's own geometry tells them apart with no
 * list to maintain — `[software system]` is bracketed, the name is the largest face, and
 * what is left is the description. That is exactly the shape of a C4 node in this model
 * (`name`, `technology`, `description`), which is why the mapping is a mapping and not a
 * translation.
 *
 * What the library does NOT get to decide is where a piece goes. Placement is the engine's,
 * the router traced every arrow around every box, and the composition pass already judged
 * the result; the item is scaled into the box that answer produced. A library that also laid
 * out would be a worse layout engine wearing a better skin.
 *
 * The C4 library is Dmitry Burnyshev's, MIT, vendored in
 * `packages/diagrams/icons/upstream/excalidraw-libraries/` with its provenance.
 */
import { ADVANCE, wrap } from '@laru/diagrams';

type El = Record<string, unknown>;

const num = (v: unknown): number => Number(v) || 0;

/** A caption the model can fill. The three are exactly the three a C4 piece declares. */
type Slot = 'name' | 'technology' | 'description';

export interface Template {
  /** Everything that is not writing, in the item's own coordinates. */
  shapes: El[];
  /** The caption slots, each with the text element the library drew it as. */
  slots: Array<{ of: Slot; el: El }>;
  x: number; y: number; w: number; h: number;
}

export type Templates = Map<string, Template>;

/**
 * Which item of the C4 library draws which shape of the C4 skins.
 *
 * The library publishes ten items and the four C4 skins declare eleven shapes between them,
 * so this is not a bijection and pretending otherwise would be the lie. A queue has no item
 * — C4 has no queue and neither does the library — and those shapes are left to the engine's
 * own silhouette rather than drawn as something they are not.
 */
const C4_ITEMS: Record<string, string> = {
  Person: 'Person',
  Person_Ext: 'Person',
  System: 'System',
  SystemDb: 'Database',
  System_Ext: 'Existing System',
  Container: 'System',
  ContainerDb: 'Database',
  Component: 'Component',
  ComponentDb: 'Database',
  Enterprise_Boundary: 'Group',
  System_Boundary: 'Group',
  Container_Boundary: 'Group',
};

/**
 * The container the technology names, when it names one the library has drawn.
 *
 * This is the point of the whole file in miniature: the model knows a container is an
 * Angular front end or an iOS app, and the library has an item for each, so the model gets
 * to choose. Anything it does not recognise stays the plain box, which is what a container
 * is when nobody said otherwise — never a guess dressed as a fact.
 */
export function itemFor(shape: string, technology?: string): string | undefined {
  if (shape === 'Container' && technology) {
    if (/\b(android|ios|swift|kotlin|flutter|react native|mobile|móvil)\b/i.test(technology)) return 'Mobile App';
    if (/\b(angular|react|vue|svelte|next\.?js|spa|browser|navegador|web)\b/i.test(technology)) return 'Web App';
  }
  return C4_ITEMS[shape];
}

/** The box every element of an item fits in. */
function bounds(elements: readonly El[]): { x: number; y: number; w: number; h: number } {
  const x = Math.min(...elements.map((e) => num(e.x)));
  const y = Math.min(...elements.map((e) => num(e.y)));
  return {
    x, y,
    w: Math.max(...elements.map((e) => num(e.x) + num(e.width))) - x,
    h: Math.max(...elements.map((e) => num(e.y) + num(e.height))) - y,
  };
}

/**
 * An item read as a template.
 *
 * The three slots are told apart by what the library itself drew, not by a list of strings
 * that would rot the first time upstream rewords a placeholder: the bracketed line is the
 * type, the largest face is the name, and whatever is left over is the description. An item
 * with one caption — the boundary — yields one slot, and that is not a failure.
 */
function templateOf(elements: readonly El[]): Template | undefined {
  if (!elements.length) return undefined;
  const texts = elements.filter((e) => e.type === 'text' && !e.containerId)
    .sort((a, b) => num(a.y) - num(b.y));
  const shapes = elements.filter((e) => !texts.includes(e));
  if (!shapes.length) return undefined;

  const slots: Template['slots'] = [];
  const rest = [...texts];
  const bracketed = rest.findIndex((e) => /^\s*\[[^\]]*\]\s*$/.test(String(e.text ?? '')));
  const tech = bracketed >= 0 ? rest.splice(bracketed, 1)[0] : undefined;
  const biggest = rest.reduce<El | undefined>((best, e) => (!best || num(e.fontSize) > num(best.fontSize) ? e : best), undefined);
  if (biggest) { slots.push({ of: 'name', el: biggest }); rest.splice(rest.indexOf(biggest), 1); }
  if (tech) slots.push({ of: 'technology', el: tech });
  if (rest.length) slots.push({ of: 'description', el: rest[0] });

  return { shapes, slots, ...bounds(elements) };
}

/**
 * The templates a class draws with, or none.
 *
 * Only the four C4 levels for now, and deliberately: C4 is the notation whose library was
 * published with this catalogue's own vocabulary in it — a person, a system, an existing
 * system, a database — so the mapping is a fact about the notation rather than a taste. A
 * class with no templates is drawn exactly as before.
 */
export async function templatesFor(kind: string): Promise<Templates> {
  const out: Templates = new Map();
  if (!kind.startsWith('c4-')) return out;
  let items: Array<{ name?: string; elements?: El[] }> = [];
  try {
    const file = (await import('../generated/libraries/c4.excalidrawlib.json')).default as {
      libraryItems?: Array<{ name?: string; elements?: El[] }>;
    };
    items = file.libraryItems ?? [];
  } catch {
    // A library that was never copied is a build that half ran, and the author still has to
    // be able to draw: the class falls back to the engine's silhouettes with nothing said.
    return out;
  }
  const byName = new Map(items.map((i) => [String(i.name ?? ''), i]));
  const wanted = new Set([...Object.values(C4_ITEMS), 'Web App', 'Mobile App']);
  for (const name of wanted) {
    const item = byName.get(name);
    const tpl = item?.elements && templateOf(item.elements);
    if (tpl) out.set(name, tpl);
  }
  return out;
}

/** What the model has to say inside a piece. */
export interface Captions { name?: string; technology?: string; description?: string }

/**
 * One piece, drawn with the template, inside the box the engine placed it in.
 *
 * The silhouette is scaled into the box; the captions are not. Text scaled by the same
 * factor as its box is text at whatever size the arithmetic landed on — 11px on a narrow
 * piece, 24px on a wide one, in the same drawing — so a caption keeps the size the library
 * chose. Only a genuinely small box shrinks the face, and only down to a floor, because
 * unreadable is worse than tight.
 *
 * They are wrapped and stacked with the **engine's** own measurements, not with a canvas
 * measurement of Excalidraw's. That is not a preference: `sizeOf` decided how tall this box
 * is by wrapping these very strings with these very numbers, so anything else is a second
 * opinion about a box that was already built on the first — and a second opinion wrong by
 * two characters puts the description below the piece, which is where it was ending up.
 */
export function instantiate(
  tpl: Template,
  box: { x: number; y: number; w: number; h: number },
  caps: Captions,
  modelId: string,
  key: (suffix: string) => El,
  boundary = false,
): El[] {
  const sx = tpl.w > 0 ? box.w / tpl.w : 1;
  const sy = tpl.h > 0 ? box.h / tpl.h : 1;
  const group = [`g-${modelId}`];

  /*
   * A transparent box the size of the piece, underneath everything, is what carries the
   * piece's identity. Without it the mark would have to sit on one of the library's own
   * elements — a person's head, the lid of a cylinder — and reading the drawing back would
   * write that element's corner as the piece's position, so a drawing opened and saved
   * untouched would walk across the canvas a little further every time.
   */
  const out: El[] = [{
    ...key(`${modelId}-anchor`),
    type: 'rectangle',
    x: box.x, y: box.y, width: box.w, height: box.h,
    strokeColor: 'transparent',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    roundness: null,
    groupIds: group,
    customData: { role: boundary ? 'boundary' : 'piece', modelId },
  }];

  for (const [i, e] of tpl.shapes.entries()) {
    const shape: El = {
      ...e,
      ...key(`${modelId}-s${i}`),
      x: box.x + (num(e.x) - tpl.x) * sx,
      y: box.y + (num(e.y) - tpl.y) * sy,
      width: num(e.width) * sx,
      height: num(e.height) * sy,
      groupIds: group,
      boundElements: [],
      containerId: null,
      frameId: null,
      link: null,
      locked: false,
      customData: { role: 'art', modelId },
    };
    /*
     * A boundary keeps the library's dashed keyline and loses its fill. The item is hatched,
     * which reads well at the size it was drawn at and as noise behind the six pieces a real
     * boundary holds — and a region exists so that what is inside it can be read.
     */
    if (boundary) shape.backgroundColor = 'transparent';
    // A line or an arrow keeps its shape in its points, which are relative to its corner.
    if (Array.isArray(e.points)) {
      shape.points = (e.points as Array<[number, number]>).map(([px, py]) => [px * sx, py * sy]);
    }
    out.push(shape);
  }

  const face = Math.min(1, Math.max(0.72, Math.min(sx, sy)));
  /*
   * The band the library reserved for writing, as a fraction of the item: a person's
   * captions live in the body below the head, and dropping that would print the name across
   * the face. The block is laid out from there and pushed back in if it overruns, because a
   * caption inside a piece it slightly crowds still reads, and one below the piece belongs
   * to whatever is underneath.
   */
  const slotTop = Math.min(...tpl.slots.map((s) => num(s.el.y)));
  const bandTop = box.y + ((slotTop - tpl.y) / (tpl.h || 1)) * box.h;
  const room = Math.max(24, box.w - 16);

  const written = tpl.slots.flatMap((slot) => {
    const text = String(caps[slot.of] ?? '').trim();
    if (!text) return [];
    const body = slot.of === 'technology' && !/^\[.*\]$/.test(text) ? `[${text}]` : text;
    const size = Math.max(9, Math.round(num(slot.el.fontSize) * face));
    // The advance the engine uses for this kind of writing: a name, a label, a description.
    const advance = slot.of === 'name' ? ADVANCE.name : slot.of === 'technology' ? ADVANCE.label : ADVANCE.body;
    const lines = wrap(body, room, size, advance);
    return [{ slot, body, size, lines, height: lines.length * Math.round(size * 1.25) }];
  });

  const tall = written.reduce((h, w) => h + w.height + 2, -2);
  let y = Math.max(box.y + 4, Math.min(bandTop, box.y + box.h - tall - 4));

  for (const { slot, body, size, lines, height } of written) {
    /*
     * The width is the piece's, not the string's, and the alignment does the centring:
     * Excalidraw lays each line out inside `width` starting at `x`, so there is no measured
     * width to be wrong about.
     */
    out.push({
      ...styleOf(slot.el),
      ...key(`${modelId}-${slot.of}`),
      type: 'text',
      x: box.x + 8,
      y,
      width: room,
      height,
      text: lines.join('\n'),
      originalText: body,
      fontSize: size,
      lineHeight: 1.25,
      textAlign: 'center',
      verticalAlign: 'top',
      containerId: null,
      boundElements: [],
      groupIds: group,
      customData: { role: slot.of, modelId },
    });
    y += height + 2;
  }
  return out;
}

/** The library's own styling of a caption, minus everything that is position or identity. */
const styleOf = (el: El): El => ({
  strokeColor: el.strokeColor,
  backgroundColor: 'transparent',
  fillStyle: el.fillStyle ?? 'solid',
  strokeWidth: el.strokeWidth ?? 1,
  strokeStyle: el.strokeStyle ?? 'solid',
  roughness: el.roughness ?? 1,
  opacity: 100,
  fontFamily: el.fontFamily ?? 1,
  roundness: null,
  angle: 0,
  frameId: null,
  link: null,
  locked: false,
});
