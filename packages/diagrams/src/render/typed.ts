/**
 * The one door to the engine: hand it a typed model, get a drawing.
 *
 * A fence holds the model of the family its class belongs to — boxes for a C4 or a map,
 * rows for a sequence — and every caller wants the same three answers: can you paint this,
 * is it sound, and what does it look like. Dispatching here means the page, the linter, the
 * write path and the capture command all ask the same question and get the same answer.
 */
import { SKINS, type DiagramKind } from '../kinds.ts';
import { FAMILY, type DiagramModel, type ModelError, type SequenceModel } from '../model.ts';
import { paintsBoxes, renderBoxes, type RenderOptions, type Rendered } from './boxes.ts';
import { renderSequence } from './sequence.ts';

/** A sequence as it travels inside a fence: its class, and the rows it is made of. */
export type SequenceDiagram = SequenceModel & { kind: 'sequence' };
export type TypedModel = DiagramModel | SequenceDiagram;

const isSequence = (model: TypedModel): model is SequenceDiagram => model.kind === 'sequence';

/** Whether the engine has a renderer for this model, or it still belongs to Mermaid. */
export function paints(model: TypedModel): boolean {
  if (isSequence(model)) return Array.isArray(model.participants) && Array.isArray(model.rows);
  return paintsBoxes(model, SKINS[model.kind]);
}

/** Whether the engine has a renderer for a class, before there is a model of it. */
export function paintsKind(kind: DiagramKind): boolean {
  return kind === 'sequence' || Boolean(SKINS[kind]);
}

export function renderTyped(model: TypedModel, opts: RenderOptions = {}): Rendered {
  if (isSequence(model)) return renderSequence(model, opts);
  return renderBoxes(model, SKINS[model.kind], opts);
}

/** What is wrong with a sequence, addressed the same way as anything else in a model. */
export function sequenceErrors(model: SequenceDiagram): ModelError[] {
  const errors: ModelError[] = [];
  if (!Array.isArray(model.participants) || model.participants.length === 0) {
    errors.push({ path: 'participants', message: 'a sequence with nobody in it draws nothing' });
    return errors;
  }
  if (!Array.isArray(model.rows)) {
    errors.push({ path: 'rows', message: 'a sequence is a list of rows, in order' });
    return errors;
  }
  const known = new Set(model.participants.map((p) => p.id));
  model.rows.forEach((row, i) => {
    if (row.kind !== 'message') return;
    for (const end of ['from', 'to'] as const) {
      if (!known.has(row[end])) errors.push({ path: `rows[${i}].${end}`, message: `"${row[end]}" is not one of the participants` });
    }
  });
  return errors;
}

/** The family a class belongs to, for whoever has to decide which model shape to expect. */
export const familyOf = (kind: DiagramKind) => FAMILY[kind];
