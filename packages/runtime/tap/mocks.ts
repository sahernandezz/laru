/**
 * A dependency answered by the tap instead of the real thing. `contract` answers from its OpenAPI file and notes
 * where a request strays from it; `record` forwards and keeps each answer; `simulate` answers only what was
 * recorded (501 otherwise, so a gap is visible); `spy` answers what it knows and forwards the rest; `script` runs
 * the workspace's own code, for HTTP or for a TCP protocol such as clamd. Stdlib only, like the tap.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMasker, type Masker } from '../../trace/src/mask.ts';
import type { MockSpec, TrafficRecord } from '../src/types.ts';
import type { SinkHost } from './sink.ts';
import { answer, operations, type Operation } from './openapi.ts';

export interface MockRequest { method: string; path: string; query: string; headers: Record<string, string>; body: Buffer }
export interface MockResponse { status: number; headers: Record<string, string>; body: Buffer }
export interface MockResult extends MockResponse { mock: string; drift?: string[]; /** a sink: the message this answer is about */ msg?: TrafficRecord['msg']; /** a sink: the request's body goes to the mailbox, not to the journal */ hideReq?: boolean }

export interface Mock {
  name: string;
  mode: MockSpec['mode'];
  /** An answer, or null to forward to the real service (spy and record). */
  http(req: MockRequest): Promise<MockResult | null>;
  /** After a forward in record mode: keep the pair. */
  recorded(req: MockRequest, res: MockResponse): void;
  /** a tcp mock speaks its protocol itself; a sink also says which port and whether the socket arrived encrypted */
  tcp?(socket: Socket, ctx?: { port: number; implicit: boolean; from: string }): void;
  /** a sink: what it received is its own record, so the connection's is not written; it answers its faults itself */
  sink?: boolean;
  quiet?: boolean;
  implicitTls?: number[];
  stop?(): void;
}

interface Recording { method: string; path: string; query: string; status: number; headers: Record<string, string>; body: string; base64?: boolean; at: string }

const TEXT = /json|text|xml|x-www-form-urlencoded|javascript/i;
const slug = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'root';

function loadRecordings(dir: string): Recording[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().flatMap((f) => { try { return [JSON.parse(readFileSync(join(dir, f), 'utf8')) as Recording]; } catch { return []; } });
}

/** A path or query as recordings are matched: masked, and a mark stands for any secret, since another env's key marks it differently. */
const unmarked = (s: string) => s.replace(/…[\w-]{4}/g, '…');

const toResult = (r: Recording, mock: string): MockResult => ({ status: r.status, headers: { ...r.headers, 'x-laru-mock': mock }, body: r.base64 ? Buffer.from(r.body, 'base64') : Buffer.from(r.body), mock });

/**
 * `dir` is mocks/<name> in the workspace; `openapi` is its openapi.yaml already parsed by the host; `state` lives as
 * long as the env's tap, shared by every request to this mock; `masker` (the tap's current one) hides secrets before a
 * recording is written, as in traffic.jsonl: the path and the query (by key) in the file and its name, headers by name,
 * and a body of a textual type, or UTF-8 text of any type, by JSON key, known values and patterns. Any other body is
 * kept byte for byte, so it replays.
 */
