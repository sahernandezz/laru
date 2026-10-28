/** A store laru.yaml explains how to read: the answer is a table when it is CSV or TSV with a header, else text. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAnswer } from '../src/explore/custom.ts';

test('a CSV or TSV answer with a header is a table; a ragged or single-line one is text', () => {
  assert.deepEqual(readAnswer('id,nombre\n1,ana\n2,\n'), { columns: ['id', 'nombre'], rows: [['1', 'ana'], ['2', null]], truncated: false });
  assert.deepEqual(readAnswer('id\tnombre\r\n1\tbea\r\n'), { columns: ['id', 'nombre'], rows: [['1', 'bea']], truncated: false });
  assert.deepEqual(readAnswer('usuarios\npagos\n'), { text: 'usuarios\npagos\n' }, 'one column without separators reads as lines of text');
  assert.deepEqual(readAnswer('OK, 3 rows\n'), { text: 'OK, 3 rows\n' });
  assert.deepEqual(readAnswer('a,b\n1\n'), { text: 'a,b\n1\n' }, 'rows of different widths are not a table');
  assert.equal(readAnswer('n\n' + Array.from({ length: 5 }, (_, i) => `${i},x`).join('\n'), 3).truncated, undefined);
  assert.deepEqual(readAnswer('a,b\n' + Array.from({ length: 5 }, (_, i) => `${i},x`).join('\n'), 3).truncated, true);
});
