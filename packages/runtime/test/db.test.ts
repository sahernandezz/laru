import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { browseSql, ident, parseCsv, updateSql } from '../src/db.ts';
import { connection, emitted, isMongo, script } from '../src/explore/mongo.ts';

test('psql CSV: quotes, commas and newlines inside a value, NULL apart from the empty string', () => {
  const { rows } = parseCsv('id,name,note\n1,"a, ""b""","two\nlines"\n2,,""\n');
  assert.deepEqual(rows, [['id', 'name', 'note'], ['1', 'a, "b"', 'two\nlines'], ['2', null, '']]);
  assert.deepEqual(parseCsv('x\r\n1\r\n').rows, [['x'], ['1']]);
  const many = parseCsv('n\n1\n2\n3\n4\n', 2);
  assert.equal(many.truncated, true);
  assert.equal(many.rows.length, 3, 'reading stops at limit+1');
});

test('identifiers are quoted by doubling the quote', () => {
  assert.equal(ident('users'), '"users"');
  assert.equal(ident('we"ird'), '"we""ird"');
});

test('a browse binds every value as a variable, whatever it holds', () => {
  const evil = "'); DROP TABLE x; --";
  const { sql, vars } = browseSql({ schema: 'gateway', table: 'users', filters: [{ column: 'email', op: 'contains', value: evil }, { column: 'role', op: '=', value: 'ADMIN' }], sort: { column: 'created_at', desc: true }, page: 2, pageSize: 50 });
  assert.equal(sql, `SELECT * FROM "gateway"."users" WHERE "email"::text ILIKE '%' || :'p1' || '%' AND "role"::text = :'p2' ORDER BY "created_at" DESC LIMIT 51 OFFSET 100;`);
  assert.deepEqual(vars, [evil, 'ADMIN']);
  assert.ok(!sql.includes('DROP'));
  const named = browseSql({ schema: 'a"; DROP TABLE x; --', table: 't', filters: [{ column: 'c"--', op: 'null' }] });
  assert.equal(named.sql, `SELECT * FROM "a""; DROP TABLE x; --"."t" WHERE "c""--" IS NULL LIMIT 101 OFFSET 0;`);
  assert.throws(() => browseSql({ schema: 's', table: 't', filters: [{ column: 'c', op: 'OR 1=1' as never, value: 'x' }] }), /unknown operator/);
});

test('an update changes one row by its key; the preview shows the values, the SQL binds them', () => {
  const u = updateSql({ schema: 'gateway', table: 'users', key: { id: '7f1c' }, set: { full_name: "O'Brien", avatar: null } });
  assert.equal(u.sql, `UPDATE "gateway"."users" SET "full_name" = :'p1', "avatar" = NULL WHERE "id" = :'p2';`);
  assert.deepEqual(u.vars, ["O'Brien", '7f1c']);
  assert.equal(u.preview, `UPDATE "gateway"."users" SET "full_name" = 'O''Brien', "avatar" = NULL WHERE "id" = '7f1c';`);
  assert.throws(() => updateSql({ schema: 's', table: 't', key: {}, set: { a: '1' } }), /primary key/);
});

test('MySQL quotes with backticks', () => {
  const { sql } = browseSql({ schema: 'shop', table: 'or`ders', filters: [{ column: 'total', op: '>', value: '10' }] }, 'mysql');
  assert.equal(sql, "SELECT * FROM `shop`.`or``ders` WHERE CAST(`total` AS CHAR) > :'p1' LIMIT 101 OFFSET 0;");
});

test('SQL Server and Oracle quote, cast and page their own way', () => {
  const ms = browseSql({ schema: 'dbo', table: 'or]ders', filters: [{ column: 'note', op: 'contains', value: "x'; DROP--" }], page: 1, pageSize: 10 }, 'mssql');
  assert.equal(ms.sql, "SELECT * FROM [dbo].[or]]ders] WHERE CAST([note] AS NVARCHAR(MAX)) LIKE N'%' + :'p1' + N'%' ORDER BY (SELECT NULL) OFFSET 10 ROWS FETCH NEXT 11 ROWS ONLY;");
  assert.deepEqual(ms.vars, ["x'; DROP--"]);
  const sorted = browseSql({ schema: 'dbo', table: 't', sort: { column: 'id', desc: true } }, 'mssql');
  assert.match(sorted.sql, /ORDER BY \[id\] DESC OFFSET 0 ROWS FETCH NEXT 101 ROWS ONLY;$/);
  const ora = browseSql({ schema: 'APP', table: 'ORDERS', filters: [{ column: 'TOTAL', op: '>', value: '10' }] }, 'oracle');
  assert.equal(ora.sql, `SELECT * FROM "APP"."ORDERS" WHERE TO_CHAR("TOTAL") > :'p1' OFFSET 0 ROWS FETCH NEXT 101 ROWS ONLY`);
  assert.equal(updateSql({ schema: 'dbo', table: 't', key: { id: '1' }, set: { n: 'a' } }, 'mssql').sql, "UPDATE [dbo].[t] SET [n] = :'p1' WHERE [id] = :'p2';");
});

