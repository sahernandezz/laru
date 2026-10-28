/**
 * A session: a person uses the app on an env that is up while the trace of the whole system is read live
 * from what the tap already records. It is a run of kind `session` with no runner: its steps are the person's marks
 * (out/marks.jsonl), turned into the runner's events so it assembles, keeps and reads exactly like a run.
 *
 * The session's own browser is the installed Chrome with no window, opened by a detached `laru session browser <id>`
 * and shown inside «En vivo»; it lives until the session is saved and records the video, the person's actions (out/actions.jsonl, never a typed value) and what
 * the page asked for outside the tap (out/outside.jsonl); out/browser.json says how it is.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkFlowSpec, knowledgeWrite, loadGraph, loadKnowledge, slugify, specPath, type FlowCheck, type Issue, type Workspace } from '@laru/core';
import { assemble, draftFromSession, scenarioFromSession, sessionEvents, type RunInfo, type SessionBrowserLog, type Trace } from '@laru/trace';
import { envMasker, isInstance, loadEnvSpec } from './env.ts';
import { instanceNarrowed, widenInstance } from './flowenv.ts';
import { baseUrl, capture, captureMemo, keepEvidence, nextId, readRun, readTrace, recordObserved, runDir, withFields, type CaptureMemo } from './runs.ts';
import { applyScenario, scenarioStorage } from './scenarios.ts';
import { status } from './up.ts';

export const SESSION = 'session';

const save = (ws: Workspace, r: RunInfo) => writeFileSync(join(runDir(ws, r.id), 'run.json'), JSON.stringify(r, null, 2));
const lines = <T>(ws: Workspace, id: string, name: string): T[] => {
  const f = join(runDir(ws, id), 'out', name);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [];
};
const marksOf = (ws: Workspace, id: string) => lines<{ t: number; text: string }>(ws, id, 'marks.jsonl');
const add = (ws: Workspace, id: string, name: string, row: unknown) => appendFileSync(join(runDir(ws, id), 'out', name), JSON.stringify(row) + '\n');

/** How the session's browser is: never opened, opening, open, closed (with its video, under out/) or failed. */
export interface SessionBrowser { state: 'none' | 'opening' | 'open' | 'closed' | 'error'; url?: string; pid?: number; videoT0?: number; video?: string; error?: string; /** requests the page sent outside the tap */ outside: Array<{ t: number; url: string }> }
export function sessionBrowser(ws: Workspace, id: string): SessionBrowser {
  const f = join(runDir(ws, id), 'out', 'browser.json');
  const b = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Omit<SessionBrowser, 'outside'>) : { state: 'none' as const };
  // a browser whose process died without saying so is closed, not open
  const gone = (b.state === 'open' || b.state === 'opening') && b.pid !== undefined && !alive(b.pid);
  const { port: _p, token: _t, ...shown } = b as typeof b & { port?: number; token?: string };
  return { ...shown, ...(gone ? { state: 'closed' as const } : {}), outside: lines(ws, id, 'outside.jsonl') };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const setBrowser = (ws: Workspace, id: string, b: Omit<SessionBrowser, 'outside'> & { port?: number; token?: string }) => writeFileSync(join(runDir(ws, id), 'out', 'browser.json'), JSON.stringify(b, null, 2), { mode: 0o600 });
const browserLog = (ws: Workspace, id: string): SessionBrowserLog => ({ actions: lines(ws, id, 'actions.jsonl'), videoT0: sessionBrowser(ws, id).videoT0 });

const FRONT = /^(frontend|front|web|ui|portal|app|site|www)$/;
/** Where the person starts: the address of the front they chose, else the env's web front, else its first HTTP service. */
export async function entranceOf(ws: Workspace, env: string, chosen?: string): Promise<string> {
  const http = (await status(ws, env)).addresses.filter((a) => /^https?:/.test(a.url));
  const front = (chosen ? http.find((a) => a.service === chosen) : undefined) ?? http.find((a) => FRONT.test(a.service)) ?? http[0];
  if (!front) throw new Error(`${env} has no HTTP address to open`);
  return front.url;
}
function session(ws: Workspace, id: string): RunInfo {
  const r = readRun(ws, id);
  if (!r || r.kind !== 'session') throw new Error(`no session ${id}`);
  return r;
}

