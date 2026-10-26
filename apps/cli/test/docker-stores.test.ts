/**
 * The NoSQL stores and brokers of an env through the CLI, the daemon and the MCP server: which broker a queue
 * command means, the Redis, RabbitMQ and MongoDB routes and commands, every value masked, errors too. Heavy:
 * LARU_E2E=1 with Docker running. The containers carry a temp workspace's labels and are removed after.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { idOf, loadWorkspace, register } from '@laru/core';
import { envDir, envMasker, mongo, workspaceKey } from '@laru/runtime';
import { writeMaskFile } from '@laru/trace';
import { dockerUp, guard } from '../../../packages/runtime/test/guard.ts';
import { run } from '../src/cli.ts';
import { startDaemon } from '../src/daemon.ts';
import { brokersOf, pickBroker } from '../src/env-cli.ts';
import { createServer } from '../src/mcp.ts';

const heavy = !dockerUp ? 'Docker is not running' : process.env.LARU_E2E !== '1' ? 'set LARU_E2E=1' : false;
const docker = (...a: string[]) => execFileSync('docker', a, { encoding: 'utf8' }).trim();
const SECRET = 'tok-Secret-4242xy';
const until = async (probe: () => unknown, s = 120) => { for (let i = 0; i < s; i++) { try { await probe(); return; } catch { await new Promise((r) => setTimeout(r, 1000)); } } throw new Error('not ready'); };
const capture = () => {
  const out: string[] = [], err: string[] = [];
  return { io: { log: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err, all: () => [...out, ...err].join('\n') };
};

test('NoSQL stores and brokers from the CLI, the daemon and MCP: the broker meant, values and errors masked', { skip: heavy, timeout: 300_000 }, async (t) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'laru-stores-')));
  // init, the CLI and the daemon register the workspace: in a home of the test's own, never the user's workspaces.yaml
  Object.assign(process.env, { LARU_HOME: join(tmp, 'home'), LARU_VAULT_KEYSTORE: 'file' });
  const root = join(tmp, 'ws');
  await run(['init', root, '--app', 'stores'], capture().io);
  mkdirSync(join(root, 'envs'));
  writeFileSync(join(root, 'envs', 'local.yaml'), 'from: stores:docker-compose.yml\n');
  const w = loadWorkspace(root);
  mkdirSync(join(envDir(w, 'local'), 'tap'), { recursive: true });
  writeMaskFile(join(envDir(w, 'local'), 'tap', 'mask.json'), [SECRET]);
  const m = envMasker(w, 'local'), mark = m.text(SECRET);

  const g = guard(workspaceKey(w));
  const ids: string[] = [];
  let d: Awaited<ReturnType<typeof startDaemon>> | undefined, client: Client | undefined;
  // One hook, the guard last: a guard that fails must not leave the daemon listening.
  t.after(async () => { await client?.close(); await d?.close(); if (ids.length) docker('rm', '-f', '-v', ...ids); g.check(); });
  const start = (service: string, ...a: string[]) => { const id = docker('run', '-d', '--label', `keelson.workspace=${workspaceKey(w)}`, '--label', 'keelson.env=local', '--label', `keelson.service=${service}`, ...a); ids.push(id); return id; };
  const cache = start('cache', '-e', 'REDIS_PASSWORD=pw-test-123', 'redis:7-alpine', 'sh', '-c', 'exec redis-server --requirepass "$REDIS_PASSWORD"');
  // A second Redis, without a password, as a dev setup usually has.
  const sessions = start('sessions', 'redis:7-alpine');
  const mq = start('mq', '-e', 'RABBITMQ_DEFAULT_USER=ks', '-e', 'RABBITMQ_DEFAULT_PASS=pw-test-123', '-p', '127.0.0.1::15672', 'rabbitmq:3-management');
  const db = start('mongo', '-e', 'MONGO_INITDB_ROOT_USERNAME=admin', '-e', 'MONGO_INITDB_ROOT_PASSWORD=pw-test-123', 'mongo:7');
  // A root user from Docker secrets, and a Mongo with no access control at all.
  const secrets = realpathSync(mkdtempSync(join(tmpdir(), 'laru-secrets-')));
  writeFileSync(join(secrets, 'user'), 'fileadmin\n');
  writeFileSync(join(secrets, 'pass'), 'pw-test-456\n');
  const dbFile = start('mongofile', '-v', `${secrets}:/run/secrets:ro`, '-e', 'MONGO_INITDB_ROOT_USERNAME_FILE=/run/secrets/user', '-e', 'MONGO_INITDB_ROOT_PASSWORD_FILE=/run/secrets/pass', 'mongo:7');
  start('mongoopen', 'mongo:7');
  // Brokers are found by image: a Kafka image that only sleeps is enough to be the env's Kafka.
  const kafka = start('kafka', '--entrypoint', 'sleep', 'apache/kafka:3.7.0', '600');
  const port = Number(docker('port', mq, '15672/tcp').split('\n')[0].split(':').pop());
  writeFileSync(join(envDir(w, 'local'), 'state.json'), JSON.stringify({ ports: { mq: { 15672: port } } }));

  const rc = (...a: string[]) => docker('exec', cache, 'sh', '-c', 'REDISCLI_AUTH=$REDIS_PASSWORD exec redis-cli "$@"', 'redis-cli', ...a);
  const api = `http://127.0.0.1:${port}`, auth = { 'content-type': 'application/json', authorization: `Basic ${Buffer.from('ks:pw-test-123').toString('base64')}` };
  await until(() => rc('PING'));
  await until(() => docker('exec', sessions, 'redis-cli', 'PING'));
  docker('exec', sessions, 'redis-cli', 'SET', 'sid:1', 'x');
  await until(async () => { if (!(await fetch(`${api}/api/overview`, { headers: auth })).ok) throw new Error('starting'); });
  for (const c of [db, dbFile]) await until(() => { if (!execFileSync('docker', ['logs', c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).includes('init process complete')) throw new Error('initialising'); });
  rc('HSET', 'user:3', 'a', 'x\ny', 'password', 'hunter2-long', 'z', 'q');
  rc('SET', `tok:${SECRET}`, `{"note":"key ${SECRET}"}`);
  rc('SET', 'gone', '1');
  await fetch(`${api}/api/queues/%2F/orders`, { method: 'PUT', headers: auth, body: '{"durable":true}' });
  const store = await mongo.mongoOf(w, 'local');
  await until(() => mongo.run(store, `db.getSiblingDB('app').users.drop(); db.getSiblingDB('app').users.insertMany([{ _id: 'ana', name: 'ana', password: 'hunter2-long', note: 'key ${SECRET}' }, { _id: 'bea', name: 'bea' }]); put(1);`, {}, 'root'));

  // Which broker: Kafka when the env has both, the one named, an error for one it does not have.
  assert.deepEqual(await brokersOf(w, 'local'), [{ kind: 'kafka', service: 'kafka' }, { kind: 'rabbitmq', service: 'mq' }]);
  assert.equal(await pickBroker(w, 'local'), 'kafka');
  assert.equal(await pickBroker(w, 'local', 'rabbitmq'), 'rabbitmq');
  await assert.rejects(pickBroker(w, 'local', 'nats'), /kafka or rabbitmq/);
  const named = capture();
  assert.equal(await run(['queue', '--broker', 'rabbitmq'], named.io, root), 0, '--broker picks RabbitMQ next to a Kafka');
  assert.match(named.out.join('\n'), /^orders\s+0 messages, 0 consumers$/m);

  // The daemon's routes.
  await register(root);
  d = await startDaemon(0);
  const base = new URL(d.url).origin;
  const cookie = String((await fetch(d.url, { redirect: 'manual' })).headers.get('set-cookie')).split(';')[0];
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path.replace(/^\/api\//, `/api/w/${idOf(root)}/`)}`, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() as any };
  };
  assert.deepEqual((await call('GET', '/api/brokers?env=local')).json, [{ kind: 'kafka', service: 'kafka' }, { kind: 'rabbitmq', service: 'mq' }]);
  assert.deepEqual((await call('POST', '/api/rabbit/publish', { env: 'local', routingKey: 'orders', payload: `{"id":7,"note":"${SECRET}"}` })).json, { routed: true });
  await until(async () => { if ((await call('GET', '/api/rabbit/queues?env=local')).json.queues.find((q: { name: string }) => q.name === 'orders')?.messages !== 1) throw new Error('not yet'); }, 20);
  const got = (await call('POST', '/api/rabbit/get', { env: 'local', queue: 'orders' })).json;
  assert.deepEqual([got.length, JSON.parse(got[0].payload)], [1, { id: 7, note: mark }]);
  // A routing key holding a known value, through a topic exchange.
  await fetch(`${api}/api/bindings/%2F/e/amq.topic/q/orders`, { method: 'POST', headers: auth, body: '{"routing_key":"orders.#"}' });
  await fetch(`${api}/api/bindings/%2F/e/amq.topic/q/orders`, { method: 'POST', headers: auth, body: JSON.stringify({ routing_key: `tenant.${SECRET}` }) });
  const bound = (await call('GET', '/api/rabbit/queues?env=local')).json.bindings;
  assert.ok(bound.some((b: { routing_key: string }) => b.routing_key === `tenant.${mark}`) && !JSON.stringify(bound).includes(SECRET), 'a binding key holding a known value shows its mark');
  assert.deepEqual((await call('POST', '/api/rabbit/route', { env: 'local', exchange: 'amq.topic', routingKey: `tenant.${SECRET}` })).json, { route: { type: 'topic', queues: [{ queue: 'orders', key: `tenant.${mark}` }] } });
  assert.deepEqual((await call('POST', '/api/rabbit/route', { env: 'local', exchange: 'amq.topic', routingKey: 'user.created' })).json, { route: { type: 'topic', queues: [] } });
  assert.deepEqual((await call('POST', '/api/rabbit/route', { env: 'local', exchange: 'nope', routingKey: 'x' })).json, { route: null });
  assert.equal((await call('POST', '/api/rabbit/publish', { env: 'local', exchange: 'nope', routingKey: 'x', payload: '{}' })).json.error, 'no exchange nope');
  assert.deepEqual((await call('POST', '/api/rabbit/publish', { env: 'local', exchange: 'amq.topic', routingKey: `orders.${SECRET}`, payload: '{"id":8}' })).json, { routed: true });
  await until(async () => { if ((await call('GET', '/api/rabbit/queues?env=local')).json.queues.find((q: { name: string }) => q.name === 'orders')?.messages !== 2) throw new Error('not yet'); }, 20);
  assert.deepEqual((await call('POST', '/api/rabbit/get', { env: 'local', queue: 'orders' })).json.map((x: { exchange: string; routing_key: string; redelivered: boolean }) => [x.exchange, x.routing_key, x.redelivered]),
    [['', 'orders', true], ['amq.topic', `orders.${mark}`, false]], 'a peek marks a message redelivered');
  assert.deepEqual((await call('GET', '/api/redis/keys?env=local&pattern=user:*')).json, { service: 'cache', keys: [{ key: 'user:3', type: 'hash', ttl: -1 }] }, 'each key with its type and TTL');
  assert.deepEqual((await call('GET', '/api/redis/stores?env=local')).json.map((x: { service: string; conn: { shell: string; url?: string } }) => [x.service, x.conn.shell.includes('pw-test-123'), x.conn.url]), [['cache', false, undefined], ['sessions', false, undefined]], 'every Redis of the env; the shell logs in with the container\'s own password');
  assert.deepEqual((await call('GET', '/api/redis/keys?env=local&service=sessions')).json, { service: 'sessions', keys: [{ key: 'sid:1', type: 'string', ttl: -1 }] }, 'each Redis by its service; one without a password reads with no AUTH');
  assert.deepEqual((await call('GET', '/api/redis/key?env=local&service=sessions&key=sid:1')).json.value, 'x');
  assert.deepEqual((await call('POST', '/api/redis/del', { env: 'local', service: 'sessions', key: 'sid:1' })).json, { ok: true });
  assert.equal((await call('GET', '/api/redis/keys?env=local&service=nope')).json.error, 'nope is not a running Redis of local');
  const key = (await call('GET', '/api/redis/key?env=local&key=user:3')).json;
  assert.deepEqual([key.type, key.value.a, key.value.z], ['hash', 'x\ny', 'q']);
  assert.match(key.value.password, /^…[\w-]{4}$/);
  assert.deepEqual((await call('GET', '/api/redis/keys?env=local&pattern=tok:*')).json.keys, [{ key: `tok:${mark}`, type: 'string', ttl: -1, masked: true }], 'a key holding a known value, flagged as masked');
  assert.deepEqual((await call('GET', `/api/redis/key?env=local&key=${encodeURIComponent(`tok:${SECRET}`)}`)).json, { key: `tok:${mark}`, type: 'string', ttl: -1, value: `{"note":"key ${mark}"}` });
  assert.deepEqual((await call('POST', '/api/redis/del', { env: 'local', key: 'gone' })).json, { ok: true });
  assert.equal(rc('EXISTS', 'gone'), '0', 'a delete is its own route');
  const [stored, fromFile, open] = (await call('GET', '/api/mongo/stores?env=local')).json;
  assert.deepEqual([stored.service, stored.user, stored.conn.user], ['mongo', 'admin', 'admin']);
  assert.deepEqual([fromFile.service, fromFile.user, fromFile.conn.shell.endsWith(' mongosh -u fileadmin --authenticationDatabase admin'), open.service, open.user], ['mongofile', 'fileadmin', true, 'mongoopen', undefined], 'a root user read from its _FILE');
  assert.match(stored.conn.shell, / mongosh -u admin /);
  assert.deepEqual((await call('GET', '/api/mongo/dbs?env=local')).json.map((x: { name: string }) => x.name), ['admin', 'app']);
  assert.deepEqual((await call('GET', '/api/mongo/collections?env=local&db=app')).json.map((c: { name: string; count: number }) => [c.name, c.count]), [['users', 2]]);
  const page = (await call('POST', '/api/mongo/find', { env: 'local', db: 'app', collection: 'users', sort: '{"_id": 1}' })).json;
  assert.deepEqual([page.docs.length, page.docs[0].note, page.more], [2, `key ${mark}`, false]);
  assert.match(page.docs[0].password, /^…[\w-]{4}$/);
  assert.deepEqual((await call('GET', '/api/mongo/doc?env=local&db=app&collection=users&id=bea')).json, { doc: { _id: 'bea', name: 'bea' } });
  const failed = await call('POST', '/api/mongo/find', { env: 'local', db: 'app', collection: 'users', projection: '{"x": {"$toInt": "$note"}}' });
  assert.equal(failed.status, 500);
  assert.ok(!failed.json.error.includes(SECRET) && failed.json.error.includes(mark), failed.json.error);

  // Without the Kafka, RabbitMQ is the env's broker; a Kafka asked for by name is an error.
  docker('rm', '-f', '-v', kafka);
  ids.splice(ids.indexOf(kafka), 1);
  assert.deepEqual(await brokersOf(w, 'local'), [{ kind: 'rabbitmq', service: 'mq' }]);
  assert.equal(await pickBroker(w, 'local'), 'rabbitmq');
  await assert.rejects(pickBroker(w, 'local', 'kafka'), /has no running Kafka/);

  // The CLI's commands.
  const cli = async (code: number, ...argv: string[]) => { const c = capture(); assert.equal(await run(argv, c.io, root), code, `${argv.join(' ')}: ${c.all()}`); assert.ok(!c.all().includes(SECRET) && !c.all().includes('hunter2-long'), c.all()); return c; };
  const peeked = (await cli(0, 'queue', 'peek', 'orders')).out.join('\n');
  assert.match(peeked, new RegExp(`^\\(default\\) orders redelivered .*"note":"${mark}"`));
  assert.match(peeked, new RegExp(`^amq\\.topic orders\\.${mark} redelivered \\{"id":8\\}$`, 'm'));
  // A peek that reorders a quorum queue is asked for by name.
  await fetch(`${api}/api/queues/%2F/qq`, { method: 'PUT', headers: auth, body: '{"durable":true,"arguments":{"x-queue-type":"quorum"}}' });
  assert.match((await cli(1, 'queue', 'peek', 'qq')).err.join('\n'), /^qq is a quorum queue: a peek puts what it reads back at the end of the queue/);
  assert.deepEqual((await cli(0, 'queue', 'peek', 'qq', '--reorder')).out, [], 'an empty quorum queue, read when its reordering is meant');
  assert.deepEqual((await cli(0, 'redis', 'keys')).out, [`tok:${mark}`, 'user:3']);
  docker('exec', sessions, 'redis-cli', 'SET', 'sid:2', 'y');
  assert.deepEqual((await cli(0, 'redis', 'keys', '--service', 'sessions')).out, ['sid:2']);
  assert.match((await cli(0, 'queue')).out.join('\n'), new RegExp(`^  ← amq\\.topic \\(tenant\\.${mark}\\)$`, 'm'), 'a binding key is masked');
  assert.match((await cli(0, 'redis', 'get', 'user:3')).out.join('\n'), /"a": "x\\ny"/);
  // An entry past 100 fields shows its first 100, and says so whatever the entry count.
  rc('EVAL', "local f = {} for i = 1, 150 do f[#f + 1] = 'f' .. i; f[#f + 1] = 'v' end redis.call('XADD', KEYS[1], '1-0', unpack(f))", '1', 'wide');
  assert.deepEqual((await cli(0, 'redis', 'get', 'wide')).err, ['stream, no expiry, 1 entries, entries past 100 fields show their first 100']);
  assert.deepEqual((await cli(0, 'redis', 'get', `tok:${SECRET}`)).out, [`{"note":"key ${mark}"}`]);
  assert.match((await cli(1, 'redis', 'del', 'gone')).out.join('\n'), /gone did not exist/);
  assert.match((await cli(0, 'mongo')).out.join('\n'), /^admin .*\napp /m);
  assert.match((await cli(0, 'mongo', 'collections', 'app')).out.join('\n'), /^users\s+2\s+_id:1$/);
  assert.equal(JSON.parse((await cli(0, 'mongo', 'find', 'app', 'users', '--filter', '{"name": "ana"}')).out[0]).note, `key ${mark}`);
  assert.deepEqual(JSON.parse((await cli(0, 'mongo', 'get', 'app', 'users', 'bea')).out.join('\n')), { _id: 'bea', name: 'bea' });
  assert.match((await cli(0, 'mongo', 'conn')).out.join('\n'), /shell docker exec -it \w+ mongosh -u admin/);
  assert.match((await cli(0, 'mongo', 'conn', '--service', 'mongofile')).out.join('\n'), /^user  fileadmin\nshell docker exec -it \w+ mongosh -u fileadmin /m);
  assert.match((await cli(0, 'db', 'list')).out.join('\n'), /^mongofile +mongo +fileadmin@admin .*\nmongoopen +mongo +\(no user\)@admin /m);
  assert.match((await cli(0, 'mongo', 'find', 'app', 'users', '--service', 'mongofile')).err.join('\n'), /^0 documents in \d+ ms, as ks_reader$/, 'the reader logs in with the password from its file');
  assert.match((await cli(0, 'mongo', 'find', 'app', 'users', '--service', 'mongoopen')).err.join('\n'), /^0 documents in \d+ ms, with no user: this Mongo has no access control$/);
  assert.match((await cli(1, 'mongo', 'find', 'app', 'users', '--projection', '{"x": {"$toInt": "$note"}}')).err.join('\n'), new RegExp(mark));

  // The MCP tools: an error is masked as the values are.
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(root).connect(a);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> };
    assert.ok(!r.content[0].text.includes(SECRET) && !r.content[0].text.includes('hunter2-long'), r.content[0].text);
    return { error: Boolean(r.isError), text: r.content[0].text };
  };
  const peekedByTool = (await tool('queue_peek', { topic: 'orders' })).text;
  assert.match(peekedByTool, new RegExp(`"note":"${mark}"`), 'the env\'s only broker');
  assert.match(peekedByTool, new RegExp(`^amq\\.topic orders\\.${mark} redelivered`, 'm'));
  assert.deepEqual([(await tool('queue_peek', { topic: 'qq' })).error, (await tool('queue_peek', { topic: 'qq', reorder: true })).text], [true, 'no messages'], 'MCP asks for the reordering too');
  assert.match((await tool('redis_get', { key: 'user:3' })).text, /"password": "…[\w-]{4}"/);
  assert.match((await tool('redis_keys', {})).text, new RegExp(`^tok:${mark}$`, 'm'));
  assert.equal((await tool('redis_keys', { service: 'sessions' })).text, 'sid:2');
  assert.match((await tool('queue_topics', {})).text, new RegExp(`bound to amq\\.topic \\(tenant\\.${mark}\\)`));
  assert.match((await tool('redis_get', { key: `tok:${SECRET}` })).text, new RegExp(`"key": "tok:${mark}",[^]*key ${mark}`));
  const err = await tool('mongo_find', { db: 'app', collection: 'users', projection: '{"x": {"$toInt": "$note"}}' });
  assert.deepEqual([err.error, err.text.includes(mark)], [true, true]);
});
