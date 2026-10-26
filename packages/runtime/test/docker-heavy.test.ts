/**
 * SQL Server and Oracle Free for real: schema, a page, the read-only identity and (SQL Server) snapshot and reset.
 * Each needs about 2 GB: run alone, with LARU_HEAVY=1, not next to a running app env.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { ensureReader, query, reset, rows, schema, snapshot, type Store } from '../src/db.ts';
import { dockerUp, guard } from './guard.ts';

const heavy = !dockerUp ? 'Docker is not running' : process.env.LARU_HEAVY !== '1' ? 'set LARU_HEAVY=1 (needs ~2 GB each, run alone)' : false;
const KEY = 'laru-heavy-test';
const docker = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8' }).trim();
const until = async (probe: () => Promise<unknown>, s: number) => { for (let i = 0; i < s; i++) { try { await probe(); return; } catch { await new Promise((r) => setTimeout(r, 2000)); } } throw new Error('not ready'); };

test('SQL Server 2022: schema, reader, snapshot and reset', { skip: heavy, timeout: 900_000 }, async (t) => {
  const g = guard(KEY);
  const id = docker('run', '-d', '--label', `keelson.workspace=${KEY}`, '-e', 'ACCEPT_EULA=Y', '-e', 'MSSQL_SA_PASSWORD=Pw-test-12345!', 'mcr.microsoft.com/mssql/server:2022-latest');
  t.after(() => { docker('rm', '-f', '-v', id); g.check(); });
  const master: Store = { service: 'sql', kind: 'mssql', container: id, user: 'sa', db: 'master', port: 1433, image: 'mssql' };
  await until(() => query(master, 'SELECT 1', { write: true }), 120);
  await query(master, 'CREATE DATABASE shop;', { write: true });
  const s: Store = { ...master, db: 'shop' };
  await query(s, "CREATE TABLE dbo.orders (id INT PRIMARY KEY, note NVARCHAR(50)); INSERT INTO dbo.orders VALUES (1, N'uno'), (2, NULL);", { write: true });
  await ensureReader(s);
  assert.deepEqual((await schema(s)).map((x) => `${x.schema}.${x.name}:${x.columns.filter((c) => c.pk).map((c) => c.name)}`), ['dbo.orders:id']);
  assert.deepEqual((await rows(s, { schema: 'dbo', table: 'orders', sort: { column: 'id' } })).rows, [['1', 'uno'], ['2', null]]);
  // the reader identity cannot write, and cannot step back out of it (-b stops the batch at the refusal)
  await assert.rejects(query(s, "INSERT INTO dbo.orders VALUES (3, N'x');"), /permission was denied/i);
  await assert.rejects(query(s, "REVERT; INSERT INTO dbo.orders VALUES (3, N'x');"), /non-revertible/i);
  assert.equal((await query(s, 'SELECT count(*) AS n FROM dbo.orders', { write: true })).rows[0][0], '2');
  await snapshot(s);
  await query(s, 'DELETE FROM dbo.orders;', { write: true });
  const r = await reset(s);
  assert.equal((await query(s, 'SELECT count(*) AS n FROM dbo.orders', { write: true })).rows[0][0], '2');
  assert.ok(r.ms < 60_000);
});

test('Oracle Free: schema, a page and the read-only user', { skip: heavy, timeout: 900_000 }, async (t) => {
  const g = guard(KEY);
  const id = docker('run', '-d', '--label', `keelson.workspace=${KEY}`, '-e', 'ORACLE_PASSWORD=pwtest123', '-e', 'APP_USER=shop', '-e', 'APP_USER_PASSWORD=pwshop123', 'gvenzl/oracle-free:slim');
  t.after(() => { docker('rm', '-f', '-v', id); g.check(); });
  const s: Store = { service: 'ora', kind: 'oracle', container: id, user: 'shop', db: 'FREEPDB1', port: 1521, image: 'gvenzl/oracle-free' };
  await until(() => query(s, 'SELECT 1 FROM dual;', { write: true }), 240);
  await query(s, "CREATE TABLE orders (id NUMBER PRIMARY KEY, note VARCHAR2(50));\nINSERT INTO orders VALUES (1, 'uno');\nINSERT INTO orders VALUES (2, NULL);\nCOMMIT;", { write: true });
  await ensureReader(s);
  assert.deepEqual((await schema(s)).map((x) => `${x.name}:${x.columns.filter((c) => c.pk).map((c) => c.name)}`), ['ORDERS:ID']);
  assert.deepEqual((await rows(s, { schema: 'SHOP', table: 'ORDERS', sort: { column: 'ID' } })).rows, [['1', 'uno'], ['2', null]]);
  // ORA-01031 before 23ai, ORA-41900 «missing INSERT privilege» since
  await assert.rejects(query(s, "INSERT INTO shop.orders VALUES (3, 'x');"), /ORA-01031|ORA-41900/);
  assert.equal((await query(s, 'SELECT count(*) FROM orders;', { write: true })).rows[0][0], '2');
});
