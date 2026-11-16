/** A run's recording of its data: each read by one key, and a recorded table browsed as the screen asks. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browseRecorded, readKey } from '../src/index.ts';

test('a read\'s key is its path and its parameters in order, without the env, the run, the flow or an empty one', () => {
  assert.equal(readKey('db/schema', { service: 'postgres', env: 'local' }), 'db/schema?service=postgres');
  assert.equal(readKey('storage/ls', { recursive: '1', path: 'files', run: '7', flujo: 'x' }), 'storage/ls?path=files&recursive=1');
  assert.equal(readKey('storage/ls', { path: '' }), 'storage/ls');
  assert.equal(readKey('mail', { q: '', kind: 'all' }), 'mail?kind=all');
});

test('a recorded table is filtered, ordered (numbers as numbers, NULL last) and paged as a live one', () => {
  const t = { columns: ['id', 'name', 'total'], rows: [['1', 'ana', '10'], ['2', 'luis', '9'], ['3', 'Bea', null], ['4', 'anabel', '100']], truncated: false };
  assert.deepEqual(browseRecorded(t, { filters: [{ column: 'name', op: 'contains', value: 'AN' }] }).rows.map((r) => r[1]), ['ana', 'anabel']);
  assert.deepEqual(browseRecorded(t, { sort: { column: 'total' } }).rows.map((r) => r[2]), ['9', '10', '100', null]);
  assert.deepEqual(browseRecorded(t, { sort: { column: 'total', desc: true } }).rows.map((r) => r[0]), ['3', '4', '1', '2']);
  assert.deepEqual(browseRecorded(t, { filters: [{ column: 'total', op: '>=', value: '10' }] }).rows.map((r) => r[0]), ['1', '4']);
  assert.deepEqual(browseRecorded(t, { filters: [{ column: 'total', op: 'null' }] }).rows.map((r) => r[0]), ['3']);
  const page = browseRecorded(t, { pageSize: 3, page: 0 });
  assert.equal(page.rows.length, 3);
  assert.equal(page.truncated, true, 'a next page is there');
  assert.deepEqual(browseRecorded(t, { pageSize: 3, page: 1 }), { columns: t.columns, rows: [['4', 'anabel', '100']], truncated: false, ms: 0 });
});
