/**
 * What a run left in its env's data, kept with the run in state/: the answers the data screens get live (reads.ts),
 * recorded as the run ends, so the same screens show the run's data with the env off. Besides those answers it keeps
 * what the screens browse: each table's rows, each Mongo collection's documents, each Redis key, each topic's last
 * messages, each bucket with its files (the ones the browser shows by themselves, images and PDFs, as bytes) and each
 * mail with its view. Masked as the rest of the run's evidence: with masking on (`mask: true`), every text kept passes
 * the run's masker, which knows the vault's values and what the mail sink learned (codes, links' tokens), and what holds
 * text the masker cannot reach is not kept (a PDF, a binary file, a mail's original and its attachments: encoded); pixels
 * are kept, as the run's video is. With masking off, as the rest of the evidence, everything is kept in plain.
 *
 * Read-only on purpose: nothing here takes a message off a queue (an SQS receive counts towards its dead-letter
 * queue, a RabbitMQ get moves it), so the env is left as the run left it. A read that fails keeps its error, as the
 * screen would have shown it live; what goes past a limit says it was cut.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Workspace } from '@laru/core';
import type { Masker } from '@laru/trace';
import { rows as dbRows, storeOf } from './db.ts';
import * as mail from './explore/mail.ts';
import * as mongo from './explore/mongo.ts';
import { READS, type ReadParams } from './explore/reads.ts';
import * as storage from './explore/storage.ts';
import { varValues } from './vault.ts';

export const STATE_LIMITS = { tables: 80, rows: 1000, collections: 40, docs: 200, keys: 300, messages: 100, files: 400, bytes: 100 * 2 ** 20, mails: 200 };

export type Answer = { ok: unknown } | { error: string; status?: number };
export interface Blob { status: number; headers: Record<string, string>; file: string }
export type RecordedTable = { columns: string[]; rows: Array<Array<string | null>>; truncated: boolean };
export interface Recording {
  at: string; env: string; run?: string;
  /** the whole recording failed: nothing of it was kept */
  error?: string;
  /** each read by its key (`db/schema?service=postgres`), as the screen got it */
  reads: Record<string, Answer>;
  /** a table's rows by `service|schema.table`, browsed here by the screen's filters, order and pages */
  rows: Record<string, RecordedTable | { error: string }>;
  /** a collection's documents by `service|db.collection` */
  docs: Record<string, { docs: unknown[]; more: boolean } | { error: string }>;
  /** bytes the screen loads by address (a stored image, a mail's HTML), by key */
  blobs: Record<string, Blob>;
  /** what passed a limit, by what it is */
  cut: string[];
  /** whether the run's masker was on (`mask: true`): off, the recording is in plain, as the rest of the run's evidence */
  masked: boolean;
  /** what masking on withheld, by its key: bytes that hold text the masker cannot reach (a PDF, a binary file) */
  withheld: string[];
}

/** A read's key: its path and its parameters in order, the env aside (the recording is of one env). */
export const readKey = (path: string, p: ReadParams = {}) => {
  const q = Object.entries(p).filter(([k, v]) => k !== 'env' && k !== 'run' && k !== 'flujo' && v !== undefined && v !== '').sort(([a], [b]) => a.localeCompare(b));
  return q.length ? `${path}?${new URLSearchParams(q).toString()}` : path;
};
const stateDirOf = (dir: string) => join(dir, 'state');
/** Why a thing the screen asks for was not kept, masking on. */
export const WITHHELD = 'No se grabó: con el enmascarado activo, un fichero binario o un PDF no se guarda, porque un token dentro de él no se puede enmascarar.';
/** Every string of a value through the masker; what is not text stays. */
export const deep = (m: Masker, v: unknown): unknown => (typeof v === 'string' ? m.text(v) : Array.isArray(v) ? v.map((x) => deep(m, x)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(m, x)])) : v);

