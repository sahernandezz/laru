/**
 * A MongoDB of an env, through the shell inside its own container (mongosh, or the legacy `mongo` of 4.4 and
 * earlier): no driver, no port. The script is fixed and travels on stdin; what the user typed (names, a filter, a
 * sort, an id) travels inside it as one JSON string literal and is read with (E)JSON.parse, so it is data whatever it
 * says. The root user's name and password are read by the script from the container's environment (process.env, or
 * the legacy shell's _getEnv), never from an argv. Reads run as `ks_reader` (readAnyDatabase), created on first use,
 * or with no user on a Mongo without access control; documents come back as Extended JSON, masked as a queue peek is.
 */
import type { Workspace } from '@laru/core';
import type { Masker } from '@laru/trace';
import { docker, DockerError, dockerJson, inspectEnv, LABEL } from '../docker.ts';
import { maskedJson, readState } from '../env.ts';

/**
 * `user` is the root user's name, when the image was started with one (for the connection line; never the password);
 * `version` the server's, as the official (MONGO_VERSION) and bitnami (APP_VERSION) images declare it.
 */
export interface MongoStore { service: string; container: string; image: string; user?: string; version?: string; hostPort?: number }

/** mongo, mongodb/mongodb-community-server (or enterprise), bitnami/mongodb; not mongo-express or another tool around it. */
export const isMongo = (image: string) => /^(mongo|mongodb|mongodb-(community|enterprise)-server)$/.test(image.split('@')[0].replace(/:[^/]*$/, '').split('/').pop() ?? '');

export async function mongoStores(ws: Workspace, env: string): Promise<MongoStore[]> {
  const ports = readState(ws, env)?.ports ?? {};
  const found = (await inspectEnv(ws, env)).filter((c) => c.state === 'running' && !c.labels[LABEL.run] && isMongo(c.image));
  const raw = found.length ? await dockerJson<any[]>(['inspect', ...found.map((c) => c.id)]) : [];
  return (await Promise.all(found.map(async (c, i) => {
    const e = (k: string) => (raw[i]?.Config?.Env as string[] | undefined)?.find((x) => x.startsWith(`${k}=`))?.slice(k.length + 1) || undefined;
    // A variable or its _FILE (a Docker secret), read in the container as the entrypoint reads it.
    const v = async (k: string) => e(k) ?? (e(`${k}_FILE`) ? (await docker(['exec', c.id, 'cat', e(`${k}_FILE`)!])).replace(/\n+$/, '') || undefined : undefined);
    const user = await v('MONGO_INITDB_ROOT_USERNAME') ?? await v('MONGODB_INITDB_ROOT_USERNAME')
      ?? ((e('MONGODB_ROOT_PASSWORD') ?? e('MONGODB_ROOT_PASSWORD_FILE')) ? await v('MONGODB_ROOT_USER') ?? 'root' : undefined);
    return { service: c.service, container: c.id, image: c.image, user, version: e('MONGO_VERSION') ?? e('APP_VERSION'), hostPort: ports[c.service]?.['27017'] };
  }))).sort((a, b) => a.service.localeCompare(b.service));
}

export async function mongoOf(ws: Workspace, env: string, service?: string): Promise<MongoStore> {
  const all = await mongoStores(ws, env);
  const s = service ? all.find((x) => x.service === service) : all[0];
  if (!s) throw new Error(service ? `${service} is not a running MongoDB of ${env}` : `${env} has no running MongoDB`);
  return s;
}

