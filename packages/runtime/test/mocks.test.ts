import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { createMasker } from '../../trace/src/mask.ts';
import { loadMock, type MockRequest } from '../tap/mocks.ts';
import { mockOperations } from '../src/rules.ts';

const openapi = parse(readFileSync(join(import.meta.dirname, 'fixtures', 'partner', 'openapi.yaml'), 'utf8'));
const req = (method: string, path: string, body?: unknown, query = ''): MockRequest => ({ method, path, query, headers: { 'content-type': 'application/json' }, body: Buffer.from(body === undefined ? '' : JSON.stringify(body)) });

test('contract: the example answers with no code written; strays are drift', async () => {
  const m = await loadMock('partner', { mode: 'contract' }, mkdtempSync(join(tmpdir(), 'mock-')), { openapi });
  const ok = await m.http(req('POST', '/v1/refunds', { payment_intent: 'pi_1', amount: 1290 }));
  assert.deepEqual([ok?.status, JSON.parse(ok!.body.toString()), ok?.drift], [201, { id: 're_123', status: 'pending' }, []]);
  const bad = await m.http(req('POST', '/v1/refunds', { amount: 'x', extra: 1 }));
  assert.deepEqual(bad?.drift, ['body.payment_intent is required', 'body.amount should be integer, is string', 'body.extra is not allowed']);
  const gen = await m.http(req('GET', '/v1/refunds/re_9', undefined));
  assert.deepEqual(JSON.parse(gen!.body.toString()), { id: 're_123', amount: 100, status: 'pending' }, 'a value generated from the schema');
  assert.deepEqual(gen?.drift, ['query.expand is required']);
  const none = await m.http(req('GET', '/x/y'));
  assert.deepEqual([none?.status, none?.drift], [404, ['undeclared operation GET /x/y']]);
  const strict = await loadMock('partner', { mode: 'contract', strict: true }, mkdtempSync(join(tmpdir(), 'mock-')), { openapi });
  assert.equal((await strict.http(req('POST', '/v1/refunds', {})))?.status, 400);
});

test('record, then simulate: unrecorded requests get 501 and say so; spy forwards them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mock-'));
  const rec = await loadMock('partner', { mode: 'record' }, dir, { masker: () => createMasker(['sk_live_secret1']) });
  assert.equal(await rec.http(req('GET', '/v1/balance')), null, 'record forwards');
  // The real answer's own tokens are unknown values: masked by JSON key and header name, as in traffic.jsonl.
  rec.recorded(req('GET', '/v1/balance', undefined, 'k=sk_live_secret1&client_secret=cs-unknown-1'), {
    status: 200, headers: { 'content-type': 'application/json', date: 'x', 'x-api-key': 'resp-header-key-778899' },
    body: Buffer.from('{"available":5,"access_token":"ya29.unknown-access","refresh_token":"1//unknown-refresh"}'),
  });
  const saved = readdirSync(join(dir, 'recordings'));
  assert.equal(saved.length, 1);
  const file = readFileSync(join(dir, 'recordings', saved[0]), 'utf8');
  for (const s of ['sk_live_secret1', 'cs-unknown-1', 'resp-header-key-778899', 'ya29.unknown-access', '1//unknown-refresh']) assert.ok(!file.includes(s), `recordings are masked: ${s}`);
  const sim = await loadMock('partner', { mode: 'simulate' }, dir);
  const hit = await sim.http(req('GET', '/v1/balance'));
  assert.deepEqual([hit?.status, JSON.parse(hit!.body.toString()).available, hit?.mock], [200, 5, 'hit']);
  const miss = await sim.http(req('GET', '/v1/other'));
  assert.deepEqual([miss?.status, miss?.headers['x-laru-mock'], miss?.mock], [501, 'unmatched', 'miss']);
  const spy = await loadMock('partner', { mode: 'spy' }, dir);
  assert.equal((await spy.http(req('GET', '/v1/balance')))?.mock, 'hit');
  assert.equal(await spy.http(req('GET', '/v1/other')), null, 'spy forwards what it does not know');
});

test('record keeps a known value out of the path and the file name, and masks a body of any textual type; replay matches in another env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mock-'));
  const token = '123456789:AAHk-known-bot-token_xyz';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJlLXZhbHVl';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
  const rec = await loadMock('tg', { mode: 'record' }, dir, { masker: () => createMasker([token], 'key-of-env-a') });
  rec.recorded(req('GET', `/hooks/${token}/send`), { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') });
  rec.recorded(req('GET', '/jwt/userinfo'), { status: 200, headers: { 'content-type': 'application/jwt' }, body: Buffer.from(jwt) });
  rec.recorded(req('GET', '/logo.png'), { status: 200, headers: { 'content-type': 'image/png' }, body: png });
  const saved = readdirSync(join(dir, 'recordings'));
  assert.ok(!saved.some((f) => f.includes('known_bot_token')), saved.join());
  const files = saved.map((f) => readFileSync(join(dir, 'recordings', f), 'utf8')).join('\n');
  for (const s of [token, jwt, Buffer.from(jwt).toString('base64').slice(0, 24)]) assert.ok(!files.includes(s), s);
  // Another env's key marks the token differently: the recording still answers its path, and a binary body replays as it was.
  const sim = await loadMock('tg', { mode: 'simulate' }, dir, { masker: () => createMasker([token], 'key-of-env-b') });
  assert.deepEqual(JSON.parse((await sim.http(req('GET', `/hooks/${token}/send`)))!.body.toString()), { ok: true });
  assert.deepEqual((await sim.http(req('GET', '/logo.png')))!.body, png);
});

const clamd = join(process.env.HOME ?? '', 'laru', 'vaultflow', 'mocks', 'clamav');
test('script: vaultflow\'s clamd answers OK, and FOUND for EICAR', { skip: !existsSync(clamd) && 'no vaultflow workspace on this machine' }, async () => {
  const dir = clamd;
  const state: Record<string, unknown> = {};
  const m = await loadMock('clamav', { mode: 'script' }, dir, { state });
  const server = createServer((s) => m.tcp!(s)).listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  const scan = (data: Buffer) => new Promise<string>((ok) => {
    const c = connect(port, '127.0.0.1', () => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      c.end(Buffer.concat([Buffer.from('zINSTREAM\0'), len, data, Buffer.alloc(4)]));
    });
    let out = ''; c.on('data', (d) => (out += d)); c.on('end', () => ok(out));
  });
  assert.equal(await scan(Buffer.from('%PDF-1.4 hello')), 'stream: OK\0');
  assert.equal(await scan(Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')), 'stream: Eicar-Test-Signature FOUND\0');
  assert.equal(state.scans, 2, 'state lives across connections');
  server.close();
});

test('mockOperations: what an external is mocked from, with the examples the mock would answer', () => {
  assert.deepEqual(mockOperations(openapi), [
    { method: 'POST', path: '/v1/refunds', summary: undefined, request: '{"payment_intent":"string","amount":1,"reason":"duplicate"}', responses: [{ status: '201', description: undefined, example: '{"id":"re_123","status":"pending"}' }, { status: '409', description: 'already refunded', example: undefined }] },
    { method: 'GET', path: '/v1/refunds/{id}', summary: undefined, request: undefined, responses: [{ status: '200', description: undefined, example: '{"id":"re_123","amount":100,"status":"pending"}' }] },
  ]);
});
