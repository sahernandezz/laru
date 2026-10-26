/**
 * The composition pass, one case per diagnostic: something that must fail, and the change
 * that makes it pass.
 *
 * This is the part of the engine that replaces prose with measurement. The standard used to
 * say «if a label lands on another box, move it»; nobody could act on that from the source,
 * because the source never said where a label goes. Here the renderer reports where things
 * ended up and this pass answers in pixels.
 */
import { describe, expect, it } from './vitest.ts';
import { composition, renderBoxes, type DiagramModel } from '../src/index.ts';
import { DIAGRAM_STANDARDS } from '../src/standards.ts';

const skin = DIAGRAM_STANDARDS['c4-container'].skin;

const draw = (model: DiagramModel, opts = {}) => composition(renderBoxes(model, skin), model, opts);

const base = (nodes: DiagramModel['nodes'], edges: DiagramModel['edges'] = []): DiagramModel =>
  ({ kind: 'c4-container', title: 'T', direction: 'TD', nodes, edges });

describe('an arrow with something in the way', () => {
  /*
   * The diagnostic is the backstop for when the router runs out of shapes. Contriving a
   * fully enclosed corridor in a fixture is fragile, so what is fed here is a drawing whose
   * arrow was already routed straight through — which is exactly the state the backstop is
   * for — while the router itself is tested on its own in route.test.ts.
   */
  it('is reported when an arrow ends up crossing a box', () => {
    const model = base(
      [
        { id: 'a', shape: 'Container', name: 'A', x: 0, y: 0 },
        { id: 'b', shape: 'Container', name: 'B', x: 600, y: 0 },
        { id: 'medio', shape: 'Container', name: 'En medio', x: 290, y: 0 },
      ],
      [{ id: 'e', from: 'a', to: 'b' }],
    );
    const rendered = renderBoxes(model, skin);
    const straight = { ...rendered, lines: [{ id: 'e', points: [{ x: 190, y: 39 }, { x: 600, y: 39 }] }] };
    const found = composition(straight, model).filter((d) => d.code === 'edge-through-node');
    expect(found).toHaveLength(1);
    expect(found[0].subject).toEqual({ id: 'e', other: 'medio', scope: 'edge' });
    expect(found[0].supportedFixes[0]).toContain('out of the way');
  });

  it('says nothing about the drawing the router actually produced', () => {
    const model = base(
      [
        { id: 'a', shape: 'Container', name: 'A', x: 0, y: 0 },
        { id: 'b', shape: 'Container', name: 'B', x: 600, y: 0 },
        { id: 'medio', shape: 'Container', name: 'En medio', x: 290, y: 0 },
      ],
      [{ id: 'e', from: 'a', to: 'b', label: 'rodea' }],
    );
    expect(draw(model)).toEqual([]);
  });
});

describe('a label on top of a box', () => {
  const tight = base(
    [
      { id: 'a', shape: 'Container', name: 'A', x: 0, y: 0 },
      { id: 'b', shape: 'Container', name: 'B', x: 0, y: 300 },
      { id: 'lado', shape: 'Container', name: 'Al lado', x: 0, y: 150 },
    ],
    [{ id: 'e', from: 'a', to: 'b', label: 'una etiqueta bastante larga que no cabe en el hueco' }],
  );

  /*
   * The renderer looks for a clear spot before it writes a label, so a drawing where one
   * exists no longer produces this. What the pass is for is the drawing where none does,
   * and that state is fed in directly — the same way the arrow diagnostic above is tested.
   */
  it('is reported when the label ends up on a box', () => {
    const rendered = renderBoxes(tight, skin);
    const over = {
      ...rendered,
      boxes: rendered.boxes.map((b) => (b.kind === 'label' ? { ...b, x: 10, y: 160, w: 170, h: 14 } : b)),
    };
    const found = composition(over, tight).filter((d) => d.code === 'label-over-node');
    expect(found).toHaveLength(1);
    expect(found[0].subject).toEqual({ id: 'e', other: 'lado', scope: 'edge' });
    expect(found[0].evidence.overlapPx).toBeGreaterThan(0);
    expect(found[0].supportedFixes[0]).toContain('labelDx');
  });

  it('says nothing when the renderer found the label a gap', () => {
    expect(draw(tight).filter((d) => d.code === 'label-over-node')).toEqual([]);
  });
});

