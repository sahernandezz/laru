/**
 * The databases of an env, through the client inside their own container: no driver, no port to open. SQL travels
 * on stdin, values as psql variables (`-v pN=…`, referenced as `:'pN'`), identifiers quoted by doubling `"`.
 * Reads run as `ks_reader` (pg_read_all_data), so a query cannot write whatever it does to its session; writes run
 * as the database owner and only through an explicit UPDATE the user has seen. Snapshot and reset copy the
 * database as a template, which takes seconds for hundreds of megabytes.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Workspace } from '@laru/core';
import { docker, dockerEnv, dockerJson, inspectEnv, LABEL } from './docker.ts';
import type { ComposeDoc } from './compose.ts';
import { envDir, readState } from './env.ts';

export interface Store {
  service: string;
  kind: 'postgres' | 'mysql' | 'mssql' | 'oracle';
  container: string;
  user: string;
  db: string;
  port: number;
  hostPort?: number;
  image: string;
}

export class DbError extends Error {}

/** RFC 4180 as psql --csv writes it: an unquoted empty field is NULL, a quoted one is ''. */
export function parseCsv(text: string, limit = Infinity): { rows: Array<Array<string | null>>; truncated: boolean } {
  const rows: Array<Array<string | null>> = [];
  let row: Array<string | null> = [], i = 0;
  while (i < text.length) {
    if (rows.length > limit) return { rows: rows.slice(0, limit + 1), truncated: true };
    let field: string | null;
    if (text[i] === '"') {
      let v = '';
      i++;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q < 0) { v += text.slice(i); i = text.length; break; }
        v += text.slice(i, q);
        if (text[q + 1] === '"') { v += '"'; i = q + 2; } else { i = q + 1; break; }
      }
      field = v;
    } else {
      let j = i;
      while (j < text.length && text[j] !== ',' && text[j] !== '\n' && text[j] !== '\r') j++;
      field = j === i ? null : text.slice(i, j);
      i = j;
    }
    row.push(field);
    if (text[i] === ',') { i++; continue; }
    if (text[i] === '\r') i++;
    if (text[i] === '\n' || i >= text.length) { i++; rows.push(row); row = []; }
  }
  return { rows, truncated: rows.length > limit };
}

export const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

type Kind = Store['kind'];
/** How each engine quotes a name, turns a column into text, and pages. */
const QUOTE: Record<Kind, (x: string) => string> = { postgres: ident, oracle: ident, mysql: (x) => `\`${x.replace(/`/g, '``')}\``, mssql: (x) => `[${x.replace(/]/g, ']]')}]` };
const TEXT: Record<Kind, (c: string) => string> = { postgres: (c) => `${c}::text`, mysql: (c) => `CAST(${c} AS CHAR)`, mssql: (c) => `CAST(${c} AS NVARCHAR(MAX))`, oracle: (c) => `TO_CHAR(${c})` };
const CONCAT: Record<Kind, (v: string) => string> = { postgres: (v) => `'%' || ${v} || '%'`, oracle: (v) => `'%' || ${v} || '%'`, mysql: (v) => `CONCAT('%', ${v}, '%')`, mssql: (v) => `N'%' + ${v} + N'%'` };
const page = (k: Kind, size: number, offset: number, sorted: boolean) =>
  k === 'mssql' ? `${sorted ? '' : ' ORDER BY (SELECT NULL)'} OFFSET ${offset} ROWS FETCH NEXT ${size + 1} ROWS ONLY`
  : k === 'oracle' ? ` OFFSET ${offset} ROWS FETCH NEXT ${size + 1} ROWS ONLY`
  : ` LIMIT ${size + 1} OFFSET ${offset}`;

const envOf = (raw: any): Record<string, string> => Object.fromEntries((raw.Config?.Env ?? []).map((e: string) => { const i = e.indexOf('='); return [e.slice(0, i), e.slice(i + 1)]; }));