/** Reads what the env holds now, as the data screens would, and writes it to `<dir>/state/`. */
export async function recordState(ws: Workspace, env: string, run: string | undefined, dir: string, m: Masker): Promise<Recording> {
  const L = STATE_LIMITS, out = stateDirOf(dir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'blobs'), { recursive: true });
  const rec: Recording = { at: new Date().toISOString(), env, ...(run ? { run } : {}), reads: {}, rows: {}, docs: {}, blobs: {}, cut: [], masked: m.on, withheld: [] };
  let bytes = 0, nblob = 0;
  const read = async (path: string, p: ReadParams = {}): Promise<unknown> => {
    const key = readKey(path, p);
    if (key in rec.reads) { const a = rec.reads[key]; return 'ok' in a ? a.ok : undefined; }
    // every answer kept passes the run's masker, whatever its read did live: a mail's codes and its links' tokens
    // (shown in plain on the live screen, for the person to use) are known to it once the tests ended, and go
    try { const ok = deep(m, await READS[path](ws, env, p, m)); rec.reads[key] = { ok }; return ok; }
    catch (e) { const status = (e as { status?: number }).status; rec.reads[key] = { error: m.text((e as Error).message), ...(status ? { status } : {}) }; return undefined; }
  };
  const blob = (key: string, status: number, headers: Record<string, string>, body: Buffer) => {
    if (bytes + body.length > L.bytes) { if (!rec.cut.includes('bytes')) rec.cut.push('bytes'); return; }
    const file = `${nblob++}.bin`;
    writeFileSync(join(out, 'blobs', file), body);
    bytes += body.length;
    rec.blobs[key] = { status, headers, file };
  };
  const mask = (v: string | null) => (v === null ? null : m.text(v));

  await Promise.all([
    // databases: each store's tables, each table's rows (an ephemeral run's own: its containers carry its label)
    (async () => {
      for (const s of ((await read('db/stores')) ?? []) as Array<{ service: string }>) {
        const tables = ((await read('db/schema', { service: s.service })) ?? []) as Array<{ schema: string; name: string }>;
        if (tables.length > L.tables) rec.cut.push(`tables:${s.service}`);
        const store = await storeOf(ws, env, s.service);
        for (const t of tables.slice(0, L.tables)) {
          const key = `${s.service}|${t.schema}.${t.name}`;
          try {
            const r = await dbRows(store, { schema: t.schema, table: t.name, pageSize: L.rows });
            rec.rows[key] = { columns: r.columns, rows: r.rows.slice(0, L.rows).map((row) => row.map(mask)), truncated: r.truncated };
          } catch (e) { rec.rows[key] = { error: m.text((e as Error).message) }; }
        }
      }
    })(),
    run ? undefined : (async () => {
      for (const s of ((await read('mongo/stores')) ?? []) as Array<{ service: string }>) {
        const store = await mongo.mongoOf(ws, env, s.service);
        let n = 0;
        for (const d of ((await read('mongo/dbs', { service: s.service })) ?? []) as Array<{ name: string }>) {
          for (const c of ((await read('mongo/collections', { service: s.service, db: d.name })) ?? []) as Array<{ name: string; type: string }>) {
            if (c.type !== 'collection' || c.name.startsWith('system.')) continue;
            if (++n > L.collections) { if (!rec.cut.includes(`collections:${s.service}`)) rec.cut.push(`collections:${s.service}`); continue; }
            const key = `${s.service}|${d.name}.${c.name}`;
            try { const f = await mongo.find(store, { db: d.name, collection: c.name, limit: L.docs }, m); rec.docs[key] = { docs: f.docs, more: f.more }; }
            catch (e) { rec.docs[key] = { error: m.text((e as Error).message) }; }
          }
        }
      }
    })(),
    run ? undefined : (async () => {
      for (const s of ((await read('redis/stores')) ?? []) as Array<{ service: string }>) {
        const keys = ((await read('redis/keys', { service: s.service })) as { keys: Array<{ key: string }> } | undefined)?.keys ?? [];
        if (keys.length > L.keys) rec.cut.push(`keys:${s.service}`);
        for (const k of keys.slice(0, L.keys)) await read('redis/key', { service: s.service, key: k.key });
      }
    })(),
    run ? undefined : read('custom/stores'),
    // brokers: Kafka's topics with their last messages; RabbitMQ's and SQS's queues (their messages are not read: that moves them)
    run ? undefined : (async () => {
      const brokers = ((await read('brokers')) ?? []) as Array<{ kind: string }>;
      if (brokers.some((b) => b.kind === 'kafka')) {
        const q = (await read('queues')) as { topics: Array<{ name: string }> } | undefined;
        for (const t of q?.topics ?? []) await read('queue/peek', { topic: t.name, limit: String(L.messages) });
      }
      if (brokers.some((b) => b.kind === 'rabbitmq')) await read('rabbit/queues');
      if (brokers.some((b) => b.kind === 'sqs')) await read('sqs/queues');
    })(),
    // storage: each bucket as the screen lists it (whole), and its files as it opens them, the newest first: what the run made
    run ? undefined : (async () => {
      const buckets = (((await read('storage/ls')) ?? []) as Array<{ key: string }>).map((b) => b.key.replace(/\/$/, ''));
      const files: Array<{ path: string; size: number; at: string }> = [];
      for (const name of buckets) {
        for (const e of ((await read('storage/ls', { path: name, recursive: '1' })) ?? []) as Array<{ key: string; type: string; size: number; lastModified: string }>) {
          if (e.type === 'file') files.push({ path: `${name}/${e.key}`, size: e.size, at: e.lastModified });
        }
      }
      files.sort((x, y) => y.at.localeCompare(x.at));
      if (files.length > L.files) rec.cut.push('files');
      for (const f of files.slice(0, L.files)) {
        const key = readKey('storage/object', { path: f.path });
        const o = (await read('storage/object', { path: f.path })) as { type: string; stream?: string; base64?: string; meta: { size?: number } } | undefined;
        // a binary file goes as base64, where a token cannot be told apart: with masking on it is not kept
        if (o?.base64 !== undefined && m.on) { rec.reads[key] = { error: WITHHELD, status: 404 }; rec.withheld.push(key); continue; }
        if (o?.stream === 'sheet') await read('storage/sheet', { path: f.path });
        if (o?.stream !== 'raw') continue;
        const raw = readKey('storage/raw', { path: f.path });
        // an SVG is text and is masked; a PDF holds text the masker cannot reach and, masking on, is not kept; pixels
        // (an image, a video, a sound) are kept as the run's own video is
        if (m.on && o.type === 'application/pdf') { rec.withheld.push(raw); continue; }
        const size = Number(o.meta.size ?? f.size);
        if (bytes + size > L.bytes) { if (!rec.cut.includes('bytes')) rec.cut.push('bytes'); continue; }
        try {
          const c = await storage.cat(await storage.storeOfEnv(ws, env), f.path, size);
          blob(raw, 200, { 'content-type': o.type }, o.type === 'image/svg+xml' ? Buffer.from(m.text(c.bytes.toString('utf8'))) : c.bytes);
        } catch { /* the screen says it cannot be shown */ }
      }
    })(),
  ]);
  // the mailbox and the variables are files of the env: read once the rest has its answers
  // the mailbox as the screen first asks it (every kind, no search); its searches are answered over these rows
  const box = (await read('mail', { kind: 'all' })) as { messages?: Array<{ id: string }> } | undefined;
  if ((box?.messages?.length ?? 0) > L.mails) rec.cut.push('mails');
  for (const x of (box?.messages ?? []).slice(0, L.mails)) {
    const msg = (await read('mail/message', { id: x.id })) as { kind?: string; unmasked?: true; eml?: boolean } | undefined;
    if (!msg) continue;
    // masked, it no longer says its codes and links are in plain view; its original is offered only if it is kept
    if (m.on) delete msg.unmasked;
    msg.eml = false;
    if (msg.kind === 'sms') continue;
    // its view, decoded and masked, with the remote images it blocked (their addresses can carry a token)
    const r = mail.part(ws, env, x.id, 'html');
    const headers = { ...r.headers, ...(r.headers['x-laru-blocked'] ? { 'x-laru-blocked': encodeURIComponent(m.text(decodeURIComponent(r.headers['x-laru-blocked']))) } : {}) };
    blob(readKey('mail/html', { id: x.id }), r.status, headers, r.status === 200 ? Buffer.from(m.text(r.body.toString('utf8'))) : r.body);
    // its original and its attachments travel encoded (quoted-printable, base64), where a code or a token cannot be told
    // apart: kept only when nothing is masked, as the live screen has them
    const parts = [readKey('mail/eml', { id: x.id }), ...((msg as { attachments_?: unknown[] }).attachments_ ?? []).map((_, n) => readKey('mail/part', { id: x.id, n: String(n) }))];
    if (m.on) { rec.withheld.push(...parts); continue; }
    msg.eml = true;
    const eml = mail.part(ws, env, x.id, 'eml');
    blob(parts[0], eml.status, eml.headers, eml.body);
    ((msg as { attachments_?: unknown[] }).attachments_ ?? []).forEach((_, n) => { const a = mail.part(ws, env, x.id, { attachment: n }); blob(parts[n + 1], a.status, a.headers, a.body); });
  }
  await read('vars');
  await read('mocks');
  // each level's value, as «Variables y secretos» shows them: a secret's is never kept
  try { rec.reads['vars/values'] = { ok: { entries: (await varValues(ws, env)).map((e) => ({ ...e, value: e.secret ? '' : m.text(e.value) })) } }; }
  catch (e) { rec.reads['vars/values'] = { error: (e as Error).message }; }
  writeFileSync(join(out, 'reads.json'), JSON.stringify(rec));
  return rec;
}

