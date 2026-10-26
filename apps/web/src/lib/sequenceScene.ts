/**
 * A sequence, as a scene Excalidraw itself draws — and back.
 *
 * The bargain is the one `excalidrawScene.ts` makes for the families of boxes: the engine
 * places, Excalidraw draws. What changes is what «placed» means. A box diagram carries its
 * positions, so a drag is a new `x`; a sequence carries none — `SequenceParticipant` has an
 * id, a label and whether it is an actor, and nothing else. The columns are the participants
 * in the order they were declared and the rows are the messages in the order they were
 * written, so the only spatial fact a sequence has is **order**.
 *
 * That decides the whole read-back. Dragging a header sideways past its neighbour reorders
 * `participants`, which is the drawing the author asked for; dragging it up or down asks for
 * nothing the model can say, and is dropped. A row's height is the walk down the list and is
 * never read back either.
 *
 * Only what the model can hold travels. `message` and `note` carry a text and come back with
 * it; a `block` boundary is an `alt` with a frame the engine grows around the rows it covers,
 * and a `raw` line is something the parser did not understand. Both are **drawn where they
 * can be and returned untouched** — a row that cannot survive the canvas keeps the bytes it
 * arrived with, because losing one silently is worse than not drawing it.
 */
import {
  TONES, renderTyped,
  type SequenceDiagram, type SequenceRow, type Tone,
} from '@laru/diagrams';

/** What Excalidraw needs to be handed. Kept loose on purpose: its element types are enormous. */
type Element = Record<string, unknown>;

/*
 * `seedOf`, `nextId` and `base` are a second copy of the scaffolding in `excalidrawScene.ts`,
 * deliberately. That file is being edited in parallel; lifting them into a shared module
 * would put two people on one line for the sake of thirty that never change.
 */
const seedOf = (id: string): number => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  // Excalidraw mints seeds in [0, 2^31). Ours is the row's own name, so a drawing is stable.
  return (h >>> 1) % 2147483647;
};

let counter = 0;
const nextId = (id: string) => `${id}-${(counter += 1).toString(36)}`;

const base = (id: string, tone: Tone, extra: Element): Element => ({
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
  strokeStyle: 'solid',
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
});

/** What this module writes on an element, so reading the scene back can find the row again. */
interface Held {
  /**
   * `participant` and `text` are read back; the rest is the drawing.
   *
   * A lifeline, a block frame and a divider are consequences of the walk down the rows — move
   * one and there is nothing in the model to write — so they are drawn and never interrogated.
   */
  role?: 'participant' | 'name' | 'text' | 'message' | 'note' | 'lifeline' | 'block';
  /** The participant's id, or the row's — `m<index>` for a message, `n<index>` for a note. */
  modelId?: string;
}

export interface Scene {
  elements: Element[];
  /** What the drawing is called, for the editor's own title. */
  name: string;
}

const unesc = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/**
 * The frames an `alt`, an `opt` or a `loop` draws, read off the painted sheet.
 *
 * The engine reports a box for every participant, note and label, and no box for a frame:
 * its top and bottom are decided by where the walk down the rows happened to be when the
 * keyword opened and closed, so there is nothing in the model to report them against. Read
 * from the SVG rather than re-derived, for the reason `excalidrawScene.ts` gives for reading
 * a silhouette the same way: a second copy of the layout drifts from the first, and this
 * catalogue has already paid for that once.
 *
 * The divider *lines* of an `alt` are inside the frame's group; its `else` *labels* are not,
 * so every `pd-block-label` in the sheet is collected once, wherever it sits.
 */
