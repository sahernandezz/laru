/** Postgres' protocol as the tap watches it: statements paired with their columns, rows, tags and errors. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ROWS, pgWatcher, type PgResult } from '../tap/pg.ts';

const z = (s: string) => Buffer.from(`${s}\0`);
const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const msg = (type: string, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from(type), i32(body.length + 4), body]); };
const untyped = (...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([i32(body.length + 4), body]); };
const field = (name: string, oid: number, fmt: number) => Buffer.concat([z(name), i32(0), i16(0), i32(oid), i16(-1), i32(-1), i16(fmt)]);
const row = (...vals: Array<Buffer | null>) => Buffer.concat([i16(vals.length), ...vals.flatMap((v) => (v === null ? [i32(-1)] : [i32(v.length), v]))]);
const extended = (name: string, sql: string, describe = true) => Buffer.concat([
  ...(sql ? [msg('P', z(name), z(sql), i16(0))] : []), msg('B', z(''), z(name), i16(0), i16(0), i16(0)), ...(describe ? [msg('D', Buffer.from('P'), z(''))] : []), msg('E', z(''), i32(0)), msg('S'),
]);

function session() {
  const out: PgResult[] = [];
  const w = pgWatcher((r) => out.push(r));
  w.up(untyped(i32(80877103)));
  w.down(Buffer.from('N'));
  w.up(untyped(i32(196608), z('user'), z('app'), Buffer.from([0])));
  w.down(Buffer.concat([msg('R', i32(0)), msg('K', i32(4242), i32(7)), msg('Z', Buffer.from('I'))]));
  return { w, out };
}

test('a prepared statement: its text, columns, rows and tag, under the backend pid', () => {
  const { w, out } = session();
  w.up(extended('S_1', 'select id, name from users where id > $1'));
  w.down(Buffer.concat([msg('1'), msg('2'), msg('T', i16(2), field('id', 23, 1), field('name', 25, 0)), msg('D', row(i32(1), Buffer.from('ana'))), msg('D', row(i32(2), null)), msg('C', z('SELECT 2')), msg('Z', Buffer.from('I'))]));
  assert.deepEqual(out, [{ pid: 4242, stmt: 'select id, name from users where id > $1', cols: ['id', 'name'], rows: [['1', 'ana'], ['2', 'NULL']], more: 0, tag: 'SELECT 2' }]);
  // run again with no Parse and no Describe: the columns are the statement's, from before
  w.up(extended('S_1', '', false));
  w.down(Buffer.concat([msg('2'), msg('D', row(i32(3), Buffer.from('luis'))), msg('C', z('SELECT 1')), msg('Z', Buffer.from('I'))]));
  assert.deepEqual(out[1], { pid: 4242, stmt: 'select id, name from users where id > $1', cols: ['id', 'name'], rows: [['3', 'luis']], more: 0, tag: 'SELECT 1' });
});

test('a simple query, an error, and many rows counted but not all kept', () => {
  const { w, out } = session();
  w.up(msg('Q', z('BEGIN')));
  w.down(Buffer.concat([msg('C', z('BEGIN')), msg('Z', Buffer.from('T'))]));
  w.up(extended('', 'insert into users(name) values ($1)'));
  w.down(Buffer.concat([msg('1'), msg('2'), msg('n'), msg('E', Buffer.from('S'), z('ERROR'), Buffer.from('C'), z('23505'), Buffer.from('M'), z('duplicate key value'), Buffer.from([0])), msg('Z', Buffer.from('E'))]));
  w.up(msg('Q', z('select n from big')));
  const rows = Array.from({ length: MAX_ROWS + 5 }, (_, i) => msg('D', row(Buffer.from(String(i)))));
  w.down(Buffer.concat([msg('T', i16(1), field('n', 23, 0)), ...rows, msg('C', z(`SELECT ${MAX_ROWS + 5}`)), msg('Z', Buffer.from('I'))]));
  assert.deepEqual(out.map((r) => [r.stmt, r.tag ?? r.error, r.rows.length, r.more]), [
    ['BEGIN', 'BEGIN', 0, 0],
    ['insert into users(name) values ($1)', '23505: duplicate key value', 0, 0],
    ['select n from big', `SELECT ${MAX_ROWS + 5}`, MAX_ROWS, 5],
  ]);
});

test('messages split across chunks are read whole; an encrypted session is let through unread', () => {
  const { w, out } = session();
  const up = extended('S_2', 'select 1');
  for (const b of up) w.up(Buffer.from([b]));
  const down = Buffer.concat([msg('1'), msg('2'), msg('T', i16(1), field('?column?', 23, 0)), msg('D', row(Buffer.from('1'))), msg('C', z('SELECT 1')), msg('Z', Buffer.from('I'))]);
  for (let i = 0; i < down.length; i += 3) w.down(down.subarray(i, i + 3));
  assert.equal(out[0]?.rows[0]?.[0], '1');
  const tls: PgResult[] = [];
  const t = pgWatcher((r) => tls.push(r));
  t.up(untyped(i32(80877103)));
  t.down(Buffer.from('S'));
  t.up(Buffer.from([0x16, 3, 1, 0, 5, 1, 2, 3, 4, 5]));
  t.down(Buffer.from([0x16, 3, 3, 0, 2, 9, 9]));
  assert.deepEqual(tls, []);
});
