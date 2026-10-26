/**
 * A RabbitMQ of an env. Queues and bindings come from rabbitmqctl inside its container (no credentials needed).
 * Reading a message and publishing go through the management API on the port the env publishes, with the user the
 * container was started with; RabbitMQ refuses `guest` outside localhost, so that needs a user of its own. A read
 * takes the message and puts it back: it is then marked redelivered, and a quorum queue counts one more delivery and
 * puts it at its end.
 */
import type { Workspace } from '@laru/core';
import type { Masker } from '@laru/trace';
import { docker, dockerJson, inspectEnv, LABEL } from '../docker.ts';
import { readState } from '../env.ts';

export interface Rabbit { service: string; container: string; api?: string }

export async function rabbitOf(ws: Workspace, env: string): Promise<Rabbit> {
  const c = (await inspectEnv(ws, env)).find((x) => x.state === 'running' && !x.labels[LABEL.run] && /rabbitmq/.test(x.image));
  if (!c) throw new Error(`${env} has no running RabbitMQ`);
  const port = readState(ws, env)?.ports[c.service]?.['15672'];
  return { service: c.service, container: c.id, api: port ? `http://127.0.0.1:${port}` : undefined };
}

const ctl = async <T>(r: Rabbit, args: string[]): Promise<T[]> => JSON.parse((await docker(['exec', r.container, 'rabbitmqctl', '-q', ...args, '--formatter', 'json'], { timeoutMs: 30_000 })) || '[]') as T[];

/** `messages` is ready plus unacknowledged (taken by a consumer, not yet acknowledged); `type` classic, quorum or stream. */
export const queues = (r: Rabbit) => ctl<{ name: string; messages: number; messages_ready: number; messages_unacknowledged: number; consumers: number; durable: boolean; type: string }>(r, ['list_queues', 'name', 'messages', 'messages_ready', 'messages_unacknowledged', 'consumers', 'durable', 'type']);
/** `destination_kind` queue or exchange. */
export interface Binding { source_name: string; destination_name: string; destination_kind: string; routing_key: string }
const rawBindings = (r: Rabbit) => ctl<Binding>(r, ['list_bindings', 'source_name', 'destination_name', 'destination_kind', 'routing_key']);
/** The bindings, each routing key masked: a key can carry a tenant's token. */
export const bindings = async (r: Rabbit, m: Masker): Promise<Binding[]> => (await rawBindings(r)).map((b) => ({ ...b, routing_key: m.text(b.routing_key) }));

/** Whether a topic binding key matches a routing key: words split by dots, `*` exactly one, `#` none or more. */
export function topicMatch(pattern: string, key: string): boolean {
  const p = pattern ? pattern.split('.') : [], k = key ? key.split('.') : [];
  const at = (i: number, j: number): boolean => (i === p.length ? j === k.length
    : p[i] === '#' ? at(i + 1, j) || (j < k.length && at(i, j + 1))
    : j < k.length && (p[i] === '*' || p[i] === k[j]) && at(i + 1, j + 1));
  return at(0, 0);
}

/** An exchange as rabbitmqctl lists it; `policy` names the policy that applies to it, or is empty. */
export interface Exchange { name: string; type: string; arguments?: unknown[][] | Record<string, unknown>; policy?: string }
export const exchanges = (r: Rabbit) => ctl<Exchange>(r, ['list_exchanges', 'name', 'type', 'arguments', 'policy']);

/**
 * `queues`: each queue reached with the binding key that takes it there, masked. `partial`: an exchange on the way
 * routes by what the keys cannot tell, so other queues may get it too.
 * `alternate`: the exchange's alternate exchange, which takes the message because no binding of the exchange matched.
 * `via`: the exchanges a matching binding of the exchange passes the message on to.
 */
export interface Route { type: string; queues?: Array<{ queue: string; key: string }>; partial?: true; alternate?: string; via?: string[] }
/**
 * Where a message published now would go, from the exchanges' types and the bindings' keys (RabbitMQ has no dry
 * run), as RabbitMQ routes it: through an exchange bound to another, and on to an exchange's alternate exchange (its
 * argument, or else its policy's) when none of its own bindings match. Null when the exchange does not exist; the
 * default exchange is '' or amq.default. A headers exchange, or a plugin's type, routes by what the keys cannot
 * tell: the route is then `partial`, with the queues the keys do tell.
 */
export async function route(r: Rabbit, exchange: string, key: string, m: Masker): Promise<Route | null> {
  const [xs, all] = await Promise.all([exchanges(r), rawBindings(r)]);
  const policies = xs.some((x) => x.policy) ? await ctl<{ name: string; definition: string | Record<string, unknown> }>(r, ['list_policies']) : [];
  return routeIn(xs, all, policies, exchange, key, m);
}

