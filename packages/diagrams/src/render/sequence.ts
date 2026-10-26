/**
 * The family of sequences: who talks to whom, in what order.
 *
 * Nothing is searched for here. A sequence has no placement problem — the order of the
 * messages *is* the placement, and the columns are the participants in the order they were
 * declared — so the drawing is a walk down the rows. That is why this renderer is a
 * hundred lines and the box one is three hundred: the geometry was given.
 *
 * What it does share with the boxes is the `Rendered` shape, so the composition pass, the
 * viewer, the zoom, the export and the captures all treat a sequence like anything else.
 */
import type { SequenceModel, SequenceRow } from '../model.ts';
import type { RenderOptions, Rendered } from './boxes.ts';
import type { Register } from './sheet.ts';
import { esc, textWidth, wrap } from './text.ts';
import { INK, inkPath, inked } from './hand.ts';
import { FURNITURE, SIZE, registerOf, scopeOf, styleBlock } from './sheet.ts';

/** The blocks that open a frame, and the words that divide one. */
const OPENS = new Set(['alt', 'opt', 'loop', 'par', 'critical', 'break', 'rect', 'box']);
const DIVIDES = new Set(['else', 'and', 'option']);

const HEAD_H = 60;
const ROW_H = 46;
const NOTE_H = 44;
const SELF_W = 54;
const MIN_COL = 150;
/** How narrow a column may get when there are too many of them to fit. */
const MIN_COL_TIGHT = 118;
/**
 * How wide the whole drawing may get before its letters stop projecting large enough.
 *
 * The floor the composition pass measures is six pixels once the drawing is scaled into the
 * reader's column; the smallest text here is the note, at 0.72 of the base size. Eight
 * hundred and twenty times 10.8 over six is a shade under fifteen hundred, so this sits
 * under it with room for the padding.
 */
const BUDGET = 1420;
const PAD = 40;

interface Column { id: string; label: string; actor: boolean; x: number; w: number }

/**
 * How wide each column has to be for its name, and where its centre lands.
 *
 * With a budget. A drawing wider than the reader's column is scaled down and its letters go
 * with it, so past a point the honest move is narrower columns and a name on two lines
 * rather than a diagram nobody can read without zooming. The number is what keeps the
 * smallest text above the floor the composition pass measures.
 */
function columns(model: SequenceModel, font: number): Column[] {
  const natural = model.participants.map((p) => Math.max(MIN_COL, textWidth(p.label, font) + 40));
  const total = natural.reduce((a, b) => a + b, 0) + (natural.length - 1) * 20 + PAD * 2;
  const squeeze = total > BUDGET ? BUDGET / total : 1;
  let x = PAD;
  return model.participants.map((p, i) => {
    const w = Math.max(MIN_COL_TIGHT, Math.round(natural[i] * squeeze));
    const column = { id: p.id, label: p.label, actor: p.actor, x: x + w / 2, w };
    x += w + 20;
    return column;
  });
}

