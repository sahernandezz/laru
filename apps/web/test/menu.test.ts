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

test('a flow\'s pages and its own environment\'s data share the flow\'s menu, before its data has loaded too', () => {
  const doc = menuOf(['docs', 'flow:buy', 't', 'live'], { k });
  assert.equal(doc.kind === 'scope' && doc.card.title, 'Comprar');
  assert.equal(doc.kind === 'scope' && doc.active, 'live');
  const data = menuOf(['queues', 'f-buy'], {});
  assert.equal(data.kind === 'scope' && data.card.title, 'buy', 'the slug from the address while nothing is loaded');
  assert.equal(data.kind === 'scope' && data.active, 'queues');
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
