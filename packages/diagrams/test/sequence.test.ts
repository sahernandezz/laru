/**
 * The sequence renderer: the one family whose placement was given.
 *
 * There is nothing to search for here — the order of the rows is where they go — so what
 * these check is that the drawing says everything the model says and that the pieces it
 * reports back can be measured by the same composition pass as any other drawing.
 */
import { describe, expect, it } from './vitest.ts';
import { composition, parseSequence, renderSequence, renderTyped, paints, sequenceErrors } from '../src/index.ts';

const code = [
  'sequenceDiagram',
  '    autonumber',
  '    participant a as Comercio',
  '    participant b as Pasarela',
  '    a->>b: cobra',
  '    b-->>a: aprobado',
  '    b->>b: reintenta',
  '    Note over b: guarda el intento',
  '    alt aprobado',
  '        b->>a: recibo',
  '    else rechazado',
  '        b->>a: motivo',
  '    end',
].join('\n');

const model = { kind: 'sequence' as const, ...parseSequence(code).model };

describe('a sequence', () => {
  it('draws everything the rows say', () => {
    const out = renderSequence(model);
    for (const text of ['Comercio', 'Pasarela', 'cobra', 'aprobado', 'reintenta', 'guarda el intento', 'alt aprobado', 'else rechazado']) {
      expect(out.svg, text).toContain(text);
    }
    // Autonumber is part of the model, so the reader sees the order without counting.
    expect(out.svg).toContain('1. cobra');
  });

  it('reports its pieces so the composition pass can measure them', () => {
    const out = renderSequence(model);
    expect(out.boxes.filter((b) => b.kind === 'node').length).toBeGreaterThanOrEqual(2);
    expect(out.lines.length).toBeGreaterThanOrEqual(4);
    expect(composition(out, model).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('goes through the one door with everything else', () => {
    expect(paints(model)).toBe(true);
    expect(renderTyped(model).svg).toBe(renderSequence(model).svg);
  });

  it('refuses a message to somebody who is not there', () => {
    const broken = { ...model, rows: [{ kind: 'message' as const, from: 'a', to: 'fantasma', arrow: '->>', text: 'hola' }] };
    expect(sequenceErrors(broken).map((e) => e.path)).toEqual(['rows[0].to']);
  });

  it('refuses a sequence with nobody in it', () => {
    expect(sequenceErrors({ ...model, participants: [] })[0].path).toBe('participants');
  });
});