test('MongoDB is found by its image, not by the tools around it', () => {
  for (const i of ['mongo:7', 'mongo', 'docker.io/library/mongo:7.0@sha256:ab12', 'mongodb/mongodb-community-server:7.0-ubi8', 'bitnami/mongodb:7.0', 'registry:5000/bitnami/mongodb']) assert.ok(isMongo(i), i);
  for (const i of ['mongo-express:1', 'bitnami/mongodb-exporter', 'percona/mongodb_exporter:0.40', 'mongoclient/mongoclient']) assert.ok(!isMongo(i), i);
});

/** A Mongo script run in a sandbox that stands in for mongosh (EJSON) or the legacy shell (no EJSON, _getEnv). */
function shell(src: string, o: { legacy?: boolean; env?: Record<string, string>; auth?: unknown } = {}) {
  const out: string[] = [], logins: unknown[][] = [], dropped: string[] = [];
  const db = { getSiblingDB: (name: string) => ({ auth: (...a: unknown[]) => { logins.push(a); return o.auth ?? { ok: 1 }; }, dropDatabase: () => dropped.push(name) }) };
  const ObjectId = (hex: string) => ({ oid: hex });
  runInNewContext(src, { print: (x: string) => out.push(x), db, ObjectId, ...(o.legacy ? { _getEnv: (k: string) => o.env?.[k] ?? '' } : { process: { env: o.env ?? {} }, EJSON: { parse: JSON.parse, stringify: (x: unknown) => JSON.stringify(x) } }) });
  return { out: out.join('\n'), logins, dropped };
}

test('a Mongo script carries what the user typed as one string literal: data, whatever it says', () => {
  const nasty = { filter: '"}); db.getSiblingDB("app").dropDatabase(); ({"', db: "app'); //", collection: '`${db}` */ \u2028\u2029 \\ \n end', id: '</script>' };
  const run = shell(script('put(A);', nasty, 'reader'));
  assert.deepEqual(emitted(run.out).map((l) => JSON.parse(l)), [nasty], 'every argument comes back exactly as typed');
  const parsed = shell(script('put(parse(A.filter)); put("after");', nasty, 'reader'));
  assert.throws(() => emitted(parsed.out), /JSON/, 'a filter that is not JSON fails as a parse error');
  assert.deepEqual(parsed.dropped, [], 'and nothing it says ever runs');
});

test('a Mongo script logs in with the credentials of the container environment, as the reader or the root user', () => {
  const env = { KS_U: 'admin', KS_P: 'pw-1' };
  assert.deepEqual(shell(script('put(1);', {}, 'reader'), { env }).logins, [['ks_reader', 'pw-1']]);
  assert.deepEqual(shell(script('put(1);', {}, 'root'), { env, legacy: true }).logins, [['admin', 'pw-1']], 'the legacy shell reads it with _getEnv');
  assert.deepEqual(shell(script('put(1);', {}, 'reader')).logins, [], 'no root password: no access control to log into');
  assert.throws(() => emitted(shell(script('put(1);', {}, 'reader'), { env, legacy: true, auth: 0 }).out), /Authentication failed/, 'the legacy shell answers 0 instead of throwing');
  assert.deepEqual(emitted(shell(script('put(parse(A.f));', { f: '{"_id":{"$oid":"5f0c3c3c3c3c3c3c3c3c3c3c"},"at":{"$date":"1970-01-01T00:00:00Z"}}' }, 'reader'), { legacy: true }).out).map((l) => JSON.parse(l)),
    [{ _id: { oid: '5f0c3c3c3c3c3c3c3c3c3c3c' }, at: { $date: '1970-01-01T00:00:00.000Z' } }], 'the legacy shell reads Extended JSON through a reviver and writes dates back as $date');
  assert.deepEqual(emitted('Current Mongosh Log ID: x\n\u0001KS{"a":1}\nnoise\n\u0001KS2\n'), ['{"a":1}', '2'], 'only what the script put');
});

test('the shell line names the shell the image has: the legacy mongo before 6.0, mongosh after or when unknown', () => {
  const at = (version?: string) => connection({ service: 'm', container: 'abcdef0123456789', image: 'mongo', user: 'admin', version }).shell;
  assert.equal(at('4.4.30'), 'docker exec -it abcdef012345 mongo -u admin --authenticationDatabase admin');
  assert.equal(at('5.0.31'), 'docker exec -it abcdef012345 mongo -u admin --authenticationDatabase admin');
  assert.equal(at('7.0.45'), 'docker exec -it abcdef012345 mongosh -u admin --authenticationDatabase admin');
  assert.equal(at(), 'docker exec -it abcdef012345 mongosh -u admin --authenticationDatabase admin');
});