/** The container's shell finds the root user (official, community-server and bitnami variables, or their _FILE) and runs the script it reads on stdin. */
const SHELL = [
  'U="${MONGO_INITDB_ROOT_USERNAME:-${MONGODB_INITDB_ROOT_USERNAME:-$MONGODB_ROOT_USER}}"',
  'F="${MONGO_INITDB_ROOT_USERNAME_FILE:-${MONGODB_INITDB_ROOT_USERNAME_FILE:-$MONGODB_ROOT_USER_FILE}}"; [ -z "$U" ] && [ -n "$F" ] && U="$(cat "$F")"; U="${U:-root}"',
  'P="${MONGO_INITDB_ROOT_PASSWORD:-${MONGODB_INITDB_ROOT_PASSWORD:-$MONGODB_ROOT_PASSWORD}}"',
  'F="${MONGO_INITDB_ROOT_PASSWORD_FILE:-${MONGODB_INITDB_ROOT_PASSWORD_FILE:-$MONGODB_ROOT_PASSWORD_FILE}}"; [ -z "$P" ] && [ -n "$F" ] && P="$(cat "$F")"',
  'sh=$(command -v mongosh || command -v mongo) || { echo "this image has neither mongosh nor the mongo shell" >&2; exit 127; }',
  'KS_U="$U" KS_P="$P" exec "$sh" --quiet --norc "mongodb://127.0.0.1:${MONGODB_PORT_NUMBER:-27017}/admin" --eval "$(cat)"',
].join('\n');

const MARK = '\u0001KS', FAIL = '\u0001KE';

/**
 * A whole script: its arguments as one string literal, helpers both shells run, the login, then the body, whose
 * errors are printed as a line of their own. The reader shares the root user's password: whoever can read one in the
 * container's environment can read the other. A Mongo started without a root user has no access control, and reads
 * are read-only there only because the scripts are.
 */
export function script(body: string, args: Record<string, unknown>, as: 'reader' | 'root'): string {
  const literal = JSON.stringify(JSON.stringify(args)).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  return `const A = JSON.parse(${literal});
const env = (k) => (typeof process !== 'undefined' ? process.env[k] : _getEnv(k));
const legacy = typeof EJSON === 'undefined';
if (legacy) Date.prototype.toJSON = function () { return { $date: this.toISOString() }; };
const parse = (s) => (legacy ? JSON.parse(s, (k, v) => (v && typeof v === 'object' ? ('$oid' in v ? ObjectId(v.$oid) : '$date' in v ? new Date(typeof v.$date === 'object' ? Number(v.$date.$numberLong) : v.$date) : '$numberLong' in v ? NumberLong(v.$numberLong) : '$numberDecimal' in v ? NumberDecimal(v.$numberDecimal) : '$numberInt' in v ? NumberInt(v.$numberInt) : v) : v)) : EJSON.parse(s));
const put = (x) => print(${JSON.stringify(MARK)} + (legacy ? JSON.stringify(x) : EJSON.stringify(x, { relaxed: true })));
try {
  if (env('KS_P')) { const ok = db.getSiblingDB('admin').auth(${as === 'reader' ? "'ks_reader'" : "env('KS_U')"}, env('KS_P')); if (!ok || ok.ok === 0) throw new Error('Authentication failed.'); }
${body}
} catch (e) { print(${JSON.stringify(FAIL)} + String((e && e.message) || e).replace(/\\s+/g, ' ')); }
`;
}

/** The JSON lines a script put; an error it printed is thrown. Whatever else the shell printed is neither. */
export function emitted(stdout: string): string[] {
  const lines = stdout.split('\n');
  const failed = lines.find((l) => l.startsWith(FAIL));
  if (failed !== undefined) throw new Error(failed.slice(FAIL.length));
  return lines.filter((l) => l.startsWith(MARK)).map((l) => l.slice(MARK.length));
}

/**
 * Runs a script body as the reader (the default) or the root user, and returns what it put. The server's errors can
 * quote a document (`Failed to parse number '…'` from a $toInt, a $where that throws a field): with `m`, their text
 * is masked as the documents are.
 */
export async function run(s: MongoStore, body: string, args: Record<string, unknown> = {}, as: 'reader' | 'root' = 'reader', m?: Masker): Promise<string[]> {
  try {
    return emitted(await docker(['exec', '-i', '-e', 'DO_NOT_TRACK=1', s.container, 'sh', '-c', SHELL], { input: script(body, args, as), timeoutMs: 60_000 }));
  } catch (e) {
    const msg = e instanceof DockerError ? e.stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ') || e.message : (e as Error).message;
    throw new Error(m ? m.text(msg) : msg);
  }
}