/** Opens a session on an env that is up. The env is not locked: runs and other sessions may use it meanwhile. */
export async function startSession(ws: Workspace, o: { env: string; title?: string; scenario?: string; flow?: string; front?: string; device?: 'phone'; confirm?: boolean }): Promise<RunInfo> {
  // a flow's environment from before they were whole is widened first: a part left out would answer nothing to the person trying it
  if (isInstance(o.env) && instanceNarrowed(ws, o.env)) await widenInstance(ws, o.env);
  const st = await status(ws, o.env);
  if (st.state !== 'ready') throw new Error(`${o.env} is ${st.state}; bring it up first: laru up ${o.env}`);
  // the state first, so the session sees only what the person does
  const applied = o.scenario ? await applyScenario(ws, o.scenario, { env: o.env, confirm: o.confirm }) : undefined;
  const id = nextId(ws);
  mkdirSync(join(runDir(ws, id), 'out'), { recursive: true });
  const entrance = await entranceOf(ws, o.env, o.front).catch(() => undefined);
  const skew = await tapSkew(ws, o.env).catch(() => 0);
  const r: RunInfo = { id, kind: 'session', title: o.title || `Sesión ${id}`, ...(entrance ? { entrance } : {}), ...(o.front ? { front: o.front } : {}), ...(o.device ? { device: o.device } : {}), ...(applied ? { scenario: applied.slug } : {}), ...(o.flow ? { flow: o.flow } : {}), ...(Math.abs(skew) > 25 ? { clockSkewMs: skew } : {}), env: o.env, ephemeral: false, flows: [SESSION], phase: 'tests', status: 'running', startedAt: new Date().toISOString(), pid: process.pid, results: {} };
  save(ws, r);
  return r;
}

/** A mark: what the person is about to do. It opens a step that lasts until the next mark or the end. */
export function markSession(ws: Workspace, id: string, text: string): { t: number; n: number } {
  const r = session(ws, id);
  if (r.phase === 'done') throw new Error(`session ${id} is already saved`);
  const t = Date.now();
  appendFileSync(join(runDir(ws, id), 'out', 'marks.jsonl'), JSON.stringify({ t, text: withFields(envMasker(ws, r.env)).text(text.trim() || 'Marca') }) + '\n');
  return { t, n: marksOf(ws, id).length };
}

/**
 * How far the tap's clock is ahead of this machine's, from three answers of its health check (the VM a container runs in can
 * drift). What the person did is stamped by this machine and what the services did by the tap, so the first is moved onto the second.
 */
export async function tapSkew(ws: Workspace, env: string): Promise<number> {
  const port = new URL(await entranceOf(ws, env)).port;
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const a = Date.now();
    const j = (await (await fetch(`http://127.0.0.1:${port}/__ks/health`, { signal: AbortSignal.timeout(2000) })).json()) as { t?: number };
    if (typeof j.t === 'number') samples.push(j.t - (a + Date.now()) / 2);
  }
  return samples.length ? Math.round(samples.sort((x, y) => x - y)[Math.floor(samples.length / 2)]) : 0;
}

/** Each open session's reads, kept between them (runs.ts CaptureMemo); gone when the session stops. */
const memos = new Map<string, CaptureMemo>();

async function assembleSession(ws: Workspace, r: RunInfo, end0: number, open: boolean, dir?: string, kafka = true, memo?: CaptureMemo) {
  const skew = r.clockSkewMs ?? 0, end = end0 + skew;
  const t0 = Date.parse(r.startedAt) + skew;
  const log = browserLog(ws, r.id);
  const events = sessionEvents(r.title ?? r.id, t0, marksOf(ws, r.id).map((m) => ({ ...m, t: m.t + skew })), end, open,
    { ...log, actions: (log.actions ?? []).map((a) => ({ ...a, t0: a.t0 + skew })), ...(log.videoT0 !== undefined ? { videoT0: log.videoT0 + skew } : {}) });
  const masker = withFields(envMasker(ws, r.env));
  const c = await capture(ws, r.env, undefined, t0 - 1000, end + 2000, masker, dir, { kafka, memo });
  let map = null;
  try { map = loadGraph(ws).map; } catch { /* no map: participants keep their names */ }
  const { traces, observed } = assemble({ run: r.id, flow: SESSION, env: r.env, events, traffic: c.traffic, sql: c.sql, kafka: c.kafka, logs: c.logs, peers: c.peers, gatewayIp: c.gateways[0], gatewayIps: c.gateways, hybrid: loadEnvSpec(ws, r.env).hybrid, map: map ?? undefined, person: true });
  return { trace: traces[0], observed, events };
}