/** The relational stores of an env that is up, with the user and database their image was started with. */
/** The databases an env runs; `run`: those of one instance of it (a flow's environment, an ephemeral run), never the base env's. */
export async function stores(ws: Workspace, env: string, run?: string): Promise<Store[]> {
  const composePath = join(envDir(ws, env), ...(run ? ['runs', run] : []), 'compose.yml');
  if (!existsSync(composePath)) return [];
  const doc = parse(readFileSync(composePath, 'utf8')) as ComposeDoc;
  const state = readState(ws, env);
  const out: Store[] = [];
  const running = (await inspectEnv(ws, env, run)).filter((c) => c.state === 'running' && (run ? true : !c.labels[LABEL.run]));
  for (const c of running) {
    const s = doc.services[c.labels['com.docker.compose.service']];
    const kind: Kind | null = /postgres|postgis|timescale/.test(c.image) ? 'postgres' : /mysql|mariadb/.test(c.image) ? 'mysql' : /mssql|sqlserver|azure-sql-edge/.test(c.image) ? 'mssql' : /oracle/.test(c.image) ? 'oracle' : null;
    if (!s || !kind || s.healthcheck === undefined && !c.health) { if (!kind) continue; }
    const [raw] = await dockerJson<any[]>(['inspect', c.id]);
    const e = envOf(raw);
    const port = { postgres: 5432, mysql: 3306, mssql: 1433, oracle: 1521 }[kind];
    const user = { postgres: e.POSTGRES_USER || 'postgres', mysql: 'root', mssql: 'sa', oracle: e.APP_USER || 'system' }[kind];
    const db = { postgres: e.POSTGRES_DB || user, mysql: e.MYSQL_DATABASE || 'mysql', mssql: e.MSSQL_DB || 'master', oracle: e.ORACLE_DATABASE || 'FREEPDB1' }[kind];
    out.push({ service: c.service, kind, container: c.id, user, db, port, hostPort: run ? undefined : state?.ports[c.service]?.[String(port)], image: c.image });
  }
  return out.sort((a, b) => a.service.localeCompare(b.service));
}

export async function storeOf(ws: Workspace, env: string, service?: string): Promise<Store> {
  const all = await stores(ws, env);
  const s = service ? all.find((x) => x.service === service) : all[0];
  if (!s) throw new DbError(service ? `${service} is not a running database of ${env}` : `${env} has no running database`);
  return s;
}

/** The password the store was started with, for the connection panel; never logged. */
export async function storePassword(s: Store): Promise<string | null> {
  const [raw] = await dockerJson<any[]>(['inspect', s.container]);
  const e = envOf(raw);
  return ({ postgres: e.POSTGRES_PASSWORD, mysql: e.MYSQL_ROOT_PASSWORD, mssql: e.MSSQL_SA_PASSWORD ?? e.SA_PASSWORD, oracle: e.APP_USER_PASSWORD ?? e.ORACLE_PASSWORD }[s.kind]) ?? null;
}

interface ExecOpts { as?: 'reader' | 'owner'; db?: string; vars?: string[]; limit?: number; timeoutMs?: number }

/** Runs SQL on stdin inside the container and parses its CSV answer. Reading stops at limit+1 rows. */
type Result = { columns: string[]; rows: Array<Array<string | null>>; truncated: boolean; ms: number };

/** `execOnce`, and when the read-only role is not there (an instance that never ran its `up`'s step, a store restored from a snapshot) it is made and the query asked again, once. */
async function exec(s: Store, sql: string, o: ExecOpts = {}): Promise<Result> {
  try { return await execOnce(s, sql, o); } catch (e) {
    if (o.as === 'reader' && s.kind === 'postgres' && /role "ks_reader" does not exist/.test((e as Error).message)) { await ensureReader(s); return execOnce(s, sql, o); }
    throw e;
  }
}