/** route() on what it read: pure, so its walk is tested without a broker. */
export function routeIn(xs: Exchange[], all: Array<{ source_name: string; destination_name: string; destination_kind: string; routing_key: string }>, policies: Array<{ name: string; definition: string | Record<string, unknown> }>, exchange: string, key: string, m: Masker): Route | null {
  const by = new Map(xs.map((x) => [x.name, x]));
  const alternateOf = (x: Exchange): string | undefined => {
    const p = policies.find((y) => y.name === x.policy)?.definition;
    const ae = record(x.arguments)['alternate-exchange'] ?? (typeof p === 'string' ? JSON.parse(p) : p)?.['alternate-exchange'];
    return ae === undefined ? undefined : String(ae);
  };
  const first = exchange === 'amq.default' ? '' : exchange;
  if (!by.has(first)) return null;
  let alternate: string | undefined, via: string[] = [];
  const reached = new Map<string, string>(), seen = new Set<string>();
  // false once an exchange on the way routes by what the keys cannot tell; the walk goes on for what they can
  let known = true;
  const walk = (name: string): void => {
    const x = by.get(name);
    // An alternate exchange that does not exist drops the message, and so does the default one: it routes to a
    // queue by its name only what is published to it.
    if (seen.has(name) || !x || (name === '' && seen.size)) return;
    seen.add(name);
    if (x.type !== 'direct' && x.type !== 'fanout' && x.type !== 'topic') { known = false; return; }
    const matched = all.filter((b) => b.source_name === name && (x.type === 'fanout' || (x.type === 'direct' ? b.routing_key === key : topicMatch(b.routing_key, key))));
    if (!matched.length) {
      const ae = alternateOf(x);
      if (name === first) alternate = ae;
      if (ae !== undefined) walk(ae);
      return;
    }
    if (name === first) via = [...new Set(matched.filter((b) => b.destination_kind === 'exchange').map((b) => b.destination_name))];
    for (const b of matched) {
      if (b.destination_kind === 'exchange') walk(b.destination_name);
      else if (!reached.has(b.destination_name)) reached.set(b.destination_name, x.type === 'fanout' ? '' : b.routing_key);
    }
  };
  walk(first);
  return { type: by.get(first)!.type, queues: [...reached].map(([queue, k]) => ({ queue, key: m.text(k) })), ...(known ? {} : { partial: true as const }), ...(alternate !== undefined ? { alternate } : {}), ...(via.length ? { via } : {}) };
}

