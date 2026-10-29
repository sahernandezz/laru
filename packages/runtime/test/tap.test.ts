import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as connectH2, createServer as createH2Server } from 'node:http2';
import { type AddressInfo, connect, createServer as createTcpServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMasker, readMaskFile, writeMaskFile } from '../../trace/src/mask.ts';
import type { TapConfig, TapRoute, TapRules, TrafficRecord } from '../src/types.ts';
import { openJournal, routeFor, startTap } from '../tap/tap.ts';

const SECRET = 'vault-Secret-42xy';
const MARK = '…' + createHash('sha256').update(SECRET).digest('base64url').slice(0, 4);
/** What a record keeps beyond each limit for SECRET's masker: a cut removes only that. */
const MARGIN = createMasker([SECRET]).margin;
const TAP = fileURLToPath(new URL('../tap/tap.ts', import.meta.url));
const NO_RULES: TapRules = { seed: 1, faults: {}, mocks: {}, peers: {} };

const listen = async <S extends Server>(srv: S) => {
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  return (srv.address() as AddressInfo).port;
};
async function freePorts(n: number) {
  const servers = Array.from({ length: n }, () => createTcpServer());
  const ports = await Promise.all(servers.map(listen));
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}
const route = (svc: string, port: number, upstreamPort: number, extra: Partial<TapRoute> = {}): TapRoute =>
  ({ svc, aliases: [svc], ports: [port], upstream: '127.0.0.1', portMap: { [port]: upstreamPort }, proto: 'http', ...extra });

