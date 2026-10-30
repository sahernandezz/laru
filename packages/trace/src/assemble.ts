/**
 * From what was captured during a run to one trace per test. Each source keeps its own clock reading (all of them
 * the VM's): the tap's traffic, Postgres' statement log, Kafka's log segments, the services' logs and the runner's
 * events. Who is who comes from the env's IPs and the map; what the map can only infer (a Kafka publisher, its
 * consumers) is marked derived. Pure: the caller reads the files and passes them in, already masked.
 */
import { causes } from './chain.ts';
import { isBrowser, type Action, type Exchange, type TrafficRecord, type LogLine, type Participant, type ParticipantType, type RunnerEvent, type Step, type Trace } from './trace.ts';

export interface SqlLine { store: string; t1: number; durationMs: number; ip: string; user: string; db: string; statement: string; params?: string; error?: string; /** the backend's pid (`%p`): one connection */ pid?: number }
export interface KafkaLine { broker: string; topic: string; partition: number; offset: number; t: number; key?: string; value?: string }
export interface ServiceLog { service: string; t: number; line: string }

/** The part of the map assemble needs; structurally the core's SystemMap. */
export interface MapLike {
  nodes: Array<{ id: string; type: string; name: string; kind?: string; service?: string; repo?: string; attrs?: Record<string, unknown> }>;
  facts: Array<{ s: string; p: string; o: string }>;
  /** the projects the map read: with more than one, participants say which is theirs */
  repos?: unknown[];
}

export interface AssembleInput {
  run: string;
  /** runners playing at once in this run */
  concurrent?: boolean;
  flow: string;
  env: string;
  events: RunnerEvent[];
  traffic: TrafficRecord[];
  sql?: SqlLine[];
  kafka?: KafkaLine[];
  logs?: ServiceLog[];
  /** IP → compose service name, from one inspect at run start */
  peers: Record<string, string>;
  /** the runner container's IP: its requests are the browser's or the test's own */
  runnerIp?: string;
  /** a run with several runners (in parallel, or one per scenario), each with its IP */
  runnerIps?: string[];
  /**
   * The IP of the runner that played a test. With runners playing at once, a test's trace keeps what started from its
   * own runner and what the chain hangs from it; what another runner set off is left out.
   */
  runnerIpOf?: (test: string) => string | undefined;
  /** the network gateway: the host, or the hybrid service when there is exactly one */
  gatewayIp?: string;
  /** a joint env's gateways, one per network: each is the host */
  gatewayIps?: string[];
  hybrid?: string[];
  map?: MapLike;
  videoOffsetMs?: number;
  /** `<test>|<screen>` → the offset of that screen's video, from the marker found in it (the test's other browsers); one without (no ffmpeg) starts by videoOffsetMs, as the main video does */
  screenOffsets?: Record<string, number>;
  /** test → its measured offset (from the marker found in its own video); wins over videoOffsetMs */
  offsets?: Record<string, number>;
  /** step n → what flow.md expects */
  expected?: Record<number, string>;
  /** how many steps flow.md's Pasos has (a failed story runs fewer) */
  stepsTotal?: number;
  /** only these tests become traces; the others still bound the windows (a multi-flow run passes every event) */
  only?: (test: string) => boolean;
  /** a session: what a browser sends from the host is the person using the app, not someone else's traffic */
  person?: boolean;
}

export interface Observed { s: string; p: 'calls' | 'reads' | 'writes' | 'uses'; o: string }

const ASSET = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|webp|avif)(\?|$)/i;
const NOISE = /^\s*(SET|SHOW|BEGIN|COMMIT|ROLLBACK|START TRANSACTION|SELECT 1|DISCARD|DEALLOCATE)\b/i;
const levelOf = (l: string): LogLine['level'] => (/\b(ERROR|FATAL|SEVERE)\b|Exception\b/.test(l) ? 'error' : /\bWARN(ING)?\b/.test(l) ? 'warn' : /\bDEBUG|TRACE\b/.test(l) ? 'debug' : 'info');

