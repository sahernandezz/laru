export * from './kinds.ts';
export * from './model.ts';
export * from './render/text.ts';
// The sheet's own vocabulary, for whoever has to paint the same drawing somewhere else.
export { TONES, REGISTERS, PAPER, FONT, SIZE, registerOf, type Tone, type Register } from './render/sheet.ts';
export { pathPoints, inkPath, type Point as HandPoint } from './render/hand.ts';
export * from './render/route.ts';
export * from './render/boxes.ts';
export * from './render/sequence.ts';
export * from './render/typed.ts';
export * from './delta.ts';
export * from './render/compose.ts';
export * from './render/propose.ts';
// The standard of each class of diagram, and the lint that reads a written diagram against it.
export { inSpanish } from './standards-es.ts';
export { DIAGRAM_STANDARDS, DERIVED_KINDS, kindsOfLayer, kindOfDialect, lintDiagram as lintDiagramOfKind, detectDialect as dialectOf, type DiagramStandard, type DiagramOrigin, type DiagramContext } from './standards.ts';
export { drawMermaid, drawModel, type Drawn } from './draw.ts';