interface Answer { status: number; headers: IncomingMessage['headers']; text: string; ms: number }
function call(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string; timeout?: number } = {}): Promise<Answer> {
  const t0 = Date.now();
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', headers: o.headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (c) => { text += c; }).on('end', () => ok({ status: res.statusCode!, headers: res.headers, text, ms: Date.now() - t0 }));
      res.on('error', fail);
    });
    req.on('error', fail);
    if (o.timeout) req.setTimeout(o.timeout, () => req.destroy(new Error('client timeout')));
    req.end(o.body);
  });
}
const json = (a: Answer) => JSON.parse(a.text);
/** A WebSocket upgrade with a chosen Host: the status, and the Host the upstream saw (it echoes it as x-host). */
const upgrade = (port: number, host: string) => new Promise<{ status: number; host?: string }>((ok, fail) => {
  const req = request({ host: '127.0.0.1', port, path: '/ws', agent: false, headers: { host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
  req.on('upgrade', (res, socket) => {
    socket.destroy();
    ok({ status: res.statusCode!, host: res.headers['x-host'] as string });
  });
  req.on('response', (res) => {
    res.resume();
    ok({ status: res.statusCode! });
  });
  req.on('error', fail);
  req.end();
});
/** clamd INSTREAM over the TCP route: the reply and how long until the connection closed (`idle`: keep the socket open, give up after that silence). */
const clamd = (port: number, payload: string | Buffer = 'hello', idle = 0) => new Promise<{ reply: string; ms: number }>((ok) => {
  const t0 = Date.now();
  const body = Buffer.from(payload);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const sock = connect(port, '127.0.0.1');
  let reply = '';
  sock.on('data', (c) => { reply += c; });
  sock.on('error', () => {});
  sock.on('close', () => ok({ reply, ms: Date.now() - t0 }));
  const request = Buffer.concat([Buffer.from('zINSTREAM\0'), len, body, Buffer.alloc(4)]);
  if (!idle) return void sock.end(request);
  sock.setTimeout(idle, () => sock.destroy());
  sock.write(request);
});

const readRecords = (dir: string): TrafficRecord[] => {
  try {
    return readFileSync(join(dir, 'traffic.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
async function waitFor<T>(what: string, fn: () => T | undefined, ms = 2000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** api-gateway's fake: echo, an SSE stream, a big body and a WebSocket that says hello. */
function gateway() {
  let hits = 0;
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits++;
    if (req.url?.startsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: hello\ndata: {"token":"t-1","n":1}\n\n');
      setTimeout(() => res.end(`: keep-alive\n\ndata: second ${SECRET}\n\n`), 300);
      return;
    }
    if (req.url === '/big') return void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.alloc(40_000, 'b'));
    let bytes = 0;
    req.on('data', (b: Buffer) => { bytes += b.length; });
    req.on('end', () => {
      if (req.url === '/redir') return void res.writeHead(302, { location: `http://${req.headers.host}/next`, 'access-control-allow-origin': `http://${req.headers.host}` }).end();
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'SESSION=abc; HttpOnly' })
        .end(JSON.stringify({ name: 'api-gateway', host: req.headers.host, origin: req.headers.origin, referer: req.headers.referer, screen: req.headers['x-laru-screen'], method: req.method, url: req.url, bytes }));
    });
  });
  srv.on('upgrade', (req: IncomingMessage, socket) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Host: ${req.headers.host}\r\n\r\n`);
    socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('hello')]));
    socket.once('data', () => socket.end(Buffer.from([0x88, 0])));
  });
  return { srv, hits: () => hits };
}
const named = (name: string) => createServer((req, res) => {
  req.resume();
  req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name, host: req.headers.host })));
});

test('the tap, in process with fake upstreams', async (t) => {
  const out = mkdtempSync(join(tmpdir(), 'ks-tap-'));
  const gw = gateway();
  const front = named('frontend');
  const minio = named('minio');
  const consoleUp = named('minio-console');
  const clam = createTcpServer((s) => {
    let got = Buffer.alloc(0);
    s.on('data', (b: Buffer) => {
      got = Buffer.concat([got, b]);
      if (got.length > 14 && got.subarray(-4).equals(Buffer.alloc(4))) s.end('stream: OK\0');
    });
  });
  const grpc = createH2Server((req, res) => res.end(`h2 ${req.url}`));
  const ups = [gw.srv, front, minio, consoleUp, clam, grpc];
  const [gwUp, frontUp, minioUp, consoleUpPort, clamUp, grpcUp] = await Promise.all(ups.map(listen));
  const [P8080, P80, P9000, P3310, PGRPC, ENTRANCE] = await freePorts(6);
  const config: TapConfig = {
    app: 'vaultflow', env: 'local', entrance: ENTRANCE,
    routes: [
      route('api-gateway', P8080, gwUp),
      route('frontend', P80, frontUp),
      route('minio', P9000, minioUp),
      route('minio-console', P9000, consoleUpPort, { aliases: ['console'] }),
      route('clamav', P3310, clamUp, { proto: 'tcp' }),
      route('grpc', PGRPC, grpcUp),
    ],
  };
  const tap = await startTap({ config, rules: NO_RULES, masker: createMasker([SECRET]), out, host: '127.0.0.1' });
  t.after(async () => {
    await tap.close();
    for (const s of ups) s.close();
  });
  const records = () => readRecords(out);

  await t.test('one listener per distinct port plus the entrance', () => {
    assert.deepEqual(tap.ports().sort(), [P8080, P80, P9000, P3310, PGRPC, ENTRANCE].sort());
  });

  await t.test('an idle keep-alive connection stays open: the client pool decides when to drop it, as with the real server', async () => {
    const s = connect(P9000, '127.0.0.1');
    let got = '';
    s.on('data', (b: Buffer) => { got += b.toString('latin1'); });
    const answers = () => got.split('HTTP/1.1 200').length - 1;
    const ask = async (n: number) => {
      s.write('GET /x HTTP/1.1\r\nHost: minio:9000\r\n\r\n');
      for (let i = 0; i < 100 && answers() < n; i++) await new Promise((r) => setTimeout(r, 20));
    };
    await ask(1);
    await new Promise((r) => setTimeout(r, 6000)); // past Node's 5 s default, short of OkHttp's 10 s re-check
    await ask(2);
    s.destroy();
    assert.equal(answers(), 2);
  });

  await t.test('port first: Host frontend.vaultflow.localhost on the 8080 listener goes to the 8080 route, Host unchanged', async () => {
    const a = await call(P8080, { headers: { host: 'frontend.vaultflow.localhost' } });
    assert.equal(a.status, 200);
    assert.deepEqual([json(a).name, json(a).host], ['api-gateway', 'frontend.vaultflow.localhost']);
  });

  await t.test('at the entrance, Host, Origin and Referer are the names inside the env, and Location and the allowed origin go back as the browser knows them', async () => {
    const outer = `api-gateway-${P8080}.vaultflow.localhost:${ENTRANCE}`;
    const a = json(await call(ENTRANCE, { method: 'POST', path: '/api/auth/register', headers: { host: outer, origin: `http://${outer}`, referer: `http://${outer}/login` }, body: '{}' }));
    assert.deepEqual([a.host, a.origin, a.referer], [`api-gateway:${P8080}`, `http://api-gateway:${P8080}`, `http://api-gateway:${P8080}/login`]);
    const r = await call(ENTRANCE, { path: '/redir', headers: { host: outer, origin: `http://${outer}` } });
    assert.deepEqual([r.status, r.headers.location, r.headers['access-control-allow-origin']], [302, `http://${outer}/next`, `http://${outer}`]);
    const foreign = json(await call(ENTRANCE, { method: 'POST', headers: { host: outer, origin: 'http://elsewhere.example:1234' }, body: '{}' }));
    assert.equal(foreign.origin, 'http://elsewhere.example:1234', 'an origin that is not one of the env\'s is left alone');
  });

  await t.test('the token that names a screen is read off the request and never reaches the app; a token that is not a plain name is dropped, not kept', async () => {
    const before = records().length;
    const a = json(await call(P8080, { path: '/who', headers: { 'x-laru-screen': 'luis' } }));
    assert.equal(a.screen, undefined, 'the app never sees it');
    const bad = json(await call(P8080, { path: '/who2', headers: { 'x-laru-screen': 'a b;c' } }));
    assert.equal(bad.screen, undefined, 'a bad token is stripped too');
    const plain = json(await call(P8080, { path: '/who3' }));
    assert.equal(plain.screen, undefined);
    await new Promise((r) => setTimeout(r, 150));
    const mine = records().slice(before).filter((r) => /^\/who\d?$/.test(r.path ?? ''));
    assert.deepEqual(mine.map((r) => [r.path, r.screen]), [['/who', 'luis'], ['/who2', undefined], ['/who3', undefined]]);
    assert.ok(mine.every((r) => !('x-laru-screen' in (r.reqHeaders ?? {}))), 'and the journal does not keep it as a header');
  });

  await t.test('Host decides only between routes sharing a port; anything else gets 421', async () => {
    assert.equal(json(await call(P9000, { headers: { host: 'minio:9000' } })).name, 'minio');
    assert.equal(json(await call(P9000, { headers: { host: 'console' } })).name, 'minio-console');
    assert.equal((await call(P9000, { headers: { host: 'elsewhere' } })).status, 421);
  });

  await t.test('entrance routes <svc>[-<port>].<app>.localhost by Host, 421 for an unknown host, and answers health', async () => {
    const a = await call(ENTRANCE, { headers: { host: `frontend.vaultflow.localhost:${ENTRANCE}` } });
    assert.deepEqual(json(a), { name: 'frontend', host: `frontend:${P80}` }, 'the service sees the name it has inside the env, as a client there would send it');
    assert.equal(json(await call(ENTRANCE, { headers: { host: `api-gateway-${P8080}.vaultflow.localhost` } })).name, 'api-gateway');
    assert.equal((await call(ENTRANCE, { headers: { host: 'nope.vaultflow.localhost' } })).status, 421);
    assert.equal((await call(ENTRANCE, { headers: { host: 'frontend.other.localhost' } })).status, 421);
    const h = await call(ENTRANCE, { path: '/__ks/health' });
    assert.deepEqual([h.status, json(h).ok], [200, true]);
    assert.ok(Math.abs(json(h).t - Date.now()) < 5000, 'it says what time the tap thinks it is, to measure its clock against ours');
    const r = await waitFor('entrance record', () => records().find((x) => x.svc === 'frontend'));
    assert.equal(r.port, P80);
  });

  await t.test('a seeded secret is masked in a request header, a JSON body and a query string', async () => {
    const body = JSON.stringify({ user: 'ana', note: SECRET, password: 'pw-123' });
    const a = await call(P8080, {
      method: 'POST', path: `/api/auth/login?q=${encodeURIComponent(SECRET)}&token=t-77`, body,
      headers: { 'content-type': 'application/json', 'x-note': `v ${SECRET}`, authorization: 'Bearer abc-123' },
    });
    assert.equal(json(a).bytes, Buffer.byteLength(body), 'the upstream gets the real body');
    const r = await waitFor('login record', () => records().find((x) => x.path === '/api/auth/login'));
    const raw = readFileSync(join(out, 'traffic.jsonl'), 'utf8');
    for (const form of [SECRET, Buffer.from(SECRET).toString('base64'), encodeURIComponent(SECRET), 'pw-123', 't-77', 'abc-123']) assert.ok(!raw.includes(form), form);
    assert.equal(r.reqHeaders!['x-note'], `v ${MARK}`);
    assert.match(r.reqHeaders!.authorization, /^Bearer …/);
    assert.match(r.resHeaders!['set-cookie'], /^…/);
    assert.equal(JSON.parse(r.req!.text!).note, MARK);
    assert.match(r.query!, new RegExp(`^q=${MARK}&token=…`));
    assert.deepEqual([r.kind, r.method, r.status, r.from, r.req!.bytes], ['http', 'POST', 200, '127.0.0.1', Buffer.byteLength(body)]);
    assert.ok(r.t1! >= r.t0);
    assert.equal(JSON.parse(r.res!.text!).name, 'api-gateway');
  });

  await t.test('tap.log never gets a raw URL or header', async () => {
    const path = `/api/${SECRET}/stream?token=${SECRET}&user%5Bpassword%5D=plainpw123`;
    assert.equal((await call(ENTRANCE, { path, headers: { host: `nope-${SECRET}.vaultflow.localhost` } })).status, 421);
    const log = await waitFor('the 421 line', () => {
      const l = readFileSync(join(out, 'tap.log'), 'utf8');
      return l.includes(`/api/${MARK}/stream`) ? l : undefined;
    });
    assert.ok(!log.includes(SECRET) && !log.includes('plainpw123'), log);
  });

  await t.test('multipart file parts are read as metadata even when a delimiter is split across chunks', async () => {
    const content = 'line1\r\n--Xy not a boundary\r\nend';
    const body = '--XyZ\r\nContent-Disposition: form-data; name="title"\r\n\r\nhello\r\n'
      + `--XyZ\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--XyZ--\r\n`;
    await new Promise<void>((ok, fail) => {
      const req = request({ host: '127.0.0.1', port: P8080, method: 'POST', path: '/split', agent: false, headers: { 'content-type': 'multipart/form-data; boundary=XyZ' } }, (res) => {
        res.resume().on('end', ok);
      }).on('error', fail);
      (async () => {
        for (let i = 0; i < body.length; i += 5) {
          req.write(body.slice(i, i + 5));
          await new Promise((r) => setTimeout(r, 1));
        }
        req.end();
      })().catch(fail);
    });
    const r = await waitFor('split record', () => records().find((x) => x.path === '/split'));
    assert.deepEqual(JSON.parse(r.req!.text!), {
      fields: { title: 'hello' },
      files: [{ name: 'file', filename: 'a.txt', size: content.length, sha256: createHash('sha256').update(content).digest('hex') }],
    });
  });

  await t.test('multipart: a part with a filename, quoted or not, or a non-text type is metadata only; at most 100 parts listed', async () => {
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const parts = [
      `Content-Disposition: form-data; name=file; filename=eicar.com\r\n\r\n${eicar}`,
      `Content-Disposition: form-data; name="blob"\r\nContent-Type: application/octet-stream\r\n\r\n${eicar}`,
      'Content-Disposition: form-data; name="note"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nplain text',
      ...Array.from({ length: 120 }, (_, i) => `Content-Disposition: form-data; name="f${i}"\r\n\r\nv${i}`),
    ];
    const body = parts.map((p) => `--B\r\n${p}\r\n`).join('') + '--B--\r\n';
    assert.equal((await call(P8080, { method: 'POST', path: '/mp', body, headers: { 'content-type': 'multipart/form-data; boundary=B' } })).status, 200);
    const r = await waitFor('multipart record', () => records().find((x) => x.path === '/mp'));
    const got = JSON.parse(r.req!.text!);
    assert.deepEqual(got.files.map((f: { name: string; filename: string; size: number }) => [f.name, f.filename, f.size]), [['file', 'eicar.com', eicar.length], ['blob', '', eicar.length]]);
    assert.equal(got.fields.note, 'plain text');
    assert.deepEqual([Object.keys(got.fields).length + got.files.length, got.omitted], [100, 23]);
    assert.ok(!readFileSync(join(out, 'traffic.jsonl'), 'utf8').includes('EICAR-STANDARD'));
  });

  await t.test('multipart: a field cut at 1 KB leaves no piece of a known value; names and filenames are capped', async () => {
    const long = (c: string) => c.repeat(30_000);
    const parts = [
      `Content-Disposition: form-data; name="note"\r\n\r\n${'x'.repeat(1015 + MARGIN)} ${SECRET} tail`,
      ...Array.from({ length: 50 }, (_, i) => `Content-Disposition: form-data; name="${long('n')}${i}"; filename="${long('f')}"\r\n\r\nx`),
    ];
    const body = parts.map((p) => `--B\r\n${p}\r\n`).join('') + '--B--\r\n';
    assert.equal((await call(P8080, { method: 'POST', path: '/mp-cut', body, headers: { 'content-type': 'multipart/form-data; boundary=B' } })).status, 200);
    const r = await waitFor('multipart cut record', () => records().find((x) => x.path === '/mp-cut'));
    const got = JSON.parse(r.req!.text!);
    assert.ok(got.fields.note.endsWith('x…') && !got.fields.note.includes(SECRET.slice(0, 3)), got.fields.note.slice(-40));
    assert.equal(got.files.length, 50);
    for (const f of got.files) assert.ok(f.name.length <= 257 + MARGIN && f.filename.length <= 257 + MARGIN, `${f.name.length} / ${f.filename.length}`);
    assert.ok(r.req!.text!.length < 50_000, `${r.req!.text!.length} characters`);
  });

  await t.test('a raw upload whose type is not textual is never recorded; +json, +xml and AWS JSON types are', async () => {
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await call(P8080, { method: 'PUT', path: '/docx', body: 'EICAR-LIKE inside a docx', headers: { 'content-type': docx } });
    const r = await waitFor('docx record', () => records().find((x) => x.path === '/docx'));
    assert.deepEqual(r.req, { bytes: 24, note: `${docx}: not recorded` });
    await call(P8080, { method: 'POST', path: '/vnd', body: '{"a":1}', headers: { 'content-type': 'application/vnd.api+json; charset=utf-8' } });
    assert.equal((await waitFor('vnd record', () => records().find((x) => x.path === '/vnd'))).req!.text, '{"a":1}');
    await call(P8080, { method: 'POST', path: '/ddb', body: '{"TableName":"users"}', headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.GetItem' } });
    assert.equal((await waitFor('aws record', () => records().find((x) => x.path === '/ddb'))).req!.text, '{"TableName":"users"}', 'DynamoDB speaks application/x-amz-json-1.0');
  });

  await t.test('a secret cut by the 64 KB tee is not left as a prefix, and the cut tells nothing about what was there', async () => {
    const body = (tail: string) => 'x'.repeat(64 * 1024 + MARGIN - tail.length - 1) + ' ' + tail + ' beyond the cut';
    await call(P8080, { method: 'POST', path: '/tee', body: body(SECRET.slice(0, 8)), headers: { 'content-type': 'text/plain' } });
    await call(P8080, { method: 'POST', path: '/tee-miss', body: body('zzQ9xzzQ'), headers: { 'content-type': 'text/plain' } });
    const r = await waitFor('tee record', () => records().find((x) => x.path === '/tee'));
    const miss = await waitFor('second tee record', () => records().find((x) => x.path === '/tee-miss'));
    assert.equal(r.req!.note, 'first 64 KB');
    assert.ok(r.req!.text!.endsWith('x…') && !r.req!.text!.includes(SECRET.slice(0, 3)), r.req!.text!.slice(-40));
    assert.equal(r.req!.text, miss.req!.text, 'a piece of a known value reads the same as a wrong guess');
    assert.equal(r.req!.text!.length, 64 * 1024 + 1, 'the first 64 KB are all there: only the margin kept beyond them is cut');
  });

  await t.test('the first SSE event is forwarded in under 100 ms and each event becomes a record', async () => {
    const t0 = Date.now();
    const first = await new Promise<number>((ok, fail) => {
      request({ host: '127.0.0.1', port: P8080, path: '/events?token=t-9', agent: false }, (res) => {
        res.once('data', () => ok(Date.now() - t0));
        res.resume();
      }).on('error', fail).end();
    });
    assert.ok(first < 100, `first event after ${first} ms`);
    const events = await waitFor('two sse records', () => {
      const e = records().filter((x) => x.kind === 'sse');
      return e.length === 2 ? e : undefined;
    });
    assert.equal(events[0].event!.name, 'hello');
    assert.match(events[0].event!.data!, /"token":"…[\w-]{4}","n":1/);
    assert.equal(events[1].event!.data, `second ${MARK}`);
    assert.match(events[0].query!, /^token=…/);
    const http = await waitFor('sse exchange', () => records().find((x) => x.kind === 'http' && x.path === '/events'));
    assert.equal(http.res!.note, 'events recorded as sse lines');
  });

  await t.test('WebSocket upgrades are tunnelled raw', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${P8080}/ws?token=w-1`);
    const closed = new Promise((r) => ws.addEventListener('close', r));
    const msg = await new Promise<string>((ok, fail) => {
      ws.addEventListener('message', (e) => { ok(String(e.data)); ws.send('ping'); });
      ws.addEventListener('error', fail);
    });
    await closed;
    assert.equal(msg, 'hello');
    const r = await waitFor('ws record', () => records().find((x) => x.kind === 'ws'));
    assert.deepEqual([r.svc, r.path, r.status], ['api-gateway', '/ws', 101]);
    assert.match(r.query!, /^token=…/);
    assert.ok(r.req!.bytes > 0 && r.res!.bytes > 0);
  });

  await t.test('WebSocket upgrades keep Host; an unknown host gets 421 on the entrance and on a shared port', async () => {
    assert.deepEqual(await upgrade(ENTRANCE, `api-gateway-${P8080}.vaultflow.localhost`), { status: 101, host: `api-gateway-${P8080}.vaultflow.localhost` });
    assert.deepEqual(await upgrade(P8080, 'frontend.vaultflow.localhost'), { status: 101, host: 'frontend.vaultflow.localhost' });
    assert.equal((await upgrade(ENTRANCE, 'nope.vaultflow.localhost')).status, 421);
    assert.equal((await upgrade(P9000, 'elsewhere')).status, 421);
  });

  await t.test('TCP routes count bytes both ways and keep a masked printable peek', async () => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(200);
    const payload = Buffer.from('A'.repeat(200 - SECRET.length - 2) + ` ${SECRET} `);
    const sock = connect(P3310, '127.0.0.1');
    sock.end(Buffer.concat([Buffer.from('zINSTREAM\0'), len, payload, Buffer.alloc(4)]));
    let reply = '';
    for await (const c of sock) reply += c;
    assert.equal(reply, 'stream: OK\0');
    const r = await waitFor('tcp record', () => records().find((x) => x.svc === 'clamav'));
    assert.deepEqual([r.kind, r.port, r.req!.bytes, r.res!.bytes], ['tcp', P3310, 218, 11]);
    assert.equal(r.peek!.down, 'stream: OK.');
    assert.ok(r.peek!.up!.startsWith('zINSTREAM.....AAAA'), r.peek!.up);
    assert.ok(r.peek!.up!.includes(' [+90 B] ') && r.peek!.up!.includes(MARK) && !r.peek!.up!.includes(SECRET), r.peek!.up);
  });

  await t.test('a secret cut by the peek is masked whole on both sides of the join', async () => {
    // 14 bytes of header, so the first copy straddles byte 64 and the second the start of the last 64 bytes.
    assert.equal((await clamd(P3310, 'B'.repeat(42) + SECRET + 'C'.repeat(150) + SECRET + 'D'.repeat(52))).reply, 'stream: OK\0');
    const r = await waitFor('second tcp record', () => records().filter((x) => x.svc === 'clamav')[1]);
    assert.ok(!r.peek!.up!.includes(SECRET.slice(0, 3)) && !r.peek!.up!.includes(SECRET.slice(-3)), r.peek!.up);
    assert.ok(r.peek!.up!.includes(`B${MARK}… [+168 B] …${MARK}D`), r.peek!.up);
  });

  await t.test('a known password right after a printable length byte (Postgres PasswordMessage) is masked in the peek', async (t) => {
    const pw = 'Kq8vR2nT5wY7zB3mX9pL4cF6hJ1dG0sAKq8vR2nT5wY7zB3mX9'; // 50 characters: length 4 + 50 + 1 = 55, a '7'
    tap.setMasker(createMasker([SECRET, pw]));
    t.after(() => tap.setMasker(createMasker([SECRET])));
    const before = records().filter((x) => x.svc === 'clamav').length;
    await new Promise<void>((ok) => {
      const sock = connect(P3310, '127.0.0.1', () => sock.end(Buffer.concat([Buffer.from('p'), Buffer.from([0, 0, 0, 55]), Buffer.from(pw), Buffer.alloc(1)])));
      sock.on('error', () => {}).on('close', () => ok()).resume();
    });
    const r = await waitFor('pg record', () => records().filter((x) => x.svc === 'clamav')[before]);
    assert.equal(r.peek!.up, `p...7${createMasker([pw]).text(pw)}.`);
  });

  await t.test('a non-ASCII known password is masked in the peek: its UTF-8 bytes are looked for before they are made printable', async (t) => {
    const pw = 'contraseña-Nza7QcJF8UXvmWEIhXsf'; // 32 bytes: length 4 + 32 + 1 = 37, a '%'
    tap.setMasker(createMasker([SECRET, pw]));
    t.after(() => tap.setMasker(createMasker([SECRET])));
    const before = records().filter((x) => x.svc === 'clamav').length;
    await new Promise<void>((ok) => {
      const sock = connect(P3310, '127.0.0.1', () => sock.end(Buffer.concat([Buffer.from('p'), Buffer.from([0, 0, 0, 37]), Buffer.from(pw), Buffer.alloc(1)])));
      sock.on('error', () => {}).on('close', () => ok()).resume();
    });
    const r = await waitFor('pg record', () => records().filter((x) => x.svc === 'clamav')[before]);
    assert.equal(r.peek!.up, `p...%${createMasker([pw]).text(pw)}.`);
  });

  await t.test('a long known value (66 characters, base64 88) still leaves the first and last 64 bytes of a peek', async (t) => {
    tap.setMasker(createMasker([SECRET, 'Kq8vR2nT5wY7zB3mX9pL4cF6hJ1dG0sA'.repeat(2) + 'zz']));
    t.after(() => tap.setMasker(createMasker([SECRET])));
    const before = records().filter((x) => x.svc === 'clamav').length;
    const payload = 'abcdefgh'.repeat(48); // 384 bytes: its length is 00 00 01 80, four dots
    assert.equal((await clamd(P3310, payload)).reply, 'stream: OK\0');
    const r = await waitFor('long-value record', () => records().filter((x) => x.svc === 'clamav')[before]);
    assert.equal(r.peek!.up, `zINSTREAM.....${payload.slice(0, 50)}… [+274 B] …${payload.slice(-60)}....`);
  });

  await t.test('a known value in the margin a peek keeps beyond its 64 bytes leaves those 64 bytes visible', async (t) => {
    tap.setMasker(createMasker([SECRET, 'Kq8vR2nT5wY7zB3mX9pL4cF6hJ1dG0sA'.repeat(2) + 'zz'])); // margin 87
    t.after(() => tap.setMasker(createMasker([SECRET])));
    const before = records().filter((x) => x.svc === 'clamav').length;
    const eight = (n: number) => 'abcdefgh'.repeat(n);
    // SECRET at stream bytes 78 to 95 (in the head's margin) and in the tail's margin, 66 to 83 bytes into its 151.
    const payload = `${eight(8)}${SECRET}${eight(30)}${SECRET}${eight(8)}`;
    assert.equal((await clamd(P3310, payload)).reply, 'stream: OK\0');
    const r = await waitFor('margin record', () => records().filter((x) => x.svc === 'clamav')[before]);
    assert.equal(r.peek!.up, `zINSTREAM.....${payload.slice(0, 50)}… [+292 B] …${payload.slice(-60)}....`);
  });

  await t.test('h2c prior knowledge (gRPC) on an http route is passed through as tcp', async () => {
    const client = connectH2(`http://127.0.0.1:${PGRPC}`);
    const body = await new Promise<string>((ok, fail) => {
      client.on('error', fail);
      let b = '';
      client.request({ ':path': '/svc.Echo/Say' }).setEncoding('utf8').on('data', (c) => { b += c; }).on('end', () => ok(b)).on('error', fail);
    });
    client.close();
    assert.equal(body, 'h2 /svc.Echo/Say');
    const r = await waitFor('h2c record', () => records().find((x) => x.svc === 'grpc'));
    assert.equal(r.kind, 'tcp');
    assert.ok(r.peek!.up!.startsWith('PRI * HTTP/2.0'), r.peek!.up);
  });

  await t.test('faults', async (t) => {
    const rules = (faults: TapRules['faults'], extra: Partial<TapRules> = {}) => tap.setRules({ ...NO_RULES, faults, ...extra });
    const lastFault = (path: string) => waitFor(`record of ${path}`, () => records().findLast((x) => x.path === path && x.kind === 'http'));
    t.after(() => tap.setRules(NO_RULES));

    await t.test('latency', async () => {
      rules({ 'api-gateway': [{ latency: 300 }] });
      const a = await call(P8080, { path: '/slow' });
      assert.equal(a.status, 200);
      assert.ok(a.ms >= 300, `${a.ms} ms`);
      const r = await lastFault('/slow');
      assert.equal(r.fault, 'latencia +300 ms inyectada');
      assert.ok(r.t1! - r.t0 >= 300);
    });

    await t.test('status, by path and method, answers without forwarding', async () => {
      rules({ 'api-gateway': [{ status: 503, path: '^/down', method: 'get' }] });
      const before = gw.hits();
      const a = await call(P8080, { path: '/down/x' });
      assert.deepEqual([a.status, a.headers['x-laru-fault']], [503, 'estado 503 inyectado']);
      assert.equal(gw.hits(), before, 'the upstream never saw it');
      assert.equal((await call(P8080, { path: '/up' })).status, 200);
      assert.equal((await call(P8080, { method: 'POST', path: '/down/x' })).status, 200);
      assert.equal((await lastFault('/down/x')).status, 200);
    });

    await t.test('abort destroys the connection', async () => {
      rules({ 'api-gateway': [{ abort: true }] });
      await assert.rejects(call(P8080, { path: '/abort' }), /socket hang up|ECONNRESET/);
      assert.equal((await lastFault('/abort')).fault, 'abortado');
    });

    await t.test('timeout never answers', async () => {
      rules({ 'api-gateway': [{ timeout: true }] });
      await assert.rejects(call(P8080, { path: '/never', timeout: 200 }), /client timeout/);
      assert.equal((await lastFault('/never')).fault, 'sin respuesta');
    });

    await t.test('bandwidth after N bytes', async () => {
      rules({ 'api-gateway': [{ bandwidth: 20_000, slowAfter: 20_000 }] });
      const t0 = Date.now();
      const { firstHalf, total, bytes } = await new Promise<{ firstHalf: number; total: number; bytes: number }>((ok, fail) => {
        request({ host: '127.0.0.1', port: P8080, path: '/big', agent: false }, (res) => {
          let bytes = 0;
          let firstHalf = 0;
          res.on('data', (c: Buffer) => {
            bytes += c.length;
            if (!firstHalf && bytes >= 20_000) firstHalf = Date.now() - t0;
          });
          res.on('end', () => ok({ firstHalf, total: Date.now() - t0, bytes }));
        }).on('error', fail).end();
      });
      assert.equal(bytes, 40_000);
      assert.ok(firstHalf < 300, `first 20 KB after ${firstHalf} ms`);
      assert.ok(total >= 800, `whole body after ${total} ms`);
      const r = await lastFault('/big');
      assert.deepEqual([r.fault, r.res!.bytes], ['ancho de banda 20000 B/s tras 20000 B', 40_000]);
    });

    await t.test('from: filters by caller through peers', async () => {
      const peers = { '127.0.0.1': 'frontend' };
      rules({ 'api-gateway': [{ from: 'batch-service', status: 500 }] }, { peers });
      assert.equal((await call(P8080, { path: '/from' })).status, 200);
      rules({ 'api-gateway': [{ from: 'frontend', status: 500 }] }, { peers });
      assert.equal((await call(P8080, { path: '/from' })).status, 500);
    });

    await t.test('p is reproducible for a seed', async () => {
      const pattern = async (seed: number) => {
        rules({ 'api-gateway': [{ status: 500, p: 0.5 }] }, { seed });
        const out: number[] = [];
        for (let i = 0; i < 24; i++) out.push((await call(P8080, { path: '/p' })).status);
        return out.join(' ');
      };
      const a = await pattern(7);
      assert.equal(await pattern(7), a);
      assert.ok(a.includes('200') && a.includes('500'), a);
      assert.notEqual(await pattern(8), a);
    });

    await t.test('TCP routes get latency, abort, timeout and bandwidth too', async () => {
      const tcpFault = async (fault: TapRules['faults'][string][number], idle = 0) => {
        rules({ clamav: [fault] });
        const before = records().filter((x) => x.svc === 'clamav').length;
        const a = await clamd(P3310, 'hello', idle);
        return { ...a, fault: (await waitFor('clamav record', () => records().filter((x) => x.svc === 'clamav')[before])).fault };
      };
      const late = await tcpFault({ latency: 300 });
      assert.deepEqual([late.reply, late.fault], ['stream: OK\0', 'latencia +300 ms inyectada']);
      assert.ok(late.ms >= 300, `${late.ms} ms`);
      assert.deepEqual(await tcpFault({ abort: true }).then((x) => [x.reply, x.fault]), ['', 'abortado']);
      const never = await tcpFault({ timeout: true }, 400);
      assert.deepEqual([never.reply, never.fault], ['', 'sin respuesta']);
      assert.ok(never.ms >= 400, `${never.ms} ms`);
      const slow = await tcpFault({ bandwidth: 20 });
      assert.deepEqual([slow.reply, slow.fault], ['stream: OK\0', 'ancho de banda 20 B/s']);
      assert.ok(slow.ms >= 400, `${slow.ms} ms for 11 bytes at 20 B/s`);
      rules({ clamav: [{ status: 503, path: '.*' }] });
      assert.equal((await clamd(P3310)).reply, 'stream: OK\0', 'status and path filters do not apply to bytes');
    });

    await t.test('WebSocket upgrades get them as well', async () => {
      rules({ 'api-gateway': [{ status: 503, path: '^/ws' }] });
      assert.deepEqual(await upgrade(P8080, 'api-gateway'), { status: 503 });
      const r = await waitFor('ws fault record', () => records().findLast((x) => x.kind === 'ws' && x.fault));
      assert.deepEqual([r.status, r.fault], [503, 'estado 503 inyectado']);
    });
  });
});

test('the journal: rotation keeps one previous file, a slow disk drops lines, a failing one never crashes', async (t) => {
  const rec = (i: number): TrafficRecord => ({ v: 1, id: String(i), kind: 'http', t0: 0, from: '', svc: 's', port: 1, error: 'x'.repeat(10_000) });

  await t.test('rotation, at a threshold injected for the test, keeps one previous file; a port shared by tcp and http is logged', async () => {
    const out = mkdtempSync(join(tmpdir(), 'ks-tap-rotate-'));
    const up = named('one');
    const upPort = await listen(up);
    const [P, ENT] = await freePorts(2);
    const tap = await startTap({
      config: { app: 'a', env: 'e', entrance: ENT, routes: [route('one', P, upPort), route('raw', P, upPort, { proto: 'tcp' })] },
      rules: NO_RULES, masker: createMasker([]), out, host: '127.0.0.1', rotate: 2000,
    });
    await waitFor('the journal', () => existsSync(join(out, 'traffic.jsonl')));
    const ino = statSync(join(out, 'traffic.jsonl')).ino;
    t.after(async () => {
      await tap.close();
      up.close();
    });
    for (let i = 0; i < 30; i++) assert.equal((await call(P, { path: `/r${i}`, headers: { host: 'one' } })).status, 200);
    await waitFor('last record', () => readRecords(out).find((x) => x.path === '/r29'));
    const older = readFileSync(join(out, 'traffic.jsonl.1'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as TrafficRecord);
    assert.ok(older.length && Number(older.at(-1)!.path!.slice(2)) < Number(readRecords(out)[0].path!.slice(2)));
    assert.ok(!existsSync(join(out, 'traffic.jsonl.2')));
    assert.equal(statSync(join(out, 'traffic.jsonl')).ino, ino, 'the same file, emptied: a runner that has it mounted keeps seeing it');
    const all = [...older, ...readRecords(out)].filter((x) => x.path?.startsWith('/r')).map((x) => Number(x.path!.slice(2)));
    assert.deepEqual([...new Set(all)].slice(-5), [25, 26, 27, 28, 29], 'the newest lines all there, in order');
    for (const f of ['traffic.jsonl', 'traffic.jsonl.1']) assert.ok(statSync(join(out, f)).size <= 2000, f);
    assert.match(readFileSync(join(out, 'tap.log'), 'utf8'), new RegExp(`port ${P}: one \\(http\\), raw \\(tcp\\) share it`));
  });

  await t.test('a slow disk: lines beyond the backlog cap are dropped and counted, not buffered', async () => {
    const out = mkdtempSync(join(tmpdir(), 'ks-journal-'));
    const logged: string[] = [];
    const j = openJournal(join(out, 'traffic.jsonl'), (m) => logged.push(m));
    for (let i = 0; i < 2000; i++) j.write(rec(i)); // 20 MB in one tick: the stream cannot flush in between
    await j.close();
    const lines = readFileSync(join(out, 'traffic.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    assert.ok(lines < 2000 && lines >= 500, `${lines} lines`);
    assert.ok(logged.some((m) => m.includes(`${2000 - lines} records dropped`)), logged.join('\n'));
  });

  await t.test('tap.log rotates like the journal, keeping one previous file', async () => {
    const out = mkdtempSync(join(tmpdir(), 'ks-tap-log-'));
    const [P, ENT] = await freePorts(2);
    const tap = await startTap({ config: { app: 'a', env: 'e', entrance: ENT, routes: [route('one', P, 1)] }, rules: NO_RULES, masker: createMasker([]), out, host: '127.0.0.1', rotate: 1000 });
    t.after(() => tap.close());
    for (let i = 0; i < 40; i++) assert.equal((await call(ENT, { path: `/x${i}`, headers: { host: 'nope.a.localhost' } })).status, 421);
    await waitFor('the last 421 line', () => readFileSync(join(out, 'tap.log'), 'utf8').includes('/x39 '));
    assert.ok(existsSync(join(out, 'tap.log.1')) && !existsSync(join(out, 'tap.log.2')));
    for (const f of ['tap.log', 'tap.log.1']) assert.ok(statSync(join(out, f)).size <= 1000, f);
  });

  await t.test('tap.log is reopened after a write error, like the journal', async () => {
    const out = mkdtempSync(join(tmpdir(), 'ks-tap-log-'));
    mkdirSync(join(out, 'tap.log')); // a directory: the first open fails
    const [P, ENT] = await freePorts(2);
    const tap = await startTap({ config: { app: 'a', env: 'e', entrance: ENT, routes: [route('one', P, 1)] }, rules: NO_RULES, masker: createMasker([]), out, host: '127.0.0.1' });
    t.after(() => tap.close());
    await new Promise((r) => setTimeout(r, 100));
    rmSync(join(out, 'tap.log'), { recursive: true });
    await new Promise((r) => setTimeout(r, 1100));
    tap.log('after the error');
    await waitFor('the line after the error', () => existsSync(join(out, 'tap.log')) && readFileSync(join(out, 'tap.log'), 'utf8').includes('after the error'));
  });

  await t.test('an unwritable journal logs the error and keeps the process alive', async () => {
    const out = mkdtempSync(join(tmpdir(), 'ks-journal-'));
    mkdirSync(join(out, 'traffic.jsonl')); // a directory: every open fails
    const logged: string[] = [];
    const j = openJournal(join(out, 'traffic.jsonl'), (m) => logged.push(m));
    j.write(rec(1));
    await waitFor('the journal error in tap.log', () => logged.find((m) => /EISDIR/.test(m)));
    j.write(rec(2));
    await j.close();
  });
});

test('the tap as a script: hot-reloaded rules and mask.json, 20 MB streamed uploads', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ks-tap-script-'));
  let firstData = 0;
  const up = createServer((req, res) => {
    let bytes = 0;
    req.on('data', (b: Buffer) => {
      firstData ||= Date.now();
      bytes += b.length;
    });
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ bytes })));
  });
  const upPort = await listen(up);
  const [SVC, ENTRANCE] = await freePorts(2);
  writeFileSync(join(dir, 'routes.json'), JSON.stringify({ app: 'vaultflow', env: 'local', entrance: ENTRANCE, routes: [route('file-service', SVC, upPort)] }));
  const maskFile = join(dir, 'mask.json');
  writeMaskFile(maskFile, [SECRET], true);
  const key = readMaskFile(maskFile).key;
  const MARK_K = createMasker([SECRET], key).text(SECRET);
  const child = spawn(process.execPath, [TAP, dir, '127.0.0.1'], { stdio: ['ignore', 'inherit', 'inherit'] });
  t.after(async () => {
    child.kill('SIGTERM');
    up.close();
  });
  const healthy = async () => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (await call(ENTRANCE, { path: '/__ks/health' }).then((a) => a.status === 200, () => false)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('tap did not start');
  };
  await healthy();
  const rss = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim()) * 1024;
  /** The tap's peak RSS, sampled every 5 ms without blocking this process (a sample is skipped while ps still runs). */
  const sampler = () => {
    let peak = 0;
    let samples = 0;
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      execFile('ps', ['-o', 'rss=', '-p', String(child.pid)], (e, out) => {
        busy = false;
        if (e) return;
        peak = Math.max(peak, Number(out.trim()) * 1024);
        samples++;
      });
    }, 5);
    return () => {
      clearInterval(timer);
      return { peak, samples };
    };
  };
  const chunk = Buffer.alloc(64 * 1024, 'abcdefgh');
  const N = 320;
  const SIZE = N * 64 * 1024;
  /** Streams `head`, then 20 MB in 64 KB chunks (a breath every other chunk, so sampling sees the upload), then `tail`. */
  async function upload(method: string, path: string, contentType: string, head: string, first: Buffer, tail: string) {
    firstData = 0;
    const base = rss();
    const stop = sampler();
    let lastWrite = 0;
    const answer = await new Promise<Answer>((ok, fail) => {
      const t0 = Date.now();
      const req = request({ host: '127.0.0.1', port: SVC, method, path, agent: false, headers: { 'content-type': contentType } }, (res) => {
        let text = '';
        res.setEncoding('utf8').on('data', (c) => { text += c; }).on('end', () => ok({ status: res.statusCode!, headers: res.headers, text, ms: Date.now() - t0 }));
      });
      req.on('error', fail);
      (async () => {
        req.write(head);
        req.write(first);
        for (let i = 1; i < N; i++) {
          if (!req.write(chunk)) await once(req, 'drain');
          if (i % 2) await new Promise((r) => setTimeout(r, 1));
        }
        lastWrite = Date.now();
        req.end(tail);
      })().catch(fail);
    });
    const { peak, samples } = stop();
    t.diagnostic(`${method} ${path}: tap RSS ${(base / 1048576).toFixed(1)} MB, peak growth ${((Math.max(peak, base) - base) / 1048576).toFixed(1)} MB over ${samples} samples`);
    assert.equal(answer.status, 200);
    assert.ok(firstData && firstData < lastWrite, 'the upstream got bytes before the client finished sending');
    assert.ok(samples >= 10, `only ${samples} RSS samples during the upload`);
    assert.ok(peak - base < 50 * 1024 * 1024, `tap grew ${((peak - base) / 1048576).toFixed(1)} MB`);
    return answer;
  }

  await t.test('a 20 MB multipart upload is streamed, the tap grows under 50 MB, and only file metadata is recorded', async () => {
    const first = Buffer.alloc(64 * 1024, 'x');
    first.write('X5O!P%@AP EICAR-LIKE-CONTENT ');
    const sha = createHash('sha256').update(first);
    for (let i = 1; i < N; i++) sha.update(chunk);
    const head = `--B\r\nContent-Disposition: form-data; name="title"\r\n\r\nreport\r\n--B\r\nContent-Disposition: form-data; name="password"\r\n\r\n${SECRET}\r\n`
      + '--B\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n';
    const answer = await upload('POST', '/api/files', 'multipart/form-data; boundary=B', head, first, '\r\n--B--\r\n');
    assert.equal(json(answer).bytes, Buffer.byteLength(head) + SIZE + 9);
    const r = await waitFor('upload record', () => readRecords(dir).find((x) => x.path === '/api/files'));
    assert.deepEqual(JSON.parse(r.req!.text!), {
      fields: { title: 'report', password: MARK_K },
      files: [{ name: 'file', filename: 'big.bin', size: SIZE, sha256: sha.digest('hex') }],
    });
    const raw = readFileSync(join(dir, 'traffic.jsonl'), 'utf8');
    assert.ok(!raw.includes('EICAR-LIKE') && !raw.includes(SECRET));
  });

  await t.test('a 20 MB raw streamed PUT (as to MinIO) is streamed, the tap grows under 50 MB, and the bytes are never recorded', async () => {
    const first = Buffer.alloc(64 * 1024, 'y');
    first.write('X5O!P%@AP EICAR-LIKE-RAW ');
    const answer = await upload('PUT', '/bucket/big.bin', 'application/octet-stream', '', first, '');
    assert.equal(json(answer).bytes, SIZE);
    const r = await waitFor('put record', () => readRecords(dir).find((x) => x.path === '/bucket/big.bin'));
    assert.deepEqual(r.req, { bytes: SIZE, note: 'application/octet-stream: not recorded' });
    assert.ok(!readFileSync(join(dir, 'traffic.jsonl'), 'utf8').includes('EICAR-LIKE'));
  });

  await t.test('mask.json is watched: a new secret, a PEM among them, is masked within 1 s', async () => {
    const NEW = 'rotated-Secret-77zz';
    const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const reloads = () => (readFileSync(join(dir, 'tap.log'), 'utf8').match(/mask reloaded/g) ?? []).length;
    const before = reloads();
    const t0 = Date.now();
    writeMaskFile(maskFile, [SECRET, NEW, pem], true);
    await waitFor('mask reloaded', () => reloads() > before, 2000);
    assert.ok(Date.now() - t0 < 1000, `reloaded after ${Date.now() - t0} ms`);
    assert.equal(readMaskFile(maskFile).key, key, 'the key is kept');
    await call(SVC, { method: 'POST', path: '/rotated', body: JSON.stringify({ note: NEW, config: pem }), headers: { 'content-type': 'application/json' } });
    const r = await waitFor('rotated record', () => readRecords(dir).find((x) => x.path === '/rotated'));
    assert.equal(JSON.parse(r.req!.text!).note, createMasker([NEW], key).text(NEW));
    const raw = readFileSync(join(dir, 'traffic.jsonl'), 'utf8');
    for (const s of [NEW, ...pem.split('\n').filter((l) => l && !l.startsWith('-----'))]) assert.ok(!raw.includes(s), s);
  });

  await t.test('rules.json changes apply within 1 s', async () => {
    assert.equal((await call(SVC, { path: '/r' })).status, 200);
    writeFileSync(join(dir, 'rules.json'), JSON.stringify({ seed: 3, faults: { 'file-service': [{ status: 418 }] }, mocks: {}, peers: {} }));
    const t0 = Date.now();
    let status = 0;
    while (status !== 418 && Date.now() - t0 < 2000) {
      status = (await call(SVC, { path: '/r' })).status;
      if (status !== 418) await new Promise((r) => setTimeout(r, 25));
    }
    const ms = Date.now() - t0;
    assert.equal(status, 418);
    assert.ok(ms < 1000, `applied after ${ms} ms`);
    const log = await waitFor('rules reloaded', () => {
      const l = readFileSync(join(dir, 'tap.log'), 'utf8');
      return /rules reloaded/.test(l) ? l : undefined;
    });
    assert.match(log, /listening on .*file-service/);
    assert.ok(!log.includes(SECRET));
  });
});

