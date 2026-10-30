/**
 * The local service behind the interface: one per machine, a JSON API over every registered workspace plus the built
 * web app. A workspace's routes live under `/api/w/<id>/`; the machine's (`/api/workspaces`, `/api/machine`) beside
 * them. It listens on 127.0.0.1 only, accepts only `localhost` Host headers (DNS rebinding) and refuses a request that
 * another page makes (Fetch Metadata), a POST that is not JSON and being framed: that, not a password, is what keeps
 * a web page of this machine out. By default no sign-in is asked (a bookmark of http://127.0.0.1:4100/ is enough);
 * started with `laru serve --token`, every API call but `/api/ping` needs the session cookie, handed out once in
 * exchange for the token kept in ~/.laru/daemon.json (0600): for a machine other people log in to.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, watchFile, unwatchFile, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { combineScreens, flowEnvDown, flowEnvStatus, flowEnvUp, instanceOf, instancesOf, prepareInstance, diskReport, dirBytes, dockerSizes, envLock, heldByEnvs, prune, readConfig, readRunnerFile, runnerFile, runnerFiles, snapshotRows, recentStats, docker, withLock, workspaceKey, writeConfig, type PruneWhat } from '@laru/runtime';
import { mail, sqs, envFor, envProjects, flowDir, flowProjects, runDir, proposeJoint, maskJson, mockContracts, sweepOrphans, readRules, saveFaults, setFaults, setMockMode, kafka, storage, mongo, rabbit, redis, custom, cancelRun, compareRuns, failedFlows, markSession, openSessionBrowser, screenOf, sessionToFlow, sessionToScenario, approveBehavior, behaviorIn, readApproved, fidelity, applyScenario, provisionScenario, appliedOn, listScenarios, scenarioState, ScenarioConfirm, shown, sessionBrowser, sessionTrace, startSession, stopSession, listFlows, listRuns, readRun, readTrace, runsDir, startRun, connection, query as dbQuery, reset as dbReset, rows as dbRows, schema as dbSchema, snapshot as dbSnapshot, storeOf, stores as dbStores, storePassword, updateRow, updateSql, type Browse, type RowUpdate, down, envDir, envMasker, missingVars, listEnvs, loadEnvSpec, logs, revealVar, varValues, mountAll, mountedOf, rebuildText, setVar, status, unsetVar, up, varTable, importEnvFile, type Level } from '@laru/runtime';
import { endpointMatcher, flowLast, seenIn, type EndpointMatch, type FlowLast, type Seen, type Trace } from '@laru/trace';
import { affected, brokersOf, doctorChecks, runEnv, screenFindings, vaultServices, writeJoint } from './env-cli.ts';
import { appHome, byCwd, envOf, idOf, initWorkspace, isWorkspace, laruHome, loadRegistry, realRoot, register, resolveId, stateDir, touch, unregister } from '@laru/core';
import { drawModel } from '@laru/diagrams';
import { acceptFinding, withEvidence, shareEvidence, addRepo, queueContracts, CONTAINERS, coverage, DEFAULT_IGNORE, docsLang, documentNote, deriveDiagram, derivedList, evaluateConventions, freshness, liveOf, serviceTests, sheetNote, git, gitOf, isContainer, knowledgeShape, knowledgeWrite, linkRepo, loadExtraction, loadGraph, loadKnowledge, loadWorkspace, PIECE_TYPES, refreshMap, repoStatus, syncRepos, verifyPiece, writeAgentFiles, WorkspaceError, type RepoRole, type Workspace, type WriteInput } from '@laru/core';

const WEB_DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };

/**
 * Playwright's own trace viewer (a static app that ships inside playwright-core, which the runner's tests already
 * need), served from disk so a trace opens with no network. Null when playwright-core is not installed.
 */
let viewerDir: string | null | undefined;
export function traceViewerDir(): string | null {
  if (viewerDir !== undefined) return viewerDir;
  try {
    const fromTrace = createRequire(join(fileURLToPath(new URL('../../../packages/trace/', import.meta.url)), 'x.js'));
    const dir = join(dirname(createRequire(fromTrace.resolve('@playwright/test/package.json')).resolve('playwright-core/package.json')), 'lib', 'vite', 'traceViewer');
    viewerDir = existsSync(join(dir, 'index.html')) ? dir : null;
  } catch { viewerDir = null; }
  return viewerDir;
}
export const VERSION = '0.1.0-beta.13';


export interface Daemon { url: string; port: number; token: string | null; close: () => Promise<void> }

/** An answer with its own status: 404 for what is gone, 400 for what is refused. */
class HttpError extends Error {
  readonly status: number;
  readonly extra?: Record<string, unknown>;
  constructor(status: number, message: string, extra?: Record<string, unknown>) { super(message); this.status = status; this.extra = extra; }
}
/** A scenario that would delete today's rows of a persistent env waits for the person's yes: 409 with what it would do. */
const asked = <T>(p: Promise<T>) => p.catch((e) => { throw e instanceof ScenarioConfirm ? new HttpError(409, e.message) : e; });
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = async (req: IncomingMessage) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
type Handler = (req: IncomingMessage, url: URL, body: any) => Promise<unknown>;
type Stream = (req: IncomingMessage, url: URL, res: ServerResponse) => void;

/**
 * What Docker says, shared for 2 s: the views a page loads together (the shell, a run's flows, the map's envs) ask it
 * once. Docker Desktop on Windows is slow to answer each question, slower with an env's containers up. Only for what
 * views show: a decision (stop, rebuild) asks again.
 */
const lately = new Map<string, { at: number; p: Promise<unknown> }>();
function shared<T>(key: string, f: () => Promise<T>): Promise<T> {
  const hit = lately.get(key);
  if (hit && Date.now() - hit.at < 2000) return hit.p as Promise<T>;
  const p = f();
  lately.set(key, { at: Date.now(), p });
  p.catch(() => lately.delete(key));
  return p;
}
const envStatus = (w: Workspace, env: string) => shared(`status|${w.root}|${env}`, () => status(w, env));
const envsHeld = () => shared('held', heldByEnvs);