/**
 * What the session has seen: live (assembled now, from its start to this instant, nothing written) while it is open;
 * its kept trace once saved. `kafka: false` reads everything but the broker, in well under a second: a live view asks
 * for Kafka every few seconds, not every time.
 */
export async function sessionTrace(ws: Workspace, id: string, o: { kafka?: boolean } = {}): Promise<{ run: RunInfo; trace: Trace }> {
  const r = session(ws, id);
  if (r.phase === 'done') {
    memos.delete(id);
    const trace = readTrace(ws, id, SESSION);
    if (!trace) throw new Error(`session ${id} kept no trace`);
    return { run: r, trace };
  }
  const memo = memos.get(id) ?? memos.set(id, captureMemo()).get(id)!;
  return { run: r, trace: (await assembleSession(ws, r, Date.now(), true, undefined, o.kafka !== false, memo)).trace };
}

/** Saves the session as evidence: its masked slices in raw/, its trace in flows/session/, what it observed for the map. */
export async function stopSession(ws: Workspace, id: string): Promise<RunInfo> {
  memos.delete(id);
  const r = session(ws, id);
  if (r.phase === 'done') return r;
  r.phase = 'evidence';
  save(ws, r);
  const dir = runDir(ws, id), end = Date.now();
  // the browser sees the session leave `tests` and closes, which is when its video is written
  for (let i = 0; i < 40 && ['open', 'opening'].includes(sessionBrowser(ws, id).state); i++) await new Promise((res) => setTimeout(res, 250));
  try {
    const { trace, observed, events } = await assembleSession(ws, r, end, false, dir);
    const video = sessionBrowser(ws, id).video;
    if (video) trace.video = join('/ks/out', video); // where keepEvidence looks, as for a runner's video
    writeFileSync(join(dir, 'out', 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    keepEvidence(dir, SESSION, [trace], trace);
    recordObserved(ws, id, observed);
    r.results[SESSION] = { status: 'passed', ms: trace.durationMs, steps: trace.steps.length, trace: `flows/${SESSION}/trace.json` };
    r.status = 'passed';
  } catch (e) {
    r.status = 'error';
    r.error = (e as Error).message;
  }
  r.phase = 'done';
  r.endedAt = new Date(end).toISOString();
  save(ws, r);
  return r;
}

/** Opens the session's browser in a detached process that outlives this one; out/browser.json follows it. */
export function openSessionBrowser(ws: Workspace, id: string): void {
  const r = session(ws, id);
  if (r.phase !== 'tests') throw new Error(`session ${id} is already saved`);
  if (['open', 'opening'].includes(sessionBrowser(ws, id).state)) return;
  setBrowser(ws, id, { state: 'opening' });
  const bin = join(import.meta.dirname, '..', '..', '..', 'apps', 'cli', 'bin', 'laru.js');
  const log = openSync(join(runDir(ws, id), 'out', 'browser.log'), 'a');
  const child = spawn(process.execPath, [bin, '-C', ws.root, 'session', 'browser', id], { detached: true, stdio: ['ignore', log, log] });
  setBrowser(ws, id, { state: 'opening', pid: child.pid });
  child.unref();
}

/**
 * Runs in the page before anything of it: reports what the person acts on, by its accessible role and name, as the
 * runner's reporter does. What is typed, picked or uploaded is never read: a fill says only which field.
 */
const RECORDER = `(() => {
  const IMPLICIT = { BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' };
  const INPUT = { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', file: 'button', search: 'searchbox', range: 'slider' };
  const roleOf = (el) => el.getAttribute('role') || (el.tagName === 'A' && el.hasAttribute('href') ? 'link' : IMPLICIT[el.tagName]) || (el.tagName === 'INPUT' ? INPUT[el.type] || 'textbox' : '');
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  const field = (el) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  const nameOf = (el) => clean(el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.innerText) || (el.labels && el.labels[0] && el.labels[0].innerText) || (field(el) ? el.getAttribute('placeholder') || el.name : el.innerText) || el.getAttribute('title'));
  const q = (s) => "'" + s.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'") + "'";
  const target = (el) => { const r = roleOf(el), n = nameOf(el); return r ? 'getByRole(' + q(r) + (n ? ', { name: ' + q(n) + ' }' : '') + ')' : n ? 'getByText(' + q(n) + ')' : el.tagName.toLowerCase(); };
  const hit = (e) => e.target instanceof Element && (e.target.closest('a[href],button,input,select,textarea,summary,label,[role],[onclick]') || e.target);
  const send = (a) => { try { window.__ksAct(a); } catch {} };
  addEventListener('click', (e) => { const el = hit(e); if (el && e.isTrusted && !(el.tagName === 'INPUT' && ['checkbox', 'radio', 'file'].includes(el.type))) send({ kind: e.detail === 2 ? 'dblclick' : 'click', target: target(el) }); }, true);
  addEventListener('change', (e) => { const el = e.target; if (!(el instanceof Element) || !e.isTrusted) return;
    const kind = el.tagName === 'SELECT' ? 'select' : el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? 'check' : 'uncheck') : el.type === 'file' ? 'files' : 'fill';
    send({ kind, target: target(el) }); }, true);
  addEventListener('keydown', (e) => { if (e.isTrusted && ['Enter', 'Escape', 'Tab'].includes(e.key) && e.target instanceof Element) send({ kind: 'press', key: e.key, target: target(e.target) }); }, true);
})();`;

/** Where the person sees the page: its size, the same for the screencast, the video and the clicks. */
export const SCREEN = { width: 1280, height: 800 };
/** a mobile front is shown at a phone's size (Known limit: the size only; no touch events or phone user agent) */
const PHONE = { width: 390, height: 844 };
/** the session video's frames per second (the screencast itself streams every frame Chrome paints) */
const FPS = 10;

/** An address the session's browser may be sent to: `http`, the entrance's port and a name `<service>.<app>.localhost` (never a store's port, another app or another host). */
export function isEntranceUrl(url: string, app: string, port: string): boolean {
  try { const u = new URL(url); return u.protocol === 'http:' && u.port === port && u.hostname.endsWith(`.${app}.localhost`) && !u.username && !u.password; } catch { return false; }
}

/** What the screen sends, in the page's own pixels; the one input of the embedded browser. */
export type ScreenInput =
  | { t: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clicks?: number }
  | { t: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { t: 'key'; down: boolean; key: string }
  | { t: 'text'; text: string }
  | { t: 'files'; files: Array<{ name: string; mimeType: string; b64: string }> }
  | { t: 'nav'; to: 'back' | 'forward' | 'reload' | 'home' }
  /** an address of this env's entrance only: `http`, its port, a name `*.<app>.localhost` (a link of a mail, never another host or a store's port) */
  | { t: 'nav'; to: 'goto'; url: string; device?: 'phone' | 'desktop' };

/**
 * The session's browser, in this process until the session is saved or the page closes: the installed Chrome with no
 * window (no browser is downloaded), shown inside «En vivo» through a server of its own on 127.0.0.1 (its port and
 * token in browser.json, 0600, which only the service reads): the screencast's frames out, the person's mouse, keys,
 * pasted text and picked files in. Its video and the person's actions are kept under out/.
 */
export async function runSessionBrowser(ws: Workspace, id: string, o: { /** a test acting on the page as the person would */ drive?: (page: import('playwright-core').Page) => Promise<unknown> } = {}): Promise<void> {
  const r = session(ws, id);
  const out = join(runDir(ws, id), 'out');
  try {
    const url = await entranceOf(ws, r.env, r.front);
    const port = new URL(url).port;
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
    // a scenario whose setup ended signed in opens the app as that person: its setup signed in on the env's network
    // (`http://frontend`), the person's browser comes through the entrance, so the session moves to that origin
    const storage = r.scenario ? scenarioStorage(ws, r.env, r.scenario) : undefined;
    const context = await browser.newContext({ viewport: r.device === 'phone' ? PHONE : SCREEN, ...(storage ? { storageState: movedTo(JSON.parse(readFileSync(storage, 'utf8')), baseUrl(ws, r.env), url) } : {}) });
    await context.exposeBinding('__ksAct', (_src, a: { kind: string; target?: string; key?: string }) => add(ws, id, 'actions.jsonl', { t0: Date.now(), kind: a.kind, ...(a.target ? { target: a.target } : {}), ...(a.key ? { key: a.key } : {}) }));
    await context.addInitScript(RECORDER);
    // what does not reach the tap leaves no trace there: it is named instead (never its query)
    context.on('request', (q) => {
      const u = new URL(q.url());
      if (/^https?:$/.test(u.protocol) && !(u.hostname.endsWith('.localhost') && u.port === port)) add(ws, id, 'outside.jsonl', { t: Date.now(), url: `${u.origin}${u.pathname}` });
    });
    // the screen shows the page the person is on: the first one, and a popup or a second tab while it is open
    const first = await context.newPage();
    let page = first;
    const screen = await screencast(first, join(out, 'video.webm'));
    const send = (event: string, data: string) => { for (const l of listeners) l(event, data); };
    const listeners = new Set<(event: string, data: string) => void>();
    screen.onFrame((jpeg) => send('frame', jpeg.toString('base64')));
    let chooser: import('playwright-core').FileChooser | undefined;
    const watch = (p: import('playwright-core').Page) => {
      p.on('framenavigated', (f) => { if (f !== p.mainFrame()) return; add(ws, id, 'actions.jsonl', { t0: Date.now(), kind: 'navigate', path: new URL(f.url()).pathname }); if (p === page) send('url', f.url()); });
      p.on('filechooser', (c) => { chooser = c; send('files', JSON.stringify({ multiple: c.isMultiple() })); });
    };
    watch(first);
    context.on('page', (p) => {
      if (p === first) return;
      page = p; watch(p);
      void screen.follow(p).then(() => send('url', p.url()), () => undefined);
      p.on('close', () => { if (page === p) { page = first; void screen.follow(first).then(() => send('url', first.url()), () => undefined); } });
    });

    // input in the order it was sent: a click is never handled before the move that preceded it
    let queue = Promise.resolve();
    const handle = async (i: ScreenInput) => {
      if (i.t === 'move') await page.mouse.move(i.x, i.y);
      else if (i.t === 'down' || i.t === 'up') { await page.mouse.move(i.x, i.y); await page.mouse[i.t]({ button: i.button ?? 'left', clickCount: i.clicks ?? 1 }); }
      else if (i.t === 'wheel') { await page.mouse.move(i.x, i.y); await page.mouse.wheel(i.dx, i.dy); }
      else if (i.t === 'key') {
        // a character is typed whole (accents and ñ included); a combination (Meta+a, Shift+Tab) is pressed once; a
        // named key goes down and up as the person pressed it
        if ([...i.key].length === 1) { if (i.down) await page.keyboard.type(i.key); }
        else if (i.key.includes('+')) { if (i.down) await page.keyboard.press(i.key); }
        else await page.keyboard[i.down ? 'down' : 'up'](i.key);
      }
      else if (i.t === 'text') await page.keyboard.insertText(i.text);
      else if (i.t === 'files') { await chooser?.setFiles(i.files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: Buffer.from(f.b64, 'base64') }))); chooser = undefined; }
      else if (i.t === 'nav' && i.to === 'goto') {
        if (!isEntranceUrl(i.url, ws.app, port)) throw new Error('the session browser only opens addresses of this env\'s own entrance');
        if (i.device) await page.setViewportSize(i.device === 'phone' ? PHONE : SCREEN);
        await page.goto(new URL(i.url).href);
      }
      else if (i.t === 'nav') await (i.to === 'back' ? page.goBack() : i.to === 'forward' ? page.goForward() : i.to === 'reload' ? page.reload() : page.goto(url));
    };
    const token = randomBytes(24).toString('hex');
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.searchParams.get('token') !== token) { res.writeHead(401).end(); return; }
      if (req.method === 'GET' && u.pathname === '/frames') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        const l = (event: string, data: string) => res.write(`event: ${event}\ndata: ${data}\n\n`);
        l('url', page.url());
        if (screen.last()) l('frame', screen.last()!.toString('base64'));
        listeners.add(l);
        req.on('close', () => listeners.delete(l));
        return;
      }
      if (req.method === 'POST' && u.pathname === '/input') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          let i: ScreenInput;
          try { i = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
          queue = queue.then(() => handle(i)).catch(() => undefined);
          queue.then(() => res.writeHead(204).end());
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    setBrowser(ws, id, { state: 'open', url, pid: process.pid, videoT0: screen.t0, port: (server.address() as { port: number }).port, token });
    await page.goto(url).catch(() => undefined);
    await o.drive?.(page);
    let tick: ReturnType<typeof setInterval> | undefined;
    await new Promise<void>((done) => {
      const end = () => { clearInterval(tick); done(); };
      first.on('close', end);
      browser.on('disconnected', end);
      tick = setInterval(() => { if (readRun(ws, id)?.phase !== 'tests') end(); }, 500);
    });
    const file = await screen.stop();
    send('closed', '');
    server.close();
    server.closeAllConnections();
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    setBrowser(ws, id, { state: 'closed', url, videoT0: screen.t0, ...(file ? { video: relative(out, file) } : {}) });
  } catch (e) {
    setBrowser(ws, id, { state: 'error', error: (e as Error).message.split('\n')[0] });
    throw e;
  }
}

