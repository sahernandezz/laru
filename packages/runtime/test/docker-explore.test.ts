/**
 * The explorers against real servers: Redis read by type, RabbitMQ queues, publish and get with requeue, MongoDB
 * read as a user that cannot write; every value they show masked. And DynamoDB Local behind the tap, its calls
 * labelled by operation and table in the trace. Heavy: LARU_E2E=1 with Docker running. Containers carry a test
 * label (or the test workspace's) and are removed after.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { addRepo, initWorkspace } from '@laru/core';
import { assemble, createMasker, type RunnerEvent } from '@laru/trace';
import { collections, connection, dbs, find, get as getDoc, run, type MongoStore } from '../src/explore/mongo.ts';
import { bindings, get, publish, queues, requeueRisk, route, topicMatch, utf8, type Rabbit } from '../src/explore/rabbit.ts';
import { topics, type Broker } from '../src/explore/kafka.ts';
import { connection as redisConnection, del, isRedis, keys, read, scan, type RedisStore } from '../src/explore/redis.ts';
import { down, envDir, setVar, up, workspaceKey } from '../src/index.ts';
import type { TrafficRecord } from '../src/types.ts';
import { dockerUp, guard } from './guard.ts';

const heavy = !dockerUp ? 'Docker is not running' : process.env.LARU_E2E !== '1' ? 'set LARU_E2E=1' : false;
const KEY = 'laru-explore-test';
const docker = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8' }).trim();
const SECRET = 'tok-Secret-4242xy';
const m = createMasker([SECRET]);
const until = async (probe: () => unknown, s = 90) => { for (let i = 0; i < s; i++) { try { await probe(); return; } catch { await new Promise((r) => setTimeout(r, 1000)); } } throw new Error('not ready'); };

test('Redis: keys by pattern, each read by its type', { skip: heavy, timeout: 120_000 }, async (t) => {
  const g = guard(KEY);
  const id = docker('run', '-d', '--label', `keelson.workspace=${KEY}`, '-e', 'REDIS_PASSWORD=pw-test-123', 'redis:7-alpine', 'sh', '-c', 'exec redis-server --requirepass "$REDIS_PASSWORD"');
  t.after(() => { docker('rm', '-f', '-v', id); g.check(); });
  const s: RedisStore = { service: 'cache', container: id };
  await until(() => scan(s, m));
  docker('exec', id, 'sh', '-c', 'REDISCLI_AUTH=$REDIS_PASSWORD redis-cli SET session:1 "{\\"user\\":\\"ana\\"}" EX 300 && REDISCLI_AUTH=$REDIS_PASSWORD redis-cli RPUSH jobs a b c && REDISCLI_AUTH=$REDIS_PASSWORD redis-cli HSET user:1 name ana role USER && REDISCLI_AUTH=$REDIS_PASSWORD redis-cli ZADD rank 2 bea 1 ana && REDISCLI_AUTH=$REDIS_PASSWORD redis-cli SADD tags x y');
  docker('exec', id, 'sh', '-c', `REDISCLI_AUTH=$REDIS_PASSWORD redis-cli SET "tok:${SECRET}" "{\\"bearer\\":\\"${SECRET}\\"}" && REDISCLI_AUTH=$REDIS_PASSWORD redis-cli HSET user:2 name bea password hunter2-long`);
  assert.deepEqual(await scan(s, m, 'user:*'), ['user:1', 'user:2']);
  assert.deepEqual(await scan(s, m), ['jobs', 'rank', 'session:1', 'tags', `tok:${m.text(SECRET)}`, 'user:1', 'user:2'], 'a key holding a known value shows its mark');
  assert.deepEqual((await keys(s, m)).map((k) => [k.key, k.type, k.ttl > 0]), [['jobs', 'list', false], ['rank', 'zset', false], ['session:1', 'string', true], ['tags', 'set', false], [`tok:${m.text(SECRET)}`, 'string', false], ['user:1', 'hash', false], ['user:2', 'hash', false]],
    'each key with its type and TTL, read by its real name before it is masked');
  assert.deepEqual(await keys(s, m, 'nothing:*'), []);
  const str = await read(s, 'session:1', m);
  assert.deepEqual([str.type, str.value], ['string', '{"user":"ana"}']);
  assert.ok(str.ttl > 0 && str.ttl <= 300);
  assert.deepEqual((await read(s, 'jobs', m)).value, ['a', 'b', 'c']);
  assert.deepEqual((await read(s, 'user:1', m)).value, { name: 'ana', role: 'USER' });
  assert.deepEqual((await read(s, 'rank', m)).value, { ana: '1', bea: '2' });
  assert.deepEqual((await read(s, 'tags', m)).value, ['x', 'y']);
  const secretive = [await read(s, `tok:${SECRET}`, m), await read(s, 'user:2', m)];
  assert.equal(secretive[0].type, 'string');
  assert.match(JSON.stringify(secretive[1].value), /"password":"…[\w-]{4}"/, 'a secret-looking field is masked');
  assert.ok(!JSON.stringify(secretive).includes(SECRET) && !JSON.stringify(secretive).includes('hunter2-long'), 'no value or key shows a secret');
  // A value holding a newline (a binary session blob often does) is one value, and a field keeps its own value.
  const rc = (...a: string[]) => docker('exec', id, 'sh', '-c', 'REDISCLI_AUTH=$REDIS_PASSWORD exec redis-cli "$@"', 'redis-cli', ...a);
  rc('HSET', 'user:3', 'a', 'x\ny', 'password', 'hunter2-long', 'z', 'q');
  rc('RPUSH', 'lines', 'x\ny', 'b');
  rc('XADD', 'events', '1-0', 'password', 'hunter2-long', 'n', '1');
  const multi = [await read(s, 'user:3', m), await read(s, 'lines', m), await read(s, 'events', m)];
  const [hash, stream] = [multi[0].value as Record<string, string>, multi[2].value as Record<string, Record<string, string>>];
  assert.deepEqual([Object.keys(hash), hash.a, hash.z], [['a', 'password', 'z'], 'x\ny', 'q']);
  assert.match(hash.password, /^…[\w-]{4}$/);
  assert.deepEqual(multi[1].value, ['x\ny', 'b']);
  assert.deepEqual([Object.keys(stream), stream['1-0'].n], [['1-0'], '1'], 'a stream reads as its entries by id');
  assert.match(stream['1-0'].password, /^…[\w-]{4}$/, 'a stream field is masked as a hash field is');
  assert.ok(!JSON.stringify(multi).includes('hunter2-long'));
  assert.equal(await del(s, 'jobs'), true);
  assert.deepEqual(await scan(s, m, 'jobs'), []);
  assert.deepEqual(await scan(s, m, '"; FLUSHALL; "'), [], 'a pattern is an argument, never shell text');
  assert.equal((await scan(s, m)).length, 9);
  // A string past 64 KB is cut by the masker, and says so: a known value at the cut leaves no piece of itself.
  rc('SET', 'big', `${'x'.repeat(65_529)} ${SECRET}`);
  rc('SET', 'bigger', `${'x'.repeat(65_536 + m.margin - 7)} ${SECRET} ${'y'.repeat(10)}`);
  const [big, bigger] = [await read(s, 'big', m), await read(s, 'bigger', m)];
  assert.deepEqual([String(big.value).endsWith(` ${m.text(SECRET)}`), big.truncated], [true, undefined], 'a value just past 64 KB is read whole');
  assert.deepEqual([String(bigger.value).endsWith('x…'), String(bigger.value).length, bigger.truncated], [true, 65_536 + 1, true], 'the first 64 KB and an ellipsis');
  assert.ok(!/tok-S/.test(String(big.value) + String(bigger.value)), 'no piece of a known value at the cut');
  // A stream past 50 entries: the first 50, and says so.
  for (let i = 1; i <= 70; i++) rc('XADD', 'long', `${i}-0`, 'n', String(i));
  const long = await read(s, 'long', m);
  assert.deepEqual([Object.keys(long.value as object).length, long.truncated, long.capped], [50, true, undefined], 'no entry past 100 fields: none capped');
  // The connection line, run as copied: it logs in with the container's own password.
  assert.equal(execFileSync('sh', ['-c', redisConnection(s).shell.replace(' -it ', ' -i ')], { input: 'PING\n', encoding: 'utf8' }).trim(), 'PONG');
});

test('Redis without a password: read, and its connection line, with no AUTH at all', { skip: heavy, timeout: 120_000 }, async (t) => {
  const g = guard(KEY);
  const id = docker('run', '-d', '--label', `keelson.workspace=${KEY}`, 'redis:7-alpine');
  t.after(() => { docker('rm', '-f', '-v', id); g.check(); });
  const s: RedisStore = { service: 'sessions', container: id };
  await until(() => docker('exec', id, 'redis-cli', 'PING'));
  docker('exec', id, 'redis-cli', 'SET', 'session:9', 'x');
  assert.deepEqual(await scan(s, m), ['session:9']);
  assert.deepEqual((await read(s, 'session:9', m)).value, 'x');
  assert.equal(execFileSync('sh', ['-c', redisConnection(s).shell.replace(' -it ', ' -i ')], { input: 'PING\n', encoding: 'utf8' }).trim(), 'PONG');
});

/**
 * Runs `body` with a docker on PATH that logs every argv it is given, and returns the log: what Laru hands the host's
 * docker is also what Docker's event stream records (exec_create carries the command).
 */