/** `2026-10-22 04:14:48.164 UTC|172.30.1.5|123|user|db|LOG:  duration: 0.5 ms  execute <unnamed>: select …` */
const PG = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?) (\w+)\|([^|]*)\|(\d+)\|([^|]*)\|([^|]*)\|(\w+):\s+(.*)$/;

/** Postgres' statement log (docker logs lines, optionally with docker's own timestamp first) to statements. */
export function parsePgLog(lines: string[], store: string): SqlLine[] {
  const out: SqlLine[] = [];
  let last: SqlLine | null = null;
  let lastKind = '';
  /** each backend's statement still waiting for its parameters: its very next line, from that backend */
  const awaiting = new Map<number, SqlLine>();
  for (const raw of lines) {
    const line = raw.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '');
    const m = PG.exec(line);
    if (!m) { if (last && lastKind === 'stmt') last.statement += `\n${line}`; continue; }
    const [, ts, tz, host, p, user, db, level, msg] = m;
    const t = Date.parse(`${ts.replace(' ', 'T')}${tz === 'UTC' ? 'Z' : ''}`);
    const ip = host.replace(/\(\d+\)$/, '');
    const pid = Number(p);
    // Only the statement's own parameters: a `bind` line's DETAIL comes after the previous execute, before its own.
    const own = awaiting.get(pid);
    awaiting.delete(pid);
    if (level === 'DETAIL' && own && /^parameters: /.test(msg)) { own.params = msg.slice(12); lastKind = 'detail'; continue; }
    const d = /^duration: ([\d.]+) ms\s+(?:statement|execute [^:]*): ([\s\S]*)$/.exec(msg);
    if (level === 'LOG' && d) { last = { store, t1: t, durationMs: Number(d[1]), ip, user, db, statement: d[2], pid }; lastKind = 'stmt'; awaiting.set(pid, last); out.push(last); continue; }
    if (level === 'ERROR') { last = { store, t1: t, durationMs: 0, ip, user, db, statement: '', error: msg, pid }; lastKind = 'error'; out.push(last); continue; }
    if (level === 'STATEMENT' && last?.error && !last.statement) { last.statement = msg; lastKind = 'stmt'; continue; }
    lastKind = 'other';
  }
  return out.filter((s) => s.statement && !NOISE.test(s.statement));
}

/** `kafka-dump-log --print-data-log` output of one topic-partition segment to messages. */
export function parseKafkaDump(text: string, broker: string, topic: string, partition: number): KafkaLine[] {
  const out: KafkaLine[] = [];
  for (const m of text.matchAll(/^\| offset: (\d+) CreateTime: (\d+) .*?(?: key: (.*?))? payload: (.*)$/gm))
    out.push({ broker, topic, partition, offset: Number(m[1]), t: Number(m[2]), key: m[3] || undefined, value: m[4] });
  return out;
}

