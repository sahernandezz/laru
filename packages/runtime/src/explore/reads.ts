/**
 * What the data screens read of an env, one entry per request («Bases de datos», «Colas», «Almacenamiento», «Correo y
 * mensajes», «Variables y secretos»): the service answers them live with these, and a run records their answers as it
 * ends, so the same screens show what the run left with the env off (state.ts). Only reads: what changes the env has
 * its own route.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph, type Workspace } from '@laru/core';
import type { Masker } from '@laru/trace';
import { connection, schema, storeOf, stores } from '../db.ts';
import { envDir, loadEnvSpec } from '../env.ts';
import { readRules } from '../rules.ts';
import { status } from '../up.ts';
import { missingVars, varTable, vaultServices } from '../vault.ts';
import * as custom from './custom.ts';
import * as kafka from './kafka.ts';
import * as mail from './mail.ts';
import * as mongo from './mongo.ts';
import * as rabbit from './rabbit.ts';
import * as redis from './redis.ts';
import * as sqs from './sqs.ts';
import * as storage from './storage.ts';

export type ReadParams = Record<string, string>;
const graphOf = (w: Workspace) => { try { return loadGraph(w); } catch { return null; } };
/** A broker the env does not run is absent; any other failure (Docker down, a broken broker) says so. */
const none = (e: Error) => { if (/has no running/.test(e.message)) return null; throw e; };

/** The brokers of an env that is up, Kafka first: «Colas» shows whichever it has. */
export async function brokersOf(w: Workspace, env: string): Promise<Array<{ kind: 'kafka' | 'rabbitmq' | 'sqs'; service: string }>> {
  const [k, r, q] = await Promise.all([kafka.brokerOf(w, env).catch(none), rabbit.rabbitOf(w, env).catch(none), sqs.sqsOf(w, env).catch(none)]);
  return [...(k ? [{ kind: 'kafka' as const, service: k.service }] : []), ...(r ? [{ kind: 'rabbitmq' as const, service: r.service }] : []), ...(q ? [{ kind: 'sqs' as const, service: q.service }] : [])];
}