/** One workspace's routes, as they were when the service served one workspace: only where `ws()` comes from changed. */
export function makeApi(root: Workspace['root']): { api: Record<string, Handler>; streams: Record<string, Stream> } {
  const ws = () => withEvidence(loadWorkspace(root));

  const envMembers = async (w: Workspace) => Promise.all(listEnvs(w).map(async (e) => ({ env: e, services: (await envStatus(w, e)).services.map((s) => s.service) })));
  const graph = (w: Workspace) => { try { return loadGraph(w); } catch { return null; } };

  // Each flow's results, oldest first, from runs/index.jsonl.
  type Row = { run: string; status: string; ms?: number; at: string };
  const history = (w: Workspace) => {
    const idx = join(runsDir(w), 'index.jsonl');
    const hist: Record<string, Row[]> = {};
    if (existsSync(idx)) for (const l of readFileSync(idx, 'utf8').split('\n').filter(Boolean)) { const x = JSON.parse(l); (hist[x.flow] ??= []).push({ run: x.run, status: x.status, ms: x.ms, at: x.at }); }
    return hist;
  };
  // The coverage rule: the newest result that is not an error; a cached one points at the run that has the evidence.
  const lastRow = (rows: Row[] = []) => rows.findLast((x) => x.status !== 'error');
  const evidenceRun = (w: Workspace, slug: string, row: Row) => (row.status === 'cached' ? readRun(w, row.run)?.results[slug]?.cachedFrom : undefined) ?? row.run;
  const testsOf = (w: Workspace, run: string, slug: string) => {
    const f = join(flowDir(w, run, slug), 'cases.json');
    return { story: readTrace(w, run, slug), cases: existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Trace[]) : [] };
  };

  // Known limit: memo per run/slug; precompute at run end if /api/flows gets slow
  const lastMemo = new Map<string, Omit<FlowLast, 'run' | 'at' | 'status'>>();
  let lastGraph: unknown;
  const lastOf = (w: Workspace, slug: string, row: Row, match: EndpointMatch): FlowLast => {
    const run = evidenceRun(w, slug, row);
    const key = `${run}/${slug}`;
    if (!lastMemo.has(key)) {
      const { story, cases } = testsOf(w, run, slug);
      lastMemo.set(key, story ? flowLast(story, cases, match) : { cases: cases.map((c) => ({ test: c.test, status: c.status })), nodes: [], endpoints: [] });
    }
    return { run, at: row.at, status: row.status as FlowLast['status'], ...lastMemo.get(key)! };
  };
  // What each flow's newest evidence saw, for the contracts to be read against; kept while no run and no map changes.
  let seenMemo: { key: string; g: unknown; seen: Seen } | undefined;

  // Env operations run detached: the request answers at once and the screen follows events.jsonl.
  type Op = { kind: 'up' | 'down'; startedAt: string; error?: string; done?: boolean; admission?: unknown };
  const ops = new Map<string, Op>();
  const detach = (env: string, kind: 'up' | 'down', fn: () => Promise<unknown>) => {
    const cur = ops.get(env);
    if (cur && !cur.done) throw new Error(`${env} is already running ${cur.kind}`);
    const op: Op = { kind, startedAt: new Date().toISOString() };
    ops.set(env, op);
    fn().then(() => { op.done = true; }, (e: Error & { admission?: unknown }) => { op.done = true; op.error = e.message; if (e.admission) op.admission = e.admission; });
    return op;
  };
  const envName = (url: URL, b?: { env?: string }) => {
    const e = b?.env ?? url.searchParams.get('env') ?? '';
    if (!listEnvs(ws()).includes(e) && !instancesOf(ws()).includes(e)) throw new Error(`no env "${e}"`);
    return e;
  };
  const maskerFor = (w: Workspace, env: string) => envMasker(w, env);
  // What the screens show of an env with several projects: which ones it runs, what it joins and shares.
  const envShape = (w: Workspace, env: string) => {
    try { const sp = loadEnvSpec(w, env); return { projects: envProjects(w, env), ...(sp.join ? { join: sp.join, share: sp.share } : {}) }; } catch { return {}; }
  };
  const envForOne = (w: Workspace, g: ReturnType<typeof graph>, f: { id: string; needs: string[] }, ready: Set<string>) => envFor(w, g, [f], ready);

  // Server-sent events: the stream owns the response until the client goes away.
  const sse = (res: ServerResponse) => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const streams: Record<string, Stream> = {
    'GET /api/env/events': (req, url, res) => {
      const env = envName(url);
      sse(res);
      const file = join(envDir(ws(), env), 'events.jsonl');
      let at = 0, head = '';
      const send = () => {
        if (!existsSync(file)) return;
        const text = readFileSync(file, 'utf8');
        // A new up truncates the file: its first line changes, even when it has already outgrown the old one.
        const first = text.slice(0, text.indexOf('\n') + 1);
        if (text.length < at || first !== head) { at = 0; head = first; }
        const end = text.lastIndexOf('\n') + 1; // whole lines only: a half-written one waits for the next poll
        for (const line of text.slice(at, end).split('\n').filter(Boolean)) res.write(`data: ${line}\n\n`);
        at = Math.max(at, end);
        const op = ops.get(env);
        res.write(`event: op\ndata: ${JSON.stringify(op ?? null)}\n\n`);
      };
      send();
      watchFile(file, { interval: 400 }, send);
      req.on('close', () => unwatchFile(file, send));
    },
    // The session's browser as the page sees it: its frames and where it is, relayed from its own local server.
    'GET /api/session/screen': (req, url, res) => {
      const at = screenOf(ws(), url.searchParams.get('id') ?? '');
      if (!at) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'the session browser is not open' })); return; }
      sse(res);
      const ctl = new AbortController();
      req.on('close', () => ctl.abort());
      fetch(`http://127.0.0.1:${at.port}/frames?token=${at.token}`, { signal: ctl.signal }).then(async (r) => {
        for await (const chunk of r.body ?? []) res.write(chunk);
        res.end();
      }).catch(() => res.end());
    },
    'GET /api/mocks/live': (req, url, res) => {
      const w = ws(), env = envName(url), svc = url.searchParams.get('service') ?? '';
      sse(res);
      const f = join(envDir(w, env), 'tap', 'traffic.jsonl');
      let at = existsSync(f) ? statSync(f).size : 0;
      const send = () => {
        if (!existsSync(f)) return;
        const size = statSync(f).size;
        if (size < at) at = 0;
        if (size === at) return;
        // Only the bytes appended since the last look: the journal can be up to 100 MB.
        const fd = openSync(f, 'r');
        const buf = Buffer.alloc(Math.min(size - at, 4 * 1024 * 1024));
        readSync(fd, buf, 0, buf.length, at);
        closeSync(fd);
        const text = buf.toString('utf8');
        at += buf.length;
        for (const l of text.split('\n').filter(Boolean)) { try { const r = JSON.parse(l); if (!svc || r.svc === svc) res.write(`data: ${l}\n\n`); } catch { /* a line cut by rotation */ } }
      };
      const timer = setInterval(send, 500);
      req.on('close', () => clearInterval(timer));
    },
    'GET /api/run/events': (req, url, res) => {
      const w = ws(), id = url.searchParams.get('id') ?? '', r = readRun(w, id);
      if (!r) throw new Error(`no run ${id}`);
      sse(res);
      const dir = runDir(w, id);
      // The runner writes raw test errors (masked in the file once it stops): every string of an event is masked.
      const m = envMasker(w, r.env, r.ephemeral ? id : undefined);
      let at = 0, last = '';
      const send = () => {
        const run = JSON.stringify(readRun(w, id));
        if (run !== last) { last = run; res.write(`event: run\ndata: ${run}\n\n`); }
        const t = readRunnerFile(dir, 'out/events.jsonl'); // the runner's file, still being written: a link is no events
        if (t === undefined) return;
        const end = t.lastIndexOf('\n') + 1;
        for (const l of t.slice(at, end).split('\n').filter(Boolean)) {
          try { res.write(`data: ${JSON.stringify(maskJson(JSON.parse(l), m))}\n\n`); } catch { /* not an event */ }
        }
        at = Math.max(at, end);
      };
      send();
      const timer = setInterval(send, 400);
      req.on('close', () => clearInterval(timer));
    },
    // An object as it is stored, for the browser's own viewers (image, video, audio, PDF), by ranges so a video can seek: it comes through a
    // pipe from the store, never whole into this process. Only those types, never sniffed, never run as a page.
    'GET /api/storage/raw': (req, url, res) => {
      const w = ws(), env = envName(url), at = url.searchParams.get('path') ?? '';
      void (async () => {
        try {
          const s = await storage.storeOfEnv(w, env), meta = await storage.stat(s, at), type = storage.contentTypeOf(meta, at), size = Number(meta.size);
          if (!storage.STREAMABLE.test(type)) { res.writeHead(415, { 'content-type': 'text/plain' }).end('only images, video, audio and PDF are streamed'); return; }
          let start = 0, end = size - 1, code = 200;
          const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
          if (m && size > 0) {
            start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
            end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
            if (start >= size || start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }).end(); return; }
            code = 206;
          }
          const headers: Record<string, string | number> = { 'content-type': type, 'content-length': size ? end - start + 1 : 0, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
          // a vector image may carry script: it is shown as an image only. (A PDF in a sandboxed frame does not open, so it keeps no sandbox.)
          if (type === 'image/svg+xml') headers['content-security-policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
          if (code === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
          res.writeHead(code, headers);
          if (!size) { res.end(); return; }
          const child = storage.slice(s, at, start, end - start + 1);
          child.stdout.pipe(res);
          res.on('close', () => child.kill());
        } catch (e) {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end(e instanceof Error ? e.message : String(e)); else res.end();
        }
      })();
    },
    // A message as the frame draws it (its HTML made safe, with its own policy), an attachment as a download, or the original: bytes, never `json()`.
    'GET /api/mail/html': (_req, url, res) => {
      const w = ws(), env = envName(url), r = mail.part(w, env, url.searchParams.get('id') ?? '', 'html', { width: Number(url.searchParams.get('width')) || undefined });
      res.writeHead(r.status, r.headers).end(r.body);
    },
    'GET /api/mail/part': (_req, url, res) => {
      const w = ws(), env = envName(url), r = mail.part(w, env, url.searchParams.get('id') ?? '', { attachment: Number(url.searchParams.get('n')) });
      res.writeHead(r.status, r.headers).end(r.body);
    },
    'GET /api/mail/eml': (_req, url, res) => {
      const w = ws(), env = envName(url), r = mail.part(w, env, url.searchParams.get('id') ?? '', 'eml');
      res.writeHead(r.status, r.headers).end(r.body);
    },
    // New messages, as a nudge: the screen asks again when the journal grows.
    'GET /api/mail/live': (req, url, res) => {
      const w = ws(), env = envName(url), f = join(mail.mailDir(w, env), 'messages.jsonl');
      sse(res);
      let at = -1;
      const send = () => {
        const size = existsSync(f) ? statSync(f).size : 0;
        if (size === at) return;
        at = size;
        res.write(`data: ${JSON.stringify({ size })}\n\n`);
      };
      send();
      const timer = setInterval(send, 700);
      req.on('close', () => clearInterval(timer));
    },
    // A screen's video recorded outside the runner, as the body of the request: kept beside the story's, named by its screen. At most 1 GiB, to a finished run.
    'POST /api/run/screen-video': (req, url, res) => {
      const w = ws(), id = url.searchParams.get('id') ?? '', flow = url.searchParams.get('flow') ?? '', screen = url.searchParams.get('screen') ?? '';
      const fail = (code: number, error: string) => { req.resume(); json(res, code, { error }); };
      if (!/^\d+$/.test(id) || !/^[a-z0-9][a-z0-9-]*$/.test(flow) || !/^[\w-]{1,32}$/.test(screen)) return fail(400, 'id, flow and screen are plain names');
      const r = readRun(w, id), dir = join(runsDir(w), id, 'flows', flow);
      if (!r || r.phase !== 'done' || !existsSync(dir)) return fail(409, `run ${id} has no finished evidence of ${flow}`);
      const file = join(dir, `video-${screen}.webm`), tmp = `${file}.part`, out = createWriteStream(tmp);
      let size = 0, over = false;
      req.on('data', (c: Buffer) => { size += c.length; if (size > 2 ** 30 && !over) { over = true; req.destroy(); out.destroy(); } });
      req.pipe(out);
      out.on('finish', () => { if (over || !size) { rmSync(tmp, { force: true }); return json(res, over ? 413 : 400, { error: over ? 'a video over 1 GiB is not kept' : 'no video in the request' }); } renameSync(tmp, file); try { shareEvidence(w, id, flow); } catch { /* the video is kept all the same */ } json(res, 200, { ok: true, bytes: size, video: `video-${screen}.webm` }); });
      out.on('error', () => { rmSync(tmp, { force: true }); if (!res.headersSent) json(res, 500, { error: 'could not keep the video' }); });
    },
    'GET /api/run-file': (req, url, res) => {
      const w = ws(), id = url.searchParams.get('id') ?? '', rel = url.searchParams.get('path') ?? '';
      // Only the masked evidence: out/ holds the runner's raw output. And a real file: evidence is moved from what the runner wrote.
      const file = /^\d+$/.test(id) && /^(flows|raw)\//.test(rel) ? runnerFile(join(runsDir(w), id), rel) : undefined;
      if (!file) { res.writeHead(403).end('not a file of this run'); return; }
      const size = statSync(file).size;
      const type = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.png': 'image/png', '.json': 'application/json' }[extname(file)] ?? 'application/octet-stream';
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (m) {
        const start = m[1] ? Number(m[1]) : size - Number(m[2]);
        const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        if (start >= size || start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }).end(); return; }
        res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'cache-control': 'no-store' });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
      createReadStream(file).pipe(res);
    },
    'GET /api/env/logs': (req, url, res) => {
      const w = ws(), env = envName(url), m = maskerFor(w, env);
      sse(res);
      const ac = new AbortController();
      req.on('close', () => ac.abort());
      logs(w, env, { service: url.searchParams.get('service') || undefined, tail: Number(url.searchParams.get('tail') ?? 200), follow: true, signal: ac.signal },
        (service, line) => res.write(`data: ${JSON.stringify({ service, line: m.text(line) })}\n\n`)).catch((e: Error) => res.write(`event: error\ndata: ${JSON.stringify(e.message)}\n\n`));
    },
  };

  const api: Record<string, Handler> = {
    'GET /api/workspace': async () => { const w = ws(); void touch(root).catch(() => undefined); return { app: w.app, title: w.title, docsLanguage: w.docsLanguage, repos: w.repos, root: w.root, id: idOf(root), key: workspaceKey(w) }; },
    'GET /api/disk': async () => diskReport(ws()),
    'GET /api/disk/docker': async () => dockerSizes(ws().app),
    'GET /api/prune/plan': async () => prune(ws(), { dryRun: true }),
    'POST /api/prune': async (_req, _url, b: { dryRun?: boolean; what?: PruneWhat[] }) => prune(ws(), { dryRun: b.dryRun !== false, what: b.what }),
    // A key, never a path: the service builds the path from what the workspace knows.
    'POST /api/reveal': async (_req, _url, b: { what?: string; id?: string; path?: unknown }) => {
      if (b.path !== undefined) throw new HttpError(400, 'reveal takes {what, id}, never a path');
      const w = ws(), id = String(b.id ?? '');
      const at: Record<string, () => string | undefined> = {
        workspace: () => w.root, state: () => stateDir(w), runs: () => runsDir(w), run: () => (/^\d+$/.test(id) ? join(runsDir(w), id) : undefined),
        // `<run>/<file>`: a file of that run's folder, selected in Finder; never a path out of it
        'run-file': () => { const m = /^(\d+)\/(.+)$/.exec(id); return m ? runnerFile(join(runsDir(w), m[1]), m[2]) : undefined; },
        project: () => (w.repos.some((r) => r.name === id) ? w.checkouts[id] : undefined), snapshot: () => snapshotRows(w).find((x) => x.id === id)?.path,
        env: () => (listEnvs(w).includes(id) ? envDir(w, id) : undefined), personal: () => appHome(w.app), home: () => laruHome(),
      };
      const path = at[b.what ?? '']?.();
      if (!path) throw new HttpError(400, `nothing to show for ${JSON.stringify(b.what)}${id ? ` ${id}` : ''}`);
      return reveal(path);
    },
    'GET /api/repos': async () => { const w = ws(); return Promise.all(w.repos.map((r) => repoStatus(w, r))); },
    'GET /api/repos/probe': async (_req, url) => probeFolder(ws(), url.searchParams.get('path') ?? '', (url.searchParams.get('ignore') ?? '').split(',').map((x) => x.trim()).filter(Boolean)),
    'POST /api/repos/add': async (_req, _url, b: { source: string; name?: string; branch?: string; role?: RepoRole; title?: string; ignore?: string[]; link?: string }) => {
      const w = ws();
      const local = /^[~/]/.test(b.source);
      const finish = (name: string) => { writeAgentFiles(w); return { ok: true, name }; };
      if (local) { const r = await addRepo(w, b.source, b); return finish(r.name); }
      if (b.link) { const r = await addRepo(w, b.link, { ...b, name: b.name }); return finish(r.name); }
      // A clone takes a while: it runs detached, and the row says «Clonando…» until it lands.
      const name = b.name ?? b.source.replace(/\.git$/, '').split(/[/:]/).pop()!.toLowerCase();
      detach(`repo:${name}`, 'up', () => addRepo(w, b.source, b).then(() => writeAgentFiles(w)).catch((e: Error) => { throw new Error(/auth|denied|could not read/i.test(e.message) ? 'git no pudo autenticarse; clónalo tú y añádelo con «Ya lo tengo en»' : e.message); }));
      return { ok: true, name, cloning: true };
    },
    'POST /api/repos/sync': async () => { const w = ws(); const st = await syncRepos(w); writeAgentFiles(w); return st; },
    'POST /api/map/refresh': async () => { const { stats, ms, map } = await refreshMap(ws()); return { stats, ms, nodes: map.nodes.length, facts: map.facts.length }; },
    'GET /api/map': async () => { try { return loadGraph(ws()).map; } catch { return null; } },
    'GET /api/knowledge': async () => {
      const w = ws(), k = loadKnowledge(w), g = graph(w);
      const conventions = await evaluateConventions(w, k);
      const memo = new Map();
      return {
        lang: docsLang(w),
        issues: k.issues,
        shapes: Object.fromEntries(PIECE_TYPES.map((t) => [t, knowledgeShape(w, t, false)])),
        containers: CONTAINERS,
        conventions: Object.fromEntries(conventions),
        pieces: k.pieces.map((p) => { const { source: _s, ...rest } = p; return { ...rest, note: documentNote(p), sheet: isContainer(p.type) ? sheetNote(w, k, g, p, conventions, memo) : undefined, freshness: freshness(w, p), coverage: isContainer(p.type) ? coverage(w, k, g, p, conventions) : undefined }; }),
      };
    },
    'GET /api/live': async (_req, url) => { const w = ws(), k = loadKnowledge(w), p = k.byId.get(url.searchParams.get('id') ?? ''); if (!p) throw new WorkspaceError('no such piece', 'id'); return liveOf(w, k, graph(w), p); },
    'GET /api/service-tests': async (_req, url) => { const g = graph(ws()); return g ? serviceTests(ws(), g, url.searchParams.get('id') ?? '') : []; },
    // Derived diagrams: read from the map and the documentation, placed and painted here, so the page only shows them.
    'GET /api/diagrams': async () => { const w = ws(); return derivedList(w, graph(w), loadKnowledge(w), await envMembers(w)); },
    'GET /api/diagram': async (_req, url) => {
      const w = ws(), id = url.searchParams.get('id') ?? '';
      const model = deriveDiagram(w, graph(w), loadKnowledge(w), await envMembers(w), id);
      if (!model) throw new WorkspaceError('no such diagram, or the map is missing', 'id');
      const d = drawModel(model, `d${Math.abs([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`);
      return { id, kind: model.kind, title: model.title, svg: d.svg, mermaid: d.mermaid, viewBox: d.viewBox, ms: d.ms, pieces: model.nodes.length, links: model.edges.length };
    },
    'GET /api/standard': async () => { const w = ws(); return { lang: docsLang(w), types: PIECE_TYPES.map((t) => knowledgeShape(w, t, true)) }; },
    'POST /api/knowledge/validate': async (_req, _url, body: WriteInput) => { const w = ws(); return knowledgeWrite(w, body, graph(w), { dryRun: true }); },
    'POST /api/knowledge/write': async (_req, _url, body: WriteInput) => { const w = ws(); return knowledgeWrite(w, body, graph(w)); },
    'POST /api/knowledge/verify': async (_req, _url, body: { id: string }) => verifyPiece(ws(), body.id),
    'GET /api/envs': async () => { const w = ws(); return Promise.all([...listEnvs(w), ...instancesOf(w)].map(async (e) => ({ ...(await envStatus(w, e)), ...envShape(w, e), op: ops.get(e) ?? null }))); },
    'GET /api/env': async (_req, url) => {
      const w = ws(), env = envName(url);
      let spec = null, specError = null;
      try { spec = loadEnvSpec(w, env); } catch (e) { specError = (e as Error).message; }
      return { ...(await status(w, env, { stats: true })), ...envShape(w, env), spec, specError, op: ops.get(env) ?? null, dir: envDir(w, env) };
    },
    'GET /api/env/join-proposal': async (_req, url) => {
      const w = ws(), g = graph(w);
      if (!g) throw new Error('there is no map yet: «Releer el código» first');
      const envs = listEnvs(w).flatMap((e) => { try { const sp = loadEnvSpec(w, e); return sp.from ? [{ env: e, repo: sp.from.repo }] : []; } catch { return []; } });
      const composeOf = Object.fromEntries(w.repos.map((r) => [r.name, Object.entries(loadExtraction(w, r.name)?.files ?? {}).find(([, f]) => f.findings.some((x) => x.kind === 'compose-service'))?.[0]]));
      return proposeJoint({ name: url.searchParams.get('name') || 'all', picked: (url.searchParams.get('members') ?? '').split(',').filter(Boolean), envs, map: g.map, composeOf, repos: w.repos.map((r) => r.name) });
    },
    'POST /api/env/create': async (_req, _url, b: { name: string; join: string[]; share?: Record<string, string>; create?: Array<{ env: string; from: string }> }) => {
      try { return { ok: true, written: writeJoint(ws(), b.name, b.join, b.share, b.create) }; }
      catch (e) { if (e instanceof WorkspaceError) throw new HttpError(400, e.message, { field: e.at }); throw e; }
    },
    // `worktree`: «Recargar desde mi copia», the env built from the working copies; images are keyed by each service's
    // tree, so only what changed is rebuilt and only its containers are replaced
    // `rebuild`: images built again without the cache and their containers replaced; on a persistent env that is running it asks first
    'POST /api/env/up': async (_req, url, b: { env: string; hybrid?: string[]; force?: boolean; worktree?: boolean; rebuild?: string[]; confirm?: boolean }) => {
      const w = ws(), env = envName(url, b), rebuild = (b.rebuild ?? []).filter((x) => typeof x === 'string' && x);
      if (rebuild.length && b.confirm !== true && loadEnvSpec(w, env).persistent !== false && ['ready', 'starting'].includes((await status(w, env)).state)) throw new HttpError(409, rebuildText(rebuild));
      return detach(env, 'up', () => up(w, { env, hybrid: b.hybrid, force: Boolean(b.force), worktree: Boolean(b.worktree), rebuild }));
    },
    // The whole project env up with every flow's scenario seeded, to walk through all the flows by hand.
    'POST /api/env/mount': async (_req, url, b: { env: string }) => { const w = ws(), env = envName(url, b); return detach(env, 'up', () => mountAll(w, { env })); },
    // With the accounts' passwords, like «reveal»: a POST, so it takes the same gate and no GET hands them out.
    'POST /api/env/mounted': async (_req, url, b: { env: string }) => ({ mounted: mountedOf(ws(), envName(url, b)) }),
    // A flow's environment: an instance of a project env with what the flow needs and its scenario in. It follows the same events and operations as any env.
    'GET /api/flow-env': async (_req, url) => { const w = ws(), r = await flowEnvStatus(w, url.searchParams.get('flow') ?? ''); return { ...r, op: ops.get(r.instance) ?? null }; },
    'POST /api/flow-env/up': async (_req, _url, b: { flow: string; from?: string; stopOffered?: boolean }) => {
      const w = ws(), env = instanceOf(String(b.flow ?? '').replace(/^flow:/, ''));
      prepareInstance(w, String(b.flow).replace(/^flow:/, ''), b.from);
      return detach(env, 'up', () => flowEnvUp(w, String(b.flow).replace(/^flow:/, ''), { from: b.from, stopOffered: b.stopOffered === true }));
    },
    'POST /api/flow-env/down': async (_req, _url, b: { flow: string }) => {
      const w = ws(), slug = String(b.flow ?? '').replace(/^flow:/, '');
      return detach(instanceOf(slug), 'down', () => flowEnvDown(w, slug));
    },
    'POST /api/env/down': async (_req, url, b: { env: string; dryRun?: boolean; caches?: boolean }) => {
      const w = ws(), env = envName(url, b);
      if (b.dryRun) return down(w, env, { dryRun: true, caches: b.caches });
      return detach(env, 'down', () => down(w, env, { caches: b.caches }));
    },
    'GET /api/db/stores': async (_req, url) => { const w = ws(), env = envName(url); return (await dbStores(w, env)).map((s) => ({ ...s, conn: connection(s, w.app) })); },
    'GET /api/db/schema': async (_req, url) => { const w = ws(); return dbSchema(await storeOf(w, envName(url), url.searchParams.get('service') ?? undefined)); },
    'POST /api/db/rows': async (_req, url, b: { env: string; service?: string; browse: Browse }) => dbRows(await storeOf(ws(), envName(url, b), b.service), b.browse),
    'POST /api/db/query': async (_req, url, b: { env: string; service?: string; sql: string; limit?: number }) => dbQuery(await storeOf(ws(), envName(url, b), b.service), b.sql, { limit: b.limit ?? 500 }),
    'POST /api/db/update/preview': async (_req, url, b: { env: string; service?: string; update: RowUpdate }) => { const s = await storeOf(ws(), envName(url, b), b.service); return { preview: updateSql(b.update, s.kind).preview, as: s.user }; },
    'POST /api/db/update/apply': async (_req, url, b: { env: string; service?: string; update: RowUpdate }) => updateRow(await storeOf(ws(), envName(url, b), b.service), b.update),
    'POST /api/db/password': async (_req, url, b: { env: string; service?: string }) => ({ value: await storePassword(await storeOf(ws(), envName(url, b), b.service)) }),
    'POST /api/env/snapshot': async (_req, url, b: { env: string; service?: string }) => { const w = ws(), env = envName(url, b); return withLock(`snapshot ${w.app}/${env}`, async () => { const out = []; for (const s of b.service ? [await storeOf(w, env, b.service)] : (await dbStores(w, env)).filter((x) => x.kind === 'postgres')) out.push({ service: s.service, ...(await dbSnapshot(s)) }); return out; }, undefined, envLock(w, env)); },
    'POST /api/env/reset': async (_req, url, b: { env: string; service?: string }) => { const w = ws(), env = envName(url, b); return withLock(`reset ${w.app}/${env}`, async () => { const out = []; for (const s of b.service ? [await storeOf(w, env, b.service)] : (await dbStores(w, env)).filter((x) => x.kind === 'postgres')) out.push({ service: s.service, ...(await dbReset(s)) }); return out; }, undefined, envLock(w, env)); },
    'GET /api/flows': async () => {
      const w = ws(), g = graph(w);
      if (g !== lastGraph) { lastMemo.clear(); lastGraph = g; }
      const match = endpointMatcher(g?.map.nodes ?? []);
      const hist = history(w);
      const several = w.repos.length > 1;
      const ready = several ? new Set((await Promise.all(listEnvs(w).map((e) => envStatus(w, e).catch(() => null)))).filter((x) => x?.state === 'ready').map((x) => x!.env)) : new Set<string>();
      return listFlows(w).map((f) => {
        const row = lastRow(hist[f.slug]);
        let runsOn: { env: string; ready: boolean } | null = null;
        if (several) try { const env = envForOne(w, g, f, ready); runsOn = { env, ready: ready.has(env) }; } catch { /* no env runs its projects: a finding says so */ }
        return { ...f, history: (hist[f.slug] ?? []).slice(-10), last: row ? lastOf(w, f.slug, row, match) : null, ...(several ? { projects: flowProjects(g, f), runsOn } : {}) };
      });
    },
    'GET /api/runs/env': async (_req, url) => {
      const w = ws(), env = await runEnv(w, (url.searchParams.get('flows') ?? '').split(',').filter(Boolean));
      return { env, ready: (await status(w, env)).state === 'ready' };
    },
    'GET /api/seen': async () => {
      const w = ws(), g = graph(w);
      const last = Object.entries(history(w)).flatMap(([slug, rows]) => { const row = lastRow(rows); return row ? [{ slug, row, run: evidenceRun(w, slug, row) }] : []; });
      const key = last.map((x) => `${x.slug}@${x.run}@${x.row.at}`).join(',');
      if (seenMemo?.key !== key || seenMemo.g !== g) {
        const tests = last.flatMap(({ slug, row, run }) => { const { story, cases } = testsOf(w, run, slug); return [...(story ? [story] : []), ...cases].map((trace) => ({ trace, at: row.at })); });
        seenMemo = { key, g, seen: seenIn(tests, endpointMatcher(g?.map.nodes ?? [])) };
      }
      return seenMemo.seen;
    },
    'GET /api/mock-contracts': async () => mockContracts(ws()),
    // `?running=1`: only what is in progress (the shell asks it every few seconds)
    'GET /api/runs': async (_req, url) => { const l = listRuns(ws(), 50); return url.searchParams.get('running') ? l.filter((r) => r.phase !== 'done') : l; },
    'GET /api/run': async (_req, url) => {
      const w = ws(), id = url.searchParams.get('id') ?? '', r = readRun(w, id);
      if (!r || !/^\d+$/.test(id)) throw new HttpError(404, `no run ${id}`);
      const dir = runDir(w, id);
      let projects: string[] | undefined;
      if (w.repos.length > 1) try { projects = envProjects(w, r.env); } catch { /* an env file that went away */ }
      // the last passed (or cached) and the last failed of each flow are never removed by retention
      const last = new Map<string, Row>();
      for (const [flow, rows] of Object.entries(history(w))) for (const x of rows) if (x.status !== 'error') last.set(`${flow}|${x.status === 'failed' ? 'failed' : 'passed'}`, x);
      const kept = [...last].find(([, x]) => x.run === id);
      return { ...r, dir, bytes: dirBytes(dir), ...(projects ? { projects } : {}), retention: { policy: readConfig().retention, ...(kept ? { keptFor: { flow: kept[0].split('|')[0], status: kept[0].split('|')[1] } } : {}) } };
    },
    'GET /api/run/trace': async (_req, url) => {
      const w = ws(), id = url.searchParams.get('id') ?? '', flow = url.searchParams.get('flow') ?? '';
      const cases = join(flowDir(w, id, flow), 'cases.json');
      return { trace: readTrace(w, id, flow), cases: existsSync(cases) ? JSON.parse(readFileSync(cases, 'utf8')) : [] };
    },
    // The story of a run against the flow's approved behavior, for the Run screen's «Comportamiento».
    'GET /api/behavior': async (_req, url) => {
      const w = ws(), flow = url.searchParams.get('flow') ?? '', run = url.searchParams.get('run') ?? '';
      const approved = readApproved(w, flow), now = behaviorIn(w, run, flow).behavior;
      const { driftOf } = await import('@laru/trace');
      return { approved, now, drifts: approved ? driftOf(approved, now) : [] };
    },
    // The env card and the `infrastructure` sheet read this table: each declared aspect of production against the env.
    'GET /api/fidelity': async (_req, url) => fidelity(ws(), envName(url)),
    'POST /api/behavior/approve': async (_req, _url, b: { flow: string; run?: string; last?: number }) => approveBehavior(ws(), b.flow, { run: b.run, last: b.last }),
    'GET /api/scenarios': async (_req, url) => {
      const w = ws(), env = envName(url);
      return { applied: appliedOn(w, env), scenarios: listScenarios(w).map((s) => { const st = scenarioState(w, env, s.slug); return { ...s, state: st && shown(st) }; }) };
    },
    // No answer about scenarios carries a password (`shown`). A persistent env waits for `confirm: true`: 409 says what applying would delete.
    // Provisioning is playing the setup again from «base» and keeping what it can as snapshots; «Aplicar» does it the first time by itself.
    'POST /api/scenarios/provision': async (_req, url, b: { name: string; env?: string; confirm?: boolean }) => shown(await asked(provisionScenario(ws(), b.name, { env: envName(url, b), confirm: b.confirm === true }))),
    'POST /api/scenarios/apply': async (_req, url, b: { name: string; env?: string; confirm?: boolean }) => shown(await asked(applyScenario(ws(), b.name, { env: envName(url, b), confirm: b.confirm === true }))),
    // every screen of a flow in one video, side by side (made the first time, kept after)
    'POST /api/run/video': async (_req, _url, b: { id: string; flow: string }) => ({ file: await combineScreens(ws(), b.id, b.flow) }),
    'POST /api/session/start': async (_req, url, b: { env?: string; title?: string; browser?: boolean; scenario?: string; flow?: string; front?: string; device?: string; confirm?: boolean }) => {
      const w = ws(), run = await asked(startSession(w, { env: envName(url, b), title: b.title, scenario: b.scenario, flow: b.flow, front: b.front, device: b.device === 'phone' ? 'phone' : undefined, confirm: b.confirm === true }));
      if (b.browser) openSessionBrowser(w, run.id);
      return { run };
    },
    'POST /api/session/input': async (_req, _url, b: { id: string; input: unknown }) => {
      const at = screenOf(ws(), b.id);
      if (!at) throw new HttpError(409, 'the session browser is not open');
      const r = await fetch(`http://127.0.0.1:${at.port}/input?token=${at.token}`, { method: 'POST', body: JSON.stringify(b.input) });
      return { ok: r.ok };
    },
    'POST /api/session/to-scenario': async (_req, _url, b: { id: string; in: string; title?: string }) => sessionToScenario(ws(), b.id, { in: b.in, title: b.title }),
    'POST /api/session/to-flow': async (_req, _url, b: { id: string; in: string; title?: string }) => sessionToFlow(ws(), b.id, { in: b.in, title: b.title }),
    'POST /api/session/browser': async (_req, _url, b: { id: string }) => { openSessionBrowser(ws(), b.id); return { browser: sessionBrowser(ws(), b.id) }; },
    'POST /api/session/mark': async (_req, _url, b: { id: string; text: string }) => markSession(ws(), b.id, b.text ?? ''),
    'POST /api/session/stop': async (_req, _url, b: { id: string }) => ({ run: await stopSession(ws(), b.id) }),
    'GET /api/session/trace': async (_req, url) => {
      const w = ws(), id = url.searchParams.get('id') ?? '';
      return { ...(await sessionTrace(w, id, { kafka: url.searchParams.get('kafka') !== '0' })), browser: sessionBrowser(w, id) };
    },
    'GET /api/run/files': async (_req, url) => {
      const id = url.searchParams.get('id') ?? '', base = join(runsDir(ws()), id);
      if (!/^\d+$/.test(id)) throw new Error(`no run ${id}`);
      // What /api/run-file serves: the masked evidence, never out/.
      return ['flows', 'raw'].flatMap((d) => runnerFiles(base, d)).map((path) => ({ path, bytes: statSync(join(base, path)).size }));
    },
    // A flow that starts from a scenario applies it first: on a persistent env that waits for `confirm: true` like «Aplicar» does (409 says what it would delete).
    // «Recargar y repetir»: `affected` (what the change in the working copies reaches, built from them) and `failed` (what failed unexpectedly in this env) together, once each.
    'POST /api/runs/start': async (_req, url, b: { env?: string; flows?: string[]; ephemeral?: boolean; failed?: boolean; affected?: boolean; confirm?: boolean; pwTrace?: boolean }) => {
      const w = ws();
      let worktree = false;
      if (b.failed || b.affected) {
        const picked = new Set(b.flows ?? []);
        if (b.failed) failedFlows(w, b.env).forEach((f) => picked.add(f));
        if (b.affected) { const im = await affected(w); im.flows.forEach((f) => picked.add(f.id.replace(/^flow:/, ''))); worktree = im.changes.length > 0; }
        if (!picked.size) throw new HttpError(409, b.affected ? 'nothing the change reaches, and no flow failed unexpectedly' : 'no flow failed unexpectedly in its last run');
        b.flows = [...picked];
      }
      // No env: the smallest that runs every project the flows need (local, with one project).
      const env = b.env ? envName(url, b) : await runEnv(w, b.flows ?? []);
      return { id: await asked(startRun(w, { env, flows: b.flows, ephemeral: b.ephemeral, worktree, confirm: b.confirm === true, pwTrace: b.pwTrace !== false })), env, flows: b.flows }; // the interface always records Playwright's trace
    },
    'POST /api/runs/cancel': async (_req, _url, b: { id: string }) => ({ ok: await cancelRun(ws(), b.id) }),
    'GET /api/runs/compare': async (_req, url) => compareRuns(ws(), url.searchParams.get('a') ?? '', url.searchParams.get('b') ?? ''),
    'GET /api/mocks': async (_req, url) => {
      const w = ws(), env = envName(url), dir = join(envDir(w, env), 'tap');
      const routes = existsSync(join(dir, 'routes.json')) ? JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8')).routes : [];
      return { rules: readRules(w, env), routes, spec: { mocks: loadEnvSpec(w, env).mocks, faults: loadEnvSpec(w, env).faults } };
    },
    'POST /api/mocks/mode': async (_req, url, b: { env: string; service: string; mode: never }) => setMockMode(ws(), envName(url, b), b.service, b.mode),
    'POST /api/mocks/faults': async (_req, url, b: { env: string; service: string; rules: never[] }) => setFaults(ws(), envName(url, b), b.service, b.rules, false),
    'POST /api/mocks/save': async (_req, url, b: { env: string }) => { saveFaults(ws(), envName(url, b)); return { ok: true }; },
    // The topics against their contracts, the code and the runs: files only, so it answers with every env stopped.
    // SQS, read only: the queues with their counts, and a look at one's messages that hides none of them.
    'GET /api/sqs/queues': async (_req, url) => sqs.queues(await sqs.sqsOf(ws(), envName(url))),
    'GET /api/sqs/peek': async (_req, url) => { const w = ws(), env = envName(url); return sqs.peek(w, env, await sqs.sqsOf(w, env), url.searchParams.get('queue') ?? '', Number(url.searchParams.get('n') ?? 10)); },
    'GET /api/queue/contracts': async () => { const w = ws(); return queueContracts(w, graph(w), loadKnowledge(w)); },
    'GET /api/queues': async (_req, url) => { const b = await kafka.brokerOf(ws(), envName(url)); const [topics, groups] = await Promise.all([kafka.topics(b), kafka.groups(b)]); return { broker: b.service, topics, groups }; },
    'GET /api/queue/peek': async (_req, url) => { const w = ws(), env = envName(url); return kafka.peek(w, env, await kafka.brokerOf(w, env), url.searchParams.get('topic') ?? '', Number(url.searchParams.get('limit') ?? 20)); },
    'POST /api/queue/publish': async (_req, url, b: { env: string; topic: string; value: string; key?: string }) => { await kafka.publish(await kafka.brokerOf(ws(), envName(url, b)), b.topic, b.value, b.key); return { ok: true }; },
    // «Colas» for whichever broker the env has; the Kafka routes above keep their shapes.
    'GET /api/brokers': async (_req, url) => brokersOf(ws(), envName(url)),
    'GET /api/rabbit/queues': async (_req, url) => { const w = ws(), env = envName(url), r = await rabbit.rabbitOf(w, env); const [queues, bindings, exchanges] = await Promise.all([rabbit.queues(r), rabbit.bindings(r, maskerFor(w, env)), rabbit.exchanges(r)]); return { broker: r.service, queues, bindings, exchanges: exchanges.map((x) => ({ name: x.name, type: x.type })) }; },
    'POST /api/rabbit/route': async (_req, url, b: { env: string; exchange?: string; routingKey: string }) => { const w = ws(), env = envName(url, b); return { route: await rabbit.route(await rabbit.rabbitOf(w, env), b.exchange ?? '', b.routingKey, maskerFor(w, env)) }; },
    // A peek requeues what it reads (a quorum queue's order changes): a POST, never a link someone can send.
    'POST /api/rabbit/get': async (_req, url, b: { env?: string; queue: string; count?: number; reorder?: boolean }) => { const w = ws(), env = envName(url, b); return rabbit.get(await rabbit.rabbitOf(w, env), b.queue ?? '', maskerFor(w, env), Math.min(Number(b.count ?? 5), 50), b.reorder === true); },
    'POST /api/rabbit/publish': async (_req, url, b: { env: string; exchange?: string; routingKey: string; payload: string }) => ({ routed: await rabbit.publish(await rabbit.rabbitOf(ws(), envName(url, b)), b.exchange ?? '', b.routingKey, b.payload) }),
    'GET /api/redis/stores': async (_req, url) => (await redis.redisStores(ws(), envName(url))).map((s) => ({ service: s.service, conn: redis.connection(s) })),
    'GET /api/redis/keys': async (_req, url) => { const w = ws(), env = envName(url), s = await redis.redisOf(w, env, url.searchParams.get('service') || undefined); return { service: s.service, keys: await redis.keys(s, maskerFor(w, env), url.searchParams.get('pattern') || '*') }; },
    'GET /api/redis/key': async (_req, url) => { const w = ws(), env = envName(url); return redis.read(await redis.redisOf(w, env, url.searchParams.get('service') || undefined), url.searchParams.get('key') ?? '', maskerFor(w, env)); },
    'POST /api/redis/del': async (_req, url, b: { env: string; service?: string; key: string }) => ({ ok: await redis.del(await redis.redisOf(ws(), envName(url, b), b.service), b.key) }),
    // Stores laru.yaml explains how to look into (`stores.<name>.explore`): any engine, through its own container's command.
    'GET /api/custom/stores': async (_req, url) => custom.customStores(ws(), envName(url)),
    'POST /api/custom/run': async (_req, url, b: { env?: string; service: string; what: 'query' | 'tables' | 'table'; input?: string }) => {
      const w = ws(), env = envName(url, b);
      return custom.customRun(w, env, b.service, { what: b.what, input: b.input }, maskerFor(w, env));
    },
    'GET /api/mongo/stores': async (_req, url) => (await mongo.mongoStores(ws(), envName(url))).map((s) => ({ ...s, conn: mongo.connection(s) })),
    'GET /api/mongo/dbs': async (_req, url) => mongo.dbs(await mongo.mongoOf(ws(), envName(url), url.searchParams.get('service') ?? undefined)),
    'GET /api/mongo/collections': async (_req, url) => mongo.collections(await mongo.mongoOf(ws(), envName(url), url.searchParams.get('service') ?? undefined), url.searchParams.get('db') ?? ''),
    'POST /api/mongo/find': async (_req, url, b: { env: string; service?: string } & mongo.Find) => { const w = ws(), env = envName(url, b); return mongo.find(await mongo.mongoOf(w, env, b.service), b, maskerFor(w, env)); },
    'GET /api/mongo/doc': async (_req, url) => {
      const w = ws(), env = envName(url), p = (k: string) => url.searchParams.get(k) ?? '';
      return { doc: await mongo.get(await mongo.mongoOf(w, env, p('service') || undefined), p('db'), p('collection'), p('id'), maskerFor(w, env)) };
    },
    'GET /api/storage/ls': async (_req, url) => storage.ls(await storage.storeOfEnv(ws(), envName(url)), url.searchParams.get('path') ?? '', url.searchParams.get('recursive') === '1'),
    'GET /api/storage/object': async (_req, url) => {
      const w = ws(), env = envName(url), s = await storage.storeOfEnv(w, env), at = url.searchParams.get('path') ?? '';
      const meta = await storage.stat(s, at), type = storage.contentTypeOf(meta, at);
      // what the browser shows by itself is streamed by /api/storage/raw; a spreadsheet has its own reader (/api/storage/sheet)
      if (storage.STREAMABLE.test(type) || type === storage.XLSX) return { meta, type, truncated: false, stream: type === storage.XLSX ? 'sheet' : 'raw' };
      const c = await storage.cat(s, at, 256 * 1024);
      const text = /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/.test(c.bytes.toString('utf8', 0, 4096));
      if (!text) return { meta, type, truncated: c.truncated, base64: c.bytes.toString('base64') };
      // Masked like a queue peek or an env log: a file holding a vault value shows its mark, never the value.
      const m = maskerFor(w, env), masked = m.body(c.bytes.toString('utf8'), String((meta.metadata as Record<string, unknown> | undefined)?.['Content-Type'] ?? ''));
      return { meta, type, truncated: c.truncated, text: c.truncated ? m.cut(masked, 'end') : masked };
    },
    // A spreadsheet as rows, read here and masked like any text: a cell holding a vault value shows its mark, never the value.
    'GET /api/storage/sheet': async (_req, url) => {
      const w = ws(), env = envName(url), s = await storage.storeOfEnv(w, env), at = url.searchParams.get('path') ?? '';
      const meta = await storage.stat(s, at);
      if (Number(meta.size) > 25 * 2 ** 20) throw new HttpError(413, 'a spreadsheet over 25 MB is not previewed');
      const bytes = await storage.cat(s, at, 25 * 2 ** 20);
      const m = maskerFor(w, env), r = storage.sheet(bytes.bytes);
      return { ...r, rows: r.rows.map((row) => row.map((c) => m.text(c))) };
    },
    'GET /api/mail': async (_req, url) => {
      const w = ws(), env = envName(url), q = url.searchParams;
      const kind = q.get('kind') === 'mail' || q.get('kind') === 'sms' ? (q.get('kind') as 'mail' | 'sms') : 'all';
      const st = await status(w, env).catch(() => undefined);
      let sinks: ReturnType<typeof mail.sinkReport> | undefined;
      try { sinks = mail.sinkReport(w, env); } catch { /* an env that does not load has no sinks to show */ }
      return { env, state: st?.state ?? 'absent', sinks, plan: mail.plan(w, env), ...mail.list(w, env, { kind, query: q.get('q') ?? '', limit: Number(q.get('limit')) || 500 }) };
    },
    'GET /api/mail/message': async (_req, url) => {
      const m = mail.message(ws(), envName(url), url.searchParams.get('id') ?? '');
      if (!m) throw new HttpError(404, 'no such message');
      return mail.withOpen(ws(), envName(url), m);
    },
    'POST /api/mail/enable': async (_req, url, b: { env?: string; as?: string; confirm?: boolean }) => mail.enable(ws(), envName(url, b), { as: b.as, confirm: b.confirm }),
    'POST /api/mail/clear': async (_req, url, b: { env?: string }) => mail.clear(ws(), envName(url, b)),
    'POST /api/mail/delete': async (_req, url, b: { env?: string; ids: string[] }) => mail.remove(ws(), envName(url, b), (b.ids ?? []).filter((x) => /^[0-9a-f-]{36}$|^SM[0-9a-f]{32}$/.test(x))),
    'POST /api/mail/sms-status': async (_req, url, b: { env?: string; id: string; status: 'sent' | 'delivered' | 'undelivered' | 'failed'; code?: number }) => mail.smsStatus(ws(), envName(url, b), b.id, b.status, b.code),
    'POST /api/mail/sms-reply': async (_req, url, b: { env?: string; from: string; body: string }) => mail.smsReply(ws(), envName(url, b), b.from, b.body),
    'GET /api/findings': async (_req, url) => screenFindings(ws(), url.searchParams.get('env') ?? undefined),
    'POST /api/findings/accept': async (_req, _url, b: { key: string; reason: string; until?: string }) => { acceptFinding(ws(), b.key, { reason: b.reason, until: b.until, by: process.env.USER }); return { ok: true }; },
    'GET /api/impact': async () => affected(ws()),
    'GET /api/overview': async () => {
      const w = ws(), k = loadKnowledge(w);
      const [envs, findings, im] = await Promise.all([
        Promise.all(listEnvs(w).map((e) => envStatus(w, e))),
        screenFindings(w).catch(() => []),
        affected(w).catch(() => null),
      ]);
      const open = findings.filter((f) => !f.accepted);
      return {
        envs: envs.map((e) => ({ env: e.env, state: e.state, source: e.source, lastReadyAt: e.lastReadyAt, services: e.services.length, healthy: e.services.filter((s) => ['healthy', 'running', 'done', 'host'].includes(s.health)).length })),
        runs: listRuns(w, 8),
        flows: listFlows(w).map((f) => ({ id: f.id, slug: f.slug, title: f.title, exists: f.exists })),
        findings: { open: open.length, accepted: findings.length - open.length, byType: Object.fromEntries([...new Set(open.map((f) => f.type))].map((t) => [t, open.filter((f) => f.type === t).length])), errors: open.filter((f) => f.severity === 'error').slice(0, 5) },
        stale: k.pieces.filter((p) => freshness(w, p) === 'stale').map((p) => ({ id: p.id, title: p.title })),
        impact: im && { changes: im.changes.length, services: im.services, flows: im.flows },
      };
    },
    'GET /api/vars': async (_req, url) => {
      const w = ws(), env = envName(url), services = vaultServices(w, env), g = graph(w);
      return { env, read: services.length > 0, rows: varTable(w, env, services, g), issues: services.length ? missingVars(w, env, services, g) : [] };
    },
    'POST /api/vars/set': async (_req, _url, b: { key: string; value: string; level: Level; scope?: string; secret?: boolean }) => { await setVar(ws(), b); return { ok: true }; },
    'POST /api/vars/unset': async (_req, _url, b: { key: string; level: Level; scope?: string }) => ({ ok: await unsetVar(ws(), b) }),
    'POST /api/vars/reveal': async (_req, url, b: { env: string; key: string; scope?: string }) => ({ value: await revealVar(ws(), envName(url, b), b.key, b.scope) }),
    'POST /api/vars/values': async (_req, url, b: { env: string }) => ({ entries: await varValues(ws(), envName(url, b)) }),
    'POST /api/vars/import': async (_req, _url, b: { from: string; env?: string }) => importEnvFile(ws(), b.from, { env: b.env }),
    'GET /api/doctor': async () => ({ checks: await doctorChecks(ws()) }),
    'GET /api/repo-tree': async (_req, url) => {
      const w = ws();
      const name = url.searchParams.get('repo') ?? '';
      const ex = loadExtraction(w, name);
      if (!ex || !w.checkouts[name] || !existsSync(w.checkouts[name])) return { dirs: [] };
      const { cwd, env } = gitOf(w, name);
      const out = await git(cwd, ['ls-tree', '-r', '-d', '--name-only', ex.commit], env);
      return { commit: ex.commit, dirs: out.split('\n').filter((d) => d && d.split('/').length <= 3 && !/(^|\/)(\.|node_modules|target|dist|build)/.test(d)) };
    },
  };

  return { api, streams };
}