/** The first table a statement touches, and whether it writes. */
export function sqlTarget(stmt: string): { verb: string; table?: string; writes: boolean } {
  const s = stmt.replace(/\s+/g, ' ').trim();
  const verb = (/^\w+/.exec(s)?.[0] ?? '').toUpperCase();
  const id = '((?:"[^"]+"|[\\w$]+)(?:\\.(?:"[^"]+"|[\\w$]+))?)';
  const m = new RegExp(verb === 'INSERT' ? `INTO ${id}` : verb === 'UPDATE' ? `^UPDATE ${id}` : verb === 'DELETE' ? `FROM ${id}` : `\\bFROM ${id}`, 'i').exec(s);
  return { verb, table: m?.[1].replace(/"/g, '').toLowerCase(), writes: ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE'].includes(verb) };
}

/** A table as a JSON string: its name, or its ARN (`arn:aws:dynamodb:…:table/users`, also `…/index/byEmail`). */
const TABLE = String.raw`"(?:arn:[^"/]*:table/)?([\w.-]+)(?:/[^"]*)?"`;
const NAMED = [new RegExp(String.raw`"TableName"\s*:\s*${TABLE}`), new RegExp(String.raw`"RequestItems"\s*:\s*\{\s*${TABLE}`)];
/** Whitespace inside a JSON string: a space, or a newline, return or tab as the SDK escapes it (`\n`, two characters). */
const WS = String.raw`(?:\s|\\[nrt])`;
/**
 * A PartiQL statement's target, in its JSON string: `FROM "users"` (escaped quotes), `INTO orders`, `FROM users.byEmail`
 * (an index), across lines too. Escapes are read whole, so FROM right after an escaped newline (`\nFROM`) is a word.
 */
const PARTIQL = new RegExp(String.raw`"Statement"\s*:\s*"${WS}*(?:SELECT\b(?:[^"\\]|\\.)*?(?:\\[nrt]|\b)FROM|INSERT${WS}+INTO|UPDATE|DELETE${WS}+FROM)${WS}+(?:\\"([^"\\]+)\\"|([\w-]+)(?=[\s;."\\]))`, 'i');

/**
 * A DynamoDB call read as its operation and table, the way a SQL row reads: the operation from `X-Amz-Target`
 * (`DynamoDB_20120810.PutItem`), the table from the body's TableName, the first table of a batch's RequestItems (a
 * name or an ARN), or a PartiQL statement's target (ExecuteStatement, a batch's or a transaction's first). The body
 * may be cut by the tap; a regex reads what is there.
 */
export function dynamoCall(headers: Record<string, string> | undefined, body = ''): { op: string; table?: string } | undefined {
  const op = /^DynamoDB(?:Streams)?_\d+\.(\w+)$/.exec(headers?.['x-amz-target'] ?? '')?.[1];
  if (!op) return;
  const named = NAMED.map((re) => re.exec(body)).find(Boolean), q = PARTIQL.exec(body);
  return { op, table: named?.[1] ?? q?.[1] ?? q?.[2] };
}

const PARAM = /\{[^}]+\}|:\w+/g;
/**
 * An endpoint path template as a matcher: `/api/files/{id}` matches `/api/files/7f…`. Spring's wildcards too: `*` is
 * one segment, a trailing `/**` any rest (none included), as a gateway's proxy routes are written.
 */
const template = (p: string) => new RegExp(`^${p.replace(/[.+?^$()|[\]\\]/g, '\\$&').replace(PARAM, '[^/]+')
  .replace(/\/\*\*$|\*\*|\*/g, (w) => (w === '*' ? '[^/]*' : w === '**' ? '.*' : '(?:/.*)?'))}/?$`);
/** How loose a template is: a literal 0, each segment it leaves open 1, a `**` more than any number of those. */
const looseness = (p: string) => (p.match(/\{[^}]+\}|:\w+|\*\*?/g) ?? []).reduce((n, w) => n + (w === '**' ? 1000 : 1), 0);

export type EndpointMatch = (svc: string, method?: string, path?: string) => string | undefined;

/**
 * The map endpoint a request to a service (`file-service`, as the traffic names it) reached. Of the templates that
 * match, the most literal wins: `/api/files/folders` before `/api/files/{fileId}`, and both before `/api/files/**`.
 */
export function endpointMatcher(nodes: MapLike['nodes']): EndpointMatch {
  const eps = nodes.filter((n) => n.type === 'endpoint').map((n) => {
    const path = String(n.attrs?.path ?? '');
    return { id: n.id, service: n.service ?? `svc:${n.id.split(':')[1]}`, method: String(n.attrs?.method ?? ''), re: template(path), loose: looseness(path) };
  }).sort((a, b) => a.loose - b.loose);
  return (svc, method, path) => (method && path ? eps.find((e) => e.service === `svc:${svc}` && e.method === method && e.re.test(path))?.id : undefined);
}

