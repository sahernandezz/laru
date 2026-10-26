/** The diagram editor's canvas read back into the model: what is deleted goes, what is drawn comes in once, an arrow drawn between two pieces is an arrow. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromMermaid } from '@laru/diagrams';
import { fromScene, toScene } from '../src/lib/excalidrawScene.ts';

const model = fromMermaid(`C4Container
  title T
  Container_Boundary(b, "App") {
    Container(fe, "Front", "React", "web")
    Container(api, "API", "Node", "back")
    ContainerDb(db, "DB", "Postgres", "data")
  }
  Rel(fe, api, "llama", "REST")
  Rel(api, db, "lee", "SQL")`, 'c4-container')!.model;
type El = Record<string, unknown> & { customData?: { role?: string; modelId?: string } };

test('a piece deleted on the canvas leaves the model with its arrows; an arrow deleted, alone', () => {
  const els = toScene(model).elements as El[];
  const gone = els.map((e) => (e.customData?.modelId === 'api' && e.customData.role !== 'edge' ? { ...e, isDeleted: true } : e));
  const next = fromScene(gone, model);
  assert.deepEqual(next.nodes.map((n) => n.id).sort(), ['b', 'db', 'fe']);
  assert.equal(next.edges.length, 0, 'both arrows touched the API');
  const noEdge = els.map((e) => (e.customData?.role === 'edge' && e.customData.modelId === model.edges[0].id ? { ...e, isDeleted: true } : e));
  assert.deepEqual(fromScene(noEdge, model).edges.map((e) => e.id), [model.edges[1].id]);
});

test('a shape drawn by hand becomes one piece, however many times the canvas reports it; an arrow drawn to it is an arrow', () => {
  const els = toScene(model).elements as El[];
  const front = els.find((e) => e.customData?.modelId === 'fe' && e.customData.role === 'piece')!;
  const drawn: El[] = [
    ...els,
    { id: 'r1', type: 'rectangle', x: 900, y: 40, width: 160, height: 80, groupIds: [], isDeleted: false },
    { id: 't1', type: 'text', x: 910, y: 60, width: 100, height: 20, text: 'Cola', originalText: 'Cola', containerId: 'r1', isDeleted: false },
    { id: 'a1', type: 'arrow', x: 0, y: 0, width: 1, height: 1, startBinding: { elementId: front.id }, endBinding: { elementId: 'r1' }, isDeleted: false },
  ];
  // the canvas calls back again and again with the same elements: the result is the same each time
  const once = fromScene(drawn, model), twice = fromScene(drawn, model);
  assert.deepEqual(once, twice);
  assert.equal(once.nodes.filter((n) => n.name === 'Cola').length, 1);
  assert.deepEqual(once.edges.at(-1), { id: 'fe-cola', from: 'fe', to: 'cola' });
});