function execOnce(s: Store, sql: string, o: ExecOpts = {}): Promise<Result> {
  const t0 = Date.now();
  // Every client gets its password from the container's own environment (or a file only the container has).
  const args = s.kind === 'postgres'
    ? ['exec', '-i', '-e', 'PGOPTIONS=-c statement_timeout=15s', s.container, 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--csv', '-U', o.as === 'reader' ? 'ks_reader' : s.user, '-d', o.db ?? s.db, '-f', '-']
    : s.kind === 'mysql' ? ['exec', '-i', s.container, 'sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -B --raw -u root "$0"', o.db ?? s.db]
    : s.kind === 'mssql' ? ['exec', '-i', s.container, 'sh', '-c', 'SQLCMDPASSWORD="${MSSQL_SA_PASSWORD:-$SA_PASSWORD}" exec "$(ls /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd 2>/dev/null | head -1)" -C -S localhost -U sa -d "$0" -b -W -w 65535 -s "$(printf \'\\037\')" -i /dev/stdin', o.db ?? s.db]
    : ['exec', '-i', s.container, 'sh', '-c', o.as === 'reader'
      ? 'exec sqlplus -S -L "ks_reader/\\"$(cat /tmp/ks_reader.pw)\\"@//localhost/$0"'
      : o.db === 'sysdba' ? 'exec sqlplus -S -L / as sysdba' : 'exec sqlplus -S -L "${APP_USER:-system}/\\"${APP_USER_PASSWORD:-$ORACLE_PASSWORD}\\"@//localhost/$0"', o.db === 'sysdba' ? s.db : o.db ?? s.db];
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: dockerEnv() });
    const out: Buffer[] = [];
    let size = 0, err = '';
    const timer = setTimeout(() => child.kill(), o.timeoutMs ?? 30_000);
    child.stdout.on('data', (c: Buffer) => { size += c.length; if (size < 64 * 1024 * 1024) out.push(c); else child.kill(); });
    child.stderr.on('data', (c: Buffer) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8');
      // sqlcmd prints «Msg N, Level …» and the reason on the next line
      const said = text.trim().split('\n').filter((l, i, all) => /ORA-|SP2-|Msg \d+|error/i.test(l) || /^Msg \d+/.test(all[i - 1] ?? '')).join(' ');
      if (code !== 0) return reject(new DbError((err.trim() || said).replace(/^psql:<stdin>:\d+: /gm, '').split('\n').slice(0, 4).join(' ') || `exit ${code}`));
      if (s.kind === 'mssql') {
        // header, a line of dashes, then rows; the unit separator never appears in data
        const lines = text.split('\n').filter((l) => l.trim() !== '');
        const [head = '', , ...rest] = lines;
        const rows = rest.map((l) => l.split('\x1f').map((v) => (v === 'NULL' ? null : v)));
        const limit = o.limit ?? Infinity;
        return resolve({ columns: head.split('\x1f'), rows: rows.slice(0, limit), truncated: rows.length > limit, ms: Date.now() - t0 });
      }
      if (s.kind === 'mysql') {
        const lines = text.split('\n').filter((l) => l !== '');
        const [head, ...rest] = lines.map((l) => l.split('\t').map((v) => (v === 'NULL' ? null : v)));
        const limit = o.limit ?? Infinity;
        return resolve({ columns: (head ?? []) as string[], rows: rest.slice(0, limit), truncated: rest.length > limit, ms: Date.now() - t0 });
      }
      const { rows, truncated } = parseCsv(text, (o.limit ?? Infinity) + 1);
      const [head = [], ...body] = rows;
      const limit = o.limit ?? Infinity;
      resolve({ columns: head.map(String), rows: body.slice(0, limit), truncated: truncated || body.length > limit, ms: Date.now() - t0 });
    });
    const bound = o.vars?.length ? substitute(sql, o.vars, s.kind) : sql; // typed values go in the SQL on stdin, never on a command line (`ps` shows those)
    child.stdin.end(
      s.kind === 'mssql' ? `SET NOCOUNT ON;\n${o.as === 'reader' ? "EXECUTE AS USER = 'ks_reader' WITH NO REVERT;\n" : ''}${bound}\n`
      : s.kind === 'oracle' ? `SET MARKUP CSV ON QUOTE ON\nSET FEEDBACK OFF\nSET PAGESIZE 50000\nSET LONG 65536\nWHENEVER SQLERROR EXIT FAILURE\n${bound}\nEXIT\n`
      : bound);
  });
}

