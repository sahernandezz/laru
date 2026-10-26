/** The SQL editor's suggestions and CSV export. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Table } from '@laru/runtime';
import { suggest, toCsv } from '../src/lib/sql.ts';

const col = (name: string) => ({ name, type: 'text', nullable: true, pk: false });
const T: Table[] = [
  { schema: 'gateway', name: 'users', rows: null, columns: [col('id'), col('username'), col('email')] },
  { schema: 'file_service', name: 'files', rows: 12, columns: [col('id'), col('owner_id'), col('original_name')] },
  { schema: 'public', name: 'flyway', rows: 3, columns: [col('version')] },
];

test('tables by name or schema, columns of the tables the query names', () => {
  assert.deepEqual(suggest('SELECT * FROM us', 16, T), { from: 14, items: ['gateway.users'] });
  assert.deepEqual(suggest('select * from gat', 17, T)?.items, ['gateway.users', 'gateway.']);
  assert.deepEqual(suggest('SELECT * FROM fly', 17, T)?.items, ['flyway'], 'public needs no schema');
  assert.deepEqual(suggest('SELECT * FROM gateway.', 22, T)?.items, ['gateway.users']);
  const q = 'SELECT us FROM gateway.users';
  assert.deepEqual(suggest(q, 9, T)?.items, ['gateway.users', 'username'], 'a column of a named table');
  assert.deepEqual(suggest('SELECT users.em', 15, T)?.items, ['users.email']);
  assert.equal(suggest('SELECT 12', 9, T), null);
  assert.equal(suggest('SELECT * FROM gateway.users', 27, T), null, 'nothing when the word is complete');
});

test('CSV keeps NULL apart from the empty string', () => {
  assert.equal(toCsv(['a', 'b', 'c'], [[null, '', 'x,"y"'], ['1', 'line\nbreak', 'z']]), 'a,b,c\r\n,"","x,""y"""\r\n1,"line\nbreak",z\r\n');
});
