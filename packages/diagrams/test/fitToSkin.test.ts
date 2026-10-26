/**
 * The reader speaks Mermaid and a skin speaks its class: `fitToSkin` is the interpreter.
 *
 * What is guarded here is the rule and its two edges. A shape a class declares is never
 * touched — that is what keeps every class that already compiled compiling to the same
 * bytes — and a shape no form of that class answers for is left alone too, so whoever is
 * compiling still refuses it by name instead of drawing the wrong thing.
 */
import { describe, expect, it } from './vitest.ts';
import { DIAGRAM_KINDS, SKINS, fitToSkin, fromMermaid, paints, type DiagramModel } from '../src/index.ts';

const model = (kind: DiagramModel['kind'], shapes: string[]): DiagramModel => ({
  kind,
  title: '',
  direction: 'LR',
  nodes: shapes.map((shape, i) => ({ id: `n${i}`, shape, name: shape, x: 0, y: 0 })),
  edges: [],
});

describe('a model read in Mermaid, said again in the vocabulary of its class', () => {
  it('gives a generic shape the role whose form is what the reader saw', () => {
    // The maps of the catalogue name their roles after the thing: container, facet, store.
    const m = model('domain-map', ['icon', 'rect', 'cylinder', 'group']);
    expect(fitToSkin(m, SKINS['domain-map'])).toEqual([
      'icon drawn as `container`, which is what this class has',
      'rect drawn as `container`, which is what this class has',
      'cylinder drawn as `store`, which is what this class has',
    ]);
    expect(m.nodes.map((n) => n.shape)).toEqual(['container', 'container', 'store', 'group']);
  });

  it('leaves a shape the class does declare exactly as it was', () => {
    for (const kind of DIAGRAM_KINDS) {
      const skin = SKINS[kind];
      if (!skin) continue;
      const own = skin.roles.map((r) => r.shape);
      const m = model(kind, own);
      expect(fitToSkin(m, skin), kind).toEqual([]);
      expect(m.nodes.map((n) => n.shape), kind).toEqual(own);
    }
  });

  it('answers within a family and never across one', () => {
    // `packages` draws a box and a frame and nothing else: no store answers for a cylinder.
    const m = model('packages', ['cylinder', 'diamond', 'round']);
    fitToSkin(m, SKINS.packages);
    expect(m.nodes.map((n) => n.shape)).toEqual(['cylinder', 'diamond', 'rect']);
  });

  it('is what lets a flowchart of the catalogue be painted at all', () => {
    const code = [
      'flowchart LR',
      '    subgraph sales["Sales"]',
      '        s1@{ icon: "pd:domain", form: "square", label: "Ordering", pos: "b" }',
      '    end',
      '    s1 -->|confirmed orders| o1["Fulfilment"]',
    ].join('\n');
    /*
     * The reader does it on the way out, for every one of its callers. It was two calls in
     * the core and none in the web, so the same Mermaid compiled in the manual and refused to
     * compile in the editor — one reader, one class, two answers.
     */
    const read = fromMermaid(code, 'domain-map')!;
    expect(read.model.nodes.map((n) => n.shape)).toEqual(['group', 'container', 'container']);
    expect(paints(read.model)).toBe(true);
    // And it says what it changed: nothing is translated behind the author's back.
    expect(read.notes.some((n) => n.includes('drawn as'))).toBe(true);
    // Running it again finds nothing left to do, which is what makes it safe to call twice.
    expect(fitToSkin(read.model, SKINS['domain-map'])).toEqual([]);
  });
});
