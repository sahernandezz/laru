/**
 * The tap: one process per environment that holds the aliases of every intercepted service, forwards each
 * exchange unchanged and records it, masked, in traffic.jsonl. Faults are applied here too, so one process
 * sees and shapes all the traffic. Stdlib only and relative imports, because it runs from Laru's
 * packages/ mounted read-only into a node:24-alpine container: `node /ks/packages/runtime/tap/tap.ts /ks/env`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, readFileSync, statSync, truncateSync, unwatchFile, watchFile, writeFileSync, type WriteStream } from 'node:fs';
import { Agent, createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { connect, createServer as createTcpServer, type Server, type Socket } from 'node:net';
import { Resolver } from 'node:dns';
import { Agent as TlsAgent, request as tlsRequest } from 'node:https';
import { createSecureContext, createServer as createTlsServer, type SecureContext } from 'node:tls';
import { basename, join } from 'node:path';
import { pipeline, Transform, type Duplex, type Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createMasker, MASK_KEYS, readLearned, readMaskFile, type Masker } from '../../trace/src/mask.ts';
import { pgWatcher, type PgResult } from './pg.ts';
import type { FaultRule, MockSpec, TapConfig, TapRoute, TapRules, TrafficRecord } from '../src/types.ts';
import { loadMock, type Mock } from './mocks.ts';
import type { SinkHost } from './sink.ts';

/** Bytes of each body kept for the record; bodies themselves are streamed whole. */
const TEE = 64 * 1024;
const ROTATE = 100 * 1024 * 1024;
const LOG_ROTATE = 10 * 1024 * 1024;
/** Bytes kept of a multipart field's value, and characters of a part's name or filename. */
const FIELD = 1024;
const NAME = 256;
/** Journal bytes waiting for the disk beyond which new lines are dropped (and counted in tap.log), not held in memory. */
const BACKLOG = 8 * 1024 * 1024;
/** Multipart parts listed in a record; the rest are counted. */
const PARTS = 100;
const TEXTUAL = /^text\/(?!css|javascript)|^application\/(?:[\w.-]+\+)?(?:json|xml|x-www-form-urlencoded|x-ndjson|x-amz-json-[\d.]+)(?:[\s;]|$)/i;
const EVENTS = /^text\/event-stream/i;
/** How each applied fault is written on its exchange, as the plan words it. */
const FAULT = {
  latency: (ms: number) => `latencia +${ms} ms inyectada`,
  abort: 'abortado',
  timeout: 'sin respuesta',
  status: (status: number) => `estado ${status} inyectado`,
  stage: (stage: string, status: number) => `respuesta ${status} en ${stage} inyectada`,
  bandwidth: (bps: number, after: number) => `ancho de banda ${bps} B/s${after ? ` tras ${after} B` : ''}`,
};

export interface Tap {
  close(): Promise<void>;
  ports(): number[];
  setRules(r: TapRules): void;
  /** the known values changed (mask.json was rewritten): every record from now on uses this masker */
  setMasker(m: Masker): void;
  /** a masked line in tap.log, written without blocking */
  log(msg: string): void;
}

type Hit = { route: TapRoute; port: number; /** the Host a browser used at the entrance, when the request came that way */ entrance?: string };
type Body = NonNullable<TrafficRecord['req']>;