/**
 * `token`: the API and the pages need the session cookie, handed out for the token. `laru serve` always asks for it: a
 * container reaches 127.0.0.1 through host.docker.internal (Docker Desktop, OrbStack) with any Host header it likes and
 * no Sec-Fetch-Site, so only a secret keeps the app under test, an image of the compose or a spec out. `session`: the
 * cookie's value, kept across starts (sessionSecret) so a restart does not sign the browser out.
 */
export async function startDaemon(port = 4100, webDist = WEB_DIST, o: { token?: boolean; session?: string } = {}): Promise<Daemon> {
  const token = o.token ? randomBytes(24).toString('base64url') : null;
  const session = o.session ?? randomBytes(24).toString('base64url');
  // One handler table per workspace root, made on its first request: each keeps its own ops, memos and streams.
  const apis = new Map<string, ReturnType<typeof makeApi>>();
  const apiOf = (root: string) => apis.get(root) ?? apis.set(root, makeApi(root)).get(root)!;
  let actual = port;
  const machine = machineApi(() => actual);

  const server = createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(421).end('Misdirected request'); return; }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      // No page of another origin frames this one (clickjacking), whatever it serves.
      res.setHeader('content-security-policy', "frame-ancestors 'self'; frame-src 'self'");
      res.setHeader('x-frame-options', 'SAMEORIGIN');
      // A request that comes from another page of this machine (a dev server on another port is same-site, so the
      // SameSite cookie goes with it) is refused. This page, the address bar (none) and the CLI (no header) are not.
      const site = req.headers['sec-fetch-site'];
      if (url.pathname.startsWith('/api/') && site !== undefined && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: 'This service answers only to its own page.' });
      // Cookies are per host, not per port: the name carries the port, so another Laru on 127.0.0.1 never replaces it.
      const cookie = new RegExp(`(?:^|;\\s*)laru_${actual}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1] ?? '';
      const authed = !token || same(cookie, session);
      // Whether a Laru answers here, and which (its pid: daemon.json's file is checked against it): no session needed.
      if (url.pathname === '/api/ping') return json(res, 200, { laru: VERSION, pid: process.pid });

      // The token is exchanged for the cookie. One from an earlier start is dropped for whoever has the cookie already
      // (an old address, a bookmark) and refused to anyone else; with no token asked, it is just dropped.
      if (url.searchParams.has('token')) {
        const good = token !== null && same(url.searchParams.get('token')!, token);
        if (token && !good && !authed) { res.writeHead(403).end('Wrong token'); return; }
        url.searchParams.delete('token');
        res.writeHead(303, { ...(good ? { 'set-cookie': `laru_${actual}=${session}; HttpOnly; SameSite=Strict; Path=/` } : {}), location: url.pathname + url.search + url.hash });
        res.end();
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authed) return json(res, 401, { error: 'Open the address printed by `laru serve` or `laru open`.' });
        // A POST that is not JSON is refused, and one with no type too: a form or a no-cors fetch cannot send application/json.
        // The one exception: a screen recorded somewhere the runner is not (another browser, a device) hands its video in as video/webm.
        const video = req.method === 'POST' && url.pathname.endsWith('/run/screen-video') && /^video\/webm\s*(;|$)/i.test(req.headers['content-type'] ?? '');
        if (req.method === 'POST' && !video && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'JSON only' });
        // /api/w/<id>/<rest>: that workspace's "<METHOD> /api/<rest>"; anything else is the machine's.
        const m = /^\/api\/w\/([^/]+)(\/.*)$/.exec(url.pathname);
        let table: { api: Record<string, Handler>; streams: Record<string, Stream> } = { api: machine, streams: {} };
        let key = `${req.method} ${url.pathname}`;
        if (m) {
          const id = decodeURIComponent(m[1]), root = resolveId(id);
          if (!root || !isWorkspace(root)) return json(res, 404, { error: `no workspace ${id} on this machine`, workspace: id });
          table = apiOf(root);
          key = `${req.method} /api${m[2]}`;
        }
        const stream = table.streams[key];
        if (stream) { stream(req, url, res); return; }
        const handler = table.api[key];
        if (!handler) return json(res, 404, { error: 'Not found' });
        return json(res, 200, await handler(req, url, req.method === 'POST' ? await readBody(req) : undefined));
      }
      if (url.pathname.startsWith('/trace-viewer/') && authed) {
        const root = traceViewerDir();
        if (!root) { res.writeHead(503).end('Playwright\'s trace viewer is not installed here (playwright-core).'); return; }
        const rel = decodeURIComponent(url.pathname.slice('/trace-viewer/'.length)) || 'index.html';
        const file = resolve(root, rel);
        if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('Not found'); return; }
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(readFileSync(file));
        return;
      }
      if (!authed) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }).end('Laru: abre la dirección que da `laru open` (lleva el token que da acceso a este navegador).'); return; }
      // Static: the built interface, with index.html for every other path.
      const file = normalize(join(webDist, url.pathname));
      // inside the built folder itself, not a sibling whose name starts the same (dist-old/…); `sep`: Windows paths use \
      const target = file.startsWith(resolve(webDist) + sep) && existsSync(file) && statSync(file).isFile() ? file : join(webDist, 'index.html');
      if (!existsSync(target)) { res.writeHead(503).end('The interface is not built: run `pnpm --filter @laru/web build`.'); return; }
      res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream', 'cache-control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable' });
      res.end(readFileSync(target));
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      json(res, e instanceof HttpError ? e.status : 500, { error: e instanceof Error ? e.message : String(e), ...(e instanceof HttpError ? e.extra : {}) });
    }
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
  actual = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${actual}/${token ? `?token=${token}` : ''}`, port: actual, token, close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()); }) };
}