async function argvOf(body: () => Promise<void>): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'laru-argv-'))), log = join(dir, 'argv.log');
  const real = execFileSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try { await body(); } finally { process.env.PATH = path; }
  const out = readFileSync(log, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return out;
}

test('Redis: no stored key name or value, and no pattern, reaches a docker argv; names exactly as stored, masked ones flagged; elements capped', { skip: heavy, timeout: 120_000 }, async (t) => {
  const g = guard(KEY);
  const id = docker('run', '-d', '--label', `keelson.workspace=${KEY}`, '-e', 'REDIS_PASSWORD=pw-test-123', 'redis:7-alpine', 'sh', '-c', 'exec redis-server --requirepass "$REDIS_PASSWORD"');
  t.after(() => { docker('rm', '-f', '-v', id); g.check(); });
  const s: RedisStore = { service: 'cache', container: id };
  // Seeded through stdin, so the seeding leaves nothing to find either.
  const seed = (cmds: string) => execFileSync('docker', ['exec', '-i', id, 'sh', '-c', 'REDISCLI_AUTH=$REDIS_PASSWORD exec redis-cli'], { input: cmds, encoding: 'utf8' });
  await until(() => seed('PING\n'));
  const big = (k: string, cmd: string) => `EVAL "redis.call('${cmd}', KEYS[1], ${k})" 1`;
  seed([
    `SET "kz-session:${SECRET}" "vz-1"`, 'SET "" "vz-empty"', 'SET "kz-clé…abcd" "vz-ellipsis"', 'SET "kz-line\\nbreak" "vz-newline"',
    `${big("string.rep('a', 3000000), string.rep('b', 3000000)", 'RPUSH')} kz-list`,
    `${big("'f1', string.rep('c', 3000000), 'json', '{\\\"password\\\":\\\"hunter2-long-unknown\\\",\\\"note\\\":\\\"' .. string.rep('x', 9000) .. '\\\"}'", 'HSET')} kz-hash`,
    `EVAL "for i = 1, 150 do redis.call('RPUSH', KEYS[1], 'vz-' .. i) end" 1 kz-many`,
    `EVAL "local f = {} for i = 1, 150 do f[#f + 1] = 'f' .. i; f[#f + 1] = 'vz-' .. i end redis.call('XADD', KEYS[1], '1-0', unpack(f))" 1 kz-wide`,
    `EVAL "local f = {} for i = 1, 150 do f[#f + 1] = 'f' .. i; f[#f + 1] = 'vz-' .. i end redis.call('XADD', KEYS[1], '1-0', unpack(f)) for i = 2, 61 do redis.call('XADD', KEYS[1], i .. '-0', 'n', 'vz') end" 1 kz-wide2`,
  ].join('\n') + '\n');
  let listed: Awaited<ReturnType<typeof keys>> = [], all: Awaited<ReturnType<typeof keys>> = [], values: Array<Awaited<ReturnType<typeof read>>> = [];
  let gone = false;
  const log = await argvOf(async () => {
    listed = await keys(s, m, 'kz-*');
    all = await keys(s, m);
    await scan(s, m, 'kz-s*');
    values = await Promise.all(['', `kz-session:${SECRET}`, 'kz-clé…abcd', 'kz-line\nbreak', 'kz-list', 'kz-hash', 'kz-many', 'kz-wide', 'kz-wide2'].map((k) => read(s, k, m)));
    gone = await del(s, '');
  });
  assert.ok(log.includes(' exec '), 'the wrapper saw the explorer\'s calls');
  for (const x of ['kz-', 'vz-', SECRET, 'hunter2']) assert.ok(!log.includes(x), `${x} on a docker argv:\n${log.slice(0, 2000)}`);

  assert.deepEqual(listed.map((k) => [k.key, k.masked]), [['kz-clé…abcd', undefined], ['kz-hash', undefined], ['kz-line\nbreak', undefined], ['kz-list', undefined], ['kz-many', undefined], [`kz-session:${m.text(SECRET)}`, true], ['kz-wide', undefined], ['kz-wide2', undefined]],
    'a name with a newline is one name; only a name the masker changed is flagged, whatever it looks like');
  assert.deepEqual(all.filter((k) => k.key === ''), [{ key: '', type: 'string', ttl: -1 }], 'the empty name is a key too');
  const [empty, secretName, ellipsis, newline, list, hash, many, wide, wide2] = values;
  assert.deepEqual([empty.value, secretName.value, ellipsis.value, newline.value], ['vz-empty', 'vz-1', 'vz-ellipsis', 'vz-newline']);
  assert.equal(secretName.key, `kz-session:${m.text(SECRET)}`);
  const els = list.value as string[];
  assert.deepEqual([list.size, els.length, list.truncated, list.cut, els.map((e) => e.length)], [2, 2, true, true, [8_192 + 1, 8_192 + 1]], 'each element cut at 8 KB, and said');
  assert.ok(els[0].endsWith('a…') && els[1].endsWith('b…'));
  const h = hash.value as Record<string, string>;
  assert.deepEqual([hash.size, hash.cut, h.f1.length], [2, true, 8_192 + 1]);
  assert.ok(!JSON.stringify(h).includes('hunter2'), `a cut JSON element still masks its secret-looking field: ${h.json.slice(0, 60)}`);
  assert.deepEqual([many.size, (many.value as string[]).length, many.truncated, many.cut], [150, 100, true, undefined], 'the first 100 of 150, nothing cut');
  const entry = (wide.value as Record<string, Record<string, string>>)['1-0'];
  assert.deepEqual([wide.size, Object.keys(entry).length, wide.truncated, wide.capped], [1, 100, true, true], 'a stream entry shows its first 100 fields, and says so');
  const entries = wide2.value as Record<string, Record<string, string>>;
  assert.deepEqual([wide2.size, Object.keys(entries).length, Object.keys(entries['1-0']).length, wide2.capped], [61, 50, 100, true], 'the field cap is said when entries are left out too');
  assert.equal(gone, true, 'the empty name is deleted by itself');
  assert.equal(seed('EXISTS ""\n').trim(), '0');
});