/** What the session's own browser recorded: the person's actions (never what they typed) and when its video began. */
export interface SessionBrowserLog { actions?: Array<{ t0: number; kind: Action['kind']; target?: string; key?: string; path?: string }>; videoT0?: number }

/**
 * A session as the runner's events, so it assembles like a run: one story from its start to `end`, and a step from
 * each mark to the next. Before the first mark nothing is a step. `open`: the session goes on, its last step too.
 * With the session's browser, its actions are the person's marks of a run and its video is the clock.
 */
export function sessionEvents(title: string, t0: number, marks: Array<{ t: number; text: string }>, end: number, open = false, b: SessionBrowserLog = {}): RunnerEvent[] {
  const test = 'session';
  const ms = [...marks].sort((a, b) => a.t - b.t);
  const steps = ms.flatMap((m, i): RunnerEvent[] => {
    const t1 = ms[i + 1]?.t ?? end;
    return [{ e: 'step-begin', t: m.t, test, title: m.text }, { e: 'step-end', t: t1, test, title: m.text, t0: m.t, status: open && i === ms.length - 1 ? 'todo' : 'passed' }];
  });
  const acts = (b.actions ?? []).map((a): RunnerEvent => ({ e: 'action', t: a.t0, test, t0: a.t0, ms: 0, kind: a.kind, ...(a.target ? { target: a.target } : {}), ...(a.key ? { key: a.key } : {}), ...(a.path ? { path: a.path } : {}) }));
  const video: RunnerEvent[] = b.videoT0 === undefined ? [] : [{ e: 'video-t0', t: b.videoT0, test }];
  return [{ e: 'test-begin', t: t0, test, title, file: 'session', story: true }, ...video, ...steps, ...acts, { e: 'test-end', t: end, test, status: 'passed', durationMs: end - t0 }];
}