/** The container's environment: its user for the API, its version. */
const envOf = async (r: Rabbit): Promise<Record<string, string>> => {
  const [raw] = await dockerJson<any[]>(['inspect', r.container]);
  return Object.fromEntries((raw.Config?.Env ?? []).map((e: string) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
};

/** The management API with the container's own user; the password stays in this process. A 404 is `missing`. */
async function api(r: Rabbit, path: string, body: unknown, missing: string): Promise<any> {
  if (!r.api) throw new Error(`${r.service}'s management port is not published: reading and publishing need a persistent env`);
  const env = await envOf(r);
  const user = env.RABBITMQ_DEFAULT_USER ?? 'guest';
  if (user === 'guest') throw new Error('RabbitMQ refuses guest outside localhost: start it with RABBITMQ_DEFAULT_USER and RABBITMQ_DEFAULT_PASS');
  const res = await fetch(`${r.api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${user}:${env.RABBITMQ_DEFAULT_PASS ?? ''}`).toString('base64')}` }, body: JSON.stringify(body) });
  if (res.status === 404) throw new Error(missing);
  if (!res.ok) { const t = await res.text(); let why = t; try { why = JSON.parse(t).reason ?? t; } catch { /* not JSON */ } throw new Error(`RabbitMQ refused it (${res.status}): ${String(why).slice(0, 200)}`); }
  return res.json();
}

/** A queue as rabbitmqctl lists it: arguments as [name, type, value] and a policy as [key, value], or objects. */
export interface QueueInfo { name: string; type: string; arguments?: unknown[][] | Record<string, unknown>; effective_policy_definition?: unknown[][] | Record<string, unknown> }
const record = (x: QueueInfo['arguments']): Record<string, unknown> => (Array.isArray(x) ? Object.fromEntries(x.map((p) => [p[0], p[p.length - 1]])) : x ?? {});

/**
 * Why putting a message back could lose it, or nothing. A requeue counts as a delivery on a quorum queue, and past its
 * delivery limit (x-delivery-limit or a policy's, the lower; 20 by default from RabbitMQ 4.0, or when the version is
 * unknown; -1 is none) RabbitMQ drops the message, or dead-letters it. A classic queue keeps it, marked redelivered.
 */
export function requeueRisk(q: QueueInfo, version?: string): string | undefined {
  if (q.type !== 'quorum') return;
  const args = record(q.arguments), policy = record(q.effective_policy_definition);
  const set = [args['x-delivery-limit'], policy['delivery-limit']].filter((n) => n !== undefined).map(Number);
  const limit = set.length ? Math.min(...set.filter((n) => n >= 0)) : parseInt(version ?? '', 10) < 4 ? Infinity : 20;
  if (limit === Infinity) return;
  const dlx = args['x-dead-letter-exchange'] ?? policy['dead-letter-exchange'];
  return `${q.name} is a quorum queue with a delivery limit of ${limit}: a peek puts each message back as one more delivery, and past the limit RabbitMQ ${dlx === undefined ? 'drops it' : `dead-letters it to ${dlx || 'the default exchange'}`}. Read it with a consumer of your own`;
}

/** How much of a payload is shown. */
const PAYLOAD_MAX = 50_000;

/**
 * Bytes as UTF-8 text, or undefined when they are not: a payload cut by the API inside a multi-byte character loses
 * that unfinished character (at most 3 bytes) and nothing else, so cut text still reads as text.
 */
export function utf8(bytes: Uint8Array, cut: boolean): string | undefined {
  let end = bytes.length;
  if (cut) {
    let i = end - 1;
    while (i >= 0 && end - i <= 3 && (bytes[i] & 0xc0) === 0x80) i--;
    const lead = bytes[i] ?? 0, need = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 0;
    if (need > end - i) end = i;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)); } catch { return undefined; }
}

/** `binary`: the payload was not text, and reads as a printable peek of its bytes. `truncated`: it was longer than 50 KB. */
export interface RabbitMessage { payload: string; binary?: true; truncated?: true; routing_key: string; exchange: string; redelivered: boolean }
/**
 * The first messages of a queue, put back and marked redelivered; refused where that could drop or dead-letter one,
 * and on a stream, which nothing takes from. A classic queue keeps them where they were. A quorum queue puts them back
 * at its end, behind the rest, so the queue's order changes: there it is refused unless `reorder` says that is meant.
 * Payloads masked as a queue peek's. The API hands a payload that is not UTF-8 over as base64, which would carry a
 * known value past the masker: binary bytes are masked as a peek instead, and text cut inside a character as text.
 * A payload is read `m.margin` bytes past the limit and cut by the masker, so no piece of a known value is left at the cut.
 */
export async function get(r: Rabbit, queue: string, m: Masker, count = 5, reorder = false): Promise<RabbitMessage[]> {
  const [info] = (await ctl<QueueInfo>(r, ['list_queues', 'name', 'type', 'arguments', 'effective_policy_definition'])).filter((q) => q.name === queue);
  if (!info) throw new Error(`no queue ${queue}`);
  if (info.type === 'stream') throw new Error(`${queue} is a stream queue: a stream consumer reads it from an offset, nothing takes a message and puts it back`);
  const env = await envOf(r);
  const risk = requeueRisk(info, env.RABBITMQ_VERSION || env.APP_VERSION || undefined);
  if (risk) throw new Error(risk);
  if (info.type === 'quorum' && !reorder) throw new Error(`${queue} is a quorum queue: a peek puts what it reads back at the end of the queue, behind the rest, so the order changes, and marks it redelivered. Ask for it with reorder`);
  const msgs: Array<Omit<RabbitMessage, 'binary' | 'truncated'> & { payload_encoding: 'string' | 'base64'; payload_bytes: number }> = await api(r, `/api/queues/%2F/${encodeURIComponent(queue)}/get`, { count, ackmode: 'ack_requeue_true', encoding: 'auto', truncate: PAYLOAD_MAX + m.margin }, `no queue ${queue}`);
  return msgs.map((x) => {
    const cut = x.payload_bytes > PAYLOAD_MAX + m.margin;
    const bytes = x.payload_encoding === 'base64' ? Buffer.from(x.payload, 'base64') : undefined;
    const text = bytes ? utf8(bytes, cut) : x.payload, binary = text === undefined;
    const mask = binary ? m.peek : (s: string) => m.body(s, 'application/json'), raw = text ?? bytes!.toString('latin1');
    return {
      payload: cut ? m.cut(raw, 'end', mask) : mask(raw), ...(binary ? { binary: true as const } : {}), ...(cut ? { truncated: true as const } : {}),
      routing_key: m.text(x.routing_key), exchange: x.exchange, redelivered: x.redelivered,
    };
  });
}

export async function publish(r: Rabbit, exchange: string, routingKey: string, payload: string): Promise<boolean> {
  const out = await api(r, `/api/exchanges/%2F/${encodeURIComponent(exchange || 'amq.default')}/publish`, { properties: {}, routing_key: routingKey, payload, payload_encoding: 'string' }, `no exchange ${exchange}`);
  return Boolean(out.routed);
}