export async function loadMock(name: string, spec: MockSpec, dir: string, o: { openapi?: Record<string, any>; state?: Record<string, unknown>; masker?: () => Masker; sink?: SinkHost } = {}): Promise<Mock> {
  const recDir = join(dir, 'recordings');
  let recordings = loadRecordings(recDir);
  const ops: Operation[] = o.openapi ? operations(o.openapi) : [];
  const state = o.state ?? {};
  if (spec.mode === 'sink') {
    if (!o.sink) throw new Error(`mocks.${name}: a sink needs the tap's mailbox`);
    return (await import('./sink.ts')).loadSink(name, spec, o.sink, state);
  }
  const masker = o.masker ?? (() => createMasker([]));
  const find = (req: MockRequest) => {
    const m = masker();
    const [path, query] = [unmarked(m.text(req.path)), unmarked(m.query(req.query))];
    const same = (r: Recording) => r.method === req.method && unmarked(m.text(r.path)) === path;
    return recordings.find((r) => same(r) && unmarked(m.query(r.query)) === query) ?? recordings.find(same);
  };

  let script: { http?: (req: MockRequest, state: Record<string, unknown>) => Promise<Partial<MockResponse> | null> | Partial<MockResponse> | null; tcp?: (s: Socket, state: Record<string, unknown>) => void } = {};
  const file = ['script.ts', 'script.js', 'script.mjs'].map((f) => join(dir, f)).find(existsSync);
  if (spec.mode === 'script') {
    if (!file) throw new Error(`mocks/${name}: mode script needs script.ts`);
    // A changed script is picked up at the next tap start or rules reload.
    script = await import(`${pathToFileURL(file).href}?v=${statSync(file).mtimeMs}`);
  }

  return {
    name,
    mode: spec.mode,
    async http(req) {
      switch (spec.mode) {
        case 'contract': {
          if (!o.openapi) throw new Error(`mocks/${name}: mode contract needs openapi.yaml`);
          const a = answer(o.openapi, ops, { method: req.method, path: req.path, query: new URLSearchParams(req.query), headers: req.headers, body: req.body.length ? req.body.toString('utf8') : undefined });
          if (spec.strict && a.drift.some((d) => !d.startsWith('not validated'))) return { status: 400, headers: { 'content-type': 'application/json', 'x-laru-mock': 'contract' }, body: Buffer.from(JSON.stringify({ error: 'request does not match the contract', drift: a.drift })), mock: 'contract', drift: a.drift };
          return { status: a.status, headers: { ...a.headers, 'x-laru-mock': 'contract' }, body: Buffer.from(a.body), mock: 'contract', drift: a.drift };
        }
        case 'simulate': {
          const r = find(req);
          return r ? toResult(r, 'hit') : { status: 501, headers: { 'content-type': 'application/json', 'x-laru-mock': 'unmatched' }, body: Buffer.from(JSON.stringify({ error: `no recording for ${req.method} ${req.path}` })), mock: 'miss' };
        }
        case 'spy': {
          const r = find(req);
          return r ? toResult(r, 'hit') : null;
        }
        case 'record': case 'sink': return null;
        case 'script': {
          if (!script.http) return { status: 501, headers: { 'x-laru-mock': 'unmatched' }, body: Buffer.from(''), mock: 'miss' };
          const r = await script.http(req, state);
          if (!r) return null;
          return { status: r.status ?? 200, headers: { ...(r.headers ?? {}), 'x-laru-mock': 'script' }, body: Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body ?? '')), mock: 'script' };
        }
      }
    },
    recorded(req, res) {
      if (spec.mode !== 'record') return;
      mkdirSync(recDir, { recursive: true });
      const m = masker();
      const ct = res.headers['content-type'] ?? '';
      const utf8 = res.body.toString('utf8');
      const text = TEXT.test(ct) || Buffer.from(utf8).equals(res.body);
      const headers = m.headers(Object.fromEntries(Object.entries(res.headers).filter(([k]) => !/^(date|connection|keep-alive|transfer-encoding|content-length|set-cookie)$/i.test(k))));
      const [path, query] = [m.text(req.path), m.query(req.query)];
      const rec: Recording = { method: req.method, path, query, status: res.status, headers, body: text ? m.body(utf8, ct) : res.body.toString('base64'), ...(text ? {} : { base64: true }), at: new Date().toISOString() };
      const id = createHash('sha1').update(`${req.method} ${path}?${query}`).digest('hex').slice(0, 8);
      writeFileSync(join(recDir, `${req.method}_${slug(path)}_${id}.json`), JSON.stringify(rec, null, 2));
      recordings = loadRecordings(recDir);
    },
    ...(script.tcp ? { tcp: (s: Socket) => script.tcp!(s, state) } : {}),
  };
}