/** Each read by its path under /api/, with the request's parameters (env aside) and the env's masker. */
export const READS: Record<string, (w: Workspace, env: string, p: ReadParams, m: Masker) => Promise<unknown>> = {
  'db/stores': async (w, env) => (await stores(w, env)).map((s) => ({ ...s, conn: connection(s, w.app) })),
  'db/schema': async (w, env, p) => schema(await storeOf(w, env, p.service || undefined)),
  'mongo/stores': async (w, env) => (await mongo.mongoStores(w, env)).map((s) => ({ ...s, conn: mongo.connection(s) })),
  'mongo/dbs': async (w, env, p) => mongo.dbs(await mongo.mongoOf(w, env, p.service || undefined)),
  'mongo/collections': async (w, env, p) => mongo.collections(await mongo.mongoOf(w, env, p.service || undefined), p.db ?? ''),
  'redis/stores': async (w, env) => (await redis.redisStores(w, env)).map((s) => ({ service: s.service, conn: redis.connection(s) })),
  'redis/keys': async (w, env, p, m) => { const s = await redis.redisOf(w, env, p.service || undefined); return { service: s.service, keys: await redis.keys(s, m, p.pattern || '*') }; },
  'redis/key': async (w, env, p, m) => redis.read(await redis.redisOf(w, env, p.service || undefined), p.key ?? '', m),
  'custom/stores': async (w, env) => custom.customStores(w, env),
  'brokers': async (w, env) => brokersOf(w, env),
  'queues': async (w, env) => { const b = await kafka.brokerOf(w, env); const [topics, groups] = await Promise.all([kafka.topics(b), kafka.groups(b)]); return { broker: b.service, topics, groups }; },
  'queue/peek': async (w, env, p, m) => kafka.peek(w, env, await kafka.brokerOf(w, env), p.topic ?? '', Number(p.limit ?? 20), m),
  'rabbit/queues': async (w, env, _p, m) => { const r = await rabbit.rabbitOf(w, env); const [queues, bindings, exchanges] = await Promise.all([rabbit.queues(r), rabbit.bindings(r, m), rabbit.exchanges(r)]); return { broker: r.service, queues, bindings, exchanges: exchanges.map((x) => ({ name: x.name, type: x.type })) }; },
  'sqs/queues': async (w, env) => sqs.queues(await sqs.sqsOf(w, env)),
  'sqs/peek': async (w, env, p, m) => sqs.peek(w, env, await sqs.sqsOf(w, env), p.queue ?? '', Number(p.n ?? 10), m),
  'storage/ls': async (w, env, p) => storage.ls(await storage.storeOfEnv(w, env), p.path ?? '', p.recursive === '1'),
  'storage/object': async (w, env, p, m) => {
    const s = await storage.storeOfEnv(w, env), at = p.path ?? '';
    const meta = await storage.stat(s, at), type = storage.contentTypeOf(meta, at);
    // what the browser shows by itself is streamed by /api/storage/raw; a spreadsheet has its own reader (/api/storage/sheet)
    if (storage.STREAMABLE.test(type) || type === storage.XLSX) return { meta, type, truncated: false, stream: type === storage.XLSX ? 'sheet' : 'raw' };
    const c = await storage.cat(s, at, 256 * 1024);
    const text = /^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(c.bytes.toString('utf8', 0, 4096));
    if (!text) return { meta, type, truncated: c.truncated, base64: c.bytes.toString('base64') };
    // Masked like a queue peek or an env log: a file holding a vault value shows its mark, never the value.
    const masked = m.body(c.bytes.toString('utf8'), String((meta.metadata as Record<string, unknown> | undefined)?.['Content-Type'] ?? ''));
    return { meta, type, truncated: c.truncated, text: c.truncated ? m.cut(masked, 'end') : masked };
  },
  'storage/sheet': async (w, env, p, m) => {
    const s = await storage.storeOfEnv(w, env), at = p.path ?? '';
    if (Number((await storage.stat(s, at)).size) > 25 * 2 ** 20) throw Object.assign(new Error('a spreadsheet over 25 MB is not previewed'), { status: 413 });
    const bytes = await storage.cat(s, at, 25 * 2 ** 20), r = storage.sheet(bytes.bytes);
    return { ...r, rows: r.rows.map((row) => row.map((c) => m.text(c))) };
  },
  'mail': async (w, env, p) => {
    const kind = p.kind === 'mail' || p.kind === 'sms' ? p.kind : 'all';
    const st = await status(w, env).catch(() => undefined);
    let sinks: ReturnType<typeof mail.sinkReport> | undefined;
    try { sinks = mail.sinkReport(w, env); } catch { /* an env that does not load has no sinks to show */ }
    return { env, state: st?.state ?? 'absent', sinks, plan: mail.plan(w, env), ...mail.list(w, env, { kind, query: p.q ?? '', limit: Number(p.limit) || 500 }) };
  },
  'mail/message': async (w, env, p) => {
    const x = mail.message(w, env, p.id ?? '');
    if (!x) throw Object.assign(new Error('no such message'), { status: 404 });
    return mail.withOpen(w, env, x);
  },
  // the tap's rules (who is who on the env's network, for «Colas»), its routes and the env's mocks and faults
  'mocks': async (w, env) => {
    const dir = join(envDir(w, env), 'tap');
    const routes = existsSync(join(dir, 'routes.json')) ? JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8')).routes : [];
    return { rules: readRules(w, env), routes, spec: { mocks: loadEnvSpec(w, env).mocks, faults: loadEnvSpec(w, env).faults } };
  },
  'vars': async (w, env) => {
    const services = vaultServices(w, env), g = graphOf(w);
    return { env, read: services.length > 0, rows: varTable(w, env, services, g), issues: services.length ? missingVars(w, env, services, g) : [] };
  },
};
