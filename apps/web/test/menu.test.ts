/** The side menu is a function of the address: the same route always gives the same menu, with the section open lit up. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { KnowledgeData } from '../src/api.ts';
import { docsTab, menuOf } from '../src/lib/menu.ts';

const piece = (id: string, type: string, parent?: string, title = id) => ({ id, type, parent, title, status: 'active', summary: '', meta: {} });
const k = {
  lang: 'es', issues: [], conventions: {}, containers: [],
  shapes: { guide: { type: 'guide', stage: 'build', livesIn: ['application', 'module'] } },
  pieces: [piece('app:shop', 'application', undefined, 'Shop'), piece('mod:pay', 'module', 'app:shop', 'Pagos'), piece('guide:a', 'guide', 'mod:pay'), piece('guide:b', 'guide', 'app:shop'), piece('flow:buy', 'flow', 'app:shop', 'Comprar')],
} as unknown as KnowledgeData;

test('a piece of the application lights its kind up in the main menu; a module\'s piece keeps the module\'s menu', () => {
  assert.deepEqual(menuOf(['docs', 'app:shop', 't', 'modules'], { k }), { kind: 'main', active: 'docs', app: 'modules' });
  assert.deepEqual(menuOf(['docs', 'guide:b'], { k }), { kind: 'main', active: 'docs', app: 'p-guide' });
  const m = menuOf(['docs', 'guide:a'], { k });
  assert.equal(m.kind, 'scope');
  assert.equal(m.kind === 'scope' && m.card.title, 'Pagos');
  assert.equal(m.kind === 'scope' && m.active, 'p-guide');
});

test('a flow\'s data are its last run\'s recording, in the flow\'s menu; its environment\'s live data keep the environment\'s menu', () => {
  const doc = menuOf(['docs', 'flow:buy', 't', 'live'], { k });
  assert.equal(doc.kind === 'scope' && doc.card.title, 'Comprar');
  assert.equal(doc.kind === 'scope' && doc.active, 'live');
  assert.deepEqual(doc.kind === 'scope' && doc.sections.filter((x) => x.group).map((x) => x.to), ['#/flowdata/buy/data', '#/flowdata/buy/queues', '#/flowdata/buy/storage', '#/flowdata/buy/mail', '#/flowdata/buy/vars']);
  const recorded = menuOf(['flowdata', 'buy', 'queues'], {});
  assert.equal(recorded.kind === 'scope' && recorded.card.title, 'buy', 'the slug from the address while nothing is loaded');
  assert.equal(recorded.kind === 'scope' && recorded.active, 'queues');
  const live = menuOf(['queues', 'f-buy'], {});
  assert.equal(live.kind === 'scope' && live.card.title, 'f-buy');
  // the same screen on a run's recording of the flow (`?run=…&flujo=buy`) keeps the flow's menu
  const onRecording = menuOf(['data', 'local'], { recording: 'buy' });
  assert.equal(onRecording.kind === 'scope' && onRecording.card.title, 'buy');
  assert.equal(onRecording.kind === 'scope' && onRecording.active, 'data');
  const env = menuOf(['data', 'local'], {});
  assert.equal(env.kind === 'scope' && env.card.title, 'local');
});

test('old tabs land where they live now; anything else is the main menu with its screen', () => {
  assert.equal(docsTab({ type: 'module' }, 'data'), 'p-data-model');
  assert.equal(docsTab({ type: 'flow' }, 'env'), 'live');
  assert.equal(docsTab({ type: 'application' }, 'gov'), undefined);
  assert.deepEqual(menuOf(['runs', '9'], { k }), { kind: 'main', active: 'runs' });
  assert.deepEqual(menuOf([], {}), { kind: 'main', active: 'overview' });
});

test('a live session keeps its environment\'s menu when it is past the runs list', () => {
  const m = menuOf(['live', '7'], { runs: [], session: { id: '7', env: 'local' } });
  assert.equal(m.kind === 'scope' && m.card.title, 'local');
  assert.equal(m.kind === 'scope' && m.active, 'live');
});