export function assemble(input: AssembleInput): { traces: Trace[]; observed: Observed[] } {
  const offset = input.videoOffsetMs ?? 0;
  const nodes = new Map((input.map?.nodes ?? []).map((n) => [n.id, n]));
  const nodeOf = (name: string) => nodes.get(`svc:${name}`) ?? nodes.get(`ds:${name}`) ?? nodes.get(`ext:${name}`);
  const endpointOf = endpointMatcher(input.map?.nodes ?? []);
  const facts = input.map?.facts ?? [];
  const publishers = (topic: string) => facts.filter((f) => f.p === 'publishes' && f.o === `topic:${topic}`).map((f) => f.s.replace(/^svc:/, ''));
  const consumers = (topic: string) => facts.filter((f) => f.p === 'consumes' && f.o === `topic:${topic}`).map((f) => f.s.replace(/^svc:/, ''));
  const hostName = input.hybrid?.length === 1 ? input.hybrid[0] : 'host';
  const several = (input.map?.repos?.length ?? 0) > 1;

  /** Who sent a request from this IP: a service, the browser or the test itself in the runner, or the host. */
  const who = (ip: string, ua = ''): string => {
    if ((input.runnerIp && ip === input.runnerIp) || input.runnerIps?.includes(ip)) return /HeadlessChrome|Chrome\//.test(ua) ? 'browser' : 'runner';
    if ((input.gatewayIp && ip === input.gatewayIp) || input.gatewayIps?.includes(ip)) return input.person && /Mozilla\//.test(ua) ? 'browser' : hostName;
    return input.peers[ip] ?? (ip ? `?${ip}` : 'unknown');
  };

  // Tests and their windows: [begin − 0.5 s, end + 2 s], clipped at the next test's begin.
  const begins = input.events.filter((e): e is Extract<RunnerEvent, { e: 'test-begin' }> => e.e === 'test-begin').sort((a, b) => a.t - b.t);
  const traces: Trace[] = [];
  const observed = new Map<string, Observed>();
  const see = (o: Observed) => observed.set(`${o.s}|${o.p}|${o.o}`, o);

  const endOf = (test: string) => input.events.find((e): e is Extract<RunnerEvent, { e: 'test-end' }> => e.e === 'test-end' && e.test === test);
  begins.forEach((b, i) => {
    if (input.only && !input.only(b.test)) return;
    const end = endOf(b.test);
    // From half a second before it began (not before the previous test ended) to 2 s after it ended (not past the next one's start).
    // With runners playing at once, the previous and the next are those of the same runner: the others overlap it.
    const runner = input.runnerIpOf?.(b.test);
    const sameRunner = runner === undefined ? begins : begins.filter((x) => input.runnerIpOf!(x.test) === runner);
    const at = sameRunner.indexOf(b);
    const prevEnd = at > 0 ? (endOf(sameRunner[at - 1].test)?.t ?? sameRunner[at - 1].t) : -Infinity;
    const next = sameRunner[at + 1]?.t ?? Infinity;
    const lo = Math.max(b.t - 500, prevEnd), hi = Math.min((end?.t ?? b.t) + 2000, next);
    const v0 = (input.events.find((e) => e.e === 'video-t0' && e.test === b.test)?.t ?? b.t) + (input.offsets?.[b.test] ?? offset);
    const rel = (t: number) => Math.round(t - v0);
    // With runners playing at once the chain is drawn with 3 s before the window too: a statement whose request (of
    // another runner) began just before it finds its parent, and goes with it.
    const ctx = input.runnerIpOf && (input.runnerIps?.length ?? 0) > 1 ? 3000 : 0;
    const inWin = (t: number) => t >= lo - ctx && t <= hi;

    const steps: Step[] = input.events
      .filter((e): e is Extract<RunnerEvent, { e: 'step-end' }> => e.e === 'step-end' && e.test === b.test)
      .sort((x, y) => x.t0 - y.t0)
      .map((e, n) => ({ n: n + 1, title: e.title, t0: rel(e.t0), t1: rel(e.t), status: e.status, error: e.error, expected: input.expected?.[n + 1] }));
    const stepAt = (t: number) => steps.find((s) => t >= s.t0 && t < s.t1)?.n;

    const ex: Exchange[] = [];
    /** who sent each exchange, by IP: whose runner a chain started from */
    const ipOf = new Map<string, string>();
    let foreign = 0;
    const streamUa = new Map(input.traffic.filter((r) => r.kind === 'http').map((r) => [r.id, r.reqHeaders?.['user-agent']]));
    const streamScreen = new Map(input.traffic.filter((r) => r.kind === 'http').map((r) => [r.id, r.screen]));
    for (const r of input.traffic) {
      if (r.kind === 'pg' || !inWin(r.t0)) continue;
      // An SSE event has no headers of its own: its stream's request says who opened it (the browser, usually).
      const ua = r.kind === 'sse' ? streamUa.get(r.id.replace(/\.\d+$/, '')) : r.reqHeaders?.['user-agent'];
      // another screen of the test (`browser:luis`): the tap read its token off the request and kept it in the record; a stream's events are the screen that opened it
      const screen = r.kind === 'sse' ? streamScreen.get(r.id.replace(/\.\d+$/, '')) : r.screen;
      // what a sink calls back from has a name, not an address: its own name is who it is
      const base = r.mock === 'callback' ? r.from : who(r.from, ua);
      const from = base === 'browser' && screen ? `browser:${screen}` : base;
      if (from === 'host' && r.svc) foreign++;
      const ep = r.kind === 'http' ? endpointOf(r.svc, r.method, r.path) : undefined;
      const dyn = r.kind === 'http' ? dynamoCall(r.reqHeaders, r.req?.text) : undefined;
      const label = r.msg ? (r.msg.cb ? `aviso ${r.msg.cb}: ${r.msg.id.slice(0, 10)}` : r.msg.kind === 'mail' ? `${r.msg.subject || '(sin asunto)'} → ${r.msg.to}` : `SMS → ${r.msg.to}`) : r.kind === 'sse' ? `evento ${r.event?.name ?? 'message'}` : r.kind === 'tcp' ? (r.peek?.down?.split(/\0|\n/)[0] || `${r.req?.bytes ?? 0} B ↑ ${r.res?.bytes ?? 0} B ↓`)
        : dyn ? `${dyn.op}${dyn.table ? ` ${dyn.table}` : ''}` : `${r.method ?? ''} ${r.path ?? ''}`.trim();
      // An http request with no status and a fault was left unanswered by it (abort, timeout).
      const ok = !r.error && (r.status === undefined ? !(r.kind === 'http' && r.fault) : r.status < 400) && r.mock !== 'miss';
      ipOf.set(r.id, r.from);
      ex.push({
        id: r.id, kind: r.kind, from, to: r.svc, t0: rel(r.t0), t1: r.t1 === undefined ? undefined : rel(r.t1), label, status: r.status, ok, origin: 'observed', ...(dyn?.table ? { table: dyn.table } : {}),
        endpoint: ep, method: r.method, path: r.path, query: r.query, reqHeaders: r.reqHeaders ?? (r.kind === 'sse' && ua ? { 'user-agent': ua } : undefined), resHeaders: r.resHeaders, req: r.req, res: r.res,
        fault: r.fault, mock: r.mock, ...(r.msg ? { msg: r.msg } : {}), drift: r.drift, error: r.error, ...(r.tap !== undefined ? { tap: r.tap } : {}), ...(r.kind === 'sse' ? { req: undefined, res: r.event?.data ? { bytes: r.event.data.length, text: r.event.data } : undefined } : {}),
      });
      if (ep && !from.startsWith('?') && !isBrowser(from) && from !== 'runner') see({ s: `svc:${from}`, p: 'calls', o: ep });
      else if (!ep && nodeOf(r.svc) && nodeOf(r.svc)!.type !== 'service' && nodeOf(from)) see({ s: nodeOf(from)!.id, p: 'uses', o: nodeOf(r.svc)!.id });
    }
    // Postgres behind the tap: the server sees every connection come from the tap, and the tap saw who opened each one
    // (by the backend's pid), and what each statement returned
    // keyed by the store and the backend's pid: two servers (two projects' Postgres) number their backends apart
    const pgKey = (store: string, pid: number) => `${store}#${pid}`;
    const pgFrom = new Map<string, string>();
    const results = new Map<string, Array<NonNullable<TrafficRecord['pg']> & { t: number; used?: boolean }>>();
    for (const r of input.traffic) {
      if (r.kind !== 'pg' || !r.pg?.pid) continue;
      const k = pgKey(r.svc, r.pg.pid);
      pgFrom.set(k, r.from);
      (results.get(k) ?? results.set(k, []).get(k)!).push({ ...r.pg, t: r.t0 });
    }
    const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
    const resultOf = (q: SqlLine) => {
      const mine = q.pid ? results.get(pgKey(q.store, q.pid)) : undefined;
      const hit = mine?.find((x) => !x.used && Math.abs(x.t - q.t1) < 3000 && flat(x.stmt) === flat(q.statement));
      if (hit) hit.used = true;
      return hit && !hit.error ? { cols: hit.cols, rows: hit.rows, more: hit.more, ...(hit.tag ? { tag: hit.tag } : {}) } : undefined;
    };
    for (const q of input.sql ?? []) {
      const t0 = q.t1 - q.durationMs;
      // over the container's own socket only Laru talks (snapshots, resets, the explorer): no service's evidence
      if (!inWin(t0) || q.ip === '[local]') continue;
      const tg = sqlTarget(q.statement);
      const from = who((q.pid && pgFrom.get(pgKey(q.store, q.pid))) || q.ip);
      const result = resultOf(q);
      ex.push({ id: `sql:${q.store}:${q.t1}:${ex.length}`, kind: 'sql', from, to: q.store, t0: rel(t0), t1: rel(q.t1), label: `${tg.verb}${tg.table ? ` ${tg.table}` : ''}`, ok: !q.error, origin: 'observed', table: tg.table,
        ...(q.pid ? { conn: `${q.store}#${q.pid}` } : {}),
        req: { bytes: q.statement.length, text: q.statement.slice(0, 2000) + (q.params ? `\n-- ${q.params.slice(0, 500)}` : '') }, error: q.error, ...(result ? { result } : {}) });
      if (tg.table && nodeOf(from)) see({ s: nodeOf(from)!.id, p: tg.writes ? 'writes' : 'reads', o: `tbl:${tg.table}` });
    }
    for (const k of input.kafka ?? []) {
      if (!inWin(k.t)) continue;
      const pubs = publishers(k.topic);
      const from = pubs.length === 1 ? pubs[0] : 'publicador ambiguo';
      ex.push({ id: `kafka:${k.topic}:${k.partition}:${k.offset}`, kind: 'kafka', from, to: k.broker, t0: rel(k.t), label: k.topic, topic: k.topic, ok: true, origin: 'derived', req: k.value ? { bytes: k.value.length, text: k.value.slice(0, 2000) } : undefined });
      for (const c of consumers(k.topic)) ex.push({ id: `kafka:${k.topic}:${k.partition}:${k.offset}>${c}`, kind: 'kafka', from: k.broker, to: c, t0: rel(k.t), label: k.topic, topic: k.topic, ok: true, origin: 'derived' });
    }

    // Static assets the browser loads in a burst become one row per step.
    const collapsed: Exchange[] = [];
    for (const e of ex.sort((x, y) => x.t0 - y.t0 || (x.t1 ?? x.t0) - (y.t1 ?? y.t0))) {
      const isAsset = e.kind === 'http' && isBrowser(e.from) && e.method === 'GET' && e.ok && ASSET.test(e.path ?? '');
      const prev = collapsed[collapsed.length - 1];
      if (isAsset && prev?.asset && prev.to === e.to && stepAt(prev.t0) === stepAt(e.t0)) { prev.asset++; prev.t1 = Math.max(prev.t1 ?? prev.t0, e.t1 ?? e.t0); prev.label = `GET ${prev.asset} recursos`; continue; }
      collapsed.push(isAsset ? { ...e, asset: 1, label: 'GET 1 recurso', req: undefined, res: undefined } : e);
    }
    // The person's actions, never with what was typed; then each exchange's cause (chain.ts says how sure it is).
    const actions: Action[] = input.events
      .filter((e): e is Extract<RunnerEvent, { e: 'action' }> => e.e === 'action' && e.test === b.test)
      .sort((x, y) => x.t0 - y.t0)
      .map((e) => ({ t0: rel(e.t0), t1: rel(e.t0 + e.ms), kind: e.kind, ...(e.target ? { target: e.target } : {}), ...(e.key ? { key: e.key } : {}), ...(e.path ? { path: e.path } : {}), step: stepAt(rel(e.t0)) }));
    let cause = causes(collapsed, { actions });
    const mine = input.runnerIpOf?.(b.test), runners = new Set(input.runnerIps ?? []);
    if (mine && runners.size > 1) {
      const rootOf = (id: string) => { let x = id; for (let n = 0; n < 200; n++) { const p = cause.get(x)?.parent; if (!p) return x; x = p; } return x; };
      // a chain whose root another runner sent belongs to that runner's test; one with no runner at its root stays
      const theirs = (id: string) => { const ip = ipOf.get(rootOf(id)); return ip !== undefined && ip !== mine && runners.has(ip); };
      const kept = collapsed.filter((e) => !theirs(e.id) && e.t0 >= rel(lo));
      collapsed.splice(0, collapsed.length, ...kept);
      cause = causes(collapsed, { actions });
    }
    for (const e of collapsed) {
      e.step = stepAt(e.t0);
      const c = cause.get(e.id);
      if (c) e.parent = c.parent;
    }

    // Participants in lane order: browser, runner, host, then whoever appears, services before stores and externals.
    const names = [...new Set(collapsed.flatMap((e) => [e.from, e.to]))];
    const typeOf = (n: string): ParticipantType => (isBrowser(n) ? 'browser' : n === 'runner' || n === 'host' ? n : n === 'ks-tap' ? 'tap' : nodeOf(n)?.type === 'datastore' ? 'datastore' : nodeOf(n)?.type === 'external' ? 'external' : 'service');
    const rank: Record<ParticipantType, number> = { browser: 0, runner: 1, host: 2, service: 3, tap: 4, datastore: 5, external: 6 };
    const participants: Participant[] = names.map((n) => {
      const node = nodeOf(n);
      return { id: n, name: n === 'browser' ? 'Navegador' : n.startsWith('browser:') ? `Navegador de ${n.slice(8)}` : n === 'runner' ? 'Prueba' : n === 'host' ? 'Tu máquina' : n, type: typeOf(n), node: node?.id, kind: isBrowser(n) ? (input.person ? undefined : 'chromium') : (node?.kind ?? String(node?.attrs?.tech ?? '')) || undefined, where: input.hybrid?.includes(n) ? ('host' as const) : undefined, ...(several && node?.repo ? { project: node.repo } : {}) };
    }).sort((a, x) => rank[a.type] - rank[x.type] || names.indexOf(a.id) - names.indexOf(x.id));

    const logs: LogLine[] = [];
    const perService = new Map<string, number>();
    for (const l of input.logs ?? []) {
      if (!inWin(l.t) || l.t < lo) continue;
      const n = (perService.get(l.service) ?? 0) + 1;
      perService.set(l.service, n);
      if (n > 400) continue; // Known limit: 400 lines per service per test; the raw log keeps the rest
      logs.push({ id: `${l.service}:${n}`, t: rel(l.t), service: l.service, level: levelOf(l.line), line: l.line.slice(0, 2000) });
    }
    logs.sort((x, y) => x.t - y.t);

    const status = end?.status === 'passed' ? 'passed' : end?.status === 'skipped' ? 'skipped' : 'failed';
    const failedStep = steps.find((s) => s.status === 'failed');
    const failure = status === 'failed' ? {
      step: failedStep?.n ?? steps.length,
      message: failedStep?.error ?? end?.error ?? 'failed',
      exchange: collapsed.find((e) => !e.ok && (!failedStep || e.step === failedStep.n))?.id ?? collapsed.find((e) => !e.ok)?.id,
      ...(end?.errors && end.errors.length > 1 ? { all: end.errors } : {}),
      ...(end?.unexpected !== undefined ? { known: end.known ?? 0, unexpected: end.unexpected } : {}),
    } : undefined;
    traces.push({
      v: 1, run: input.run, flow: input.flow, test: b.title, story: b.story, env: input.env, t0: v0, durationMs: Math.max(0, rel(end?.t ?? b.t)), status, stepsTotal: input.stepsTotal,
      participants, steps, exchanges: collapsed, logs, failure, ...(foreign ? { foreign } : {}), ...(end?.screens?.length ? { screens: end.screens.map((s) => { const off = input.screenOffsets?.[`${b.test}|${s.name}`]; return { name: s.name, video: s.video, offsetMs: off, startMs: s.t0 !== undefined ? Math.round(s.t0 + (off ?? offset) - v0) : undefined }; }) } : {}), ...(input.concurrent ? { concurrent: true } : {}), video: end?.video, ...(end?.pwTrace ? { pwTrace: end.pwTrace } : {}), ...(actions.length ? { actions } : {}),
    });
  });
  return { traces, observed: [...observed.values()] };
}
