/**
 * The delta says what happened to a drawing, in the words of the drawing.
 *
 * A `git diff` of a typed block says which lines changed; a reviewer wants to know that a
 * container appeared, one was renamed and two moved. These check that it says exactly that
 * and nothing else — a drawing that did not change has to come back silent, or the report
 * is noise on every commit.
 */
import { describe, expect, it } from './vitest.ts';
import { delta, deltaLines, type DiagramModel } from '../src/index.ts';

const before: DiagramModel = {
  kind: 'c4-container', title: 'T', direction: 'TD',
  nodes: [
    { id: 'gw', shape: 'Container', name: 'API Gateway', x: 0, y: 0 },
    { id: 'auth', shape: 'Container', name: 'Autorización', x: 0, y: 200 },
    { id: 'old', shape: 'Container', name: 'Lo que se fue', x: 0, y: 400 },
  ],
  edges: [{ id: 'e1', from: 'gw', to: 'auth', label: 'llama' }],
};

describe('el delta entre dos versiones', () => {
  it('no dice nada cuando el dibujo es el mismo', () => {
    const d = delta(before, structuredClone(before));
    expect(d.same).toBe(true);
    expect(deltaLines(d)).toEqual([]);
  });

  it('nombra lo que apareció, lo que se fue, lo que cambió y lo que se movió', () => {
    const after: DiagramModel = {
      ...before,
      nodes: [
        { id: 'gw', shape: 'Container', name: 'Pasarela de entrada', x: 0, y: 0 },
        { id: 'auth', shape: 'Container', name: 'Autorización', x: 300, y: 220 },
        { id: 'tok', shape: 'Container', name: 'Tokenizador', x: 0, y: 400 },
      ],
      edges: [{ id: 'e1', from: 'gw', to: 'tok', label: 'llama' }],
    };
    const d = delta(before, after);
    expect(d.added).toEqual(['tok']);
    expect(d.removed).toEqual(['old']);
    expect(d.changed).toEqual([{ id: 'gw', fields: ['name'] }]);
    expect(d.moved).toEqual([{ id: 'auth', dx: 300, dy: 20 }]);
    expect(d.edgesAdded).toEqual(['gw → tok (llama)']);
    expect(d.edgesRemoved).toEqual(['gw → auth (llama)']);
    expect(d.same).toBe(false);
    expect(deltaLines(d)[0]).toBe('+ tok');
  });

  it('un movimiento no es un cambio: la caja es la misma en otro sitio', () => {
    const moved = { ...before, nodes: before.nodes.map((n) => ({ ...n, x: n.x + 40 })) };
    const d = delta(before, moved);
    expect(d.changed).toEqual([]);
    expect(d.moved.map((m) => m.dx)).toEqual([40, 40, 40]);
  });
});