export async function startTap(o: { config: TapConfig; rules: TapRules; masker: Masker; out: string; host?: string; rotate?: number; mocks?: { root: string; openapiDir?: string }; /** where a sink's learned codes go, and how to build the masker again with them; `vault` is the masker with the vault's values only, which is what the mailbox itself uses */ learned?: { file: string; rebuild(): Masker; vault?(): Masker } }): Promise<Tap> {
  const { config } = o;
  let { rules, masker } = o;
  // Mocks answer for their service: rebuilt when the rules change; a script keeps one state per env.
  let mocks = new Map<string, Mock>();
  const mockState = new Map<string, Record<string, unknown>>();
  const loadMocks = async (r: TapRules) => {
    const next = new Map<string, Mock>();
    for (const [svc, spec] of Object.entries(r.mocks ?? {})) {
      if (!o.mocks && spec.mode !== 'sink') { log(`mock ${svc}: no mocks folder mounted`); continue; }
      try {
        const oa = o.mocks?.openapiDir ? join(o.mocks.openapiDir, `${svc}.openapi.json`) : '';
        const openapi = oa && existsSync(oa) ? JSON.parse(readFileSync(oa, 'utf8')) : undefined;
        if (!mockState.has(svc)) mockState.set(svc, {});
        next.set(svc, await loadMock(svc, spec, join(o.mocks?.root ?? o.out, spec.dir ?? svc), { openapi, state: mockState.get(svc), masker: () => masker, ...(spec.mode === 'sink' ? { sink: sinkFor(svc) } : {}) }));
      } catch (e) { log(`mock ${svc}: ${(e as Error).message}`); }
    }
    mocks = next;
  };
  const counters = new Map<string, number>();
  // A sink keeps what it receives and learns the codes and tokens in it; they are masked everywhere but in the mailbox.
  const learned = new Set<string>(o.learned ? readLearned(o.learned.file) : []);
  const learn = (values: string[]) => {
    let added = false;
    for (const v of values) if (v.length >= 4 && v.length <= 2000 && learned.size < 200 && !learned.has(v)) { learned.add(v); added = true; }
    if (!added || !o.learned) return;
    try { writeFileSync(o.learned.file, JSON.stringify([...learned]), { mode: 0o600 }); masker = o.learned.rebuild(); } catch (e) { log(`learned.json: ${(e as Error).message}`); }
  };
  const sharedBox: Record<string, any> = {};
  const sinkFor = (svc: string): SinkHost => ({
    out: o.out, svc, shared: sharedBox,
    open: (file) => openJournal(file, log, 20 * 1024 * 1024),
    log, masker: () => (o.learned?.vault ? o.learned.vault() : masker), learn,
    faults: (stage, who) => faultsFor(svc, 'sink', stage, who),
    linkEnv: { local: (h) => config.routes.some((r) => r.svc === h || r.aliases.includes(h)) },
    record: (patch) => journal.write({ v: 1, id: randomUUID(), kind: 'tcp', t0: Date.now(), from: '', svc, port: 0, ...patch } as TrafficRecord),
    call,
    ...(routeTls(svc) ? { tls: routeTls(svc) } : {}),
  });
  const routeTls = (svc: string): SecureContext | undefined => {
    const t = config.routes.find((r) => r.svc === svc && r.tls)?.tls;
    return t ? createSecureContext({ cert: readFileSync(t.cert), key: readFileSync(t.key) }) : undefined;
  };
  /** The app's own webhook, from a sink: http only, a service of this env by name (never an IP, host.docker.internal or a name of the internet), no redirect followed, 10 s, 64 KB. */
  const call: SinkHost['call'] = (url, form, headers) => new Promise((done) => {
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    let u: URL;
    try { u = new URL(url); } catch { return done({ ms: 0, skipped: 'not a URL' }); }
    const port = Number(u.port || 80);
    const route = u.protocol === 'http:' ? config.routes.find((r) => r.proto === 'http' && !r.kind && r.upstream && r.upstream !== 'host.docker.internal' && (r.svc === u.hostname || r.aliases.includes(u.hostname)) && r.ports.includes(port)) : undefined;
    if (!route) return done({ ms: 0, skipped: 'not sent: its destination is not a service of this env' });
    const body = new URLSearchParams(form).toString();
    const req = request({ host: route.upstream, port: route.portMap?.[port] ?? port, method: 'POST', path: u.pathname + u.search, agent: false, timeout: 10_000,
      headers: { ...headers, host: u.host, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const parts: Buffer[] = [];
      let n = 0;
      res.on('data', (c: Buffer) => { n += c.length; if (n <= 65536) parts.push(c); });
      res.on('end', () => done({ http: res.statusCode, ms: ms(), body: Buffer.concat(parts).toString('utf8') }));
      res.on('error', (e) => done({ ms: ms(), skipped: e.message }));
    });
    req.on('timeout', () => { req.destroy(); done({ ms: ms(), skipped: 'no answer in 10 s' }); });
    req.on('error', (e) => done({ ms: ms(), skipped: e.message }));
    req.end(body);
  });
  // tap.log is written like the journal: rotated, never blocking, reopened after an error (its own errors go to stderr).
  const logFile = openJournal(join(o.out, 'tap.log'), (e) => console.error(`laru tap: ${e}`), o.rotate ?? LOG_ROTATE);
  /** tap.log never gets a raw URL, header or value: every line is masked. */
  const log = (msg: string) => logFile.write(`${new Date().toISOString()} ${masker.text(msg)}`);
  const journal = openJournal(join(o.out, 'traffic.jsonl'), log, o.rotate);
  const agent = new Agent({ keepAlive: true });
  const tlsAgent = new TlsAgent({ keepAlive: true });
  // The env's DNS answers a mocked host's name with the tap itself: the real one is asked of public resolvers.
  const resolver = new Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const publicLookup = (host: string, opts: { all?: boolean }, cb: (e: Error | null, a: any, f?: number) => void) =>
    resolver.resolve4(host, (e, addrs) => (e ? cb(e, undefined) : opts.all ? cb(null, addrs.map((address) => ({ address, family: 4 }))) : cb(null, addrs[0], 4)));
  const sockets = new Set<Duplex>();
  const track = (s: Duplex) => { sockets.add(s); s.once('close', () => sockets.delete(s)); };

  const byPort = new Map<number, TapRoute[]>();
  for (const r of config.routes) for (const p of r.ports) byPort.set(p, [...(byPort.get(p) ?? []), r]);
  // A port speaks one protocol: https routes (one per host, told apart by SNI) or http routes win over tcp ones, and of
  // several tcp routes the first does — in a joint env, the one of the network the connection came in on.
  for (const [port, rs] of byPort) {
    const web = rs.filter((r) => r.proto === (rs.some((x) => x.proto === 'https') ? 'https' : 'http'));
    if (web.length === rs.length || (!web.length && config.nets)) continue;
    const kept = web.length ? web : [rs[0]];
    if (rs.length > 1) log(`port ${port}: ${rs.map((r) => `${r.svc} (${r.proto})`).join(', ')} share it; only ${kept.map((r) => r.svc).join(', ')} get its traffic`);
    byPort.set(port, kept);
  }

  /** Port first, then the network it came in on, then Host (nginx forwards the browser's Host). */
  const pick = (port: number, host?: string, local?: string): Hit | undefined => {
    const r = routeFor({ routes: byPort.get(port) ?? [], nets: config.nets }, port, host, local);
    return r && { route: r, port };
  };
  /** The entrance: `<svc>[-<port>].<app>.localhost`, by Host only. */
  const enter = (host?: string): Hit | undefined => {
    const h = hostname(host);
    const suffix = `.${config.app}.localhost`;
    if (!h.endsWith(suffix)) return;
    const label = h.slice(0, -suffix.length);
    const web = config.routes.filter((r) => r.proto === 'http' && !r.kind && (!r.net || r.net === 'ks'));
    const exact = web.find((r) => r.svc === label);
    if (exact) return { route: exact, port: exact.ports[0] };
    const m = /^(.+)-(\d+)$/.exec(label);
    const r = m ? web.find((x) => x.svc === m[1] && x.ports.includes(Number(m[2]))) : undefined;
    return r && { route: r, port: Number(m![2]) };
  };
  const resolve = (port: number | null, host?: string, local?: string) => (port === null ? enter(host) : pick(port, host, local));
  const target = ({ route, port }: Hit) => ({ host: route.upstream, port: route.portMap?.[port] ?? port });

  /**
   * Faults whose filters match and whose `p` roll passes; the roll depends only on the seed and the request's index on the route.
   * A tcp connection has no method or path, so a rule that filters on them never applies to it.
   */
  const faultsFor = (svc: string, from: string, method?: string, path?: string): FaultRule[] => {
    const list = rules.faults?.[svc] ?? [];
    if (!list.length) return [];
    const n = counters.get(svc) ?? 0;
    counters.set(svc, n + 1);
    return list.filter((f, i) => (!f.from || rules.peers?.[from] === f.from)
      && (!f.method || f.method.toUpperCase() === method)
      && (!f.path || (path !== undefined && matches(f.path, path)))
      && roll(rules.seed, svc, n, i) < (f.p ?? 1));
  };

  async function exchange(req: IncomingMessage, res: ServerResponse, hit: Hit) {
    const arrived = performance.now();
    const from = peer(req.socket);
    const [path, qs] = splitUrl(req.url ?? '/');
    const method = req.method ?? 'GET';
    const named = screenOf(req.headers);
    const rec: TrafficRecord = {
      v: 1, id: randomUUID(), kind: 'http', t0: Date.now(), from, ...(named.screen ? { screen: named.screen } : {}), svc: hit.route.svc, port: hit.port, method,
      path: masker.text(path), query: qs ? masker.query(qs) : undefined, reqHeaders: masker.headers(named.rest),
    };
    const labels: string[] = [];
    let reqBody: (() => Body) | undefined;
    let resBody: (() => Body) | undefined;
    /** An event stream's answer, fed as it arrives: each event its own sse record. */
    const sse = () => {
      let n = 0;
      return events((e) => journal.write({
        v: 1, id: `${rec.id}.${++n}`, kind: 'sse', t0: Date.now(), from, svc: rec.svc, port: rec.port, method, path: rec.path, query: rec.query,
        event: { name: e.name === undefined ? undefined : masker.text(e.name), data: e.data.length > TEE + masker.margin ? masker.cut(e.data.slice(0, TEE + masker.margin), 'end', masker.body) : masker.body(e.data) },
      }));
    };
    res.once('close', () => {
      rec.t1 = Date.now();
      rec.req = reqBody?.();
      rec.res = resBody?.() ?? rec.res;
      if (labels.length) rec.fault = labels.join(', ');
      journal.write(rec);
    });

    const p = plan(mocks.get(hit.route.svc)?.sink ? [] : faultsFor(hit.route.svc, from, method, path));
    if (p.latency) {
      labels.push(FAULT.latency(p.latency));
      await new Promise((r) => setTimeout(r, p.latency));
      if (req.socket.destroyed) return;
    }
    if (p.abort) {
      labels.push(FAULT.abort);
      return void req.socket.destroy();
    }
    // The capture listener and the pipe (or resume) are attached in the same tick, so no chunk is lost.
    reqBody = capture(req, req.headers, masker);
    if (p.timeout) {
      labels.push(FAULT.timeout);
      return void req.resume();
    }
    if (p.status) {
      labels.push(FAULT.status(p.status));
      req.resume();
      const text = `laru fault: status ${p.status}\n`;
      rec.status = p.status;
      rec.res = { bytes: Buffer.byteLength(text), text };
      return void res.writeHead(p.status, { 'content-type': 'text/plain', 'x-laru-fault': labels.join(', ') }).end(text);
    }
    const { slow } = p;
    if (slow) labels.push(FAULT.bandwidth(slow.bps, slow.after));

    // An Upgrade that is not a WebSocket (the JDK client's h2c) is answered as HTTP/1.1: the hop asks for nothing.
    const headers = { ...named.rest };
    if (headers.upgrade && !/websocket/i.test(String(headers.upgrade))) {
      delete headers.upgrade;
      delete headers['http2-settings'];
      if (headers.connection) headers.connection = String(headers.connection).split(',').map((t) => t.trim()).filter((t) => !/^(upgrade|http2-settings)$/i.test(t)).join(', ') || 'keep-alive';
    }

    // At the entrance a browser is at `<svc>.<app>.localhost:<port>`, a name no service knows: its Host, Origin and Referer say
    // the name the service has inside the env (what a client there sends), so the app's own same-origin and CORS checks see
    // what they would in production. The answer's Location and allowed origin are put back for the browser.
    const inside = (h: string) => { const x = enter(h); return x ? `${x.route.svc}${x.port === 80 ? '' : `:${x.port}`}` : h; };
    if (hit.entrance) {
      headers.host = inside(hit.entrance);
      for (const k of ['origin', 'referer'] as const) if (typeof headers[k] === 'string') headers[k] = (headers[k] as string).replace(/^(\w+:\/\/)([^/]+)/, (_m, scheme: string, host: string) => scheme + inside(host));
    }

    const mock = mocks.get(hit.route.svc);
    let body: Buffer | undefined;
    if (mock) {
      body = await readAll(req, 16 * 1024 * 1024);
      const r = await mock.http({ method, path, query: qs ?? '', headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])), body });
      if (r) {
        rec.mock = r.mock;
        if (r.msg) rec.msg = r.msg;
        if (r.hideReq) reqBody = () => ({ bytes: body!.length, note: 'cuerpo en el buzón' });
        if (r.drift?.length) rec.drift = r.drift.map((d) => masker.text(d));
        rec.status = r.status;
        rec.resHeaders = masker.headers(r.headers);
        // Recorded as a forwarded body is (the request already is, by capture): textual, multipart, encodings and events alike.
        resBody = capture(r.body, r.headers, masker);
        if (EVENTS.test(r.headers['content-type'] ?? '')) sse()(r.body);
        return void res.writeHead(r.status, r.headers).end(r.body);
      }
      if (!hit.route.upstream) {
        rec.status = 502;
        return void res.writeHead(502, { 'content-type': 'text/plain' }).end(`laru tap: mock ${hit.route.svc} has no answer and no real service to forward to\n`);
      }
    }

    const secure = hit.route.proto === 'https';
    const upReq = (secure ? tlsRequest : request)({ ...target(hit), method, path: req.url, headers, ...(secure ? { agent: tlsAgent, servername: hit.route.upstream, lookup: publicLookup as never } : { agent }) }, (up) => {
      const answered = performance.now();
      if (mock?.mode === 'record') {
        const chunks: Buffer[] = [];
        let size = 0;
        up.on('data', (c: Buffer) => { size += c.length; if (size <= 16 * 1024 * 1024) chunks.push(c); });
        up.once('end', () => { if (size <= 16 * 1024 * 1024) mock.recorded({ method, path, query: qs ?? '', headers: {}, body: body ?? Buffer.alloc(0) }, { status: up.statusCode ?? 0, headers: Object.fromEntries(Object.entries(up.headers).map(([k, v]) => [k, String(v)])), body: Buffer.concat(chunks) }); });
        rec.mock = 'record';
      }
      rec.status = up.statusCode;
      rec.resHeaders = masker.headers(up.headers);
      const stream = EVENTS.test(String(up.headers['content-type'] ?? ''));
      resBody = capture(up, up.headers, masker);
      if (stream) up.on('data', sse());
      const raw = hit.entrance ? up.rawHeaders.map((v, i) => (i % 2 && /^(location|access-control-allow-origin)$/i.test(up.rawHeaders[i - 1]) ? v.split(`://${headers.host}`).join(`://${hit.entrance}`) : v)) : up.rawHeaders;
      res.writeHead(up.statusCode ?? 502, up.statusMessage, raw);
      if (stream) res.flushHeaders();
      // what the tap costs a hop: a deliberate fault's delay is not its own, a mock answers instead of forwarding
      if (sent !== undefined && !labels.length && !mock) rec.tap = Math.round((sent - arrived + performance.now() - answered) * 100) / 100;
      pipeline([up, ...(slow ? [throttle(slow.bps, slow.after)] : []), res], () => {});
    });
    upReq.on('error', (e) => {
      rec.error = masker.text(e.message);
      if (res.headersSent) return void res.destroy();
      rec.status = 502;
      res.writeHead(502, { 'content-type': 'text/plain' }).end(`laru tap: ${hit.route.svc} upstream: ${e.message}\n`);
    });
    let sent: number | undefined;
    upReq.once('socket', (s: Socket) => { const at = () => { sent = performance.now(); }; if (s.connecting) s.once(secure ? 'secureConnect' : 'connect', at); else at(); });
    res.once('close', () => { if (!res.writableFinished) upReq.destroy(); });
    if (body) { rec.mock ??= 'forwarded'; upReq.end(body); } else req.pipe(upReq);
  }

  /**
   * TCP routes, WebSocket (or any) upgrades and h2c: bytes both ways, nothing decoded. Faults shape the connection as
   * they shape an exchange: latency before connecting upstream, abort, timeout (bytes read, never forwarded), bandwidth
   * on the way down, and a status for an upgrade. `open` connects upstream once the faults let it.
   */
  async function tunnel(client: Duplex, open: () => Socket, rec: TrafficRecord, faults: FaultRule[]) {
    const p = plan(faults);
    const labels: string[] = [];
    const upPeek = peeker(masker.margin);
    const downPeek = peeker(masker.margin);
    const done = () => {
      rec.t1 = Date.now();
      rec.req = { bytes: upPeek.bytes() };
      rec.res = { bytes: downPeek.bytes() };
      if (labels.length) rec.fault = labels.join(', ');
      if (rec.kind === 'tcp') rec.peek = { up: upPeek.text(masker), down: downPeek.text(masker) };
      journal.write(rec);
    };
    client.on('error', (e) => { rec.error ??= masker.text(e.message); });
    if (p.latency) {
      labels.push(FAULT.latency(p.latency));
      await new Promise((r) => setTimeout(r, p.latency));
      if (client.destroyed) return done();
    }
    if (p.abort) {
      labels.push(FAULT.abort);
      client.destroy();
      return done();
    }
    client.on('data', (b: Buffer) => upPeek.add(b));
    if (p.timeout) {
      labels.push(FAULT.timeout);
      client.once('end', () => client.end()); // nothing is ever written, so only the client's end shows it has gone
      client.once('close', done);
      return void client.resume();
    }
    if (rec.kind === 'ws' && p.status) {
      labels.push(FAULT.status(p.status));
      rec.status = p.status;
      client.once('close', done);
      return void client.end(`HTTP/1.1 ${p.status} Laru Fault\r\nX-Laru-Fault: ${labels.join(', ')}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
    const up = open();
    track(up);
    up.on('data', (b: Buffer) => {
      if (rec.kind === 'ws' && !downPeek.bytes()) rec.status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(b.toString('latin1', 0, 16))?.[1]) || undefined;
      downPeek.add(b);
    });
    up.on('error', (e) => { rec.error ??= masker.text(e.message); client.destroy(); });
    client.on('error', () => up.destroy());
    client.pipe(up);
    if (p.slow) labels.push(FAULT.bandwidth(p.slow.bps, p.slow.after));
    (p.slow ? up.pipe(throttle(p.slow.bps, p.slow.after)) : up).pipe(client);
    let ends = 2;
    const closed = () => { if (!--ends) done(); };
    client.once('close', () => { up.destroy(); closed(); });
    up.once('close', () => {
      // Bytes still on their way down (behind the throttle, or not flushed yet) reach the client first; a reset upstream resets it.
      const end = () => client.destroy();
      if (!up.readableEnded || client.writableFinished) end();
      else client.once('finish', end);
      closed();
    });
  }

  function upgrade(port: number | null) {
    return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const hit = resolve(port, req.headers.host, req.socket.localAddress);
      if (!hit) return void socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      const [path, qs] = splitUrl(req.url ?? '/');
      const from = peer(socket as Socket);
      const method = req.method ?? 'GET';
      const open = () => {
        const up = connect({ ...target(hit), allowHalfOpen: true });
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() !== SCREEN) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(lines.join('\r\n') + '\r\n\r\n');
        if (head.length) up.write(head);
        return up;
      };
      tunnel(socket, open, {
        v: 1, id: randomUUID(), kind: 'ws', t0: Date.now(), from, ...(screenOf(req.headers).screen ? { screen: screenOf(req.headers).screen } : {}), svc: hit.route.svc, port: hit.port, method,
        path: masker.text(path), query: qs ? masker.query(qs) : undefined, reqHeaders: masker.headers(screenOf(req.headers).rest),
      }, faultsFor(hit.route.svc, from, method, path)).catch((e: Error) => { log(`upgrade ${path}: ${e.stack}`); socket.destroy(); });
    };
  }

  function http(port: number | null) {
    // Only WebSocket upgrades are tunnelled; any other Upgrade (h2c) is a plain request.
    const srv = createServer({ requestTimeout: 0, headersTimeout: 60_000, shouldUpgradeCallback: (req) => /websocket/i.test(String(req.headers.upgrade ?? '')) }, (req, res) => {
      if (port === null && req.method === 'GET' && req.url === '/__ks/health') {
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(`{"ok":true,"t":${Date.now()}}`);
      }
      const [path, qs] = splitUrl(req.url ?? '/');
      const hit = resolve(port, req.headers.host, req.socket.localAddress);
      if (hit && port === null) hit.entrance = req.headers.host;
      if (!hit) {
        log(`421 ${req.method} ${masker.text(path)}${qs ? `?${masker.query(qs)}` : ''} host=${req.headers.host} on ${port ?? 'entrance'}`);
        return void res.writeHead(421, { 'content-type': 'text/plain' }).end(`laru tap: no route for host ${req.headers.host} on port ${port ?? config.entrance}\n`);
      }
      exchange(req, res, hit).catch((e: Error) => { log(`exchange ${masker.text(path)}: ${e.stack}`); res.destroy(); });
    });
    // Node closes an idle keep-alive connection after 5 s; a pooled client (OkHttp re-checks only after 10 s) then
    // sends on a dead socket, which the real server would have kept open. The client decides when to drop it.
    srv.keepAliveTimeout = 0;
    srv.on('upgrade', upgrade(port));
    return srv;
  }

  /** A tcp listener: the route is picked per connection, by the network it came in on. */
  function tcp(port: number): Server {
    const handle = (client: Socket, implicit: boolean) => {
      const hit = pick(port, undefined, client.localAddress);
      if (!hit) { log(`tcp on ${port} from ${peer(client)}: no route on that network`); return void client.destroy(); }
      const mock = mocks.get(hit.route.svc);
      if (mock?.tcp) return answerTcp(client, hit, mock, implicit);
      pass(client, hit);
    };
    // A sink's port that starts encrypted (465): TLS ends here, with the certificate of the sink's name, and the protocol runs inside.
    const first = byPort.get(port)?.[0];
    const implicit = first ? mocks.get(first.svc)?.implicitTls?.includes(port) : false;
    const ctx = first && implicit ? routeTls(first.svc) : undefined;
    if (ctx) {
      const srv = createTlsServer({ SNICallback: (_n, cb) => cb(null, ctx), allowHalfOpen: true }, (c) => handle(c as unknown as Socket, true));
      srv.on('tlsClientError', (e) => log(`tls on ${port}: ${e.message}`));
      return srv;
    }
    return createTcpServer({ allowHalfOpen: true }, (client) => handle(client, false));
  }
  /**
   * Postgres, passed through byte for byte and read on the way: each statement's columns, first rows and tag (or error)
   * become a record of its own, masked as a body is (a secret-looking column whole, known values anywhere).
   */
  function pg(port: number): Server {
    return createTcpServer({ allowHalfOpen: true, noDelay: true }, (client) => {
      const hit = pick(port, undefined, client.localAddress);
      if (!hit) { log(`pg on ${port} from ${peer(client)}: no route on that network`); return void client.destroy(); }
      const from = peer(client);
      const w = pgWatcher((r: PgResult) => {
        const hide = r.cols.map((c) => MASK_KEYS.test(c));
        const now = Date.now();
        journal.write({ v: 1, id: randomUUID(), kind: 'pg', t0: now, t1: now, from, svc: hit.route.svc, port: hit.port, pg: {
          ...r, stmt: masker.text(r.stmt), rows: r.rows.map((row) => row.map((v, i) => (hide[i] && v !== 'NULL' ? '••••' : masker.text(v)))), ...(r.error ? { error: masker.text(r.error) } : {}),
        } });
      });
      const up = connect({ ...target(hit), allowHalfOpen: true, noDelay: true });
      track(up);
      client.on('data', (b: Buffer) => { try { w.up(b); } catch (e) { log(`pg ${hit.route.svc}: ${(e as Error).message}`); } });
      up.on('data', (b: Buffer) => { try { w.down(b); } catch (e) { log(`pg ${hit.route.svc}: ${(e as Error).message}`); } });
      client.pipe(up); up.pipe(client);
      const end = () => { client.destroy(); up.destroy(); };
      client.on('error', end); up.on('error', end); client.on('close', end); up.on('close', end);
    });
  }
  /** A tcp mock speaks the protocol itself; the record keeps byte counts and a masked peek of its answer, as a tunnel's. */
  function answerTcp(client: Socket, hit: Hit, mock: Mock, implicit = false) {
    const rec: TrafficRecord = { v: 1, id: randomUUID(), kind: 'tcp', t0: Date.now(), from: peer(client), svc: hit.route.svc, port: hit.port, mock: 'script' };
    const down = peeker(masker.margin);
    const write = client.write.bind(client);
    const tee = (c: unknown) => { if (typeof c === 'string' || Buffer.isBuffer(c)) down.add(Buffer.isBuffer(c) ? c : Buffer.from(c)); };
    client.write = ((c: unknown, ...rest: unknown[]) => { tee(c); return (write as (...a: unknown[]) => boolean)(c, ...rest); }) as typeof client.write;
    const end = client.end.bind(client);
    client.end = ((c?: unknown, ...rest: unknown[]) => { if (c !== undefined && typeof c !== 'function') tee(c); return (end as (...a: unknown[]) => Socket)(c, ...rest); }) as typeof client.end;
    if (!mock.quiet) client.once('close', () => {
      rec.t1 = Date.now();
      rec.req = { bytes: client.bytesRead };
      rec.res = { bytes: client.bytesWritten };
      rec.peek = { down: down.text(masker) };
      journal.write(rec);
    });
    client.on('error', () => {});
    mock.tcp!(client, { port: hit.port, implicit, from: peer(client) });
  }
  /** A tcp tunnel to a route: tcp routes, and h2c prior knowledge on an http one. */
  function pass(client: Socket, hit: Hit) {
    const from = peer(client);
    tunnel(client, () => connect({ ...target(hit), allowHalfOpen: true }), { v: 1, id: randomUUID(), kind: 'tcp', t0: Date.now(), from, svc: hit.route.svc, port: hit.port }, faultsFor(hit.route.svc, from))
      .catch((e: Error) => { log(`tcp ${hit.route.svc}: ${e.stack}`); client.destroy(); });
  }

  const inner: HttpServer[] = [];
  /**
   * An http listener. It reads the first bytes: HTTP/1 goes to the http server, and h2c prior knowledge (gRPC, which
   * compose cannot announce) is passed through as tcp, not decoded.
   */
  function web(port: number | null) {
    const srv = http(port);
    srv.emit('listening'); // starts its header-timeout checks: it gets connections from the listener below, never listens itself
    inner.push(srv);
    return createTcpServer({ allowHalfOpen: true, noDelay: true }, (socket) => {
      socket.on('error', () => {}); // a reset before the first bytes; later errors have their own listeners
      let got = Buffer.alloc(0);
      const sniff = (b: Buffer) => {
        got = Buffer.concat([got, b]);
        if (got.length < 4 && 'PRI '.startsWith(got.toString('latin1'))) return;
        socket.off('data', sniff);
        socket.unshift(got);
        if (got.toString('latin1', 0, 4) !== 'PRI ') return void srv.emit('connection', socket);
        socket.pause();
        const hit = port === null ? undefined : pick(port, undefined, socket.localAddress);
        if (!hit) {
          log(`h2c on ${port ?? 'entrance'}: no single route to pass it to`);
          return void socket.destroy();
        }
        pass(socket, hit);
      };
      socket.on('data', sniff);
    });
  }

  /** An https listener: TLS ends here with the certificate of the host the client asked for (SNI), then it is http. */
  function secure(port: number) {
    const srv = http(port);
    srv.emit('listening');
    inner.push(srv);
    const contexts = new Map<string, SecureContext>();
    for (const r of byPort.get(port) ?? []) if (r.tls) contexts.set(r.svc, createSecureContext({ cert: readFileSync(r.tls.cert), key: readFileSync(r.tls.key) }));
    const fallback = [...contexts.values()][0];
    const tls = createTlsServer({ SNICallback: (name, cb) => cb(null, contexts.get(name) ?? fallback) }, (socket) => srv.emit('connection', socket));
    tls.on('tlsClientError', (e) => log(`tls on ${port}: ${e.message}`));
    return tls;
  }

  const servers: Server[] = [];
  const listen = (srv: Server, port: number) => new Promise<void>((ok, fail) => {
    servers.push(srv);
    srv.on('connection', track);
    srv.once('error', fail);
    srv.listen(port, o.host ?? '0.0.0.0', () => { srv.off('error', fail); ok(); });
  });
  const close = async () => {
    for (const m of mocks.values()) m.stop?.();
    for (const s of sockets) s.destroy();
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    for (const s of inner) s.close();
    agent.destroy();
    tlsAgent.destroy();
    await journal.close();
    await logFile.close();
  };
  await loadMocks(rules);
  try {
    for (const [port, rs] of byPort) await listen(rs[0].proto === 'tcp' ? tcp(port) : rs[0].proto === 'pg' ? pg(port) : rs[0].proto === 'https' ? secure(port) : web(port), port);
    await listen(web(null), config.entrance);
  } catch (e) {
    await close();
    throw e;
  }
  const ports = () => servers.map((s) => (s.address() as { port: number }).port);
  log(`listening on ${ports().join(', ')} (entrance ${config.entrance}) for ${config.routes.map((r) => r.svc).join(', ')}`);
  return {
    close,
    ports,
    log,
    setRules(r) {
      rules = r;
      counters.clear();
      void loadMocks(r);
    },
    setMasker(m) {
      masker = m;
    },
  };
}

/** Script mode: reads routes.json, then rules.json and mask.json from the state dir, both hot-reloaded every 500 ms. */
export async function runTap(dir: string, host?: string): Promise<Tap> {
  const file = (f: string) => join(dir, f);
  const rules = (): TapRules => ({ seed: 0, faults: {}, mocks: {}, peers: {}, ...(existsSync(file('rules.json')) ? JSON.parse(readFileSync(file('rules.json'), 'utf8')) : {}) });
  const masker = () => {
    const { key, values } = readMaskFile(file('mask.json'));
    const learned = readLearned(file('learned.json'));
    return createMasker([...values, ...learned], key, { short: learned });
  };
  const root = existsSync('/ks/mocks') ? '/ks/mocks' : join(dir, '..', '..', '..', '..', 'mocks');
  const tap = await startTap({ config: JSON.parse(readFileSync(file('routes.json'), 'utf8')), rules: rules(), masker: masker(), out: dir, host, mocks: { root, openapiDir: file('mocks') }, learned: { file: file('learned.json'), rebuild: masker, vault: () => { const { key, values } = readMaskFile(file('mask.json')); return createMasker(values, key); } } });
  const watch = (f: string, what: string, apply: () => void) => watchFile(file(f), { interval: 500 }, () => {
    try {
      apply();
      tap.log(`${what} reloaded`);
    } catch (e) {
      // A mask.json error could quote the file, so only rules.json's is shown.
      tap.log(`${f} ignored${f === 'rules.json' ? `: ${(e as Error).message}` : ''}`);
    }
  });
  watch('rules.json', 'rules', () => tap.setRules(rules()));
  watch('mask.json', 'mask', () => {
    if (!existsSync(file('mask.json'))) throw new Error('gone: the last values stay');
    tap.setMasker(masker());
  });
  return {
    ...tap,
    close: async () => {
      unwatchFile(file('rules.json'));
      unwatchFile(file('mask.json'));
      await tap.close();
    },
  };
}

/**
 * An append-only file of lines (traffic.jsonl, tap.log), rotated at `rotate` bytes keeping one previous file. It never
 * blocks the tap or takes it down: while the disk is behind (more than BACKLOG waiting) or failing, lines are dropped
 * and counted through `log`, and a failed file is reopened at most once a second.
 * Rotation copies the file to `.1` and empties it in place, once what was written has reached it: the file keeps its
 * inode, so a reader that has it mounted (a runner's `observed`) goes on seeing it; a rename left it reading a file
 * that no longer grew. Lines that come meanwhile wait in memory, within the same backlog.
 */
export function openJournal(file: string, log: (msg: string) => void, rotate = ROTATE) {
  const name = basename(file);
  let size = 0;
  try { size = statSync(file).size; } catch { /* a new file */ }
  let dropped = 0;
  let failedAt = 0;
  /** while a rotation flushes: the lines that came meanwhile, and the rotation itself */
  let held: string[] = [], heldBytes = 0;
  let rotating: Promise<void> | null = null;
  let stream!: WriteStream;
  const report = () => {
    if (dropped) log(`${name}: ${dropped} records dropped while the disk was behind or failing`);
    dropped = 0;
  };
  const open = () => {
    stream = createWriteStream(file, { flags: 'a' }).on('drain', report).on('error', (e) => {
      failedAt = Date.now();
      log(`${name}: ${e.message}`);
    });
  };
  open();
  return {
    /** a record, or a line of text */
    write(r: TrafficRecord | string) {
      if (stream.destroyed) {
        if (Date.now() - failedAt < 1000) return void dropped++; // a failed stream is reopened at most once a second
        report();
        open();
      }
      const line = (typeof r === 'string' ? r : JSON.stringify(r)) + '\n';
      const n = Buffer.byteLength(line);
      if (rotating) { if (heldBytes + n > BACKLOG) return void dropped++; held.push(line); heldBytes += n; return; }
      if (stream.writableLength > BACKLOG) return void dropped++;
      if (size && size + n > rotate) {
        held = [line]; heldBytes = n;
        // Known limit: one synchronous copy per rotation (100 MB of traffic, 10 MB of tap.log), done once the stream has flushed
        rotating = new Promise<void>((done) => stream.end(() => {
          try { copyFileSync(file, file + '.1'); truncateSync(file, 0); } catch (e) { log(`${name}: ${(e as Error).message}`); }
          size = 0;
          open();
          for (const l of held) { stream.write(l); size += Buffer.byteLength(l); }
          held = []; heldBytes = 0; rotating = null;
          done();
        }));
        return;
      }
      stream.write(line);
      size += n;
    },
    close: async () => { await rotating; return new Promise<void>((r) => {
      report();
      if (stream.destroyed) return r();
      stream.end(r);
    }); },
  };
}

/**
 * Counts a body (a stream, or a mock's whole answer) and keeps only what the record shows: a textual, uncompressed
 * body's first 64 KB, or each multipart part's metadata. It keeps the masker's margin beyond 64 KB, which the cut removes.
 */

/** The token that names a screen of a test (Luis's browser beside Ana's): read off the request and never forwarded, so the app never sees it. */
const SCREEN = 'x-laru-screen';
function screenOf(headers: IncomingHttpHeaders): { screen?: string; rest: IncomingHttpHeaders } {
  const v = headers[SCREEN];
  if (v === undefined) return { rest: headers };
  const { [SCREEN]: _gone, ...rest } = headers;
  const t = String(Array.isArray(v) ? v[0] : v);
  return { rest, ...(/^[\w-]{1,32}$/.test(t) ? { screen: t } : {}) };
}

function capture(s: Readable | Buffer, headers: IncomingHttpHeaders, masker: Masker): () => Body {
  const ct = String(headers['content-type'] ?? '');
  const enc = headers['content-encoding'];
  const boundary = /^multipart\/form-data\b.*?boundary="?([^";]+)"?/i.exec(ct)?.[1];
  const parts = boundary ? multipart(boundary, masker) : undefined;
  // Known limit: compressed bodies are not decoded; zlib with finishFlush over the first 64 KB if evidence needs them
  const note = parts ? 'multipart: file parts as metadata only'
    : EVENTS.test(ct) ? 'events recorded as sse lines'
    : enc && enc !== 'identity' ? `${enc}: not decoded`
    : !TEXTUAL.test(ct) ? `${ct || 'no content-type'}: not recorded`
    : undefined;
  const head: Buffer[] = [];
  const keep = TEE + masker.margin;
  let bytes = 0;
  let kept = 0;
  const add = (b: Buffer) => {
    bytes += b.length;
    if (parts) parts.feed(b);
    else if (!note && kept < keep) {
      head.push(Buffer.from(b.subarray(0, keep - kept)));
      kept += Math.min(b.length, keep - kept);
    }
  };
  if (Buffer.isBuffer(s)) add(s);
  else s.on('data', add);
  return () => {
    if (!bytes) return { bytes };
    if (parts) return { bytes, text: masker.body(JSON.stringify(parts.result()), 'application/json'), note };
    if (note) return { bytes, note };
    return teed(Buffer.concat(head), bytes, ct, masker);
  };
}

/** A body's record from what was kept of its `bytes` (`head`): when that is not all of it, a character split there is left out rather than garbled, and the cut is hidden. */
function teed(head: Buffer, bytes: number, ct: string, masker: Masker): Body {
  const text = new StringDecoder('utf8').write(head);
  return bytes > head.length ? { bytes, text: masker.cut(text, 'end', (t) => masker.body(t, ct)), note: 'first 64 KB' } : { bytes, text: masker.body(text, ct) };
}

/**
 * A streaming multipart/form-data reader. A part with a filename (quoted or not) or a non-text content type becomes
 * name, filename, size and SHA-256, never content, so an EICAR upload stays out of the evidence; plain fields keep
 * their first 1 KB. Names and filenames keep 256 characters, and the first 100 parts are listed and the rest counted,
 * so a record stays small. Whatever is cut is cut through the masker, so no piece of a known value is left at a cut.
 */
function multipart(boundary: string, masker: Masker) {
  const delim = Buffer.from(`\r\n--${boundary}`);
  // Each piece keeps the masker's margin beyond its limit, which the cut removes.
  const [field, name] = [FIELD + masker.margin, NAME + masker.margin];
  const fields: Record<string, string> = {};
  const files: Array<{ name: string; filename: string; size: number; sha256: string }> = [];
  let part: { name: string; filename: string; size: number; hash?: ReturnType<typeof createHash>; value: string; dec: StringDecoder } | undefined;
  let count = 0;
  let buf: Buffer = Buffer.from('\r\n'); // so the first boundary looks like every other one
  let inHeaders = false;
  let done = false;
  const add = (b: Buffer) => {
    if (!part || !b.length) return;
    const before = part.size;
    part.size += b.length;
    if (part.hash) part.hash.update(b);
    else if (before < field) part.value += part.dec.write(b.subarray(0, field - before));
  };
  const cut = (s: string) => masker.cut(s, 'end');
  const capped = (s: string) => (s.length > name ? cut(s.slice(0, name)) : s);
  const finish = () => {
    if (part?.hash) files.push({ name: capped(part.name), filename: capped(part.filename), size: part.size, sha256: part.hash.digest('hex') });
    else if (part) fields[capped(part.name)] = part.size > field ? cut(part.value) : part.value;
    part = undefined;
  };
  const param = (h: string, re: RegExp) => {
    const m = re.exec(h);
    return m ? (m[1] ?? m[2]) : undefined;
  };
  return {
    feed(chunk: Buffer) {
      if (done) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (inHeaders) {
          const end = buf.indexOf('\r\n\r\n');
          if (end < 0) {
            if (buf.length > TEE) done = true; // not multipart after all: stop looking
            return;
          }
          const h = buf.toString('utf8', 0, end);
          const filename = param(h, /\bfilename\*?=(?:"([^"]*)"|([^;\s]*))/i);
          const type = /^content-type:\s*([^;\s]*)/im.exec(h)?.[1];
          const file = filename !== undefined || (type !== undefined && !TEXTUAL.test(type));
          part = count++ < PARTS
            ? { name: param(h, /\bname=(?:"([^"]*)"|([^;\s]*))/i) ?? '', filename: filename ?? '', size: 0, value: '', hash: file ? createHash('sha256') : undefined, dec: new StringDecoder('utf8') }
            : undefined;
          buf = buf.subarray(end + 4);
          inHeaders = false;
        }
        const i = buf.indexOf(delim);
        if (i < 0) {
          // Keep only a tail that could start a delimiter split across chunks, so most chunks are never copied.
          let keep = buf.length;
          for (let q = buf.indexOf(13, Math.max(0, buf.length - delim.length + 1)); q >= 0; q = buf.indexOf(13, q + 1)) {
            if (buf.subarray(q).equals(delim.subarray(0, buf.length - q))) {
              keep = q;
              break;
            }
          }
          add(buf.subarray(0, keep));
          buf = buf.subarray(keep);
          return;
        }
        add(buf.subarray(0, i));
        buf = buf.subarray(i);
        if (buf.length < delim.length + 2) return;
        finish();
        if (buf.toString('latin1', delim.length, delim.length + 2) === '--') {
          done = true;
          return;
        }
        buf = buf.subarray(delim.length + 2);
        inHeaders = true;
      }
    },
    result: () => ({ fields, files, ...(count > PARTS ? { omitted: count - PARTS } : {}) }),
  };
}

/** Splits an event stream into events as bytes arrive. */
function events(emit: (e: { name?: string; data: string }) => void) {
  const dec = new StringDecoder('utf8');
  let buf = '';
  return (b: Buffer) => {
    buf += dec.write(b);
    const blocks = buf.split(/\r?\n\r?\n/);
    buf = blocks.pop()!.slice(-TEE);
    for (const block of blocks) {
      let name: string | undefined;
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        const m = /^(event|data):\s?(.*)$/.exec(line);
        if (m?.[1] === 'event') name = m[2];
        else if (m) data.push(m[2]);
      }
      if (name !== undefined || data.length) emit({ name, data: data.join('\n') });
    }
  };
}

/** Lets `after` bytes through, then `bps` bytes per second in slices of a tenth of a second. */
function throttle(bps: number, after: number) {
  let sent = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      const free = Math.max(0, Math.min(chunk.length, after - sent));
      if (free) this.push(chunk.subarray(0, free));
      sent += free;
      let rest = chunk.subarray(free);
      const step = () => {
        if (!rest.length) return done();
        const n = Math.min(rest.length, Math.max(1, Math.ceil(bps / 10)));
        this.push(rest.subarray(0, n));
        sent += n;
        rest = rest.subarray(n);
        setTimeout(step, (n / bps) * 1000);
      };
      step();
    },
  });
}

/** What a set of faults asks for, summed and in the order they apply. */
function plan(faults: FaultRule[]) {
  const slow = faults.find((f) => f.bandwidth || f.slowAfter);
  return {
    latency: faults.reduce((s, f) => s + (f.latency ?? 0), 0),
    abort: faults.some((f) => f.abort),
    timeout: faults.some((f) => f.timeout),
    status: faults.find((f) => f.status)?.status,
    slow: slow && { bps: slow.bandwidth || 1024, after: slow.slowAfter ?? 0 },
  };
}

/**
 * Byte count plus the first and last 64 bytes, as the masker's peek shows them: known values found in the bytes (a
 * length byte glued to a value is no token boundary, a value's UTF-8 bytes are its UTF-8 form), then printable only.
 * Head and tail keep the masker's margin beyond 64 bytes, which their cut removes; when they hold every byte, nothing is cut.
 */
function peeker(margin: number) {
  const keep = 64 + margin;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let n = 0;
  const shown = (m: Masker, b: Buffer, cut?: 'start' | 'end') => (cut ? m.cut(b.toString('latin1'), cut, m.peek) : m.peek(b.toString('latin1')));
  return {
    add(b: Buffer) {
      n += b.length;
      if (head.length < keep) head = Buffer.concat([head, b.subarray(0, keep - head.length)]);
      tail = Buffer.concat([tail, b.subarray(-keep)]).subarray(-keep);
    },
    bytes: () => n,
    text: (m: Masker) => (n <= 2 * keep ? shown(m, Buffer.concat([head, tail.subarray(tail.length - (n - head.length))]))
      : `${shown(m, head, 'end')} [+${n - 128} B] ${shown(m, tail, 'start')}`),
  };
}

const hostname = (h?: string) => (h ?? '').replace(/:\d+$/, '').toLowerCase();

/**
 * The route a connection on `port` takes. A pinned port has one route, whatever the network or Host. Otherwise the
 * routes of the network it came in on (the tap's address there: `localAddress`), or every route when the env has one
 * network; one left is it, else Host decides. A Host that names none (nginx forwards the browser's) goes to the
 * network's own service, not to another project's reached by name nor to a published host port; a tcp connection
 * (no Host) takes the first.
 */
export function routeFor(cfg: { routes: TapRoute[]; nets?: Record<string, string> }, port: number, host: string | undefined, localAddress: string | undefined): TapRoute | undefined {
  const rs = cfg.routes.filter((r) => r.ports.includes(port));
  const pinned = rs.find((r) => r.kind === 'pinned');
  if (pinned) return pinned;
  const net = cfg.nets?.[(localAddress ?? '').replace(/^::ffff:/, '')];
  const mine = net ? rs.filter((r) => !r.net || r.net === net) : rs;
  if (mine.length === 1) return mine[0];
  const h = hostname(host);
  // a published host port answers to host.docker.internal only: vaultflow publishes 8080:8080, and its frontend's
  // nginx forwarding the browser's Host to api-gateway:8080 is the gateway's own route, not that one
  const named = mine.find((x) => x.aliases.includes(h)) ?? mine.find((x) => x.svc === h && x.kind !== 'host-port');
  if (named) return named;
  const own = mine.filter((x) => !x.visible && x.kind !== 'host-port');
  if (net && own.length === 1) return own[0];
  return host === undefined && mine.every((r) => r.proto === 'tcp') ? (own[0] ?? mine[0]) : undefined;
}
const peer = (s: Socket) => (s.remoteAddress ?? '').replace(/^::ffff:/, '');
const splitUrl = (url: string): [string, string] => {
  const i = url.indexOf('?');
  return i < 0 ? [url, ''] : [url.slice(0, i), url.slice(i + 1)];
};
const roll = (seed: number, svc: string, n: number, i: number) => createHash('sha256').update(`${seed}:${svc}:${n}:${i}`).digest().readUInt32BE(0) / 2 ** 32;
const matches = (re: string, s: string) => {
  try { return new RegExp(re).test(s); } catch { return false; }
};

if (import.meta.main) {
  const [dir, host] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: node tap.ts <stateDir> [host]');
    process.exit(2);
  }
  const tap = await runTap(dir, host);
  const stop = () => void tap.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/** A whole request body, up to `max` bytes (more is cut). */
function readAll(s: Readable, max: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    s.on('data', (c: Buffer) => { size += c.length; if (size <= max) chunks.push(c); });
    s.once('end', () => ok(Buffer.concat(chunks)));
    s.once('error', fail);
  });
}
