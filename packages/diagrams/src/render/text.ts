/**
 * How wide a piece of text is, without a DOM to ask.
 *
 * The renderer has to produce the same bytes in Node and in a browser, so it cannot measure
 * with `getComputedTextLength`: it estimates. The factor is the average advance of the
 * monospace-ish stack the theme uses, and it is deliberately generous — a box a few pixels
 * wider than needed reads fine, one a few pixels narrower clips the last letter.
 *
 * The composition pass later measures what actually got drawn and complains about the
 * cases the estimate got wrong, which is the honest division: guess here, verify there.
 */
/**
 * The average advance of the face, measured — not guessed — per style that gets painted.
 *
 * One number for everything was wrong in both directions at once, and by a lot; five numbers
 * is what it takes. Each figure below is `ctx.measureText` over **real strings out of the
 * catalogues** — the names, descriptions, edge labels, cardinalities and technology lines of
 * a thousand actual drawings, not lorem — set in the very face and weight and tracking the
 * sheet declares, divided by `length × fontSize`.
 *
 * Re-measured for Excalifont on 2026-09-16, and one of them mattered: a piece's name advances
 * 0.527 in this face against 0.502 in Inter, so the old 0.52 was **under** the truth. Too high
 * only pads a box; too low lets a name run out of the box it is written in, and `widthOf`
 * takes this number as gospel when it decides how wide that box is.
 *
 * Each figure is the measurement with a little headroom: a box a few pixels wide reads fine,
 * a few pixels narrow clips the last letter. To repeat the measurement for another face, do
 * exactly this again — sample the catalogues, set `ctx.font` and `ctx.letterSpacing` per
 * style, average over characters.
 */
export const ADVANCE = {
  /**
   * A piece's name: 600, tracked 0.005em. Measured 0.527 (Inter: 0.502).
   *
   * The headroom here is thin on purpose, and it was chosen by measuring the consequence
   * rather than by taste: this number multiplies the width of every piece that carries a
   * name, and a wider piece leaves less room beside it for an edge label. Over the ten
   * catalogues, 0.53 leaves nineteen drawings with a composition error and 0.55 — the same
   * relative headroom the Inter figure carried — leaves thirty-eight. Under-estimating is
   * survivable because the renderer wraps to the room it has; over-estimating is not, because
   * nothing gives the room back.
   */
  name: 0.53,
  /** A description or a field: 400. Measured 0.497 (Inter: 0.501). */
  body: 0.52,
  /** An edge label: 600, tracked 0.015em. Measured 0.521 (Inter: 0.545). */
  label: 0.55,
  /** A cardinality: 600, tracked 0.08em. Measured 0.534 over six real ones — kept generous
   *  on purpose, because two characters of slack is two pixels and a clipped `}o` is a lie. */
  card: 0.63,
  /** A frame's name or a technology line: 600, tracked 0.12em, capitals. Measured 0.745. */
  caps: 0.77,
} as const;

export const textWidth = (text: string, fontSize: number, advance: number = ADVANCE.name): number =>
  text.length * fontSize * advance;

/** Cuts a line into as many as it takes to fit, on spaces where there are any. */
export function wrap(text: string, maxWidth: number, fontSize: number, advance: number = ADVANCE.name): string[] {
  // `<br/>` is how Mermaid breaks a line; here it is just a space, and the wrap decides.
  const words = text.replace(/<br\s*\/?>/gi, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, fontSize, advance) <= maxWidth || !line) line = candidate;
    else { lines.push(line); line = word; }
  }
  lines.push(line);
  return lines;
}

/**
 * `<` and `&` in a name are text, not markup — except `<br/>`, which is how Mermaid says
 * «new line» and arrives in every migrated drawing. Here the wrap decides where a line
 * breaks, so it is a space.
 */
export const esc = (text: string): string =>
  text.replace(/<br\s*\/?>/gi, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