/** The local address of an open session browser, for the service only: never sent to the page. */
export function screenOf(ws: Workspace, id: string): { port: number; token: string } | undefined {
  const f = join(runDir(ws, id), 'out', 'browser.json');
  const b = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { state: string; port?: number; token?: string; pid?: number }) : undefined;
  return b?.state === 'open' && b.port && b.token && b.pid && alive(b.pid) ? { port: b.port, token: b.token } : undefined;
}

/**
 * Chrome's screencast: each frame to whoever watches the screen, and the video with the host's ffmpeg (Laru already
 * needs it to calibrate), not Playwright's own, which it would download. The newest frame is repeated at 10 per second
 * so the video's frame n is `t0 + n × 100 ms`: a person's pace, at a ninth of the CPU of 25 per second (0.8 s for 10 s
 * of video against 7.2 s, measured on a still frame; a session of 51 minutes held four cores at 25).
 */
async function screencast(page: import('playwright-core').Page, file: string) {
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libvpx', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '16', '-threads', '2', '-pix_fmt', 'yuv420p', file], { stdio: ['pipe', 'ignore', 'inherit'] });
  const exited = new Promise<number | null>((res) => { ff.on('exit', res); ff.on('error', () => res(null)); });
  ff.stdin.on('error', () => undefined);
  let cdp: import('playwright-core').CDPSession | undefined;
  let last: Buffer | undefined;
  const watchers: Array<(jpeg: Buffer) => void> = [];
  /** Shows this page: the frames and the video continue from it (a popup the page opened, then the page again). */
  const follow = async (p: import('playwright-core').Page) => {
    const before = cdp;
    cdp = undefined;
    if (before) { await before.send('Page.stopScreencast').catch(() => undefined); await before.detach().catch(() => undefined); }
    const next = await p.context().newCDPSession(p);
    next.on('Page.screencastFrame', (f) => {
      last = Buffer.from(f.data, 'base64');
      for (const w of watchers) w(last);
      next.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    });
    await next.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: SCREEN.width, maxHeight: SCREEN.height });
    cdp = next;
  };
  await follow(page);
  const t0 = Date.now();
  let n = 0;
  const pump = () => { if (!last) return; for (const due = Math.floor(((Date.now() - t0) * FPS) / 1000); n < due; n++) ff.stdin.write(last); };
  const timer = setInterval(pump, 1000 / FPS);
  return {
    t0,
    last: () => last,
    onFrame: (w: (jpeg: Buffer) => void) => watchers.push(w),
    follow,
    stop: async () => {
      clearInterval(timer);
      pump();
      await cdp?.send('Page.stopScreencast').catch(() => undefined);
      ff.stdin.end();
      return (await exited) === 0 && n > 0 && existsSync(file) ? file : undefined;
    },
  };
}

