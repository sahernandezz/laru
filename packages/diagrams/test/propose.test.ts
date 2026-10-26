/**
 * A placement to start from, when nobody wrote one — and honesty about what is left.
 *
 * The plan called for a solver here and two measurements said no. On landscapes of 8 to 45
 * pieces the layout this package already had produced zero complaints once the arrows were
 * routed; on the three real C4 levels of an application, ELK produced two to three times
 * more, because it packs for compactness and leaves the labels nowhere to go. So what
 * proposes is the plain layout, and what improves it is the composition pass used as the
 * objective.
 *
 * What matters most here is the last test: a proposal that still has problems says so
 * rather than passing itself off as a finished drawing.
 */
import { describe, expect, it } from './vitest.ts';
import { propose, type DiagramModel } from '../src/index.ts';
import { DIAGRAM_STANDARDS } from '../src/standards.ts';

const std = DIAGRAM_STANDARDS['c4-container'];

const unplaced = (count: number, edges = 1): DiagramModel => ({
  kind: 'c4-container', title: 'Sin colocar', direction: 'TD',
  nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, shape: 'Container', name: `Pieza ${i}`, x: NaN, y: NaN })),
  edges: Array.from({ length: edges }, (_, i) => ({ id: `e${i}`, from: `n${i}`, to: `n${(i + 1) % count}`, label: 'usa' })),
});

describe('propose', () => {
  it('places every piece, so the drawing can be painted at all', () => {
    const model = unplaced(6);
    const p = propose(model, std);
    for (const n of p.model.nodes) {
      expect(Number.isFinite(n.x), n.id).toBe(true);
      expect(Number.isFinite(n.y), n.id).toBe(true);
    }
  });

  it('accepts a drawing that reads, and says which spread won', () => {
    const p = propose(unplaced(4), std);
    expect(p.accepted).toBe(true);
    expect(p.remaining).toEqual([]);
    expect(p.spread).toHaveLength(2);
  });

  it('places into the model it was handed, so the caller keeps its object', () => {
    const model = unplaced(5);
    const p = propose(model, std);
    expect(p.model).toBe(model);
    expect(Number.isFinite(model.nodes[0].x)).toBe(true);
  });

  it('is deterministic: the same model proposes the same placement twice', () => {
    const a = propose(unplaced(9, 4), std);
    const b = propose(unplaced(9, 4), std);
    expect(a.model.nodes.map((n) => [n.x, n.y])).toEqual(b.model.nodes.map((n) => [n.x, n.y]));
    expect(a.spread).toEqual(b.spread);
  });

  it('spreads the grid when the first attempt does not read', () => {
    // Enough arrows that the tight grid leaves the labels nowhere: the objective moves it.
    const p = propose(unplaced(8, 6), std);
    expect(p.spread[0]).toBeGreaterThanOrEqual(1);
    expect(p.remaining.length).toBeLessThan(8);
  });

  it('does not pass a draft off as a finished drawing', () => {
    const crowded = unplaced(12, 12);
    const p = propose(crowded, std);
    // Whatever it manages, it reports: accepted is true only when nothing is left.
    expect(p.accepted).toBe(p.remaining.length === 0);
    for (const d of p.remaining) {
      expect(d.severity).toBe('error');
      expect(d.supportedFixes.length).toBeGreaterThan(0);
    }
  });
});