function furniture(svg: string): Element[] {
  const out: Element[] = [];
  let n = 0;
  for (const [, inner] of svg.matchAll(/<g class="pd-block">([\s\S]*?)<\/g>/g)) {
    const plate = /<rect class="pd-plate" x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(inner);
    if (plate) {
      const [x, y, w, h] = plate.slice(1, 5).map(Number);
      out.push(base(`block-${(n += 1)}`, TONES.frame, {
        type: 'rectangle', x, y, width: w, height: h,
        backgroundColor: 'transparent', strokeStyle: 'dashed', strokeWidth: 1,
        roundness: { type: 3 }, customData: { role: 'block' } satisfies Held,
      }));
    }
    for (const [, x1, y1, x2, y2] of inner.matchAll(/<path class="pd-divider" d="M(-?[\d.]+) (-?[\d.]+) L(-?[\d.]+) (-?[\d.]+)"/g)) {
      const [ax, ay, bx, by] = [x1, y1, x2, y2].map(Number);
      out.push(base(`divider-${(n += 1)}`, TONES.frame, {
        type: 'line', x: ax, y: ay, width: bx - ax, height: by - ay,
        points: [[0, 0], [bx - ax, by - ay]], lastCommittedPoint: null,
        backgroundColor: 'transparent', strokeStyle: 'dashed', strokeWidth: 1,
        startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null,
        customData: { role: 'block' } satisfies Held,
      }));
    }
  }
  for (const [, x, y, size, text] of svg.matchAll(/<text class="pd-block-label" x="(-?[\d.]+)" y="(-?[\d.]+)" font-size="([\d.]+)">([^<]*)<\/text>/g)) {
    const label = unesc(text);
    const px = Number(size);
    out.push(base(`block-label-${(n += 1)}`, TONES.frame, {
      // SVG puts a baseline where Excalidraw puts a top, which is the engine's own box
      // convention for a label: its `y` is the baseline less the point size.
      type: 'text', x: Number(x), y: Number(y) - px, width: label.length * px * 0.62, height: px * 1.25,
      text: label, originalText: label, fontSize: px, fontFamily: 5,
      textAlign: 'left', verticalAlign: 'top', strokeColor: TONES.frame.ink,
      backgroundColor: 'transparent', containerId: null, lineHeight: 1.25,
      customData: { role: 'block' } satisfies Held,
    }));
  }
  return out;
}

/** The number the engine writes in front of a message when the model is autonumbered. */
function leads(model: SequenceDiagram): Map<number, string> {
  const out = new Map<number, string>();
  if (!model.autonumber) return out;
  let order = 0;
  model.rows.forEach((row, i) => { if (row.kind === 'message') out.set(i, `${(order += 1)}. `); });
  return out;
}

/**
 * The model as a scene.
 *
 * The geometry is the engine's, down to the column widths: a sequence too wide for a reader's
 * column gets narrower columns and a name on two lines, and that budget is solved in
 * `render/sequence.ts`. Excalidraw is handed the answer and asked to draw it.
 */
export function sequenceToScene(model: SequenceDiagram): Scene {
  counter = 0;
  const name = model.title || 'sequence';
  // A sequence with nobody in it is not a failure: the engine refuses to draw one, and the
  // editor opens empty waiting for the first participant.
  if (!model.participants?.length) return { elements: [], name };

  const painted = renderTyped(model, { idPrefix: 'x', hand: false });
  const boxOf = (kind: 'node' | 'label', id: string) => painted.boxes.find((b) => b.kind === kind && b.id === id);
  // The engine ends every lifeline ten short of the sheet's bottom edge, which is the
  // viewBox's: `bottom - top` is its height and `top` its origin.
  const floor = painted.viewBox[1] + painted.viewBox[3] - 10;
  const elements: Element[] = [...furniture(painted.svg)];
  const lead = leads(model);

  for (const p of model.participants) {
    const at = boxOf('node', p.id);
    if (!at) continue;
    /* The tone is the sheet's and it agrees with the word the author used: a participant runs,
     * an actor is a person, and violet is the only thing a person is ever drawn in. */
    const tone = p.actor ? TONES.actor : TONES.runtime;
    const head = base(p.id, tone, {
      type: 'rectangle', x: at.x, y: at.y, width: at.w, height: at.h,
      roundness: { type: 3 }, customData: { role: 'participant', modelId: p.id } satisfies Held,
    });
    const text = base(`${p.id}-t`, tone, {
      type: 'text', x: at.x + 8, y: at.y + at.h / 2 - 12, width: at.w - 16, height: 25,
      text: p.label, originalText: p.label, fontSize: Math.round(at.fontSize), fontFamily: 5,
      textAlign: 'center', verticalAlign: 'middle', strokeColor: tone.ink,
      backgroundColor: 'transparent', containerId: head.id, lineHeight: 1.25,
      customData: { role: 'name', modelId: p.id } satisfies Held,
    });
    head.boundElements = [{ id: text.id, type: 'text' }];
    elements.push(head, text);

    elements.push(base(`${p.id}-life`, TONES.frame, {
      type: 'line', x: at.x + at.w / 2, y: at.y + at.h, width: 0, height: floor - (at.y + at.h),
      points: [[0, 0], [0, floor - (at.y + at.h)]], lastCommittedPoint: null,
      backgroundColor: 'transparent', strokeStyle: 'dashed', strokeWidth: 1,
      startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null,
      customData: { role: 'lifeline', modelId: p.id } satisfies Held,
    }));
  }

  model.rows.forEach((row, i) => {
    if (row.kind === 'message') return message(elements, row, `m${i}`, painted, lead.get(i) ?? '');
    if (row.kind === 'note') return note(elements, row, `n${i}`, boxOf('node', `n${i}`));
    /* `block` and `raw` are drawn by `furniture` or not at all: neither has a box of its own,
     * and both come back from `sceneToSequence` exactly as they went in. */
  });

  return { elements, name };
}

