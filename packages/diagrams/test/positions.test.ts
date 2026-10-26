/**
 * Who decides where a piece goes, checked rather than agreed.
 *
 * Archify ran the experiment and published the result: stock Mermaid against auto-layout
 * with a good skin, rated blind, came out indistinguishable, and only hand-decided
 * placement rated well. So an authored diagram keeps its positions. The twelve derived
 * classes have no author — a landscape of forty applications is nobody's drawing — and a
 * position written there would be overwritten on the next scan.
 *
 * Six months from now somebody will want to «tidy up» a C4 by running it through the
 * solver. This is the test that says no.
 */
import { describe, expect, it } from './vitest.ts';
import { DIAGRAM_KINDS, positionIssues, type DiagramModel, type StandardFacts } from '../src/index.ts';

const facts = (kind: string, origin: 'authored' | 'derived'): Pick<StandardFacts, 'kind' | 'origin'> =>
  ({ kind: kind as StandardFacts['kind'], origin });

const model = (nodes: Array<{ id: string; x?: number; y?: number }>): DiagramModel => ({
  kind: 'c4-context',
  title: 'T',
  direction: 'TD',
  nodes: nodes.map((n) => ({ id: n.id, shape: 'System', name: n.id, x: n.x as number, y: n.y as number })),
  edges: [],
});

describe('an authored diagram carries its positions', () => {
  it('says nothing when every piece is placed', () => {
    expect(positionIssues(model([{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 200, y: 0 }]), facts('c4-context', 'authored'))).toEqual([]);
  });

  it('names the piece that was left to be guessed', () => {
    const issues = positionIssues(model([{ id: 'a', x: 0, y: 0 }, { id: 'b' }]), facts('c4-context', 'authored'));
    expect(issues).toHaveLength(1);
    expect(issues[0].nodeId).toBe('b');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].text).toContain('placement is part of what is being said');
  });
});

describe('a derived diagram must not carry them', () => {
  it('says nothing when the engine will place it', () => {
    expect(positionIssues(model([{ id: 'a' }, { id: 'b' }]), facts('application-landscape', 'derived'))).toEqual([]);
  });

  it('refuses a position the next scan would overwrite', () => {
    const issues = positionIssues(model([{ id: 'a', x: 10, y: 10 }, { id: 'b' }]), facts('application-landscape', 'derived'));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].text).toContain('1 of its 2 pieces');
  });
});

describe('the split matches the standard', () => {
  it('leaves the placement to the engine on exactly the derived classes', async () => {
    const { DIAGRAM_STANDARDS } = await import('../src/standards.ts');
    const derived = DIAGRAM_KINDS.filter((k) => DIAGRAM_STANDARDS[k].origin === 'derived');
    // Ten today. The number is here so that adding a derived class is a deliberate act.
    expect(derived).toHaveLength(10);
    for (const kind of DIAGRAM_KINDS) {
      const origin = DIAGRAM_STANDARDS[kind].origin;
      const placed = positionIssues(model([{ id: 'a', x: 1, y: 1 }]), facts(kind, origin));
      expect(placed.length === 0, `${kind} (${origin}) with a position`).toBe(origin === 'authored');
    }
  });
});