/** When the whole recording failed: the run says so, and no older run's data stand in for its own. */
export function recordFailure(dir: string, env: string, error: string): void {
  mkdirSync(stateDirOf(dir), { recursive: true });
  writeFileSync(join(stateDirOf(dir), 'reads.json'), JSON.stringify({ at: new Date().toISOString(), env, error, reads: {}, rows: {}, docs: {}, blobs: {}, cut: [], masked: false, withheld: [] } satisfies Recording));
}

/** A run's recording, or null when it kept none (it ran before Laru recorded, or never played a test). */
export function recordingOf(dir: string): Recording | null {
  const f = join(stateDirOf(dir), 'reads.json');
  try { return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Recording) : null; } catch { return null; }
}

/** A recorded blob's bytes, from the run's own folder only. */
export function blobOf(dir: string, b: Blob): Buffer | null {
  if (!/^\d+\.bin$/.test(b.file)) return null;
  const f = join(stateDirOf(dir), 'blobs', b.file);
  return existsSync(f) ? readFileSync(f) : null;
}

/** A recorded table browsed as the screen asks: its filters, its order and its page, over the rows the run kept. */
export function browseRecorded(t: RecordedTable, b: { filters?: Array<{ column: string; op: string; value?: string }>; sort?: { column: string; desc?: boolean }; page?: number; pageSize?: number }) {
  const at = (c: string) => t.columns.indexOf(c);
  const num = (x: string) => (x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
  const cmp = (a: string | null, c: string | null) => { if (a === c) return 0; if (a === null) return 1; if (c === null) return -1; const x = num(a), y = num(c); return x !== null && y !== null ? x - y : a.localeCompare(c); };
  let rows = t.rows.filter((r) => (b.filters ?? []).every((f) => {
    const v = r[at(f.column)] ?? null, w = f.value ?? '';
    if (f.op === 'null') return v === null;
    if (f.op === 'not-null') return v !== null;
    if (v === null) return false;
    if (f.op === 'contains') return v.toLowerCase().includes(w.toLowerCase());
    const c = cmp(v, w);
    return f.op === '=' ? c === 0 : f.op === '!=' ? c !== 0 : f.op === '<' ? c < 0 : f.op === '>' ? c > 0 : f.op === '<=' ? c <= 0 : f.op === '>=' ? c >= 0 : false;
  }));
  if (b.sort && at(b.sort.column) >= 0) { const i = at(b.sort.column), d = b.sort.desc ? -1 : 1; rows = [...rows].sort((x, y) => d * cmp(x[i], y[i])); }
  const size = Math.min(Math.max(b.pageSize ?? 100, 1), 1000), from = Math.max(b.page ?? 0, 0) * size;
  return { columns: t.columns, rows: rows.slice(from, from + size), truncated: rows.length > from + size, ms: 0 };
}