function message(
  elements: Element[],
  row: Extract<SequenceRow, { kind: 'message' }>,
  id: string,
  painted: ReturnType<typeof renderTyped>,
  lead: string,
): void {
  const line = painted.lines.find((l) => l.id === id);
  if (!line || line.points.length < 2) return;
  const head = line.points[0];
  const xs = line.points.map((p) => p.x);
  const ys = line.points.map((p) => p.y);
  /*
   * The route is the engine's, point for point, and unbound. A self-call is a bracket out to
   * the right and back; a plain message is one horizontal run at the height its row reached.
   * Binding it to the two headers would let Excalidraw re-trace it between them — vertically,
   * down the columns — which is not what a sequence is.
   */
  elements.push(base(id, TONES.step, {
    type: 'arrow', x: head.x, y: head.y,
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
    points: line.points.map((p) => [p.x - head.x, p.y - head.y]),
    strokeColor: '#1e1e1e', backgroundColor: 'transparent', strokeWidth: 1,
    strokeStyle: row.arrow.startsWith('--') ? 'dashed' : 'solid',
    lastCommittedPoint: null, startBinding: null, endBinding: null,
    startArrowhead: null, endArrowhead: 'arrow', elbowed: false,
    customData: { role: 'message', modelId: id } satisfies Held,
  }));

  const at = painted.boxes.find((b) => b.kind === 'label' && b.id === id);
  if (!at) return;
  const label = `${lead}${row.text}`;
  elements.push(base(`${id}-l`, TONES.step, {
    type: 'text', x: at.x, y: at.y, width: at.w, height: at.h,
    text: label, originalText: label, fontSize: Math.round(at.fontSize), fontFamily: 5,
    textAlign: 'left', verticalAlign: 'top', strokeColor: TONES.step.ink,
    backgroundColor: 'transparent', containerId: null, lineHeight: 1.25,
    customData: { role: 'text', modelId: id } satisfies Held,
  }));
}