/** The read-only user; idempotent. Called when a read finds it missing, and again whenever its password moved. */
export async function ensureReader(s: MongoStore): Promise<void> {
  await run(s, `if (env('KS_P')) {
  const admin = db.getSiblingDB('admin'), roles = [{ role: 'readAnyDatabase', db: 'admin' }];
  if (admin.getUser('ks_reader')) admin.updateUser('ks_reader', { pwd: env('KS_P'), roles }); else admin.createUser({ user: 'ks_reader', pwd: env('KS_P'), roles });
}
put({ ok: 1 });`, {}, 'root');
}

const read = (s: MongoStore, script: string, args: Record<string, unknown> = {}, m?: Masker) =>
  run(s, script, args, 'reader', m).catch(async (e: Error) => {
    if (!/Authentication failed/i.test(e.message)) throw e;
    await ensureReader(s);
    return run(s, script, args, 'reader', m);
  });

export interface MongoDb { name: string; sizeOnDisk: number; empty: boolean }
/** The databases the reader can read: readAnyDatabase leaves out config and local. */
export const dbs = async (s: MongoStore): Promise<MongoDb[]> =>
  JSON.parse((await read(s, `put(db.adminCommand({ listDatabases: 1 }).databases.filter((d) => d.name !== 'config' && d.name !== 'local').map((d) => ({ name: d.name, sizeOnDisk: Number(d.sizeOnDisk), empty: d.empty })));`))[0]);

export interface MongoCollection { name: string; type: string; count: number | null; indexes: Array<{ name: string; key: Record<string, unknown>; unique?: boolean }> }
/**
 * Collections and views of a database; a collection with its estimated count and its indexes. A system collection
 * (system.views, admin's system.users) is listed without either: the reader may not count it, and mongosh's implicit
 * await would carry the refusal past a try.
 */
export const collections = async (s: MongoStore, database: string): Promise<MongoCollection[]> =>
  JSON.parse((await read(s, `const d = db.getSiblingDB(A.db);
put(d.getCollectionInfos().map((c) => { const counted = c.type !== 'view' && !c.name.startsWith('system.'), k = d.getCollection(c.name);
  return { name: c.name, type: c.type || 'collection', count: counted ? k.estimatedDocumentCount() : null,
    indexes: counted ? k.getIndexes().map((i) => ({ name: i.name, key: i.key, ...(i.unique ? { unique: true } : {}) })) : [] }; }).sort((a, b) => (a.name < b.name ? -1 : 1)));`, { db: database }))[0]);

/**
 * A document as the masker shows it. A BinData's bytes travel as base64, where a known value is only found when it
 * starts at a multiple of 3 bytes: they are masked as a queue peek's instead, whatever their alignment (a GridFS
 * chunk, a serialized session), and shown as that peek. Bytes that hold nothing to hide stay Extended JSON, so a
 * UUID `_id` can be asked for again.
 */
function masked(line: string, m: Masker): unknown {
  return maskedDoc(line, m).doc;
}

/** As `masked`, and whether the document's _id reads differently masked: it then cannot be asked for by what is shown. */
function maskedDoc(line: string, m: Masker): { doc: unknown; idMasked: boolean } {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== 'object') return x;
    const o = x as Record<string, any>;
    if ('$binary' in o) {
      const [base64, subType] = typeof o.$binary === 'string' ? [o.$binary, o.$type] : [o.$binary?.base64, o.$binary?.subType]; // the legacy shell's, or mongosh's
      const bytes = Buffer.from(String(base64), 'base64').toString('latin1'), peek = m.peek(bytes);
      return peek === bytes.replace(/[^\x20-\x7e]/g, '.') ? o : { $binary: { peek, subType } };
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)]));
  };
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return { doc: maskedJson(line, m), idMasked: true }; }
  const doc = maskedJson(JSON.stringify(walk(raw)), m);
  const id = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? JSON.stringify((x as Record<string, unknown>)._id) : undefined);
  return { doc, idMasked: id(doc) !== id(raw) };
}