/**
 * The session as the draft of a flow in container `in`: flow.md (its marks as Pasos) through the same validator as any
 * write, and its spec next to it, never over one that exists. Answers with what `laru check` says of the draft:
 * every '…' and todo() it left is yours to write.
 */
export async function sessionToFlow(ws: Workspace, id: string, o: { in: string; title?: string }): Promise<{ ok: boolean; id?: string; spec?: string; issues: Issue[]; checks: FlowCheck[] }> {
  const { run, trace } = await sessionTrace(ws, id);
  const title = (o.title || run.title || `Sesión ${id}`).trim();
  let nodes = new Set<string>();
  try { nodes = new Set(loadGraph(ws).map.nodes.map((n) => n.id)); } catch { /* no map: no service is named */ }
  const draft = draftFromSession(trace, { session: id, title, nodes });
  const taken = takenBy(ws, 'flow', title);
  if (taken) return { ok: false, id: taken.id, issues: [taken.issue], checks: [] };
  const w = knowledgeWrite(ws, { type: 'flow', in: o.in, title, status: 'draft', summary: `Borrador de la sesión ${id}.`, meta: draft.needs.length ? { needs: draft.needs } : undefined, fields: draft.fields });
  if (!w.ok) return { ok: false, id: w.id, issues: w.issues, checks: [] };
  const k = loadKnowledge(ws), piece = k.byId.get(w.id)!;
  const file = join(ws.root, specPath(piece));
  if (existsSync(file)) return { ok: false, id: w.id, issues: [...w.issues, { level: 'error', at: 'spec', key: 'exists', message: `${specPath(piece)} already exists; a draft never overwrites a spec` }], checks: [] };
  writeFileSync(file, draft.spec(title));
  return { ok: true, id: w.id, spec: specPath(piece), issues: w.issues, checks: checkFlowSpec(ws, piece, k.byId) };
}