test('mocks answer through the tap, and an h2c Upgrade is a plain request', async () => {
  const out = mkdtempSync(join(tmpdir(), 'tap-mock-'));
  const mocksRoot = join(out, 'mocks');
  mkdirSync(join(mocksRoot, 'partner'), { recursive: true });
  mkdirSync(join(mocksRoot, 'clamav'), { recursive: true });
  writeFileSync(join(mocksRoot, 'clamav', 'script.ts'), `export function tcp(s, state) { let b = Buffer.alloc(0); s.on('data', (c) => { b = Buffer.concat([b, c]); if (b.subarray(-4).equals(Buffer.alloc(4))) s.end(b.includes(Buffer.from('EICAR')) ? 'stream: Eicar FOUND\\0' : 'stream: OK\\0'); }); }\n`);
  const oaDir = join(out, 'oa');
  mkdirSync(oaDir);
  writeFileSync(join(oaDir, 'partner.openapi.json'), JSON.stringify({ openapi: '3.0.3', paths: { '/v1/ping': { get: { responses: { '200': { content: { 'application/json': { example: { pong: true } } } } } } } } }));
  // A real upstream that records what it was sent, for the h2c case.
  let seen: IncomingMessage['headers'] = {};
  const real = createServer((req, res) => { seen = req.headers; res.end('ok'); });
  const realPort = await listen(real);
  const [web, partner, clam, entrance] = await freePorts(4);
  const tap = await startTap({
    config: { app: 'shop', env: 'local', entrance, routes: [route('api', web, realPort), route('partner', partner, 0, { upstream: '' }), { svc: 'clamav', aliases: ['clamav'], ports: [clam], upstream: '', proto: 'tcp' }] },
    rules: { ...NO_RULES, mocks: { partner: { mode: 'contract' }, clamav: { mode: 'script' } } }, masker: createMasker([]), out, host: '127.0.0.1', mocks: { root: mocksRoot, openapiDir: oaDir },
  });
  try {
    const pong = await call(partner, { path: '/v1/ping' });
    assert.deepEqual([pong.status, json(pong), pong.headers['x-laru-mock']], [200, { pong: true }, 'contract']);
    const stray = await call(partner, { path: '/v1/nope' });
    assert.equal(stray.status, 404);
    assert.equal((await clamd(clam, 'clean bytes')).reply, 'stream: OK\0');
    assert.equal((await clamd(clam, 'X EICAR X')).reply, 'stream: Eicar FOUND\0');
    const h2c = await call(web, { headers: { connection: 'Upgrade, HTTP2-Settings', upgrade: 'h2c', 'http2-settings': 'AAMAAABkAARAAAAAAAIAAAAA' } });
    assert.equal(h2c.status, 200, 'answered, not tunnelled');
    assert.equal(seen.upgrade, undefined, 'the upstream is not asked to upgrade');
    await new Promise((r) => setTimeout(r, 200));
    const recs = readFileSync(join(out, 'traffic.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as TrafficRecord);
    assert.ok(recs.some((r) => r.svc === 'partner' && r.mock === 'contract' && r.status === 200));
    assert.deepEqual(recs.find((r) => r.svc === 'partner' && r.status === 404)?.drift, ['undeclared operation GET /v1/nope']);
    assert.ok(recs.some((r) => r.svc === 'clamav' && r.mock === 'script' && /FOUND/.test(r.peek?.down ?? '')));
    assert.ok(recs.some((r) => r.svc === 'api' && r.kind === 'http' && r.status === 200), 'the h2c request has its own http record');
  } finally {
    await tap.close();
    real.close();
  }
});

test('a mocked exchange is recorded like a forwarded one: a secret at the 64 KB cut or the peek cut leaves no piece', async () => {
  const out = mkdtempSync(join(tmpdir(), 'tap-mock-cut-'));
  const mocksRoot = join(out, 'mocks');
  mkdirSync(join(mocksRoot, 'echo'), { recursive: true });
  mkdirSync(join(mocksRoot, 'clamav'), { recursive: true });
  writeFileSync(join(mocksRoot, 'echo', 'script.ts'), `export function http(req) {
  if (req.path === '/events') return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'event: scan\\ndata: {"verdict":"clean","token":"${SECRET}"}\\n\\n' };
  return { status: 200, headers: { 'content-type': 'text/plain' }, body: req.path === '/echo' ? req.body : 'ok' };
}\n`);
  writeFileSync(join(mocksRoot, 'clamav', 'script.ts'), `export function tcp(s) { s.once('data', () => s.end('stream: ' + 'A'.repeat(50) + ${JSON.stringify(SECRET)} + 'B'.repeat(100))); }\n`);
  const [echo, clam, entrance] = await freePorts(3);
  const tap = await startTap({
    config: { app: 'shop', env: 'local', entrance, routes: [route('echo', echo, 0, { upstream: '' }), { svc: 'clamav', aliases: ['clamav'], ports: [clam], upstream: '', proto: 'tcp' }] },
    rules: { ...NO_RULES, mocks: { echo: { mode: 'script' }, clamav: { mode: 'script' } } }, masker: createMasker([SECRET]), out, host: '127.0.0.1', mocks: { root: mocksRoot },
  });
  try {
    const body = 'x'.repeat(64 * 1024 + MARGIN - 9) + ' ' + SECRET + ' tail';
    assert.equal((await call(echo, { method: 'POST', path: '/echo', body, headers: { 'content-type': 'text/plain' } })).text, body);
    assert.ok((await clamd(clam, 'hello')).reply.startsWith('stream: AAA'));
    const r = await waitFor('echo record', () => readRecords(out).find((x) => x.svc === 'echo'));
    for (const b of [r.req!, r.res!]) {
      assert.equal(b.note, 'first 64 KB');
      assert.ok(b.text!.endsWith('x…') && !b.text!.includes(SECRET.slice(0, 3)), b.text!.slice(-40));
    }
    const c = await waitFor('clamav record', () => readRecords(out).find((x) => x.svc === 'clamav'));
    assert.ok(c.peek!.down!.startsWith('stream: AAA') && !c.peek!.down!.includes(SECRET.slice(0, 3)), c.peek!.down);
    // An upload to a mocked route keeps only its file parts' metadata; a compressed body is not read as text.
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    await call(echo, { method: 'POST', path: '/upload', body: `--B\r\nContent-Disposition: form-data; name="file"; filename="eicar.com"\r\n\r\n${eicar}\r\n--B--\r\n`, headers: { 'content-type': 'multipart/form-data; boundary=B' } });
    await call(echo, { method: 'POST', path: '/gz', body: 'not really gzip', headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' } });
    const up = await waitFor('upload record', () => readRecords(out).find((x) => x.path === '/upload'));
    assert.deepEqual(JSON.parse(up.req!.text!).files.map((f: { filename: string; size: number }) => [f.filename, f.size]), [['eicar.com', eicar.length]]);
    assert.ok(!readFileSync(join(out, 'traffic.jsonl'), 'utf8').includes('EICAR-STANDARD'));
    assert.deepEqual((await waitFor('gzip record', () => readRecords(out).find((x) => x.path === '/gz'))).req, { bytes: 15, note: 'gzip: not decoded' });
    // A mocked event stream is recorded as events, as a forwarded one is.
    assert.equal((await call(echo, { path: '/events' })).status, 200);
    const sse = await waitFor('mocked sse record', () => readRecords(out).find((x) => x.kind === 'sse' && x.path === '/events'));
    assert.deepEqual([sse.event!.name, JSON.parse(sse.event!.data!)], ['scan', { verdict: 'clean', token: MARK }]);
    assert.equal((await waitFor('sse exchange', () => readRecords(out).find((x) => x.kind === 'http' && x.path === '/events'))).res!.note, 'events recorded as sse lines');
  } finally {
    await tap.close();
  }
});

test('routeFor: the network a connection came in on, then Host; a pinned port is its route whatever the network', () => {
  const r = (svc: string, ports: number[], over: Partial<TapRoute> = {}): TapRoute => ({ svc, aliases: [svc], ports, upstream: `${svc}-real`, proto: 'http', ...over });
  const cfg = {
    nets: { '172.30.7.254': 'ks', '172.30.8.254': 'app', '172.30.9.254': 'ledger' },
    routes: [
      r('web', [80], { net: 'ks' }), r('ledger-web', [80], { net: 'ks' }),
      r('web', [80], { net: 'app' }), r('ledger-web', [80], { net: 'ledger', aliases: ['ledger-web'] }),
      r('postgres-ish', [5432], { net: 'app', proto: 'tcp' }), r('ledger-postgres-ish', [5432], { net: 'ledger', proto: 'tcp', aliases: ['postgres-ish'] }),
      r('api', [18080], { net: 'ledger', aliases: ['host.docker.internal'], portMap: { 18080: 3000 }, kind: 'host-port' }),
      r('api', [3000], { net: 'ledger', aliases: ['api'], visible: true }), r('ledger', [3000], { net: 'ledger' }),
      r('web', [30000], { aliases: [], portMap: { 30000: 80 }, kind: 'pinned' }),
    ],
  };
  assert.equal(routeFor(cfg, 80, 'ledger-web', '172.30.7.254')?.svc, 'ledger-web', 'two on ks: Host decides');
  assert.equal(routeFor(cfg, 80, 'anything', '172.30.8.254')?.svc, 'web', 'one on the app network: it is the route, whatever the Host (nginx forwards the browser\'s)');
  assert.equal(routeFor(cfg, 5432, undefined, '::ffff:172.30.9.254')?.svc, 'ledger-postgres-ish', 'an ::ffff: address is stripped; tcp picks by network');
  assert.equal(routeFor(cfg, 5432, undefined, '172.30.8.254')?.svc, 'postgres-ish');
  const hp = routeFor(cfg, 18080, 'host.docker.internal:18080', '172.30.9.254');
  assert.equal(hp?.svc, 'api');
  assert.deepEqual(hp?.portMap, { 18080: 3000 });
  assert.equal(routeFor(cfg, 3000, 'api:3000', '172.30.9.254')?.svc, 'api');
  assert.equal(routeFor(cfg, 3000, 'ledger:3000', '172.30.9.254')?.svc, 'ledger');
  assert.equal(routeFor(cfg, 3000, 'ledger-web', '172.30.9.254')?.svc, 'ledger', 'nginx forwarding the browser\'s Host reaches its own project\'s service, not one reached by name');
  // a service published on the same port it listens on (8080:8080): the Host decides, and a Host naming neither is
  // the service's own route, never the published port's
  // (the host-port route listed first, and the service's own route aliased by its compose name, as in a joint env)
  const [hostPort, own] = [r('vaultflow-gw', [8080], { net: 'app', aliases: ['host.docker.internal'], portMap: { 8080: 8080 }, kind: 'host-port' }), r('vaultflow-gw', [8080], { net: 'app', aliases: ['gw'] })];
  const same = { nets: cfg.nets, routes: [hostPort, own] };
  for (const host of ['frontend', 'gw:8080', 'vaultflow-gw:8080']) assert.equal(routeFor(same, 8080, host, '172.30.8.254'), own, host);
  assert.equal(routeFor(same, 8080, 'host.docker.internal:8080', '172.30.8.254'), hostPort);
  assert.equal(routeFor(cfg, 30000, 'whatever', '10.0.0.1')?.svc, 'web', 'a pinned port ignores network and Host');
  // an env of one network: routes have no net, as before
  const one = { routes: [r('a', [80]), r('b', [80]), r('t1', [9000], { proto: 'tcp' }), r('t2', [9000], { proto: 'tcp' })] };
  assert.equal(routeFor(one, 80, 'b:80', '172.30.1.254')?.svc, 'b');
  assert.equal(routeFor(one, 80, 'c', '172.30.1.254'), undefined);
  assert.equal(routeFor(one, 9000, undefined, '172.30.1.254')?.svc, 't1', 'of several tcp routes the first');
});
