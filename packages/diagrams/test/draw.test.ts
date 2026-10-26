import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawMermaid } from '../src/index.ts';

const FLOW = '---\ntitle: Order\n---\nflowchart TD\n  subgraph a["Customer"]\n    p[Place the order]\n  end\n  subgraph b["Platform"]\n    c[Charge the card]\n  end\n  p --> c';

test('a written diagram is drawn as a fixed SVG, each label once and escaped', () => {
  const r = drawMermaid(FLOW);
  assert.ok(r.svg?.startsWith('<svg'), r.error);
  assert.match(r.svg!, /Place the order/);
  const evil = drawMermaid(FLOW.replace('Place the order', '<img src=x onerror=alert(1)>'));
  assert.ok(evil.svg && !evil.svg.includes('<img'), 'markup in a label never reaches the page as markup');
});

test('what cannot be drawn says why instead of throwing', () => {
  assert.match(drawMermaid('gantt\n  title x').error ?? '', /./);
  assert.ok(drawMermaid('').error);
});

test('a roadmap draws its tasks, its sections and a diamond for a milestone', () => {
  const r = drawMermaid(['gantt', '    title Hoja', '    dateFormat YYYY-MM-DD', '    section Bases', '        Catálogo  :milestone, m1, 2026-01-15, 0d', '        Contratos :active, m2, 2026-03-01, 30d'].join('\n'));
  assert.equal(r.error, undefined);
  assert.match(r.svg!, /Catálogo/);
  assert.match(r.svg!, /BASES/);
  assert.match(r.svg!, /<path d="M/);
  assert.match(r.svg!, /<rect x=/);
  // nothing is drawn past the plot: a month tick after the last task would sit outside the sheet
  assert.ok([...r.svg!.matchAll(/<line x1="([\d.]+)"/g)].every((m) => Number(m[1]) <= 1000));
});

test('the branches and releases of a repository draw a lane per branch and the tag of a release', () => {
  const r = drawMermaid(['gitGraph', '    commit id: "start"', '    branch develop', '    commit', '    checkout main', '    merge develop tag: "v1.0.0"'].join('\n'));
  assert.equal(r.error, undefined);
  assert.match(r.svg!, /develop/);
  assert.match(r.svg!, /v1\.0\.0/);
});

test('the classes of some code draw their members and the cardinality of what relates them', () => {
  const r = drawMermaid(['classDiagram', '    class Order {', '        +string id', '    }', '    class Line {', '        +int amount', '    }', '    Order "1" --> "0..*" Line'].join('\n'));
  assert.equal(r.error, undefined);
  assert.match(r.svg!, /\+string id/);
  assert.match(r.svg!, /0\.\.\*/);
});

test('what the readers do not understand is said, never drawn as if it were not there', () => {
  const err = (code: string) => drawMermaid(code).error ?? '';
  // gantt: a date format or a calendar it does not apply, a task with no start, an unknown word, a dependency that is not above
  assert.match(err('gantt\n    dateFormat DD-MM-YYYY\n    section A\n        T :t1, 01-02-2026, 1d'), /dateFormat DD-MM-YYYY is not read/);
  assert.match(err('gantt\n    excludes weekends\n    section A\n        T :t1, 2026-01-01, 5d'), /excludes/);
  assert.match(err('gantt\n    section A\n        T :t1, 2 days'), /is not a tag, an id, a date or a duration/);
  assert.match(err('gantt\n    section A\n        T :t1, 1d'), /has no start date/);
  assert.match(err('gantt\n    section A\n        T :t1, after zz, 1d'), /names a task that is not above it/);
  assert.match(err('gantt\n    section A\n        not a task'), /not understood/);
  // dates that do not exist, and an end before its start, never reach the sheet as NaN
  assert.match(err('gantt\n    section A\n        T :t1, 2026-13-45, 1d'), /is not a date/);
  assert.match(err('gantt\n    section A\n        T :t1, 2026-02-30, 1d'), /is not a date/);
  assert.match(err('gantt\n    section A\n        T :t1, 2026-03-10, 2026-03-01'), /ends before it starts/);
  assert.ok(!/NaN/.test(drawMermaid('gantt\n    section A\n        T :t1, 2026-03-01, 2026-03-01').svg ?? ''), 'a task that ends the day it starts is one day, not NaN');
  // an end date is an end, not a second start
  const g = drawMermaid('gantt\n    section A\n        Obra :o1, 2026-01-01, 2026-01-31\n        Fin :milestone, f1, after o1, 0d');
  assert.equal(g.error, undefined);
  assert.match(g.svg!, /<rect x="[^"]+" y="[^"]+" width="(?:[3-9]\d\d)/, 'the bar spans the thirty days');
  // gitGraph: a branch that is not there, a command it does not read
  assert.match(err('gitGraph\n    commit\n    checkout nope'), /branch that does not exist/);
  assert.match(err('gitGraph\n    commit\n    merge nope'), /branch that does not exist/);
  assert.match(err('gitGraph\n    commit\n    cherry-pick id: "x"'), /«cherry-pick» is not read/);
  assert.match(err('gitGraph\n    commit\n    branch a\n    branch a'), /created twice/);
  // classDiagram: members written outside the braces count, anything else it does not read is said
  const c = drawMermaid('classDiagram\n    class Order\n    Order : +string id\n    Order : +int total\n    Order --> Line');
  assert.equal(c.error, undefined);
  assert.match(c.svg!, /\+string id/);
  assert.match(c.svg!, /\+int total/);
  assert.match(err('classDiagram\n    class Order\n    note for Order "x"'), /not understood/);
  assert.match(err('classDiagram\n    class Order {\n        +int id'), /never closed/);
  // the start of a line points at its own end: an inheritance triangle faces the parent
  assert.match(drawMermaid('classDiagram\n    Animal <|-- Dog').svg!, /orient="auto-start-reverse"/);
});

test('the manual of diagrams is told in Spanish: every class and every rule', async () => {
  const { DIAGRAM_STANDARDS } = await import('../src/standards.ts');
  const { DIAGRAM_ES, inSpanish } = await import('../src/standards-es.ts');
  for (const c of Object.values(DIAGRAM_STANDARDS)) {
    assert.ok(DIAGRAM_ES[c.kind], `${c.kind} has its Spanish text`);
    const es = inSpanish(c);
    assert.notEqual(es.question, c.question, c.kind);
    assert.notEqual(es.purpose, c.purpose, c.kind);
    for (const [i, r] of es.rules.entries()) assert.notEqual(r.text, c.rules[i].text, `${c.kind}.${r.id} is translated`);
  }
  assert.match(inSpanish(DIAGRAM_STANDARDS['c4-context']).rules.find((r) => r.id === 'size')!.text, /No más de \d+ elementos/);
});