/** filter, sort and projection are Extended JSON text (an object is taken as its JSON); at most 500 documents a page. */
export interface Find { db: string; collection: string; filter?: string; sort?: string; projection?: string; limit?: number; skip?: number }
const text = (x: unknown) => (x === undefined || x === null ? '' : typeof x === 'string' ? x : JSON.stringify(x));

/** `maskedIds`: the documents (by index) whose _id the masker changed, so they cannot be asked for by the one shown. */
export async function find(s: MongoStore, q: Find, m: Masker): Promise<{ docs: unknown[]; more: boolean; ms: number; maskedIds?: number[] }> {
  const t0 = Date.now();
  const limit = Math.min(Math.max(Math.trunc(Number(q.limit) || 50), 1), 500);
  const lines = await read(s, `const c = db.getSiblingDB(A.db).getCollection(A.collection);
c.find(parse(A.filter || '{}'), parse(A.projection || '{}')).sort(parse(A.sort || '{}')).skip(A.skip).limit(A.limit + 1).maxTimeMS(15000).toArray().forEach((d) => put(d));`,
  { db: String(q.db), collection: String(q.collection), filter: text(q.filter), sort: text(q.sort), projection: text(q.projection), skip: Math.max(Math.trunc(Number(q.skip) || 0), 0), limit }, m);
  const docs = lines.slice(0, limit).map((l) => maskedDoc(l, m)), maskedIds = docs.flatMap((d, i) => (d.idMasked ? [i] : []));
  return { docs: docs.map((d) => d.doc), more: lines.length > limit, ms: Date.now() - t0, ...(maskedIds.length ? { maskedIds } : {}) };
}

/**
 * One document by its _id, written as Extended JSON (`{"$oid": …}`, `42`, `"text"`), a bare ObjectId or a bare string;
 * null when there is none. The readings are tried in that order and the first found wins: `42` is the number when
 * both 42 and "42" are _ids, and 24 hex digits the ObjectId; `"42"` is the string.
 */
export async function get(s: MongoStore, database: string, collection: string, id: string, m: Masker): Promise<unknown> {
  const [line] = await read(s, `const ids = [A.id];
try { ids.unshift(parse(A.id)); } catch (e) { /* not JSON: a bare string */ }
if (/^[0-9a-fA-F]{24}$/.test(A.id)) ids.unshift(ObjectId(A.id));
const c = db.getSiblingDB(A.db).getCollection(A.collection);
let d = null;
for (let i = 0; i < ids.length && !d; i++) d = c.findOne({ _id: ids[i] });
put(d);`, { db: database, collection, id }, m);
  return line === undefined ? null : masked(line, m);
}

/**
 * How to reach it from the host: a URL for Compass or mongosh (the password is not in it) and a shell in the container:
 * mongosh, or the legacy `mongo` before 6.0 (a 4.4 image has no mongosh; 5.0 still has the legacy shell).
 */
export function connection(s: MongoStore): { host: string; port?: number; user?: string; url?: string; shell: string } {
  const login = s.user ? ` -u ${s.user} --authenticationDatabase admin` : '';
  const shell = `docker exec -it ${s.container.slice(0, 12)} ${Number(s.version?.split('.')[0]) < 6 ? 'mongo' : 'mongosh'}${login}`;
  if (!s.hostPort) return { host: '127.0.0.1', user: s.user, shell };
  return { host: '127.0.0.1', port: s.hostPort, user: s.user, url: `mongodb://${s.user ? `${encodeURIComponent(s.user)}@` : ''}127.0.0.1:${s.hostPort}/${s.user ? '?authSource=admin' : ''}`, shell };
}