/** A draft never replaces a piece: writing one with an id that exists would overwrite it, so it is refused before anything is written. */
function takenBy(ws: Workspace, type: 'flow' | 'scenario', title: string): { id: string; issue: Issue } | undefined {
  const id = `${type === 'flow' ? 'flow' : 'scn'}:${slugify(title)}`;
  return loadKnowledge(ws).byId.has(id) ? { id, issue: { level: 'error', at: 'id', key: 'exists', message: `${id} already exists; a draft never overwrites a piece: give it another title` } } : undefined;
}

/**
 * Turns a session into the draft of a scenario inside a module or the application: scenario.md with the marks as the state
 * it leaves, and its `<slug>.setup.ts` with the person's actions as the preparation. It never overwrites a setup.
 */
export async function sessionToScenario(ws: Workspace, id: string, o: { in: string; title?: string }): Promise<{ ok: boolean; id?: string; setup?: string; issues: Issue[] }> {
  const { run, trace } = await sessionTrace(ws, id);
  const title = (o.title || run.title || `Sesión ${id}`).trim();
  let nodes = new Set<string>();
  try { nodes = new Set(loadGraph(ws).map.nodes.map((n) => n.id)); } catch { /* no map: no service is named */ }
  const draft = scenarioFromSession(trace, { session: id, title, nodes });
  const taken = takenBy(ws, 'scenario', title);
  if (taken) return { ok: false, id: taken.id, issues: [taken.issue] };
  const w = knowledgeWrite(ws, { type: 'scenario', in: o.in, title, status: 'draft', summary: `Borrador de la sesión ${id}.`, meta: draft.needs.length ? { needs: draft.needs } : undefined, fields: draft.fields });
  if (!w.ok) return { ok: false, id: w.id, issues: w.issues };
  const piece = loadKnowledge(ws).byId.get(w.id)!;
  const rel = join(piece.dir, `${w.id.replace(/^scn:/, '')}.setup.ts`), file = join(ws.root, rel);
  if (existsSync(file)) return { ok: false, id: w.id, issues: [...w.issues, { level: 'error', at: 'setup', key: 'exists', message: `${rel} already exists; a draft never overwrites a setup` }] };
  writeFileSync(file, draft.setup(title));
  return { ok: true, id: w.id, setup: rel, issues: w.issues };
}

type Storage = Exclude<import('playwright-core').BrowserContextOptions['storageState'], string | undefined>;
/** A browser session saved on one origin, as it would be on another: its local storage and its cookies. */
export function movedTo(st: Storage, from: string, to: string): Storage {
  const a = new URL(from), b = new URL(to);
  return {
    cookies: (st.cookies ?? []).map((c) => (c.domain.replace(/^\./, '') === a.hostname ? { ...c, domain: b.hostname, secure: b.protocol === 'https:' && c.secure } : c)),
    origins: (st.origins ?? []).map((o) => (o.origin === a.origin ? { ...o, origin: b.origin } : o)),
  };
}