test('Redis images: the server, not a tool around it', () => {
  for (const x of ['redis:7-alpine', 'bitnami/redis:7.2', 'valkey/valkey:8', 'redis/redis-stack-server:latest', 'docker.dragonflydb.io/dragonflydb/dragonfly', 'redis@sha256:abc']) assert.ok(isRedis(x), x);
  for (const x of ['redis/redisinsight:latest', 'oliver006/redis_exporter', 'rediscommander/redis-commander', 'myredis-app:1']) assert.ok(!isRedis(x), x);
});

test('RabbitMQ: queues and bindings, publish, get with requeue', { skip: heavy, timeout: 180_000 }, async (t) => {
  const g = guard(KEY);
  const id = docker('run', '-d', '--label', `keelson.workspace=${KEY}`, '-e', 'RABBITMQ_DEFAULT_USER=ks', '-e', 'RABBITMQ_DEFAULT_PASS=pw-test-123', '-p', '127.0.0.1::15672', 'rabbitmq:3-management');
  t.after(() => { docker('rm', '-f', '-v', id); g.check(); });
  const port = docker('port', id, '15672/tcp').split('\n')[0].split(':').pop();
  const r: Rabbit = { service: 'mq', container: id, api: `http://127.0.0.1:${port}` };
  await until(async () => { const res = await fetch(`${r.api}/api/overview`, { headers: { authorization: `Basic ${Buffer.from('ks:pw-test-123').toString('base64')}` } }); if (!res.ok) throw new Error(String(res.status)); }, 120);
  await fetch(`${r.api}/api/queues/%2F/orders`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from('ks:pw-test-123').toString('base64')}` }, body: '{"durable":true}' });
  assert.equal(await publish(r, '', 'orders', `{"id":7,"token":"abc","note":"${SECRET}"}`), true);
  assert.equal(await publish(r, '', 'orders', '{"id":8}'), true);
  await until(async () => { const q = (await queues(r)).find((x) => x.name === 'orders'); if (q?.messages !== 2) throw new Error('not yet'); }, 20);
  const got = await get(r, 'orders', m, 1);
  assert.deepEqual(got.map((x) => JSON.parse(x.payload).id), [7]);
  assert.match(got[0].payload, /"token":"…[\w-]{4}"/, 'a secret-looking field is masked');
  assert.ok(!got[0].payload.includes(SECRET) && got[0].payload.includes(m.text(SECRET)), 'a known value shows its mark');
  const orders = (await queues(r)).find((x) => x.name === 'orders');
  assert.deepEqual([orders?.messages, orders?.messages_ready, orders?.messages_unacknowledged, orders?.type], [2, 2, 0, 'classic'], 'a read message is put back, ready again');
  // Binary payloads come from the API as base64: the known value is masked in their bytes whatever its alignment.
  const auth = { 'content-type': 'application/json', authorization: `Basic ${Buffer.from('ks:pw-test-123').toString('base64')}` };
  await fetch(`${r.api}/api/queues/%2F/blobs`, { method: 'PUT', headers: auth, body: '{"durable":true}' });
  for (const prefix of [[], [7], [0, 1]]) {
    const payload = Buffer.concat([Buffer.from(prefix), Buffer.from(SECRET), Buffer.from([0xff, 0xfe])]).toString('base64');
    await fetch(`${r.api}/api/exchanges/%2F/amq.default/publish`, { method: 'POST', headers: auth, body: JSON.stringify({ properties: {}, routing_key: 'blobs', payload, payload_encoding: 'base64' }) });
  }
  await until(async () => { if ((await queues(r)).find((x) => x.name === 'blobs')?.messages !== 3) throw new Error('not yet'); }, 20);
  const blobs = await get(r, 'blobs', m, 3);
  assert.deepEqual(blobs.map((x) => x.binary), [true, true, true]);
  for (const x of blobs) assert.ok(!x.payload.includes(SECRET) && x.payload.includes(m.text(SECRET)), x.payload);
  assert.ok((await bindings(r, m)).some((b) => b.destination_name === 'orders'));

  // A payload past 50 KB is cut by the masker, and says so; text and binary alike.
  const send = (q: string, payload: string, payload_encoding = 'string') => fetch(`${r.api}/api/exchanges/%2F/amq.default/publish`, { method: 'POST', headers: auth, body: JSON.stringify({ properties: {}, routing_key: q, payload, payload_encoding }) });
  const declare = (q: string, args: Record<string, unknown> = {}) => fetch(`${r.api}/api/queues/%2F/${q}`, { method: 'PUT', headers: auth, body: JSON.stringify({ durable: true, arguments: args }) });
  const count = async (q: string) => (await queues(r)).find((x) => x.name === q)?.messages;
  await declare('big');
  await send('big', `${'x'.repeat(49_993)} ${SECRET}`);
  await send('big', `${'x'.repeat(50_000 + m.margin - 7)} ${SECRET} ${'y'.repeat(10)}`);
  await send('big', Buffer.concat([Buffer.from([0xff]), Buffer.from(`${'x'.repeat(50_000 + m.margin - 7)}${SECRET}`)]).toString('base64'), 'base64');
  await until(async () => { if (await count('big') !== 3) throw new Error('not yet'); }, 20);
  const big = await get(r, 'big', m, 3);
  assert.deepEqual(big.map((x) => [x.binary, x.truncated, x.payload.endsWith('x…')]), [[undefined, undefined, false], [undefined, true, true], [true, true, true]]);
  assert.ok(big[0].payload.endsWith(` ${m.text(SECRET)}`), 'a payload just past 50 KB is read whole');
  assert.ok(!big.some((x) => /tok-S/.test(x.payload)), 'no piece of a known value at the cut');
  // Text cut inside a multi-byte character comes from the API as base64: it is still text, masked as text.
  await declare('utf8');
  const head = '{"user":"ana","password":"hunter2-long-unknown","note":"';
  for (const shift of [0, 1]) {
    const room = 50_000 + m.margin - Buffer.byteLength(head) - shift;
    await send('utf8', head + 'x'.repeat(room % 2) + 'ñ'.repeat(Math.ceil(room / 2) + 50) + '"}');
  }
  await until(async () => { if (await count('utf8') !== 2) throw new Error('not yet'); }, 20);
  const cutText = await get(r, 'utf8', m, 2);
  assert.deepEqual(cutText.map((x) => [x.binary, x.truncated, x.payload.endsWith('ñ…')]), [[undefined, true, true], [undefined, true, true]]);
  for (const x of cutText) assert.match(x.payload, /^\{"user":"ana","password":"…[\w-]{4}","note":"x?ñ/, 'the secret-looking field is masked as in any text payload');

  // A peek marks the message redelivered. Where that counts as a delivery towards a limit, it is refused, and the message stays.
  await declare('quorum', { 'x-queue-type': 'quorum' });
  await send('quorum', 'order-7');
  await until(async () => { if (await count('quorum') !== 1) throw new Error('not yet'); }, 20);
  await assert.rejects(get(r, 'quorum', m), /^Error: quorum is a quorum queue: a peek puts what it reads back at the end of the queue, behind the rest, so the order changes/, 'a peek that reorders the queue asks for it');
  assert.deepEqual([...await get(r, 'quorum', m, 5, true), ...await get(r, 'quorum', m, 5, true)].map((x) => [x.payload, x.redelivered]), [['order-7', false], ['order-7', true]], 'a quorum queue without a limit on 3.13');
  // What the confirmation says, as RabbitMQ does it: a quorum queue puts what a peek read behind the rest; a classic one keeps its order.
  await declare('qorder', { 'x-queue-type': 'quorum' });
  await declare('corder');
  for (let i = 1; i <= 8; i++) { await send('qorder', `m${i}`); await send('corder', `m${i}`); }
  await until(async () => { if (await count('qorder') !== 8 || await count('corder') !== 8) throw new Error('not yet'); }, 20);
  await get(r, 'qorder', m, 5, true);
  await get(r, 'corder', m, 5);
  assert.deepEqual((await get(r, 'qorder', m, 8, true)).map((x) => x.payload).join(' '), 'm6 m7 m8 m1 m2 m3 m4 m5');
  assert.deepEqual((await get(r, 'corder', m, 8)).map((x) => x.payload).join(' '), 'm1 m2 m3 m4 m5 m6 m7 m8');
  await declare('limited', { 'x-queue-type': 'quorum', 'x-delivery-limit': 2, 'x-dead-letter-exchange': 'dlx' });
  await send('limited', 'order-8');
  await until(async () => { if (await count('limited') !== 1) throw new Error('not yet'); }, 20);
  for (let i = 0; i < 4; i++) await assert.rejects(get(r, 'limited', m), /limited is a quorum queue with a delivery limit of 2: .* dead-letters it to dlx/);
  assert.equal(await count('limited'), 1, 'four refused peeks lose nothing');
  await declare('policed', { 'x-queue-type': 'quorum' });
  await fetch(`${r.api}/api/policies/%2F/limit`, { method: 'PUT', headers: auth, body: JSON.stringify({ pattern: '^policed$', definition: { 'delivery-limit': 3 }, 'apply-to': 'queues' }) });
  await until(() => assert.rejects(get(r, 'policed', m), /delivery limit of 3: .* drops it/), 20);

  // Where a publish would go: the exchange's type and the bindings' keys, the keys masked; a stream and a missing exchange say so.
  const put = (path: string, body: unknown) => fetch(`${r.api}${path}`, { method: 'PUT', headers: auth, body: JSON.stringify(body) });
  const bind = (x: string, q: string, routing_key: string, to = 'q') => fetch(`${r.api}/api/bindings/%2F/e/${x}/${to}/${q}`, { method: 'POST', headers: auth, body: JSON.stringify({ routing_key }) });
  await put('/api/exchanges/%2F/shop.events', { type: 'topic', durable: true });
  await put('/api/exchanges/%2F/shop.fan', { type: 'fanout', durable: true });
  await put('/api/exchanges/%2F/shop.headers', { type: 'headers', durable: true });
  await declare('emails');
  await bind('shop.events', 'orders', 'order.*');
  await bind('shop.events', 'orders', `tenant.${SECRET}`);
  await bind('shop.events', 'emails', 'email.#');
  await bind('shop.events', 'shop.fan', 'audit.#', 'e');
  await bind('shop.fan', 'blobs', '');
  assert.ok((await bindings(r, m)).some((b) => b.routing_key === `tenant.${m.text(SECRET)}`), 'a binding key holding a known value shows its mark');
  assert.ok(!JSON.stringify(await bindings(r, m)).includes(SECRET));
  const to = async (x: string, key: string) => { const out = await route(r, x, key, m); return out?.queues ? { ...out, queues: out.queues.map((q) => `${q.queue} ${q.key}`) } : out; };
  assert.deepEqual(await to('shop.events', 'user.created'), { type: 'topic', queues: [] }, 'no binding key matches');
  assert.deepEqual(await to('shop.events', 'order.paid'), { type: 'topic', queues: ['orders order.*'] });
  assert.deepEqual(await to('shop.events', 'email.welcome.es'), { type: 'topic', queues: ['emails email.#'] });
  assert.deepEqual(await to('shop.events', `tenant.${SECRET}`), { type: 'topic', queues: [`orders tenant.${m.text(SECRET)}`] });
  assert.deepEqual(await to('shop.events', 'audit.x'), { type: 'topic', queues: ['blobs '], via: ['shop.fan'] }, 'through an exchange bound to another');
  assert.deepEqual(await to('', 'orders'), { type: 'direct', queues: ['orders orders'] }, 'the default exchange: the queue of that name');
  assert.deepEqual(await to('', 'nobody'), { type: 'direct', queues: [] });
  assert.deepEqual(await to('shop.headers', 'x'), { type: 'headers', queues: [], partial: true }, 'headers route by what a key cannot tell');
  // past an exchange the keys cannot tell, the queues they do tell are kept
  await put('/api/exchanges/%2F/e7', { type: 'direct', durable: true });
  await declare('dq7');
  await bind('e7', 'shop.headers', 'k', 'e');
  await bind('e7', 'dq7', 'k');
  assert.deepEqual(await to('e7', 'k'), { type: 'direct', queues: ['dq7 k'], partial: true, via: ['shop.headers'] });
  assert.deepEqual(await to('amq.default', 'orders'), { type: 'direct', queues: ['orders orders'] }, 'amq.default is the default exchange');
  // An alternate exchange takes what no binding matched: by the exchange's argument, or by a policy.
  await put('/api/exchanges/%2F/unrouted', { type: 'fanout', durable: true });
  await declare('unrouted.q');
  await bind('unrouted', 'unrouted.q', '');
  await put('/api/exchanges/%2F/shop.ae', { type: 'topic', durable: true, arguments: { 'alternate-exchange': 'unrouted' } });
  await bind('shop.ae', 'orders', 'order.*');
  await put('/api/exchanges/%2F/shop.pae', { type: 'direct', durable: true });
  await put('/api/policies/%2F/ae', { pattern: '^shop\\.pae$', definition: { 'alternate-exchange': 'unrouted' }, 'apply-to': 'exchanges' });
  await put('/api/exchanges/%2F/shop.outer', { type: 'direct', durable: true });
  await bind('shop.outer', 'shop.ae', 'k', 'e');
  await put('/api/exchanges/%2F/shop.lost', { type: 'topic', durable: true, arguments: { 'alternate-exchange': 'nowhere' } });
  assert.deepEqual(await to('shop.ae', 'user.created'), { type: 'topic', queues: ['unrouted.q '], alternate: 'unrouted' }, 'no binding matches: the alternate exchange takes it');
  assert.deepEqual(await to('shop.ae', 'order.paid'), { type: 'topic', queues: ['orders order.*'] }, 'a binding matches: the alternate exchange is not used');
  await until(async () => assert.deepEqual(await to('shop.pae', 'x'), { type: 'direct', queues: ['unrouted.q '], alternate: 'unrouted' }), 20);
  assert.deepEqual(await to('shop.outer', 'k'), { type: 'direct', queues: ['unrouted.q '], via: ['shop.ae'] }, 'an exchange bound to one with an alternate');
  assert.deepEqual(await to('shop.lost', 'x'), { type: 'topic', queues: [], alternate: 'nowhere' }, 'an alternate that does not exist drops it');
  // The default exchange as an alternate routes nowhere: it takes a queue by its name only what is published to it.
  await declare('dq');
  await put('/api/exchanges/%2F/g2', { type: 'direct', durable: true, arguments: { 'alternate-exchange': '' } });
  assert.deepEqual(await to('g2', 'dq'), { type: 'direct', queues: [], alternate: '' }, 'the default exchange as an alternate drops it');
  // A binding to an exchange that takes nothing: that binding matched, so the alternate is not used, and it is dropped.
  await put('/api/exchanges/%2F/e3', { type: 'direct', durable: true, arguments: { 'alternate-exchange': 'unrouted' } });
  await put('/api/exchanges/%2F/e4', { type: 'direct', durable: true });
  await bind('e3', 'e4', 'k', 'e');
  assert.deepEqual(await to('e3', 'k'), { type: 'direct', queues: [], via: ['e4'] }, 'it reaches e4, where nothing takes it');
  const was = [await count('dq'), await count('unrouted.q')];
  assert.deepEqual([await publish(r, 'g2', 'dq', '{}'), await publish(r, 'e3', 'k', '{}')], [false, false], 'RabbitMQ drops both, as the reviews say');
  await new Promise((res) => setTimeout(res, 1500));
  assert.deepEqual([await count('dq'), await count('unrouted.q')], was);
  const before = await count('unrouted.q');
  assert.equal(await publish(r, 'shop.ae', 'user.created', '{}'), true, 'RabbitMQ routes it as the review said');
  await until(async () => { if (await count('unrouted.q') !== (before ?? 0) + 1) throw new Error('not yet'); }, 20);

  assert.equal(await route(r, 'nope', 'x', m), null, 'no such exchange');
  await assert.rejects(publish(r, 'nope', 'x', '{}'), /^Error: no exchange nope$/);
  await assert.rejects(get(r, 'nobody', m), /^Error: no queue nobody$/);
  await declare('ledger', { 'x-queue-type': 'stream' });
  await assert.rejects(get(r, 'ledger', m), /^Error: ledger is a stream queue: /);
});

test('RabbitMQ text cut inside a UTF-8 character is still text; binary is not', () => {
  const b = (s: string, ...tail: number[]) => Buffer.concat([Buffer.from(s), Buffer.from(tail)]);
  assert.equal(utf8(b('añ'), false), 'añ');
  assert.equal(utf8(b('a', 0xc3), true), 'a', 'ñ cut after its first byte');
  assert.equal(utf8(b('a', 0xe2, 0x82), true), 'a', '€ cut after two of its three');
  assert.equal(utf8(b('a', 0xf0, 0x9f, 0x98), true), 'a', 'an emoji cut after three of its four');
  assert.equal(utf8(b('a€'), true), 'a€', 'a whole character at the cut stays');
  assert.equal(utf8(b('a', 0xc3), false), undefined, 'not cut: an unfinished character is not text');
  assert.equal(utf8(b('a', 0xff), true), undefined, 'a byte no UTF-8 starts with is binary');
  assert.equal(utf8(b('a', 0x00, 0xfe, 0x41), true), undefined);
});

test('RabbitMQ topic keys: * one word, # none or more', () => {
  const yes: Array<[string, string]> = [['order.*', 'order.paid'], ['email.#', 'email'], ['email.#', 'email.a.b'], ['#', ''], ['#', 'a.b'], ['*.b.#', 'a.b'], ['a.#.z', 'a.z'], ['a.#.z', 'a.b.c.z'], ['', '']];
  const no: Array<[string, string]> = [['order.*', 'order'], ['order.*', 'order.a.b'], ['order.*', 'user.created'], ['*', ''], ['a.#.z', 'a.b'], ['', 'a'], ['email.#', 'emails']];
  for (const [p, k] of yes) assert.ok(topicMatch(p, k), `${p} ${k}`);
  for (const [p, k] of no) assert.ok(!topicMatch(p, k), `${p} ${k}`);
});

test('RabbitMQ: a peek is refused where putting a message back counts towards a delivery limit', () => {
  const q = (type: string, args: unknown[][] = [], policy: unknown[][] | Record<string, unknown> = []) => ({ name: 'q', type, arguments: args, effective_policy_definition: policy });
  assert.equal(requeueRisk(q('classic', [['x-delivery-limit', 'long', 2]])), undefined, 'a classic queue has no delivery limit');
  assert.equal(requeueRisk(q('quorum'), '3.13.7'), undefined, 'none before 4.0');
  assert.match(requeueRisk(q('quorum'), '4.1.4') ?? '', /delivery limit of 20: .* drops it/, '20 from 4.0');
  assert.match(requeueRisk(q('quorum')) ?? '', /delivery limit of 20/, 'an unknown version is taken as 4.0 or later');
  assert.equal(requeueRisk(q('quorum', [['x-delivery-limit', 'long', -1]]), '4.1.4'), undefined, '-1 is none');
  assert.match(requeueRisk(q('quorum', [['x-delivery-limit', 'long', 5]], { 'delivery-limit': 3, 'dead-letter-exchange': '' }), '3.13.7') ?? '', /limit of 3: .* dead-letters it to the default exchange/, 'the lower of the argument and the policy');
});

for (const image of ['mongo:7', 'mongo:4.4']) test(`MongoDB (${image}): databases, collections, a page and one document, masked, as a reader that cannot write; input stays data`, { skip: heavy, timeout: 300_000 }, async (t) => {
  const g = guard(KEY);
  const id = docker('run', '-d', '--label', `keelson.workspace=${KEY}`, '-e', 'MONGO_INITDB_ROOT_USERNAME=admin', '-e', 'MONGO_INITDB_ROOT_PASSWORD=pw-test-123', image);
  t.after(() => { docker('rm', '-f', '-v', id); g.check(); });
  const version = docker('inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', id).split('\n').find((e) => e.startsWith('MONGO_VERSION='))?.slice(14);
  const s: MongoStore = { service: 'mongo', container: id, image, user: 'admin', version };
  const shell = connection(s).shell.split(' ')[4];
  assert.ok(docker('exec', id, 'sh', '-c', 'command -v "$1"', 'sh', shell), `the connection line's ${shell} is in the image`);
  // The entrypoint creates the root user on a first server, then restarts it with access control.
  await until(() => { if (!execFileSync('docker', ['logs', id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).includes('init process complete')) throw new Error('initialising'); });
  await until(() => run(s, `const d = db.getSiblingDB('app'); d.users.drop();
d.users.insertMany([{ _id: ObjectId('5f0c3c3c3c3c3c3c3c3c3c3c'), name: 'ana', age: 20, password: 'hunter2-long', note: 'key ${SECRET}' }, { _id: 'bea', name: 'bea', age: 30 }, { _id: 42, name: 'carl', age: 40 }]);
d.users.createIndex({ name: 1 }, { unique: true }); d.createView('adults', 'users', [{ $match: { age: { $gte: 30 } } }]); put(1);`, {}, 'root'));
  const count = async () => (await find(s, { db: 'app', collection: 'users', limit: 500 }, m)).docs.length;

  assert.deepEqual((await dbs(s)).map((d) => d.name), ['admin', 'app'], 'the first read creates ks_reader; config and local are not the reader\'s to read');
  const users = { name: 'users', type: 'collection', count: 3, indexes: [{ name: '_id_', key: { _id: 1 } }, { name: 'name_1', key: { name: 1 }, unique: true }] };
  assert.deepEqual(await collections(s, 'app'), [{ name: 'adults', type: 'view', count: null, indexes: [] }, { name: 'system.views', type: 'collection', count: null, indexes: [] }, users], 'a system collection the reader may not count reads without a count');
  assert.ok((await collections(s, 'admin')).some((c) => c.name === 'system.version'), 'admin too');
  const ana0 = (await find(s, { db: 'app', collection: 'users', filter: '{"name": "ana"}' }, m)).docs[0] as Record<string, unknown>;
  assert.match(String(ana0.password), /^…[\w-]{4}$/, 'a page is masked as one document is');
  assert.equal(ana0.note, `key ${m.text(SECRET)}`);
  for (const q of [{ projection: '{"x": {"$toInt": "$note"}}' }, { filter: '{"$where": "throw new Error(this.note)"}' }]) {
    await assert.rejects(find(s, { db: 'app', collection: 'users', ...q }, m), (e: Error) => !e.message.includes(SECRET) && e.message.includes(m.text(SECRET)), 'an error that quotes a document is masked');
  }
  const page = await find(s, { db: 'app', collection: 'users', filter: '{"age": {"$gte": 20}}', sort: '{"age": -1}', projection: '{"name": 1}', limit: 1, skip: 1 }, m);
  assert.deepEqual([page.docs, page.more], [[{ _id: 'bea', name: 'bea' }], true]);
  const ana = await getDoc(s, 'app', 'users', '5f0c3c3c3c3c3c3c3c3c3c3c', m) as Record<string, unknown>;
  assert.deepEqual(ana._id, { $oid: '5f0c3c3c3c3c3c3c3c3c3c3c' });
  assert.match(String(ana.password), /^…[\w-]{4}$/, 'a secret-looking field is masked');
  assert.equal(ana.note, `key ${m.text(SECRET)}`, 'a known value shows its mark');
  assert.deepEqual(await getDoc(s, 'app', 'users', '42', m), { _id: 42, name: 'carl', age: 40 });
  assert.deepEqual(await getDoc(s, 'app', 'users', 'bea', m), { _id: 'bea', name: 'bea', age: 30 });
  assert.equal(await getDoc(s, 'app', 'users', 'nobody', m), null);
  // _ids of different types that read alike: the bare form is the number or the ObjectId, the quoted one the string.
  await run(s, `db.getSiblingDB('app').mixed.insertMany([{ _id: '5', t: 's5' }, { _id: 5, t: 'n5' }, { _id: '5f0c3c3c3c3c3c3c3c3c3c3c', t: 'shex' }, { _id: ObjectId('5f0c3c3c3c3c3c3c3c3c3c3c'), t: 'oid' }]); put(1);`, {}, 'root');
  const which = async (id: string) => ((await getDoc(s, 'app', 'mixed', id, m)) as { t: string }).t;
  assert.deepEqual([await which('5'), await which('"5"'), await which('5f0c3c3c3c3c3c3c3c3c3c3c'), await which('"5f0c3c3c3c3c3c3c3c3c3c3c"'), await which('{"$oid":"5f0c3c3c3c3c3c3c3c3c3c3c"}')], ['n5', 's5', 'oid', 'shex', 'oid']);
  // BinData travels as base64: its bytes are masked as a peek's whatever the value's alignment; a UUID with nothing to hide stays as it is.
  const b64 = (...pre: number[]) => Buffer.concat([Buffer.from(pre), Buffer.from(SECRET)]).toString('base64');
  await run(s, `db.getSiblingDB('app').bins.insertOne({ _id: 1, a: BinData(0, '${b64(7)}'), b: BinData(0, '${b64(0, 1)}'), u: UUID('0123456789abcdef0123456789abcdef') }); put(1);`, {}, 'root');
  const bin = (await find(s, { db: 'app', collection: 'bins' }, m)).docs[0] as Record<string, any>;
  assert.deepEqual([bin.a, bin.b], [{ $binary: { peek: `.${m.text(SECRET)}`, subType: '00' } }, { $binary: { peek: `..${m.text(SECRET)}`, subType: '00' } }]);
  assert.match(JSON.stringify(bin.u), /"ASNFZ4mrze8BI0VniavN7w=="/);
  assert.deepEqual(await getDoc(s, 'app', 'bins', '1', m), bin, 'one document as a page');
  // The back end says which _ids it masked (a known value, a secret-looking field), however a real one looks; an empty _id is asked for quoted.
  await run(s, `db.getSiblingDB('app').ids.insertMany([{ _id: 'key ${SECRET}', n: 1 }, { _id: 'x…abcd', n: 2 }, { _id: '', n: 3 }, { _id: { token: 'abc' }, n: 4 }, { _id: 'plain', n: 5 }]); put(1);`, {}, 'root');
  const byId = await find(s, { db: 'app', collection: 'ids', sort: '{"n": 1}' }, m);
  assert.deepEqual(byId.maskedIds, [0, 3]);
  assert.deepEqual(await getDoc(s, 'app', 'ids', '""', m), { _id: '', n: 3 });
  assert.deepEqual(await getDoc(s, 'app', 'ids', 'x…abcd', m), { _id: 'x…abcd', n: 2 });
  // The legacy shell takes no raw line or paragraph separator in a string literal: the arguments carry them escaped.
  assert.deepEqual((await find(s, { db: 'app', collection: 'users', filter: '{"name": "a\u2028b\u2029"}' }, m)).docs, []);

  await assert.rejects(find(s, { db: 'app', collection: 'users', filter: '{"a":1}); db.getSiblingDB("app").dropDatabase(); ({"' }, m), /JSON/, 'a filter is parsed, never run');
  assert.deepEqual((await find(s, { db: 'app', collection: 'users"); db.getSiblingDB("app").dropDatabase(); ("' }, m)).docs, [], 'a name is a name');
  assert.equal(await count(), 3, 'nothing was dropped');
  await assert.rejects(run(s, 'db.getSiblingDB("app").users.insertOne({ x: 1 }); put(1);'), /not authorized/, 'the reader cannot write');
  await assert.rejects(run(s, 'const r = db.getSiblingDB("app").dropDatabase(); if (!r.ok) throw new Error(r.errmsg); put(1);'), /not authorized/, 'the legacy shell answers ok: 0 where mongosh throws');
  assert.equal(await count(), 3);
});

test('Kafka: a broker without topics has none, an empty list rather than its tool\'s error', { skip: heavy, timeout: 180_000 }, async (t) => {
  const g = guard(KEY);
  // A single KRaft node; once one KAFKA_ variable is set, the image wants them all.
  const conf = { NODE_ID: '1', PROCESS_ROLES: 'broker,controller', LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093', ADVERTISED_LISTENERS: 'PLAINTEXT://localhost:9092', CONTROLLER_LISTENER_NAMES: 'CONTROLLER', CONTROLLER_QUORUM_VOTERS: '1@localhost:9093', OFFSETS_TOPIC_REPLICATION_FACTOR: '1', HEAP_OPTS: '-Xmx256m' };
  const id = docker('run', '-d', '--label', `keelson.workspace=${KEY}`, ...Object.entries(conf).flatMap(([k, v]) => ['-e', `KAFKA_${k}=${v}`]), 'apache/kafka:3.7.0');
  t.after(() => { docker('rm', '-f', '-v', id); g.check(); });
  const b: Broker = { service: 'kafka', container: id, image: 'apache/kafka:3.7.0' };
  // Until it starts, its tool cannot reach it, and that is an error.
  await until(async () => assert.deepEqual(await topics(b), []), 120);
  docker('exec', '-e', 'KAFKA_HEAP_OPTS=-Xmx96m', id, '/opt/kafka/bin/kafka-topics.sh', '--bootstrap-server', 'localhost:9092', '--create', '--topic', 'orders');
  assert.deepEqual(await topics(b), [{ name: 'orders', partitions: [{ partition: 0, end: 0 }], messages: 0 }]);
});

const DYNAMO_APP = {
  'docker-compose.yml': `services:
  dynamodb:
    image: amazon/dynamodb-local:latest
    ports: ["8000:8000"]
  orders:
    build: ./orders
    ports: ["3000:3000"]
    environment:
      DYNAMO_URL: http://dynamodb:8000
      AWS_SECRET_ACCESS_KEY: \${AWS_SECRET_ACCESS_KEY}
    depends_on: [dynamodb]
`,
  'orders/Dockerfile': 'FROM node:22-alpine\nCOPY server.js /srv/server.js\nEXPOSE 3000\nCMD ["node", "/srv/server.js"]\n',
  // An AWS-style call without the SDK: X-Amz-Target, a JSON body and a SigV4-shaped Authorization.
  'orders/server.js': `const { createHmac } = require('crypto');
const call = async (op, body) => {
  const sig = createHmac('sha256', process.env.AWS_SECRET_ACCESS_KEY).update(op).digest('hex');
  const r = await fetch(process.env.DYNAMO_URL + '/', { method: 'POST', body: JSON.stringify(body), headers: {
    'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.' + op, 'x-amz-date': '20261022T000000Z',
    authorization: 'AWS4-HMAC-SHA256 Credential=AKIDLARUTEST/20261022/us-east-1/dynamodb/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=' + sig } });
  return { status: r.status, body: await r.json() };
};
require('http').createServer(async (req, res) => {
  if (req.url !== '/run') return res.end('ok');
  await call('CreateTable', { TableName: 'users', AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], BillingMode: 'PAY_PER_REQUEST' });
  await call('PutItem', { TableName: 'users', Item: { id: { S: 'u1' }, name: { S: 'Ana' } } });
  const got = await call('GetItem', { TableName: 'users', Key: { id: { S: 'u1' } } });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(got));
}).listen(3000);
`,
};

test('DynamoDB Local behind the tap: every call is in the journal and reads «PutItem users» in the trace', { skip: heavy, timeout: 15 * 60_000 }, async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-dynamo-')));
  process.env.LARU_HOME = join(tmp, 'home');
  process.env.LARU_VAULT_KEYSTORE = 'file';
  mkdirSync(process.env.LARU_HOME, { recursive: true });
  writeFileSync(join(process.env.LARU_HOME, 'config.yaml'), 'maxEnvs: 9\n');
  const work = join(tmp, 'seed', 'shopdyn');
  for (const [p, c] of Object.entries(DYNAMO_APP)) { mkdirSync(dirname(join(work, p)), { recursive: true }); writeFileSync(join(work, p), c); }
  const git = (...a: string[]) => execFileSync('git', a, { cwd: work, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '--quiet', '-b', 'main'); git('add', '-A'); git('commit', '--quiet', '-m', 'first');
  git('clone', '--quiet', '--bare', work, join(tmp, 'remotes', 'shopdyn.git'));
  const ws = initWorkspace(join(tmp, 'ws'), { app: 'shopdyn', title: 'Shop' });
  await addRepo(ws, `file://${join(tmp, 'remotes', 'shopdyn.git')}`);
  mkdirSync(join(ws.root, 'envs'));
  writeFileSync(join(ws.root, 'envs', 'local.yaml'), 'from: shopdyn:docker-compose.yml\n');
  await setVar(ws, { key: 'AWS_SECRET_ACCESS_KEY', value: SECRET, level: 'app', secret: true });
  const g = guard(workspaceKey(ws));
  t.after(async () => { await down(ws, 'local'); g.check(); });

  const r = await up(ws, { env: 'local' });
  assert.equal(r.services.find((x) => x.service === 'dynamodb')?.compose, 'dynamodb-real', 'the tap holds the name dynamodb');
  const port = JSON.parse(readFileSync(join(envDir(ws, 'local'), 'state.json'), 'utf8')).ports.orders['3000'];
  const t0 = Date.now();
  const res = await (await fetch(`http://127.0.0.1:${port}/run`)).json() as { status: number; body: unknown };
  assert.deepEqual([res.status, res.body], [200, { Item: { id: { S: 'u1' }, name: { S: 'Ana' } } }], 'the call went through the tap and back');
  await new Promise((ok) => setTimeout(ok, 1500));

  const tap = join(envDir(ws, 'local'), 'tap');
  const journal = readFileSync(join(tap, 'traffic.jsonl'), 'utf8');
  const sigs = ['CreateTable', 'PutItem', 'GetItem'].map((op) => createHmac('sha256', SECRET).update(op).digest('hex'));
  assert.ok(![SECRET, ...sigs].some((x) => journal.includes(x)), 'no signature and no secret in the journal');
  const traffic = journal.split('\n').filter(Boolean).map((l) => JSON.parse(l) as TrafficRecord).filter((x) => x.t0 >= t0 - 1000);
  const t1 = Math.max(...traffic.map((x) => x.t1 ?? x.t0));
  const events: RunnerEvent[] = [{ e: 'test-begin', t: t0, test: 'a', title: 'pedido', file: 'x.spec.ts', story: true }, { e: 'test-end', t: t1, test: 'a', status: 'passed', durationMs: t1 - t0 }];
  const { peers } = JSON.parse(readFileSync(join(tap, 'rules.json'), 'utf8'));
  const [trace] = assemble({ run: '1', flow: 'pedido', env: 'local', events, traffic, peers }).traces;
  const calls = trace.exchanges.filter((e) => e.to === 'dynamodb');
  assert.deepEqual(calls.map((e) => [e.from, e.label, e.table]), [['orders', 'CreateTable users', 'users'], ['orders', 'PutItem users', 'users'], ['orders', 'GetItem users', 'users']]);
  assert.match(calls[1].reqHeaders?.authorization ?? '', /^AWS4-HMAC-SHA256 …[\w-]{4}$/, 'SigV4 stays masked');
  assert.match(calls[2].res?.text ?? '', /"Ana"/, 'bodies are kept, masked as any JSON');
});