/** `:'pN'` becomes a literal quoted the engine's way. Postgres' is an E'' string: it reads a backslash the same whatever standard_conforming_strings says. */
const substitute = (sql: string, vars: string[], k: Kind) => sql.replace(/:'p(\d+)'/g, (_m, n) => {
  const v = vars[Number(n) - 1];
  return k === 'mysql' || k === 'postgres' ? `${k === 'postgres' ? 'E' : ''}'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'` : `${k === 'mssql' ? 'N' : ''}'${v.replace(/'/g, "''")}'`;
});

/** The read-only identity every query runs as. Idempotent; called at every up. */
export async function ensureReader(s: Store): Promise<void> {
  if (s.kind === 'postgres') {
    await exec(s, `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ks_reader') THEN CREATE ROLE ks_reader LOGIN; END IF;
END $$;
GRANT pg_read_all_data TO ks_reader;
`);
  }
  if (s.kind === 'mssql') {
    // A user without a login: queries switch to it with EXECUTE AS … WITH NO REVERT, so they cannot switch back.
    await exec(s, `IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'ks_reader') CREATE USER ks_reader WITHOUT LOGIN;
ALTER ROLE db_datareader ADD MEMBER ks_reader;`);
  }
  if (s.kind === 'oracle') {
    // Its password is made inside the container and kept in a file only the container has; it changes at every up.
    await docker(['exec', '-i', s.container, 'sh', '-c', `PW="K$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \\n')"; printf '%s' "$PW" > /tmp/ks_reader.pw; chmod 600 /tmp/ks_reader.pw
sqlplus -S -L / as sysdba <<SQL
WHENEVER SQLERROR EXIT FAILURE
ALTER SESSION SET CONTAINER = "$0";
DECLARE n NUMBER; BEGIN
  SELECT count(*) INTO n FROM dba_users WHERE username = 'KS_READER';
  IF n = 0 THEN EXECUTE IMMEDIATE 'CREATE USER ks_reader IDENTIFIED BY "' || '$PW' || '"';
  ELSE EXECUTE IMMEDIATE 'ALTER USER ks_reader IDENTIFIED BY "' || '$PW' || '"'; END IF;
END;
/
GRANT CREATE SESSION, READ ANY TABLE TO ks_reader;
EXIT
SQL`, s.db], { timeoutMs: 60_000 });
  }
}

export interface Column { name: string; type: string; nullable: boolean; pk: boolean }
/** `rows` is the engine's estimate (null when it has none yet). */
export interface Table { schema: string; name: string; rows: number | null; columns: Column[] }

const SCHEMA_SQL: Record<Kind, (s: Store) => string> = {
  postgres: () => `SELECT n.nspname, c.relname, CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END, a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
  EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
WHERE c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY 1, 2, a.attnum;`,
  mysql: () => `SELECT c.TABLE_SCHEMA, c.TABLE_NAME, coalesce(t.TABLE_ROWS, 0), c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE = 'YES', c.COLUMN_KEY = 'PRI'
FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
WHERE c.TABLE_SCHEMA = DATABASE() ORDER BY 1, 2, c.ORDINAL_POSITION;`,
  mssql: () => `SELECT s.name, t.name, (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)), c.name, ty.name,
  CASE WHEN c.is_nullable = 1 THEN 1 ELSE 0 END,
  CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id WHERE i.is_primary_key = 1 AND ic.object_id = t.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END
FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.columns c ON c.object_id = t.object_id JOIN sys.types ty ON ty.user_type_id = c.user_type_id
ORDER BY 1, 2, c.column_id;`,
  oracle: (st) => `SELECT c.owner, c.table_name, t.num_rows, c.column_name, c.data_type, CASE WHEN c.nullable = 'Y' THEN 1 ELSE 0 END,
  CASE WHEN EXISTS (SELECT 1 FROM all_constraints k JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name WHERE k.constraint_type = 'P' AND k.owner = c.owner AND k.table_name = c.table_name AND kc.column_name = c.column_name) THEN 1 ELSE 0 END
FROM all_tab_columns c JOIN all_tables t ON t.owner = c.owner AND t.table_name = c.table_name
WHERE c.owner = ${lit(st.user.toUpperCase())} ORDER BY 1, 2, c.column_id;`,
};