describe('two labels on top of each other', () => {
  /*
   * Cuatro flechas, no tres. Con tres el renderizador ya se las arregla: reparte los
   * puertos por el lado, cada una sale y entra perpendicular con su tramo propio, y las
   * etiquetas encuentran hueco arriba y abajo de la línea. Fue tres hasta que el trazado
   * aprendió a llegar de frente a la caja, y entonces esta prueba dejó de reproducir nada
   * — que es lo que pasa cuando el motor mejora: el caso tiene que endurecerse o la prueba
   * se convierte en un adorno que pasa siempre.
   */
  const converging = (gap: number) => base(
    [
      { id: 'a', shape: 'Container', name: 'A', x: 0, y: 0 },
      { id: 'b', shape: 'Container', name: 'B', x: 500, y: 0 },
      { id: 'c', shape: 'Container', name: 'C', x: 500, y: gap },
      { id: 'd', shape: 'Container', name: 'D', x: 500, y: gap * 2 },
      { id: 'e', shape: 'Container', name: 'E', x: 500, y: gap * 3 },
    ],
    [
      { id: 'e1', from: 'a', to: 'b', label: 'etiqueta numero uno' },
      { id: 'e2', from: 'a', to: 'c', label: 'etiqueta numero dos' },
      { id: 'e3', from: 'a', to: 'd', label: 'etiqueta numero tres' },
      { id: 'e4', from: 'a', to: 'e', label: 'etiqueta numero cuatro' },
    ],
  );

  it('is found when the arrows land in the same place', () => {
    expect(draw(converging(6)).some((d) => d.code === 'label-over-label')).toBe(true);
  });

  it('goes away when the ends separate', () => {
    expect(draw(converging(300)).filter((d) => d.code === 'label-over-label')).toEqual([]);
  });
});

describe('the drawing the reader ends up with', () => {
  const wide = base(
    Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, shape: 'Container' as const, name: `Pieza ${i}`, x: i * 320, y: 0 })),
  );

  it('refuses one whose smallest text falls under the minimum once scaled', () => {
    const found = draw(wide).filter((d) => d.code === 'font-too-small');
    expect(found).toHaveLength(1);
    const e = found[0].evidence;
    expect(Number(e.projectedFontPx)).toBeLessThan(6);
    expect(Number(e.scale)).toBeLessThan(1);
    // It says how narrow it has to get, so the next attempt aims instead of guessing.
    expect(found[0].supportedFixes[0]).toMatch(/narrow the drawing to \d+px/);
  });

  it('accepts the same drawing when the reader has the room for it', () => {
    expect(draw(wide, { availableWidth: 4000 }).filter((d) => d.code === 'font-too-small')).toEqual([]);
  });

  it('accepts one that fits', () => {
    const small = base([
      { id: 'a', shape: 'Container', name: 'A', x: 0, y: 0 },
      { id: 'b', shape: 'Container', name: 'B', x: 300, y: 0 },
    ]);
    expect(draw(small).filter((d) => d.code === 'font-too-small')).toEqual([]);
  });
});

