/**
 * The database explorer against real servers: a 100 MB Postgres reset under 10 s, the read-only role, and MySQL's
 * schema and query. Heavy: LARU_E2E=1 with Docker running. Containers carry a test label and are removed after.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { ensureReader, query, reset, rows, schema, snapshot, type Store } from '../src/db.ts';
import { dockerUp, guard } from './guard.ts';

const heavy = !dockerUp ? 'Docker is not running' : process.env.LARU_E2E !== '1' ? 'set LARU_E2E=1' : false;
const KEY = 'laru-db-test';
const run = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8' }).trim();
const wait = async (id: string, probe: string[]) => { for (let i = 0; i < 90; i++) { try { execFileSync('docker', ['exec', id, ...probe], { stdio: 'ignore' }); return; } catch { await new Promise((r) => setTimeout(r, 1000)); } } throw new Error('not ready'); };

test('Postgres: reset of 100 MB under 10 s, and a reader that cannot write', { skip: heavy, timeout: 300_000 }, async (t) => {
  const g = guard(KEY);
  const id = run('run', '-d', '--label', `keelson.workspace=${KEY}`, '-e', 'POSTGRES_PASSWORD=pw-test-123', '-e', 'POSTGRES_USER=app', '-e', 'POSTGRES_DB=app', 'postgres:16-alpine');
  t.after(() => { run('rm', '-f', '-v', id); g.check(); });
  await wait(id, ['pg_isready', '-h', '127.0.0.1', '-U', 'app']);
  await new Promise((r) => setTimeout(r, 1500));
  const s: Store = { service: 'pg', kind: 'postgres', container: id, user: 'app', db: 'app', port: 5432, image: 'postgres:16-alpine' };
  await ensureReader(s);
  await ensureReader(s); // idempotent
  await query(s, "CREATE TABLE b AS SELECT g, md5(g::text)||repeat('x',200) AS pad FROM generate_series(1,400000) g; ALTER TABLE b ADD PRIMARY KEY (g);", { write: true });
  assert.ok(Number((await query(s, "SELECT pg_database_size('app')")).rows[0][0]) >= 100 * 2 ** 20);
  await snapshot(s);
  await query(s, 'DELETE FROM b WHERE g > 1000;', { write: true });
  const r = await reset(s);
  assert.ok(r.ms < 10_000, `reset took ${r.ms} ms`);
  assert.equal((await query(s, 'SELECT count(*) FROM b')).rows[0][0], '400000');
  await assert.rejects(query(s, 'SET default_transaction_read_only = off; INSERT INTO b VALUES (0, $$x$$);'), /permission denied/);
  const page = await rows(s, { schema: 'public', table: 'b', filters: [{ column: 'pad', op: 'contains', value: "'); DROP TABLE b; --" }] });
  assert.equal(page.rows.length, 0);
  assert.equal((await query(s, 'SELECT count(*) FROM b')).rows[0][0], '400000', 'nothing dropped');
  assert.deepEqual((await schema(s)).find((x) => x.name === 'b')?.columns.filter((c) => c.pk).map((c) => c.name), ['g']);
});

test('MySQL 8.4: schema and query', { skip: heavy, timeout: 300_000 }, async (t) => {
  const g = guard(KEY);
  const id = run('run', '-d', '--label', `keelson.workspace=${KEY}`, '-e', 'MYSQL_ROOT_PASSWORD=pw-test-123', '-e', 'MYSQL_DATABASE=shop', 'mysql:8.4');
  t.after(() => { run('rm', '-f', '-v', id); g.check(); });
  await wait(id, ['sh', '-c', 'MYSQL_PWD=pw-test-123 mysql -u root -e "select 1" shop']);
  const s: Store = { service: 'my', kind: 'mysql', container: id, user: 'root', db: 'shop', port: 3306, image: 'mysql:8.4' };
  await query(s, "CREATE TABLE orders (id INT PRIMARY KEY, note VARCHAR(50)); INSERT INTO orders VALUES (1, 'uno'), (2, NULL);", { write: true });
  assert.deepEqual((await schema(s)).map((x) => `${x.name}:${x.columns.filter((c) => c.pk).map((c) => c.name)}`), ['orders:id']);
  const r = await rows(s, { schema: 'shop', table: 'orders', sort: { column: 'id' } });
  assert.deepEqual(r.rows, [['1', 'uno'], ['2', null]]);
});