/** Reads go through the read-only identity on every engine but MySQL (no ks_reader there yet: it reads as the owner). */
const readAs = (s: Store): 'reader' | 'owner' => (s.kind === 'mysql' ? 'owner' : 'reader');

export async function schema(s: Store): Promise<Table[]> {
  const r = await exec(s, SCHEMA_SQL[s.kind](s), { as: readAs(s) });
  const out = new Map<string, Table>();
  for (const [sch, name, rows, col, type, nullable, pk] of r.rows) {
    const key = `${sch}.${name}`;
    if (!out.has(key)) out.set(key, { schema: sch!, name: name!, rows: rows === null || rows === '' ? null : Number(rows), columns: [] });
    out.get(key)!.columns.push({ name: col!, type: type!, nullable: nullable === 't' || nullable === '1', pk: pk === 't' || pk === '1' });
  }
  return [...out.values()];
}

export interface Filter { column: string; op: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'contains' | 'null' | 'not-null'; value?: string }
export interface Browse { schema: string; table: string; filters?: Filter[]; sort?: { column: string; desc?: boolean }; page?: number; pageSize?: number }

/** The SELECT a browse runs, and the values it binds. Names are quoted, values are only ever variables. */
export function browseSql(b: Browse, kind: Kind = 'postgres'): { sql: string; vars: string[] } {
  const q = QUOTE[kind];
  const text = (c: string) => TEXT[kind](q(c));
  const vars: string[] = [];
  const v = (x: string) => { vars.push(x); return `:'p${vars.length}'`; };
  const where = (b.filters ?? []).map((f) => {
    if (f.op === 'null') return `${q(f.column)} IS NULL`;
    if (f.op === 'not-null') return `${q(f.column)} IS NOT NULL`;
    if (f.op === 'contains') return `${text(f.column)} ${kind === 'postgres' ? 'ILIKE' : 'LIKE'} ${CONCAT[kind](v(f.value ?? ''))}`;
    if (!['=', '!=', '<', '>', '<=', '>='].includes(f.op)) throw new DbError(`unknown operator ${f.op}`);
    return `${text(f.column)} ${f.op === '!=' ? '<>' : f.op} ${v(f.value ?? '')}`;
  });
  const size = Math.min(Math.max(b.pageSize ?? 100, 1), 1000);
  const order = b.sort ? ` ORDER BY ${q(b.sort.column)}${b.sort.desc ? ' DESC' : ''}` : '';
  const sql = `SELECT * FROM ${q(b.schema)}.${q(b.table)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${order}${page(kind, size, Math.max(b.page ?? 0, 0) * size, Boolean(b.sort))}${kind === 'oracle' ? '' : ';'}`;
  return { sql, vars };
}

export async function rows(s: Store, b: Browse) {
  const { sql, vars } = browseSql(b, s.kind);
  const size = Math.min(Math.max(b.pageSize ?? 100, 1), 1000);
  return exec(s, s.kind === 'oracle' ? `${sql};` : sql, { as: readAs(s), vars, limit: size });
}

/** An arbitrary query: as the read-only identity unless the caller asked to write. */
export async function query(s: Store, sql: string, o: { write?: boolean; limit?: number } = {}) {
  if (!sql.trim()) throw new DbError('empty query');
  return exec(s, sql, { as: o.write ? 'owner' : readAs(s), limit: o.limit ?? 500 });
}

export interface RowUpdate { schema: string; table: string; key: Record<string, string>; set: Record<string, string | null> }

/** The UPDATE of one row by its primary key: the SQL that runs, and the same statement with values shown, for the dialog. */
export function updateSql(u: RowUpdate, kind: Kind = 'postgres'): { sql: string; vars: string[]; preview: string } {
  if (!Object.keys(u.key).length) throw new DbError('a row is updated by its primary key; this table has none');
  if (!Object.keys(u.set).length) throw new DbError('nothing to change');
  const q = QUOTE[kind];
  const vars: string[] = [];
  const shown: string[] = [];
  const v = (x: string | null) => { if (x === null) { shown.push('NULL'); return 'NULL'; } vars.push(x); shown.push(lit(x)); return `:'p${vars.length}'`; };
  const sets = Object.entries(u.set).map(([c, x]) => `${q(c)} = ${v(x)}`);
  const where = Object.entries(u.key).map(([c, x]) => `${q(c)} = ${v(x)}`);
  const sql = `UPDATE ${q(u.schema)}.${q(u.table)} SET ${sets.join(', ')} WHERE ${where.join(' AND ')};`;
  let i = 0;
  const preview = sql.replace(/:'p\d+'|NULL/g, () => shown[i++]);
  return { sql, vars, preview };
}