describe('two arrows in the same corridor', () => {
  /*
   * Two arrows between the same pair leave from different points on the side and read fine.
   * Four do not: the side is only so tall, and once the lanes are closer together than the
   * eye can follow, which label belongs to which arrow stops being answerable.
   */
  it('is found when more arrows share a side than fit on it', () => {
    const model = base(
      [
        { id: 'a', shape: 'Container', name: 'A', x: 0, y: 0 },
        { id: 'c', shape: 'Container', name: 'C', x: 600, y: 0 },
      ],
      [
        { id: 'pide', from: 'a', to: 'c' },
        { id: 'contesta', from: 'c', to: 'a' },
        { id: 'reintenta', from: 'a', to: 'c' },
        { id: 'confirma', from: 'c', to: 'a' },
      ],
    );
    const found = draw(model).filter((d) => d.code === 'ambiguous-corridor');
    expect(found.length).toBeGreaterThan(0);
    expect(Number(found[0].evidence.distancePx)).toBeLessThan(24);
  });

  it('says nothing when a call and its answer each get their own lane', () => {
    const model = base(
      [
        { id: 'a', shape: 'Container', name: 'A', x: 0, y: 0 },
        { id: 'c', shape: 'Container', name: 'C', x: 600, y: 0 },
      ],
      [{ id: 'pide', from: 'a', to: 'c' }, { id: 'contesta', from: 'c', to: 'a' }],
    );
    expect(draw(model).filter((d) => d.code === 'ambiguous-corridor')).toEqual([]);
  });

  it('is found when two arrows run alongside each other', () => {
    const model = base(
      [
        { id: 'a', shape: 'Container', name: 'A', x: 0, y: 0 },
        { id: 'b', shape: 'Container', name: 'B', x: 0, y: 90 },
        { id: 'c', shape: 'Container', name: 'C', x: 600, y: 0 },
        { id: 'd', shape: 'Container', name: 'D', x: 600, y: 90 },
      ],
      [{ id: 'e1', from: 'a', to: 'c' }, { id: 'e2', from: 'b', to: 'd' }],
    );
    // Twelve pixels apart is a corridor; the default of twenty-four is not a guess about
    // this drawing, it is where two lines stop being told apart at a glance.
    expect(draw(model, { corridor: 100 }).some((d) => d.code === 'ambiguous-corridor')).toBe(true);
    expect(draw(model).filter((d) => d.code === 'ambiguous-corridor')).toEqual([]);
  });

  it('says nothing about two that merely cross', () => {
    const model = base(
      [
        { id: 'a', shape: 'Container', name: 'A', x: 0, y: 0 },
        { id: 'b', shape: 'Container', name: 'B', x: 600, y: 400 },
        { id: 'c', shape: 'Container', name: 'C', x: 0, y: 400 },
        { id: 'd', shape: 'Container', name: 'D', x: 600, y: 0 },
      ],
      [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'c', to: 'd' }],
    );
    expect(draw(model).filter((d) => d.code === 'ambiguous-corridor')).toEqual([]);
  });
});

describe('a piece half inside a boundary', () => {
  const at = (x: number) => base([
    { id: 'zona', shape: 'Container_Boundary', name: 'Zona', x: 0, y: 0, w: 400, h: 300 },
    { id: 'p', shape: 'Container', name: 'Pieza', x, y: 100 },
  ]);

  it('is found: the reader takes it to be in, or out, and it is neither', () => {
    const found = draw(at(300)).filter((d) => d.code === 'node-straddles-boundary');
    expect(found).toHaveLength(1);
    expect(found[0].subject).toEqual({ id: 'p', other: 'zona', scope: 'node' });
  });

  it('says nothing when it is fully inside, or fully out', () => {
    expect(draw(at(60)).filter((d) => d.code === 'node-straddles-boundary')).toEqual([]);
    expect(draw(at(600)).filter((d) => d.code === 'node-straddles-boundary')).toEqual([]);
  });
});

describe('every diagnostic answers the same three questions', () => {
  it('says what it is about, what was measured, and what may be changed', () => {
    const model = base(
      [
        { id: 'zona', shape: 'Container_Boundary', name: 'Zona', x: 0, y: 0, w: 400, h: 300 },
        { id: 'a', shape: 'Container', name: 'A', x: 300, y: 100 },
        { id: 'b', shape: 'Container', name: 'B', x: 900, y: 100 },
        { id: 'medio', shape: 'Container', name: 'Medio muy cerca', x: 600, y: 100 },
      ],
      [
        { id: 'e', from: 'a', to: 'b', label: 'una etiqueta larga que se sale del hueco' },
        { id: 'e2', from: 'b', to: 'a', label: 'la respuesta, por el mismo sitio' },
      ],
    );
    const found = draw(model);
    expect(found.length).toBeGreaterThan(1);
    for (const d of found) {
      expect(d.subject.scope, d.code).toBeTruthy();
      expect(Object.keys(d.evidence).length, d.code).toBeGreaterThan(0);
      expect(d.supportedFixes.length, d.code).toBeGreaterThan(0);
    }
  });
});