function note(
  elements: Element[],
  row: Extract<SequenceRow, { kind: 'note' }>,
  id: string,
  at: { x: number; y: number; w: number; h: number; fontSize: number } | undefined,
): void {
  if (!at) return;
  /* The note's own parchment is written inside `sequenceStyle` and not exported; `channel` is
   * the sheet's warm tone and the nearest thing it publishes. */
  const tone = TONES.channel;
  const plate = base(id, tone, {
    type: 'rectangle', x: at.x, y: at.y, width: at.w, height: at.h,
    strokeWidth: 1, roundness: { type: 3 }, customData: { role: 'note', modelId: id } satisfies Held,
  });
  const text = base(`${id}-t`, tone, {
    type: 'text', x: at.x + 8, y: at.y + 8, width: at.w - 16, height: at.h - 16,
    text: row.text, originalText: row.text, fontSize: Math.round(at.fontSize), fontFamily: 5,
    textAlign: 'center', verticalAlign: 'middle', strokeColor: tone.ink,
    backgroundColor: 'transparent', containerId: plate.id, lineHeight: 1.25,
    customData: { role: 'text', modelId: id } satisfies Held,
  });
  plate.boundElements = [{ id: text.id, type: 'text' }];
  elements.push(plate, text);
}

/* ---------------------------------------------------------------------------------- */
/* And back                                                                             */
/* ---------------------------------------------------------------------------------- */

/**
 * The scene back into the model, and only what the model can say.
 *
 * Deterministic on purpose: it starts from the model the scene was built from and patches
 * what changed, so a drawing opened and closed without a touch writes the same bytes.
 *
 * Three things change. A header dragged past its neighbour reorders `participants` — the only
 * position a sequence has. A label retyped becomes the participant's `label`. A message or a
 * note retyped becomes that row's `text`. Everything else that was drawn — the lifelines, the
 * block frames, the dividers, the row heights — the engine derives on the next paint, so
 * reading it back would be writing down an answer as if it were a question.
 */
export function sceneToSequence(elements: readonly unknown[], model: SequenceDiagram): SequenceDiagram {
  const centres = new Map<string, number>();
  const labels = new Map<string, string>();
  const texts = new Map<string, string>();
  const read = (el: Record<string, unknown>) => String(el.originalText ?? el.text ?? '');

  for (const raw of elements) {
    const el = raw as Record<string, unknown> & { customData?: Held };
    if (el.isDeleted) continue;
    const held = el.customData;
    if (!held?.modelId) continue;
    if (held.role === 'participant') centres.set(held.modelId, (Number(el.x) || 0) + (Number(el.width) || 0) / 2);
    else if (held.role === 'name') labels.set(held.modelId, read(el));
    else if (held.role === 'text') texts.set(held.modelId, read(el));
  }
  // A text the author bound by double-clicking a shape carries the container's id and no
  // `customData` of ours: without this, typing a name straight onto a header went nowhere.
  for (const raw of elements) {
    const el = raw as Record<string, unknown> & { containerId?: string };
    if (el.type !== 'text' || !el.containerId) continue;
    const owner = (elements as Array<Record<string, unknown> & { customData?: Held }>)
      .find((o) => o.id === el.containerId)?.customData;
    if (!owner?.modelId) continue;
    if (owner.role === 'participant') labels.set(owner.modelId, read(el));
    else if (owner.role === 'note') texts.set(owner.modelId, read(el));
  }

  /*
   * Only the participants the scene actually reported are reordered, and they are put back
   * into the places they held. A participant Excalidraw never drew keeps its own slot rather
   * than being swept to one end of the row.
   */
  const placed = model.participants.filter((p) => centres.has(p.id));
  const ordered = [...placed].sort((a, b) => centres.get(a.id)! - centres.get(b.id)!);
  let k = 0;
  const participants = model.participants.map((p) => {
    const next = centres.has(p.id) ? ordered[k++] : p;
    const label = labels.get(next.id);
    return label !== undefined && label !== next.label ? { ...next, label } : next;
  });

  const lead = leads(model);
  const rows = model.rows.map((row, i) => {
    if (row.kind !== 'message' && row.kind !== 'note') return row;
    const text = texts.get(`${row.kind === 'message' ? 'm' : 'n'}${i}`);
    if (text === undefined) return row;
    // The number in front of an autonumbered message is the engine's, not the author's, and
    // writing it into `text` would number the row again on the next paint.
    const bare = text.startsWith(lead.get(i) ?? '\0') ? text.slice((lead.get(i) ?? '').length) : text;
    return bare === row.text ? row : { ...row, text: bare };
  });

  return { ...model, participants, rows };
}