export async function updateRow(s: Store, u: RowUpdate): Promise<{ preview: string; ms: number }> {
  const { sql, vars, preview } = updateSql(u, s.kind);
  const r = await exec(s, `${sql}${s.kind === 'oracle' ? '\nCOMMIT;' : ''}\n`, { as: 'owner', vars });
  return { preview, ms: r.ms };
}

/**
 * A snapshot's database (or backup file): «base», the env's, as it always was; a scenario's, by an 8-hex hash of its
 * name, so the name stays within Postgres' 63 bytes and needs no quoting of its own.
 */
const snapId = (name: string) => (name === 'base' ? 'base' : `s${createHash('sha256').update(name).digest('hex').slice(0, 8)}`);
const BASE = (db: string, name = 'base') => `${db}__ks_${snapId(name)}`;
const MSSQL_BAK = (db: string, name = 'base') => `/var/opt/mssql/data/${db}__ks_${snapId(name)}.bak`;

/** Copies the database as «base»: a Postgres template, a SQL Server backup file. */
/** Where snapshot and reset connect from: never the database they take offline (an app whose database is `postgres`). */
const adminDb = (s: Store) => (s.db === 'postgres' ? 'template1' : 'postgres');

export async function snapshot(s: Store, name = 'base'): Promise<{ ms: number; bytes: number }> {
  const t0 = Date.now();
  if (s.kind === 'mssql') {
    await exec(s, `BACKUP DATABASE ${QUOTE.mssql(s.db)} TO DISK = ${`N${lit(MSSQL_BAK(s.db, name))}`} WITH INIT, COPY_ONLY, FORMAT;`, { db: 'master', timeoutMs: 300_000 });
    const size = await docker(['exec', s.container, 'sh', '-c', 'stat -c %s "$0"', MSSQL_BAK(s.db, name)]).catch(() => '0');
    return { ms: Date.now() - t0, bytes: Number(size.trim()) };
  }
  if (s.kind !== 'postgres') throw new DbError(`snapshots are for Postgres and SQL Server; ${s.kind} has none yet`);
  await exec(s, `ALTER DATABASE ${ident(s.db)} ALLOW_CONNECTIONS false;
SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = ${lit(s.db)} AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ${ident(BASE(s.db, name))};
CREATE DATABASE ${ident(BASE(s.db, name))} TEMPLATE ${ident(s.db)} STRATEGY FILE_COPY;
ALTER DATABASE ${ident(s.db)} ALLOW_CONNECTIONS true;
`, { db: adminDb(s), timeoutMs: 120_000 }).catch(async (e) => {
    await exec(s, `ALTER DATABASE ${ident(s.db)} ALLOW_CONNECTIONS true;`, { db: adminDb(s) }).catch(() => undefined);
    throw e;
  });
  const size = await exec(s, `SELECT pg_database_size(${lit(BASE(s.db, name))});`, { db: adminDb(s) });
  return { ms: Date.now() - t0, bytes: Number(size.rows[0]?.[0] ?? 0) };
}

export async function hasSnapshot(s: Store, name = 'base'): Promise<boolean> {
  if (s.kind === 'mssql') return docker(['exec', s.container, 'test', '-f', MSSQL_BAK(s.db, name)]).then(() => true, () => false);
  if (s.kind !== 'postgres') return false;
  const r = await exec(s, `SELECT 1 FROM pg_database WHERE datname = ${lit(BASE(s.db, name))};`, { db: adminDb(s) });
  return r.rows.length > 0;
}

