/**
 * A Redis (or Valkey) of an env, through redis-cli in its own container. The password, when the image takes one
 * from its environment, is handed to redis-cli by the container's shell (REDISCLI_AUTH), never on Laru's argv.
 * Key names and patterns travel on stdin, never on an argv; names and values come back masked with the env's masker,
 * as a queue peek does.
 */
import type { Workspace } from '@laru/core';
import type { Masker } from '@laru/trace';
import { docker, inspectEnv, LABEL } from '../docker.ts';
import { maskedJson, readState } from '../env.ts';

export interface RedisStore { service: string; container: string; hostPort?: number }

/** redis, bitnami/redis, valkey/valkey, redis/redis-stack(-server), dragonfly; not redisinsight, an exporter or another tool around one. */
export const isRedis = (image: string) => /^(redis|valkey|dragonfly|redis-stack|redis-stack-server)$/.test(image.split('@')[0].replace(/:[^/]*$/, '').split('/').pop() ?? '');

/** Every running Redis of the env, by service. */
export async function redisStores(ws: Workspace, env: string): Promise<RedisStore[]> {
  const ports = readState(ws, env)?.ports ?? {};
  return (await inspectEnv(ws, env)).filter((c) => c.state === 'running' && !c.labels[LABEL.run] && isRedis(c.image))
    .map((c) => ({ service: c.service, container: c.id, hostPort: ports[c.service]?.['6379'] })).sort((a, b) => a.service.localeCompare(b.service));
}

export async function redisOf(ws: Workspace, env: string, service?: string): Promise<RedisStore> {
  const all = await redisStores(ws, env);
  const s = service ? all.find((x) => x.service === service) : all[0];
  if (!s) throw new Error(service ? `${service} is not a running Redis of ${env}` : `${env} has no running Redis`);
  return s;
}

/** The container's password, when it has one: an empty REDISCLI_AUTH would send AUTH "" to a Redis without one, which refuses it. */
const AUTH = 'P="${REDIS_PASSWORD:-${REDIS_PASS:-}}"; [ -z "$P" ] || export REDISCLI_AUTH="$P";';
/**
 * redis-cli with fixed arguments and one more, `last`, read from stdin (-x): a key name or a pattern never rides
 * Laru's argv or Docker's event stream, and no value is ever spliced into the shell text.
 */
const cli = (s: RedisStore, args: string[], last: string) =>
  docker(['exec', '-i', s.container, 'sh', '-c', `${AUTH} exec redis-cli --no-auth-warning --raw -x "$@"`, 'redis-cli', ...args], { input: last, timeoutMs: 30_000 });

/** How to reach it from the host: a URL without the password, and redis-cli in the container, logged in by its own shell. */
export function connection(s: RedisStore): { host: string; port?: number; url?: string; shell: string } {
  const shell = `docker exec -it ${s.container.slice(0, 12)} sh -c '${AUTH} exec redis-cli --no-auth-warning'`;
  return s.hostPort ? { host: '127.0.0.1', port: s.hostPort, url: `redis://127.0.0.1:${s.hostPort}`, shell } : { host: '127.0.0.1', shell };
}

/** cjson writes an empty table as an object. */
const arr = <T = unknown>(x: unknown): T[] => (Array.isArray(x) ? x : []);

/**
 * One stretch of SCAN run by the server, each key with its type and TTL read there by its real name: up to 100 SCAN
 * calls, or until ARGV[2] keys are found. ARGV[1] is the cursor, ARGV[3] (from stdin) the pattern; the reply is [cursor, keys].
 */
const SCAN = `local cursor, room, out, n = ARGV[1], tonumber(ARGV[2]), {}, 0
repeat
  local r = redis.call('SCAN', cursor, 'MATCH', ARGV[3], 'COUNT', 1000)
  cursor = r[1]
  for _, k in ipairs(r[2]) do out[#out + 1] = { k, redis.call('TYPE', k).ok, redis.call('TTL', k) } end
  n = n + 1
until cursor == '0' or #out >= room or n == 100
return cjson.encode({ cursor, out })`;

/** `masked`: the name shown is not the key's own (it holds a known value), so the key cannot be asked for by it. */
export interface RedisKey { key: string; type: string; ttl: number; masked?: true }
/** Keys matching a glob pattern, up to `max`, each with its type and TTL (-1: none); names masked, as a key can hold a session token. */
export async function keys(s: RedisStore, m: Masker, pattern = '*', max = 500): Promise<RedisKey[]> {
  const found = new Map<string, [string, number]>();
  let cursor = '0';
  do {
    const [next, batch] = JSON.parse(await cli(s, ['EVAL', SCAN, '0', cursor, String(max - found.size)], pattern)) as [string, unknown];
    for (const [k, type, ttl] of arr<[string, string, number]>(batch)) if (type !== 'none' && found.size < max) found.set(k, [type, ttl]);
    cursor = next;
  } while (cursor !== '0' && found.size < max);
  return [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, [type, ttl]]) => {
    const key = m.text(k);
    return { key, type, ttl, ...(key !== k ? { masked: true as const } : {}) };
  });
}

