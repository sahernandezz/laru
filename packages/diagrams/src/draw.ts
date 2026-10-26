/** A Mermaid block as a fixed SVG: the page needs no Mermaid library, and what the engine cannot draw says why. */
import { DIAGRAM_KINDS, SKINS, type DiagramKind } from './kinds.ts';
import { fromMermaid, kindOfCode, parseSequence, toMermaid, type DiagramModel } from './model.ts';
import { renderBoxes } from './render/boxes.ts';
import { propose } from './render/propose.ts';
import { drawClasses, drawGantt, drawGitGraph, specialDialect } from './render/special.ts';
import { paints, renderTyped, type TypedModel } from './render/typed.ts';

export interface Drawn { svg?: string; error?: string }

/**
 * `expected` is the class the caller knows the text belongs to (a standard's template, a piece's field): several classes share
 * the `flowchart` dialect, and guessing wrong drew nothing.
 */
export function drawMermaid(code: string, idPrefix = 'pd', expected?: DiagramKind): Drawn {
  try {
    // a roadmap, the branches of a repository and the classes of some code are not boxes and arrows: they have their own hand
    const special = specialDialect(code);
    if (special) return { svg: special === 'gantt' ? drawGantt(code, idPrefix) : special === 'gitGraph' ? drawGitGraph(code, idPrefix) : drawClasses(code, idPrefix) };
    const kind = kindOfCode(code, expected ? [expected] : []);
    if (!kind || !DIAGRAM_KINDS.includes(kind)) return { error: 'unknown class of diagram' };
    let model: TypedModel;
    if (kind === 'sequence') {
      const r = parseSequence(code);
      if (!r.model) return { error: 'the sequence could not be read' };
      model = { ...r.model, kind: 'sequence' };
    } else {
      const r = fromMermaid(code, kind);
      if (!r) return { error: `a ${kind} cannot be drawn from this text` };
      model = r.model;
    }
    // a class without a skin of its own still draws: its pieces are plain steps rather than nothing
    if (!paints(model) && model.kind !== 'sequence') return { svg: renderBoxes(model, undefined, { idPrefix }).svg };
    return { svg: renderTyped(model, { idPrefix }).svg };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** A model placed by the engine and painted: the SVG, the same drawing as Mermaid, and how long it took. */
export function drawModel(model: DiagramModel, idPrefix = 'pd'): { svg: string; mermaid: string; model: DiagramModel; viewBox: [number, number, number, number]; ms: number } {
  const t0 = performance.now();
  const skin = SKINS[model.kind];
  const placed = skin ? propose(structuredClone(model), { kind: model.kind, skin }).model : model;
  const r = renderBoxes(placed, skin, { idPrefix });
  return { svg: r.svg, mermaid: toMermaid(placed), model: placed, viewBox: r.viewBox, ms: Math.round(performance.now() - t0) };
}