/** Puts the database back as it was at the snapshot. Services reconnect through their pools. */
export async function reset(s: Store, name = 'base'): Promise<{ ms: number }> {
  if (!(await hasSnapshot(s, name))) throw new DbError(name === 'base' ? `${s.service} has no snapshot yet; take one with laru snapshot` : `${s.service} has no snapshot of scenario ${name}`);
  const t0 = Date.now();
  if (s.kind === 'mssql') {
    await exec(s, `ALTER DATABASE ${QUOTE.mssql(s.db)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
RESTORE DATABASE ${QUOTE.mssql(s.db)} FROM DISK = N${lit(MSSQL_BAK(s.db, name))} WITH REPLACE;
ALTER DATABASE ${QUOTE.mssql(s.db)} SET MULTI_USER;`, { db: 'master', timeoutMs: 300_000 });
    return { ms: Date.now() - t0 };
  }
  await exec(s, `ALTER DATABASE ${ident(s.db)} ALLOW_CONNECTIONS false;
SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = ${lit(s.db)} AND pid <> pg_backend_pid();
DROP DATABASE ${ident(s.db)} WITH (FORCE);
CREATE DATABASE ${ident(s.db)} TEMPLATE ${ident(BASE(s.db, name))} STRATEGY FILE_COPY;
`, { db: adminDb(s), timeoutMs: 120_000 });
  return { ms: Date.now() - t0 };
}

/** Runs a seed file as the owner, once, before the first base snapshot. */
export async function seed(s: Store, sql: string): Promise<void> {
  await exec(s, sql, { as: 'owner', timeoutMs: 300_000 });
}

export interface Connection { host: string; port?: number; db: string; user: string; jdbc?: string; url?: string; shell: string; intellij?: string }

/** How to reach the store from the host; the password is revealed separately. */
export function connection(s: Store, app: string): Connection {
  const host = '127.0.0.1';
  const c = s.container.slice(0, 12);
  const shell = {
    postgres: `docker exec -it ${c} psql -U ${s.user} -d ${s.db}`,
    mysql: `docker exec -it ${c} mysql -u root -p ${s.db}`,
    mssql: `docker exec -it ${c} /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -d ${s.db}`,
    oracle: `docker exec -it ${c} sqlplus ${s.user}@//localhost/${s.db}`,
  }[s.kind];
  if (!s.hostPort) return { host, db: s.db, user: s.user, shell };
  const p = s.hostPort;
  const jdbc = { postgres: `jdbc:postgresql://${host}:${p}/${s.db}`, mysql: `jdbc:mysql://${host}:${p}/${s.db}`, mssql: `jdbc:sqlserver://${host}:${p};databaseName=${s.db};encrypt=true;trustServerCertificate=true`, oracle: `jdbc:oracle:thin:@//${host}:${p}/${s.db}` }[s.kind];
  const url = { postgres: `postgresql://${s.user}@${host}:${p}/${s.db}`, mysql: `mysql://${s.user}@${host}:${p}/${s.db}`, mssql: `sqlserver://${s.user}@${host}:${p}?database=${s.db}`, oracle: `oracle://${s.user}@${host}:${p}/${s.db}` }[s.kind];
  const [driver, cls] = { postgres: ['postgresql', 'org.postgresql.Driver'], mysql: ['mysql.8', 'com.mysql.cj.jdbc.Driver'], mssql: ['sqlserver.ms', 'com.microsoft.sqlserver.jdbc.SQLServerDriver'], oracle: ['oracle', 'oracle.jdbc.OracleDriver'] }[s.kind];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="DataSourceManagerImpl" format="xml" multifile-model="true">
    <data-source source="LOCAL" name="${app} ${s.service} (laru)" uuid="${s.container.slice(0, 8)}-0000-4000-8000-${s.container.slice(0, 12)}">
      <driver-ref>${driver}</driver-ref>
      <synchronize>true</synchronize>
      <jdbc-driver>${cls}</jdbc-driver>
      <jdbc-url>${jdbc}</jdbc-url>
      <user-name>${s.user}</user-name>
      <working-dir>$ProjectFileDir$</working-dir>
    </data-source>
  </component>
</project>`;
  return { host, port: p, db: s.db, user: s.user, jdbc, url, shell, intellij: xml };
}