export function renderSequence(model: SequenceModel, opts: RenderOptions = {}): Rendered {
  const font = opts.fontSize ?? 15;
  const pad = opts.padding ?? 40;
  const prefix = opts.idPrefix ?? 'pd';
  const arrow = `${prefix}-arrow`;
  /*
   * The same ink as everywhere else. A sequence seeds from what a row *is* — who speaks to
   * whom, on which line — rather than from a counter, so inserting a message above does not
   * re-draw every arrow below it.
   */
  const nib = opts.hand ?? INK;
  const ink = (d: string, seed: string) => (nib === false ? d : inkPath(d, seed, nib));
  const inkShape = (svg: string, seed: string) => (nib === false ? svg : inked(svg, seed, nib));
  /* A sequence is a process sheet: the same register the flowcharts of this catalogue use. */
  const reg = registerOf('sequence');
  if (model.participants.length === 0) throw new Error('cannot draw "sequence": it has nobody in it');

  const cols = columns(model, font);
  const at = (id: string) => cols.find((c) => c.id === id);
  const boxes: Rendered['boxes'] = [];
  const lines: Rendered['lines'] = [];
  const body: string[] = [];
  const frames: string[] = [];

  let y = HEAD_H + 34;
  let order = 0;
  const open: Array<{ text: string; top: number; divisions: number[] }> = [];

  const message = (row: Extract<SequenceRow, { kind: 'message' }>, index: number) => {
    const from = at(row.from);
    const to = at(row.to);
    if (!from || !to) return;
    order++;
    const dashed = row.arrow.startsWith('--');
    const label = model.autonumber ? `${order}. ${row.text}` : row.text;
    const size = font * 0.78;
    const id = `m${index}`;
    if (from === to) {
      const points = [{ x: from.x, y }, { x: from.x + SELF_W, y }, { x: from.x + SELF_W, y: y + 22 }, { x: from.x, y: y + 22 }];
      body.push(`<g class="pd-edge${dashed ? ' pd-dashed' : ''}" data-id="${id}">`);
      const self = `M${points.map((p) => `${Math.round(p.x)} ${Math.round(p.y)}`).join(' L')}`;
      const selfInk = ink(self, `${row.from}>${row.from}@${y}`);
      body.push(`<path class="pd-casing" d="${selfInk}" />`);
      body.push(`<path class="pd-line" d="${selfInk}" marker-end="url(#${arrow})" />`);
      body.push(`<text class="pd-edge-label pd-halo" x="${Math.round(from.x + SELF_W + 10)}" y="${Math.round(y + 4)}" font-size="${size}">${esc(label)}</text>`);
      body.push('</g>');
      lines.push({ id, points });
      boxes.push({ id, kind: 'label', form: 'label', x: from.x + SELF_W + 10, y: y - size, w: textWidth(label, size), h: size * 1.3, fontSize: size });
      y += 34;
      return;
    }
    const points = [{ x: from.x, y }, { x: to.x, y }];
    const middle = (from.x + to.x) / 2;
    const w = textWidth(label, size);
    body.push(`<g class="pd-edge${dashed ? ' pd-dashed' : ''}" data-id="${id}">`);
    const run = `M${Math.round(from.x)} ${y} L${Math.round(to.x)} ${y}`;
    const runInk = ink(run, `${row.from}>${row.to}@${y}`);
    body.push(`<path class="pd-casing" d="${runInk}" />`);
    body.push(`<path class="pd-line" d="${runInk}" marker-end="url(#${arrow})" />`);
    body.push(`<text class="pd-edge-label pd-halo" x="${Math.round(middle)}" y="${Math.round(y - 8)}" font-size="${size}" text-anchor="middle">${esc(label)}</text>`);
    body.push('</g>');
    lines.push({ id, points });
    boxes.push({ id, kind: 'label', form: 'label', x: middle - w / 2, y: y - 8 - size, w, h: size * 1.3, fontSize: size });
  };

  model.rows.forEach((row, index) => {
    if (row.kind === 'message') { message(row, index); y += ROW_H; return; }
    if (row.kind === 'note') {
      const who = row.who.split(',')[0]?.trim() ?? '';
      const column = at(who) ?? cols[0];
      const size = font * 0.72;
      const lines2 = wrap(row.text, 200, size);
      const w = Math.max(140, Math.max(...lines2.map((l) => textWidth(l, size))) + 24);
      const x = row.placement.includes('left') ? column.x - w - 16 : row.placement.includes('over') ? column.x - w / 2 : column.x + 16;
      body.push(`<g class="pd-note" data-id="n${index}">`);
      body.push(`<rect class="pd-plate" x="${Math.round(x)}" y="${Math.round(y - 14)}" width="${Math.round(w)}" height="${NOTE_H}" rx="4" />`);
      lines2.slice(0, 2).forEach((l, i) => body.push(`<text x="${Math.round(x + w / 2)}" y="${Math.round(y + 4 + i * size * 1.3)}" font-size="${size}" text-anchor="middle">${esc(l)}</text>`));
      body.push('</g>');
      boxes.push({ id: `n${index}`, kind: 'node', form: 'rect', x, y: y - 14, w, h: NOTE_H, fontSize: size });
      y += NOTE_H + 12;
      return;
    }
    if (row.kind === 'block') {
      const word = row.keyword.toLowerCase();
      if (word === 'end') {
        const frame = open.pop();
        if (frame) frames.push(frameOf(frame, cols, y, font));
        y += 14;
        return;
      }
      if (DIVIDES.has(word)) {
        const frame = open[open.length - 1];
        if (frame) frame.divisions.push(y - 10);
        body.push(`<text class="pd-block-label" x="${Math.round(cols[0].x - cols[0].w / 2 + 10)}" y="${Math.round(y)}" font-size="${font * 0.72}">${esc(`${row.keyword} ${row.text}`.trim())}</text>`);
        y += 26;
        return;
      }
      open.push({ text: `${row.keyword} ${row.text}`.trim(), top: y - 16, divisions: [] });
      y += 26;
      return;
    }
    y += 8; // a raw line keeps its room without pretending to be drawn
  });
  for (const frame of open.reverse()) frames.push(frameOf(frame, cols, y, font));

  const bottom = y + 20;
  const left = Math.min(PAD, ...boxes.map((b) => b.x)) - pad;
  const right = Math.max(...cols.map((c) => c.x + c.w / 2), ...boxes.map((b) => b.x + b.w)) + pad;
  const top = -pad - (model.title ? font * 2 : 0);
  const viewBox: [number, number, number, number] = [left, top, right - left, bottom - top];

  const heads: string[] = [];
  for (const c of cols) {
    heads.push(`<g class="pd-node pd-${c.actor ? 'actor' : 'runtime'}" data-id="${esc(c.id)}">`);
    // La cabecera de un participante es una caja como las demás: se entinta igual.
    heads.push(inkShape(`<rect x="${Math.round(c.x - c.w / 2)}" y="0" width="${Math.round(c.w)}" height="${HEAD_H}" rx="10" />`, `cabecera:${c.id}`));
    wrap(c.label, c.w - 16, font).slice(0, 3).forEach((l, i, all) => {
      heads.push(`<text class="pd-name" x="${Math.round(c.x)}" y="${Math.round(HEAD_H / 2 + 5 - (all.length - 1) * font * 0.6 + i * font * 1.2)}" font-size="${font}" text-anchor="middle">${esc(l)}</text>`);
    });
    heads.push('</g>');
    heads.push(`<path class="pd-lifeline" d="${ink(`M${Math.round(c.x)} ${HEAD_H} L${Math.round(c.x)} ${Math.round(bottom - 10)}`, `vida:${c.id}`)}" />`);
    boxes.push({ id: c.id, kind: 'node', form: 'rounded', x: c.x - c.w / 2, y: 0, w: c.w, h: HEAD_H, fontSize: font });
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" width="${Math.round(viewBox[2])}" height="${Math.round(viewBox[3])}"`
      + ` viewBox="${viewBox.join(' ')}" class="pd-diagram ${scopeOf(reg)} pd-sequence">`,
    `<title>${esc(model.title || opts.name || 'sequence')}</title>`,
    sequenceStyle(reg, opts.fontSrc),
    `<rect class="pd-ground" x="${viewBox[0]}" y="${viewBox[1]}" width="${viewBox[2]}" height="${viewBox[3]}" />`,
    `<defs><marker id="${esc(arrow)}" viewBox="0 0 10 8" refX="9.2" refY="4" markerWidth="10" markerHeight="8"`
      + ' markerUnits="userSpaceOnUse" orient="auto-start-reverse">'
      + '<path class="pd-head" d="M0 0 L9.6 4 L0 8 L1.6 4 Z" /></marker>'
      + '</defs>',
    model.title ? `<text class="pd-title" x="${left + pad}" y="${top + font * 2}" font-size="${font * SIZE.TITLE}">${esc(model.title)}</text>` : '',
    ...frames,
    ...heads,
    ...body,
    '</svg>',
  ].filter(Boolean).join('\n');

  return { svg, viewBox, boxes, lines };
}

