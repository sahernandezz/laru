/**
 * What the composition pass costs on a map of a real catalogue.
 *
 * It measures a drawing by comparing everything with everything: every label against every
 * box, every label against every other label, every arrow against every other arrow. That
 * is correct and it was fine for the forty-piece drawings it was written against. The map of
 * a real application is not forty pieces — 161 pieces and 1325 arrows, 878 000 pairs of
 * labels — and measuring it took 12.5 seconds, eight times over inside `propose`, on the
 * browser's main thread. The page did not load; it hung for ninety-two seconds.
 *
 * Two things hold that down now, and both are pinned here because both are the kind of
 * optimisation that is easy to get subtly wrong and impossible to notice:
 *
 *  - boxes are filed in a grid and compared only with those sharing a cell. This must find
 *    **exactly** the pairs the double loop found — not nearly all of them — so the test
 *    recomputes the answer by brute force and demands the same list.
 *  - `propose` stops climbing its ladder on a drawing too big to afford it.
 */
import { describe, expect, it } from './vitest.ts';
import { composition, propose, renderTyped, rungsFor, worthPlacing, SKINS, type DiagramModel } from '../src/index.ts';

/** A drawing with enough pieces and arrows that comparing everything with everything hurts. */
function crowded(pieces: number, edgesPerPiece: number): DiagramModel {
  const nodes = Array.from({ length: pieces }, (_, i) => ({
    id: `n${i}`, shape: 'rect', name: `Pieza número ${i}`,
    x: (i % 12) * 180, y: Math.floor(i / 12) * 120,
  }));
  const edges = [];
  for (let i = 0; i < pieces; i++) {
    for (let k = 1; k <= edgesPerPiece; k++) {
      const to = (i + k * 7) % pieces;
      if (to !== i) edges.push({ id: `e${i}-${k}`, from: `n${i}`, to: `n${to}`, label: `usa ${k}` });
    }
  }
  return { kind: 'process', title: 'Apretado', direction: 'LR', nodes, edges } as DiagramModel;
}

const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('measuring a crowded drawing', () => {
  const model = crowded(60, 4);
  const painted = renderTyped(JSON.parse(JSON.stringify(model)), { skin: SKINS.process } as never);
  const found = composition(painted, model);

  it('finds every overlapping pair the plain double loop would, and no others', () => {
    const labels = painted.boxes.filter((b) => b.kind === 'label');
    const pieces = painted.boxes.filter((b) => b.kind === 'node' && b.form !== 'boundary');
    expect(labels.length, 'the drawing is crowded enough to be worth asking').toBeGreaterThan(30);

    /*
     * The answer, computed the slow and obvious way. The grid is an optimisation and nothing
     * else: a pair it misses is a complaint the author never sees, and a pair it invents is
     * one they cannot act on.
     */
    const brute: string[] = [];
    for (const l of labels) for (const p of pieces) if (overlap(l, p)) brute.push(`label-over-node ${l.id} ${p.id}`);
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        if (overlap(labels[i], labels[j])) brute.push(`label-over-label ${labels[i].id} ${labels[j].id}`);
      }
    }

    const mine = found
      .filter((d) => d.code === 'label-over-node' || d.code === 'label-over-label')
      .map((d) => `${d.code} ${d.subject.id} ${d.subject.other}`);
    expect(mine).toEqual(brute);
  });

  it('still answers about the arrows, and says which ones', () => {
    // The corridor and crossing checks were reworked too. A diagnostic about one piece names
    // it; the only one that does not is the sheet-wide complaint about the projected font.
    for (const d of found) {
      expect(['error', 'warning']).toContain(d.severity);
      if (d.subject.scope === 'diagram') continue;
      expect(d.subject.id, d.code).toBeTruthy();
    }
    expect(found.some((d) => d.code === 'ambiguous-corridor' || d.code === 'edge-through-node')).toBe(true);
  });
});

describe('the ladder is a budget', () => {
  it('knows which drawings are worth placing before paying to find out', () => {
    expect(worthPlacing(crowded(20, 2))).toBe(true);
    // The real map that started this: 1325 arrows. Nothing should try to place that.
    expect(worthPlacing({ edges: Array.from({ length: 1325 }, (_, i) => ({ id: `e${i}` })) } as never)).toBe(false);
  });

  it('never makes a smaller drawing cost more than a larger one', () => {
    /*
     * The first guard was a step at 240 arrows, and a step was the wrong shape: measured
     * either side of it, 239 arrows cost 1706 ms and 241 cost 241 — the drawing just under
     * the line paid seven times what the one just over it did, because it still climbed all
     * eight rungs. The budget has no line to be on the wrong side of, and this is the
     * property that says so: the ladder may only ever get shorter as the drawing grows.
     */
    const rungs = (edges: number) => {
      const m = crowded(40, 1);
      m.edges = Array.from({ length: edges }, (_, i) => ({ id: `e${i}`, from: 'n0', to: 'n1' }));
      return rungsFor(m);
    };
    let last = Infinity;
    for (const e of [10, 50, 96, 97, 150, 200, 239, 240, 241, 300, 600, 1325]) {
      const r = rungs(e);
      expect(r, `${e} arrows`).toBeLessThanOrEqual(last);
      expect(r, `${e} arrows`).toBeGreaterThanOrEqual(1);
      last = r;
    }
    // And a drawing small enough to be free still gets the whole ladder.
    expect(rungs(10)).toBe(8);
  });

  it('climbs fewer rungs on a drawing it cannot afford, and still answers', () => {
    const big = crowded(90, 6);
    expect(worthPlacing(big)).toBe(false);
    const r = propose(big, { kind: 'process', skin: SKINS.process });
    // It still returns a placed model with its verdict; what it does not do is paint eight.
    expect(r.model.nodes).toHaveLength(big.nodes.length);
    expect(typeof r.accepted).toBe('boolean');
    for (const n of r.model.nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
  });
});