/** «Añadir proyecto» says 20.000+ from here: past it, the count stops. */
export const PROBE_CAP = 20_000;
/**
 * What «Añadir proyecto» shows while a path is typed: a git clone with its origin, or a folder and how many files
 * Laru would read of it with the typed ignores, up to PROBE_CAP (a throwaway listing through a temporary git dir, removed after; the folder
 * is untouched), and whether it overlaps the workspace or another project. `/` and the home folder are too wide to be
 * a project (addRepo refuses them): answered at once, never listed.
 */
export async function probeFolder(w: Workspace, path: string, ignore: string[] = []): Promise<{ exists: boolean; isGit: boolean; origin: string | null; files: number; overlap?: string; wide?: true }> {
  const abs = path.replace(/^~(?=\/|$)/, homedir());
  if (!abs.startsWith('/') || !existsSync(abs) || !statSync(abs).isDirectory()) return { exists: false, isGit: false, origin: null, files: 0 };
  const real = realpathSync(abs);
  if (real === '/' || real === realpathSync(homedir())) return { exists: true, isGit: false, origin: null, files: 0, wide: true };
  const run = promisify(execFile);
  const tryGit = (args: string[], env: Record<string, string> = {}) => run('git', args, { cwd: real, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...env } }).then((r) => r.stdout.trim(), () => null);
  const isGit = (await tryGit(['rev-parse', '--is-inside-work-tree'])) === 'true';
  const origin = isGit ? await tryGit(['remote', 'get-url', 'origin']) : null;
  const inside = (a: string, b: string) => a === b || a.startsWith(b + sep);
  const root = realpathSync(w.root);
  let overlap: string | undefined;
  if (inside(real, root) || inside(root, real)) overlap = `el workspace (${root})`;
  for (const [name, dir] of Object.entries(w.checkouts)) if (!overlap && dir && existsSync(dir) && (inside(real, realpathSync(dir)) || inside(realpathSync(dir), real))) overlap = `${name} (${dir})`;
  let files = 0;
  if (!origin) {
    const tmp = mkdtempSync(join(tmpdir(), 'laru-probe-'));
    try {
      await tryGit(['init', '--bare', '-q', join(tmp, 'g')], { GIT_CONFIG_GLOBAL: '/dev/null' });
      writeFileSync(join(tmp, 'exclude'), [...DEFAULT_IGNORE, ...ignore].join('\n') + '\n');
      const env = { GIT_DIR: join(tmp, 'g'), GIT_WORK_TREE: real, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: join(tmp, 'exclude') };
      // counted as they stream, and stopped at the cap: a big folder neither fills a buffer nor takes its whole walk
      files = await new Promise<number>((ok) => {
        const p = spawn('git', ['ls-files', '-z', '-o', '--exclude-standard'], { cwd: real, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
        let n = 0;
        p.stdout.on('data', (c: Buffer) => { for (let i = c.indexOf(0); i >= 0; i = c.indexOf(0, i + 1)) n++; if (n >= PROBE_CAP) p.kill(); });
        p.on('close', () => ok(Math.min(n, PROBE_CAP)));
        p.on('error', () => ok(0));
      });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  return { exists: true, isGit, origin, files, ...(overlap ? { overlap } : {}) };
}

/** Opens the system's file browser on a path the service built (macOS Finder, xdg-open, WSL's Explorer); never a shell. */
async function reveal(path: string): Promise<{ ok: true; path: string }> {
  if (!existsSync(path)) throw new HttpError(404, `no longer there: ${path}`, { path });
  const dir = statSync(path).isDirectory();
  // tests and headless machines: the path is answered, nothing opens
  if (envOf('REVEAL') === 'off') return { ok: true, path };
  const run = promisify(execFile);
  const wsl = process.platform === 'linux' && existsSync('/proc/version') && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  if (process.platform === 'darwin') await run('open', dir ? [path] : ['-R', path]);
  else if (wsl) await run('explorer.exe', [(await run('wslpath', ['-w', dir ? path : join(path, '..')])).stdout.trim()]).catch(() => undefined); // explorer.exe exits 1 on success
  else await run('xdg-open', [dir ? path : join(path, '..')]);
  return { ok: true, path };
}

// ---------- the machine: daemon.json, the registry's workspaces, this machine's Docker ----------

export const daemonFile = () => join(laruHome(), 'daemon.json');
export interface DaemonInfo { pid: number; port: number; token?: string; startedAt: string; version: string }

export function readDaemonFile(): DaemonInfo | null {
  try { return JSON.parse(readFileSync(daemonFile(), 'utf8')) as DaemonInfo; } catch { return null; }
}
/** The token, when one is asked, lives here only (0600), never in a log or on argv. */
export function writeDaemonFile(d: Daemon): DaemonInfo {
  const info: DaemonInfo = { pid: process.pid, port: d.port, ...(d.token ? { token: d.token } : {}), startedAt: new Date().toISOString(), version: VERSION };
  mkdirSync(laruHome(), { recursive: true });
  const tmp = `${daemonFile()}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, daemonFile());
  return info;
}
/** The session cookie's value, kept in ~/.laru/session (0600) so a browser stays signed in across restarts; made once. */
export function sessionSecret(): string {
  const file = join(laruHome(), 'session');
  try { const s = readFileSync(file, 'utf8').trim(); if (/^[\w-]{32,}$/.test(s)) return s; } catch { /* none yet */ }
  const s = randomBytes(24).toString('base64url');
  mkdirSync(laruHome(), { recursive: true });
  const tmp = `${file}.${process.pid}`;
  writeFileSync(tmp, s, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return s;
}
/** How `laru serve` starts the service: with the token, always, and the session kept across starts. */
export const serveOptions = () => ({ token: true, session: sessionSecret() });
export function removeDaemonFile(): void {
  if (readDaemonFile()?.pid === process.pid) rmSync(daemonFile(), { force: true });
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ping = (port: number) => fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(2000) });
/**
 * The service daemon.json names, when its pid is alive and its port answers as that process: takes the file's token, or
 * (no token asked) says its own pid at /api/ping. A stale file (a crash, a reboot) can name a pid that is anyone's now,
 * and a port another Laru listens on.
 */
export async function liveDaemon(): Promise<DaemonInfo | null> {
  const d = readDaemonFile();
  if (!d || !alive(d.pid)) return null;
  try {
    if (d.token) return (await fetch(`http://127.0.0.1:${d.port}/?token=${encodeURIComponent(d.token)}`, { redirect: 'manual', signal: AbortSignal.timeout(2000) })).status === 303 ? d : null;
    const r = await ping(d.port);
    return r.ok && (await r.json() as { pid?: number }).pid === d.pid ? d : null;
  } catch { return null; }
}
/** A Laru from before one service served every workspace: it answers /api/ping with its 401 and its old words. */
export async function olderLaru(port: number): Promise<boolean> {
  try { const r = await ping(port); return r.status === 401 && /Open the address printed by `laru serve`/.test(await r.text()); } catch { return false; }
}
/** Leftovers of finished ephemeral runs, in every registered workspace that still exists. */
export async function sweepAll(): Promise<void> {
  for (const x of loadRegistry()) { try { await sweepOrphans(loadWorkspace(x.root)); } catch { /* gone, or Docker is down */ } }
}

const home = () => realRoot(homedir()); // compared with real paths, as roots are
const expand = (p: string) => realRoot(p.replace(/^~(?=\/|$)/, home())); // as registry rows are kept: symlinks resolved
const inside = (a: string, b: string) => a === b || a.startsWith(b + sep);

/** The registered workspaces with what the home page and the switcher show; most recently opened first. */
async function workspaceRows() {
  const all = loadRegistry();
  const held = await envsHeld().catch(() => []);
  return [...all].sort((a, b) => (b.openedAt ?? b.addedAt).localeCompare(a.openedAt ?? a.addedAt)).map((x) => {
    const exists = isWorkspace(x.root);
    const base = { root: x.root, addedAt: x.addedAt, openedAt: x.openedAt, exists, key: workspaceKey(x) };
    if (!exists) return { ...base, id: null };
    let w: Workspace;
    try { w = loadWorkspace(x.root); } catch (e) { return { ...base, id: idOf(x.root, all), error: (e as Error).message }; }
    const last = listRuns(w, 1)[0];
    return {
      ...base, id: idOf(x.root, all), app: w.app, title: w.title, projects: w.repos.length,
      envs: held.filter((h) => h.key === base.key && !h.run).map((h) => h.env),
      lastRun: last ? { id: last.id, status: last.status, startedAt: last.startedAt, env: last.env } : null,
      stateBytes: existsSync(stateDir(w)) ? dirBytes(stateDir(w)) : 0,
    };
  });
}

function probeWorkspace(path: string) {
  if (!path.trim()) return { ok: false, reason: 'empty' };
  const root = expand(path.trim());
  if (!existsSync(root) || !statSync(root).isDirectory()) return { ok: false, reason: 'missing', root };
  if (!isWorkspace(root)) return { ok: false, reason: 'no-yaml', root };
  try {
    const w = loadWorkspace(root);
    return { ok: true, root, app: w.app, title: w.title, projects: w.repos.length, registered: loadRegistry().some((x) => x.root === root) };
  } catch (e) { return { ok: false, reason: 'invalid', root, error: (e as Error).message }; }
}

/** The machine's own routes: the registry, adding or creating a workspace, Docker and maxEnvs. */
function machineApi(port: () => number): Record<string, Handler> {
  return {
    'GET /api/workspaces': async () => workspaceRows(),
    'GET /api/workspaces/found': async () => {
      // ~/laru, and the folder where the workspaces made before the rename live
      const known = new Set(loadRegistry().map((x) => x.root));
      return [join(home(), 'laru'), join(home(), 'keelson')].filter((b) => existsSync(b)).flatMap((b) => readdirSync(b).map((d) => expand(join(b, d)))).filter((r) => !known.has(r) && isWorkspace(r)).map((r) => probeWorkspace(r)); // legacy-name
    },
    'GET /api/workspaces/probe': async (_req, url) => probeWorkspace(url.searchParams.get('path') ?? ''),
    'POST /api/workspaces/add': async (_req, _url, b: { root?: string }) => {
      const root = expand(String(b.root ?? ''));
      loadWorkspace(root); // no laru.yaml, or an invalid one: refused, naming the field
      const r = await register(root);
      return { id: idOf(root), root, ...r };
    },
    'POST /api/workspaces/init': async (_req, _url, b: { root?: string; app?: string; title?: string; docsLanguage?: string }) => {
      const root = expand(String(b.root ?? ''));
      // Only under the home folder, never inside a workspace or a project another workspace reads: nothing is written otherwise.
      if (!inside(root, home()) || root === home()) throw new HttpError(400, `root: a folder under ${home()}`, { field: 'root' });
      if (isWorkspace(root)) throw new HttpError(400, 'root: there is a workspace there already; open it instead', { field: 'root' });
      for (const x of loadRegistry()) if (inside(root, x.root) || inside(x.root, root)) throw new HttpError(400, `root: overlaps the workspace at ${x.root}`, { field: 'root' });
      const owners = byCwd(root);
      if (owners.length) throw new HttpError(400, `root: inside a project of ${owners.join(', ')}`, { field: 'root' });
      if (!/^[a-z0-9][a-z0-9-]*$/.test(String(b.app ?? ''))) throw new HttpError(400, 'app: lowercase letters, digits and dashes', { field: 'app' });
      if (b.docsLanguage && !['es', 'en'].includes(b.docsLanguage)) throw new HttpError(400, 'docsLanguage: es or en', { field: 'docsLanguage' });
      const w = initWorkspace(root, { app: String(b.app), title: b.title || undefined, docsLanguage: b.docsLanguage || 'es' });
      const r = await register(w.root);
      return { id: idOf(w.root), root: w.root, ...r };
    },
    'POST /api/workspaces/remove': async (_req, _url, b: { root?: string }) => { await unregister(String(b.root ?? '')); return { ok: true }; },
    'GET /api/machine': async () => {
      const [version, info, held] = await Promise.all([
        docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 }).then((v) => v.trim(), () => null),
        docker(['info', '--format', '{{.NCPU}} {{.MemTotal}}'], { timeoutMs: 10_000 }).then((v) => v.trim().split(' ').map(Number), () => [] as number[]),
        envsHeld().catch(() => []),
      ]);
      const persistent = held.filter((h) => !h.run);
      const usage = await recentStats(persistent.flatMap((h) => h.ids)).catch(() => []);
      const all = loadRegistry();
      const byKey = new Map(all.map((x) => [workspaceKey(x), x.root]));
      return {
        port: port(), version: VERSION, workspaces: all.length, docker: version, cpus: info[0] ?? null, memBytes: info[1] ?? null, maxEnvs: readConfig().maxEnvs,
        running: persistent.map((h) => {
          const root = byKey.get(h.key);
          let title: string | undefined, projects: string[] | undefined;
          if (root) try { const w = loadWorkspace(root); title = w.title; projects = w.repos.length > 1 ? envProjects(w, h.env) : undefined; } catch { /* its laru.yaml went away */ }
          return { key: h.key, app: h.app, env: h.env, ws: root ? idOf(root, all) : null, title, projects, services: h.ids.length, memBytes: usage.filter((u) => h.ids.some((id) => id.startsWith(u.id))).reduce((n, u) => n + u.memBytes, 0), since: h.since };
        }),
        home: { path: laruHome(), bytes: existsSync(laruHome()) ? dirBytes(laruHome()) : 0 },
      };
    },
    'GET /api/machine/docker': async () => (await docker(['system', 'df', '--format', '{{json .}}'], { timeoutMs: 120_000 })).split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    'POST /api/machine/config': async (_req, _url, b: { maxEnvs?: number }) => {
      if (!Number.isInteger(b.maxEnvs) || b.maxEnvs! < 0) throw new HttpError(400, 'maxEnvs: 0 for no limit, or how many at once');
      return writeConfig({ maxEnvs: b.maxEnvs });
    },
    'POST /api/machine/reveal': async (_req, _url, b: { what?: string; path?: unknown }) => {
      if (b.path !== undefined || b.what !== 'home') throw new HttpError(400, 'reveal takes {what: "home"} here');
      return reveal(laruHome());
    },
  };
}