/** As `keys`, the names alone. */
export async function scan(s: RedisStore, m: Masker, pattern = '*', max = 500): Promise<string[]> {
  return (await keys(s, m, pattern, max)).map((k) => k.key);
}

/**
 * `size`: how many elements a collection holds (entries of a stream). `truncated`: not all of it is shown, as fewer
 * elements than `size`, `cut` or `capped`. `cut`: the string, or some element, field or member, was longer than its
 * limit and is shown up to it. `capped`: some stream entry has more than 100 fields and shows its first 100.
 */
export interface RedisValue { key: string; type: string; ttl: number; value: unknown; size?: number; truncated?: true; cut?: true; capped?: true }

/** How much of a string is shown, of each element of a collection, how many elements (and fields of a stream entry), and how many stream entries. */
const STRING_MAX = 65_536, ELEMENT_MAX = 8_192, ITEMS = 100, STREAM_MAX = 50;

/**
 * A key read by the server in one script, by its name from stdin (KEYS[1]): its type, TTL, size and value, each string
 * at most `s` bytes and each element `e`; a longer one comes back as `[its first bytes]`, so it is known to be cut.
 * Collections are read by the server's own Lua (cjson): an element that holds a newline (a binary session blob) stays
 * one element, so a field is never paired with another's value.
 */
const READ = (s: number, e: number) => `local k, N = KEYS[1], ${ITEMS}
local t = redis.call('TYPE', k).ok
local r = { type = t, ttl = redis.call('TTL', k) }
local function c(v, max) if #v > max then return { string.sub(v, 1, max) } end return v end
local function each(xs) for i = 1, #xs do xs[i] = c(xs[i], ${e}) end return xs end
if t == 'string' then r.v = c(redis.call('GETRANGE', k, 0, ${s}), ${s})
elseif t == 'list' then r.size = redis.call('LLEN', k); r.v = each(redis.call('LRANGE', k, 0, N - 1))
elseif t == 'set' then r.size = redis.call('SCARD', k); r.v = each(redis.call('SRANDMEMBER', k, N))
elseif t == 'zset' then r.size = redis.call('ZCARD', k); r.v = each(redis.call('ZRANGE', k, 0, N - 1, 'WITHSCORES'))
elseif t == 'hash' then r.size = redis.call('HLEN', k); r.v = each(redis.call('HRANDFIELD', k, N, 'WITHVALUES'))
elseif t == 'stream' then
  r.size = redis.call('XLEN', k); r.v = redis.call('XRANGE', k, '-', '+', 'COUNT', ${STREAM_MAX})
  for _, x in ipairs(r.v) do local f = x[2]; for i = #f, 2 * N + 1, -1 do f[i] = nil; r.over = true end; each(f) end
end
return cjson.encode(r)`;
const pairs = (xs: string[]) => Object.fromEntries(Array.from({ length: Math.floor(xs.length / 2) }, (_, i) => [xs[2 * i], xs[2 * i + 1]]));

/**
 * A key's type, TTL and value read by its type (100 elements of a collection: a list's first, a set's or hash's
 * random, a sorted set's lowest; a stream's first 50 entries by id, 100 fields each; the first 64 KB of a string and
 * 8 KB of each element), masked as a JSON body. A longer string or element is read `m.margin` bytes past its limit and
 * cut by the masker, so no piece of a known value is left at the cut.
 */
export async function read(s: RedisStore, key: string, m: Masker): Promise<RedisValue> {
  const r = JSON.parse(await cli(s, ['EVAL', READ(STRING_MAX + m.margin, ELEMENT_MAX + m.margin), '1'], key)) as { type: string; ttl: number; size?: number; v?: unknown; over?: boolean };
  let cut = false;
  const one = (x: unknown) => (Array.isArray(x) ? ((cut = true), m.cut(String(x[0]), 'end')) : String(x));
  const all = (x: unknown) => arr(x).map(one);
  const t = r.type;
  const value = t === 'string' ? one(r.v) : t === 'list' ? all(r.v) : t === 'set' ? all(r.v).sort() : t === 'zset' || t === 'hash' ? pairs(all(r.v))
    : t === 'stream' ? Object.fromEntries(arr<[string, unknown]>(r.v).map(([id, fields]) => [id, pairs(all(fields))])) : null;
  const shown = value && typeof value === 'object' ? Object.keys(value).length : 0;
  const truncated = cut || r.over || (r.size !== undefined && r.size > shown);
  return { key: m.text(key), type: t, ttl: r.ttl, value: maskedJson(JSON.stringify(value), m), ...(r.size !== undefined ? { size: r.size } : {}), ...(truncated ? { truncated: true as const } : {}), ...(cut ? { cut: true as const } : {}), ...(r.over ? { capped: true as const } : {}) };
}

export async function del(s: RedisStore, key: string): Promise<boolean> {
  return (await cli(s, ['DEL'], key)).trim() === '1';
}