/** The frame an `alt`, an `opt` or a `loop` draws around the rows it covers. */
function frameOf(frame: { text: string; top: number; divisions: number[] }, cols: Column[], bottom: number, font: number): string {
  const x = cols[0].x - cols[0].w / 2 - 12;
  const right = cols[cols.length - 1].x + cols[cols.length - 1].w / 2 + 12;
  const out = [`<g class="pd-block">`, `<rect class="pd-plate" x="${Math.round(x)}" y="${Math.round(frame.top)}" width="${Math.round(right - x)}" height="${Math.round(bottom - frame.top)}" rx="6" />`];
  out.push(`<text class="pd-block-label" x="${Math.round(x + 10)}" y="${Math.round(frame.top + font)}" font-size="${font * 0.72}">${esc(frame.text)}</text>`);
  for (const at of frame.divisions) out.push(`<path class="pd-divider" d="M${Math.round(x)} ${Math.round(at)} L${Math.round(right)} ${Math.round(at)}" />`);
  out.push('</g>');
  return out.join('\n');
}

/**
 * What a sequence adds to the shared sheet: the lifelines, the notes and the block frames.
 *
 * Everything else — the paper, the tones, the type, the routes — comes from `sheet.ts`, and
 * that is the point. This renderer used to carry a hand-copied second stylesheet with the
 * same hexes typed again, which is how a note ended up the only warm colour in the product
 * and how the block keyline drifted to a different dash and a different weight from the
 * boundary keyline it is supposed to match.
 */
function sequenceStyle(reg: Register, fontSrc?: string): string {
  const at = `.${scopeOf(reg)}`;
  return styleBlock(reg, fontSrc).replace('</style>', [
    `${at} .pd-lifeline { stroke: ${FURNITURE}; stroke-width: 1.5; stroke-dasharray: 4 5; fill: none; }`,
    `${at} .pd-note > .pd-plate { fill: #F6E6C4; stroke: #A6761C; stroke-width: 1.2; }`,
    `${at} .pd-note text { fill: #3F2A06; }`,
    `${at} .pd-block > .pd-plate { fill: none; stroke: #BCB3A2; stroke-width: 1.2; stroke-dasharray: 5 4; }`,
    `${at} .pd-block-label { fill: #6B6353; font-weight: 600; letter-spacing: 0.12em; }`,
    `${at} .pd-divider { stroke: ${FURNITURE}; stroke-width: 1; stroke-dasharray: 4 4; fill: none; }`,
    '</style>',
  ].join('\n'));
}
