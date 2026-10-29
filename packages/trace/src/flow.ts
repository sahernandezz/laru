/**
 * `@laru/flow`: what a flow spec imports. A story is one recorded test whose steps are the Pasos of its flow.md;
 * each step shows its caption on the video and leaves a screenshot when it fails. Runs inside the runner image,
 * where `@laru/flow` resolves here and `@playwright/test` to the image's own copy.
 */
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { test as base, expect, type APIRequestContext, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

export { expect };

interface Fixtures {
  /** applies the flow's own time limit before the test starts; never used by name */
  _limit: void;
  /** a value no other test of this run gets: `<prefix>-r<run>-<n>` */
  uniq: (prefix: string) => string;
  /** the vault's `flows:` level */
  vars: Record<string, string>;
  /** a request context on a service of the env, by its compose name */
  api: (service: string, port?: number) => Promise<APIRequestContext>;
  /** what the env's services did since this test began, as the tap saw it (masked): a check on a dependency */
  observed: Observed;
  /** the scenario the flow starts from (its `scenario:`), applied right before it: who can sign in */
  given: Given;
  /** what the env's mailbox received since this test began: a check on the mail the app sends */
  mail: Mail;
  /** the same, for the texts the app sends */
  sms: Sms;
  /** another screen of the same test, by name (`otherScreen('luis')`): a second person's browser, with its own video on the same clock and its own lane in the trace; `size` makes it a phone (its window and its video, 1280×720 by default) */
  otherScreen: (name: string, size?: { width: number; height: number }) => Promise<Page>;
}
/** The state a flow starts from: its scenario and who its setup left able to sign in. */
export interface Given { scenario?: string; identities: Identity[]; identity(name?: string): Identity }

/** One exchange the tap recorded: who called which service, how, and how it ended. */
export interface Seen { from: string; to: string; kind: string; method?: string; path?: string; status?: number; t0: number; ms?: number; mock?: string; fault?: string }
export interface ObservedQuery { from?: string; to?: string; method?: string; path?: string | RegExp; status?: number | ((s: number) => boolean) }
export interface Observed {
  /** exchanges recorded since this test began that match the query */
  find(q: ObservedQuery): Seen[];
  /** waits until one matching exchange is recorded (default 15 s), and returns it */
  wait(q: ObservedQuery, timeoutMs?: number): Promise<Seen>;
}

/** A mail the env's mailbox received. Its codes and links are as they arrived: a flow needs them to go on. */
export interface MailMsg { id: string; subject: string; from: string; to: string[]; cc: string[]; text: string; codes: string[]; links: Array<{ url: string; text?: string; class: string }>; attachments: Array<{ name: string; type: string; size: number }>; t: number }
export interface SmsMsg { id: string; to: string; from: string; body: string; codes: string[]; status: string; direction: string; t: number }
export interface MailQuery { to?: string | RegExp; subject?: string | RegExp; from?: string | RegExp }
export interface SmsQuery { to?: string | RegExp; body?: string | RegExp }
export interface Mail {
  /** waits (15 s by default) for a mail received since this test began that matches; when none comes it says what did */
  waitFor(q?: MailQuery, timeoutMs?: number): Promise<MailMsg>;
  /** the links of a message, by class (`local` are the env's own names, which the runner reaches as they are) */
  links(m: MailMsg, o?: { class?: 'local' | 'external' | 'production' | 'tracking' | 'unsubscribe' }): MailMsg['links'];
  /** everything received since this test began */
  all(): MailMsg[];
}
export interface Sms {
  waitFor(q?: SmsQuery, timeoutMs?: number): Promise<SmsMsg>;
  /** the code (4 to 8 digits) of the latest text to that number since this test began, waiting for it */
  code(to?: string | RegExp, timeoutMs?: number): Promise<string>;
}

/** The env's tap directory, mounted read-only: traffic.jsonl and the peers in rules.json. */
const TAP = '/ks/tap';
/** The mailbox's journal read as the observer reads traffic: only what was appended, folded into messages with their latest state. */
function mailbox(since: number) {
  const file = `${TAP}/messages.jsonl`;
  const mails = new Map<string, MailMsg>(), texts = new Map<string, SmsMsg>();
  let at = 0;
  const pull = () => {
    if (!existsSync(file)) throw new Error('this env has no mailbox: bring up an env with a mail or SMS sink (laru mail enable)');
    const size = statSync(file).size;
    if (size < at) at = 0; // emptied or rotated: read it again from the start
    if (size === at) return;
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - at);
    readSync(fd, buf, 0, buf.length, at);
    closeSync(fd);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n') + 1;
    at += Buffer.byteLength(text.slice(0, end));
    for (const l of text.slice(0, end).split('\n').filter(Boolean)) {
      let m: Record<string, any>;
      try { m = JSON.parse(l); } catch { continue; }
      if (m.kind === 'mail') mails.set(m.id, { id: m.id, subject: m.headers.subject, from: m.headers.from, to: m.headers.to?.length ? m.headers.to : m.envelope.rcpt, cc: m.headers.cc ?? [], text: m.text ?? '', codes: m.codes ?? [], links: m.links ?? [], attachments: (m.attachments ?? []).map((a: { name: string; type: string; size: number }) => ({ name: a.name, type: a.type, size: a.size })), t: m.t });
      else if (m.kind === 'sms') texts.set(m.id, { id: m.id, to: m.to, from: m.sender, body: m.body, codes: m.codes ?? [], status: 'queued', direction: m.direction, t: m.t });
      else if (m.kind === 'status' && texts.has(m.id) && !m.callback) texts.get(m.id)!.status = m.status;
      else if (m.kind === 'gone') { mails.delete(m.id); texts.delete(m.id); }
    }
  };
  const has = (v: string, q?: string | RegExp) => q === undefined || (typeof q === 'string' ? v.toLowerCase().includes(q.toLowerCase()) : q.test(v));
  const wait = async <T extends { t: number }>(pool: Map<string, T>, ok: (x: T) => boolean, what: string, summary: (x: T) => string, ms: number): Promise<T> => {
    for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 150))) {
      pull();
      const hit = [...pool.values()].filter((x) => x.t >= since && ok(x)).sort((a, b) => b.t - a.t)[0];
      if (hit) return hit;
      if (Date.now() - t0 > ms) {
        const got = [...pool.values()].filter((x) => x.t >= since);
        throw new Error(`${what} did not arrive in ${ms / 1000} s; ${got.length ? `what arrived since the test began: ${got.map(summary).join('; ')}` : 'nothing arrived since the test began'}`);
      }
    }
  };
  return {
    mail: {
      waitFor: (q: MailQuery = {}, ms = 15000) => wait(mails, (m) => (q.to === undefined || m.to.some((a) => has(a, q.to))) && has(m.subject, q.subject) && has(m.from, q.from), `a mail${q.to ? ` to ${q.to}` : ''}${q.subject ? ` about ${q.subject}` : ''}`, (m) => `«${m.subject}» to ${m.to.join(', ')}`, ms),
      links: (m: MailMsg, o: { class?: string } = {}) => m.links.filter((l) => !o.class || l.class === o.class),
      all: () => { pull(); return [...mails.values()].filter((m) => m.t >= since); },
    } satisfies Mail,
    sms: {
      waitFor: (q: SmsQuery = {}, ms = 15000) => wait(texts, (m) => m.direction === 'outbound' && has(m.to, q.to) && has(m.body, q.body), `a text${q.to ? ` to ${q.to}` : ''}`, (m) => `to ${m.to}: «${m.body.slice(0, 40)}»`, ms),
      code: async (to?: string | RegExp, ms = 15000) => {
        const m = await wait(texts, (x) => x.direction === 'outbound' && has(x.to, to) && x.codes.length > 0, `a text with a code${to ? ` to ${to}` : ''}`, (x) => `to ${x.to}: «${x.body.slice(0, 40)}»`, ms);
        return m.codes[0];
      },
    } satisfies Sms,
  };
}

function observer(): Observed {
  const file = `${TAP}/traffic.jsonl`;
  let at = existsSync(file) ? statSync(file).size : 0;
  const seen: Seen[] = [];
  const peers = (): Record<string, string> => { try { return JSON.parse(readFileSync(`${TAP}/rules.json`, 'utf8')).peers ?? {}; } catch { return {}; } };
  const pull = () => {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size < at) at = 0; // rotated
    if (size === at) return;
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - at);
    readSync(fd, buf, 0, buf.length, at);
    closeSync(fd);
    const text = buf.toString('utf8');
    const end = text.lastIndexOf('\n') + 1;
    at += Buffer.byteLength(text.slice(0, end));
    const ip = peers();
    // The runner joins the env per run, so the env's map does not know its address.
    for (const a of Object.values(networkInterfaces()).flat()) if (a && !a.internal) ip[a.address] ??= 'runner';
    for (const l of text.slice(0, end).split('\n').filter(Boolean)) {
      try {
        const r = JSON.parse(l);
        seen.push({ from: ip[r.from] ?? r.from, to: r.svc, kind: r.kind, method: r.method, path: r.path, status: r.status, t0: r.t0, ms: r.t1 === undefined ? undefined : r.t1 - r.t0, mock: r.mock, fault: r.fault });
      } catch { /* a line cut by rotation */ }
    }
  };
  const match = (q: ObservedQuery) => (e: Seen) => (!q.from || e.from === q.from) && (!q.to || e.to === q.to) && (!q.method || e.method === q.method.toUpperCase())
    && (!q.path || (typeof q.path === 'string' ? e.path === q.path : q.path.test(e.path ?? '')))
    && (q.status === undefined || (typeof q.status === 'function' ? e.status !== undefined && q.status(e.status) : e.status === q.status));
  return {
    find: (q) => { pull(); return seen.filter(match(q)); },
    wait: async (q, timeoutMs = 15_000) => {
      const until = Date.now() + timeoutMs;
      for (;;) {
        pull();
        const hit = seen.find(match(q));
        if (hit) return hit;
        if (Date.now() > until) throw new Error(`no exchange ${JSON.stringify({ ...q, path: String(q.path ?? '') })} in ${timeoutMs} ms; seen: ${seen.slice(-8).map((e) => `${e.from}→${e.to} ${e.method ?? e.kind} ${e.path ?? ''} ${e.status ?? ''}`).join(' | ')}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    },
  };
}

let current: { page?: Page; info?: TestInfo; n: number } = { n: 0 };
/** One counter per worker process; with the worker index, every test of every flow gets values no other test has. */
let uniqCount = 0;

/**
 * The marker a recorded screen opens with: a ticking black page, then magenta at a known instant (returned). The evidence finds that frame in
 * the screen's video, so the trace and the video share one clock even when the video starts late.
 */
async function drawMarker(page: Page): Promise<number> {
  await page.setContent(`<html><body style="margin:0;background:#000;height:100vh"><div id="t" style="position:fixed;left:0;top:0;width:8px;height:8px"></div>
<script>let n = 0; (function tick() { document.getElementById('t').style.background = n++ % 2 ? '#111' : '#222'; requestAnimationFrame(tick); })();</script></body></html>`);
  await page.waitForTimeout(250);
  const drawn = await page.evaluate(() => new Promise<number>((done) => requestAnimationFrame(() => { document.body.style.background = '#ff00ff'; requestAnimationFrame(() => done(Date.now())); })));
  await page.waitForTimeout(120);
  return drawn;
}

const CAPTION = 'ks-caption';
/** Draws the caption in a corner of the page; re-applied after every navigation from sessionStorage. */
function drawCaption() {
  const text = sessionStorage.getItem('ks-caption');
  const id = 'ks-caption';
  let el = document.getElementById(id);
  if (!text) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:60%;padding:6px 10px;border-radius:6px;background:rgba(10,10,10,.82);color:#fff;font:500 13px/18px system-ui,sans-serif;pointer-events:none';
    (document.body ?? document.documentElement).appendChild(el);
  }
  el.textContent = text;
}

/** In a joint env each spec file starts on its own project's front: `KS_BASE_URLS_JSON` = slug → URL. */
const perFlow = JSON.parse(process.env.KS_BASE_URLS_JSON ?? '{}') as Record<string, string>;
/** A flow's own time limit (`timeout` in its flow.md), in ms, by the name of its spec file; the runner passes them. */
const limits = JSON.parse(process.env.KS_FLOW_TIMEOUTS_JSON ?? '{}') as Record<string, number>;
/**
 * story and scenario declare their test in this file, so Playwright's `info.file` is flow.ts: each keeps the
 * name of the spec that called it as a `spec` annotation, read from the call's stack while the spec loads.
 */
const callerSpec = () => new Error().stack?.match(/([\w.-]+)\.spec\.ts:\d+/)?.[1];
const specAnnotation = () => { const spec = callerSpec(); return spec ? [{ type: 'spec', description: spec }] : []; };
/** The flow a test belongs to: its spec's name. */
const specOf = (info: TestInfo) => info.annotations.find((a) => a.type === 'spec')?.description ?? (info.file.split('/').pop() ?? '').replace(/\.spec\.ts$/, '');

export const test = base.extend<Fixtures>({
  _limit: [async ({}, use, info) => {
    const ms = limits[specOf(info)];
    if (ms) info.setTimeout(ms);
    await use();
  }, { auto: true }],
  baseURL: async ({ baseURL }, use, info) => {
    await use(perFlow[specOf(info)] ?? baseURL);
  },
  page: async ({ page }, use, info) => {
    // The page's video starts with the page: this instant is frame 0 for the trace.
    info.annotations.push({ type: 'videoT0', description: String(Date.now()) });
    // A recorded story opens with a marker: a ticking black page, then magenta at a known instant. The evidence
    // finds that frame in the video, so the trace and the video share one clock even when the video starts late.
    if (info.project.name === 'story') info.annotations.push({ type: 'marker', description: String(await drawMarker(page)) });
    await page.addInitScript(`(${drawCaption.toString()})(); document.addEventListener('DOMContentLoaded', () => (${drawCaption.toString()})());`);
    current = { page, info, n: 0 };
    await use(page);
    current = { n: 0 };
  },
  otherScreen: async ({ browser, baseURL }, use, info) => {
    const made: Array<{ name: string; page: Page; context: BrowserContext; t0: number; marker?: number }> = [];
    await use(async (name, size = { width: 1280, height: 720 }) => {
      if (!/^[\w-]{1,32}$/.test(name)) throw new Error(`a screen's name is letters, digits, _ and - (up to 32): ${name}`);
      const had = made.find((m) => m.name === name);
      if (had) return had.page;
      const story = info.project.name === 'story';
      const context = await browser.newContext({ baseURL, locale: 'es-ES', timezoneId: 'Europe/Madrid', viewport: size, ...(story ? { recordVideo: { dir: info.outputPath(`screen-${name}`), size } } : {}) });
      // The token that names the screen goes on the app's own requests only: on another origin it would turn each request into a preflight.
      // The tap reads it off and never forwards it.
      const own = baseURL ? new URL(baseURL).origin : '';
      await context.route('**/*', (route) => {
        const r = route.request();
        return own && new URL(r.url()).origin === own ? route.continue({ headers: { ...r.headers(), 'x-laru-screen': name } }) : route.continue();
      });
      const page = await context.newPage();
      const m: (typeof made)[number] = { name, page, context, t0: Date.now() };
      if (story) m.marker = await drawMarker(page);
      await page.addInitScript(`(${drawCaption.toString()})(); document.addEventListener('DOMContentLoaded', () => (${drawCaption.toString()})());`);
      made.push(m);
      return page;
    });
    for (const m of made) {
      const video = m.page.video();
      await m.context.close();
      const path = await video?.path().catch(() => undefined);
      info.annotations.push({ type: 'screen', description: JSON.stringify({ name: m.name, t0: m.t0, marker: m.marker }) });
      if (path) await info.attach(`video:${m.name}`, { path, contentType: 'video/webm' }).catch(() => undefined);
    }
  },
  uniq: async ({}, use, info) => {
    // Playwright starts a new worker after a failed test, and the counter with it: the worker's index keeps them apart.
    // Known limit: a worker that makes more than 1000 values runs into the next one's.
    // runners playing at once each start at worker 0: the shard keeps their values apart
    await use((prefix) => `${prefix}-r${process.env.KS_RUN ?? 'x'}${process.env.KS_SHARD ? `s${process.env.KS_SHARD}` : ''}-${info.workerIndex * 1000 + ++uniqCount}`);
  },
  vars: async ({}, use) => {
    await use(JSON.parse(process.env.KS_FLOW_VARS_JSON ?? '{}') as Record<string, string>);
  },
  observed: async ({}, use) => {
    await use(observer());
  },
  mail: async ({}, use) => {
    await use(mailbox(Date.now()).mail);
  },
  sms: async ({}, use) => {
    await use(mailbox(Date.now()).sms);
  },
  given: async ({}, use) => {
    const g = JSON.parse(process.env.KS_SCENARIO_JSON ?? '{"identities":[]}') as { scenario?: string; identities: Identity[] };
    await use({ ...g, identity: (name) => {
      const i = name ? g.identities.find((x) => x.name === name || x.username === name) : g.identities[0];
      if (!i) throw new Error(g.scenario ? `${g.scenario} names no identity ${name ?? ''}: it has ${g.identities.map((x) => x.name).join(', ') || 'none'}` : 'this flow has no scenario: name one in its flow.md (scenario: scn:…)');
      return i;
    } });
  },
  api: async ({ playwright }, use) => {
    const made: APIRequestContext[] = [];
    await use(async (service, port) => {
      const c = await playwright.request.newContext({ baseURL: `http://${service}${port ? `:${port}` : ''}` });
      made.push(c);
      return c;
    });
    for (const c of made) await c.dispose();
  },
});

/** The recorded journey of a flow, tagged @story: the config's story project records its video. */
export function story(title: string, fn: Parameters<typeof test>[2]) {
  test(title, { tag: '@story', annotation: specAnnotation() }, fn);
}

/**
 * Data that exists before the journey, one row of the flow's Precondiciones (laru check holds it to the row).
 * Not a step: the recorded steps stay the Pasos.
 */
export async function prepare<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error) e.message = `Precondiciones «${what}»: ${e.message}`;
    throw e;
  }
}

/** Who can sign in once a scenario is applied. The password should come from `vars` (the vault), so it is masked by value too. */
export interface Identity { name: string; username?: string; email?: string; password?: string }
/** What a scenario's setup leaves: who can sign in and, when its page ended signed in, that session for the person's browser. */
export interface ScenarioResult { identities?: Identity[]; signedIn?: boolean }

/**
 * A scenario's setup: one test, through the app's own API or its screen, that leaves the system in the state
 * its scenario.md names. Its result goes to /ks/out/scenario.json, the page's session (when `signedIn`) beside it.
 */
export function scenario(title: string, fn: (fx: { page: Page; api: Fixtures['api']; uniq: Fixtures['uniq']; vars: Fixtures['vars']; observed: Observed }) => Promise<ScenarioResult | void>) {
  test(title, { tag: '@scenario', annotation: specAnnotation() }, async ({ page, api, uniq, vars, observed }) => {
    const out = (await fn({ page, api, uniq, vars, observed })) ?? {};
    mkdirSync('/ks/out', { recursive: true });
    writeFileSync('/ks/out/scenario.json', JSON.stringify({ identities: out.identities ?? [] }));
    if (out.signedIn) await page.context().storageState({ path: '/ks/out/storage.json' });
  });
}

/** Shows text on the video until the next caption or step. */
export async function caption(text: string): Promise<void> {
  const page = current.page;
  if (!page || page.isClosed()) return;
  await page.evaluate(([t, f]) => { sessionStorage.setItem('ks-caption', t); new Function(`(${f})()`)(); }, [text, drawCaption.toString()]).catch(() => undefined);
}

const STEP_HOLD_MS = Math.max(0, Number(process.env.KS_STEP_HOLD_MS) || 0);
/** One row of the flow's Pasos table. A failure leaves `s<n>.png` next to the run's output. */
export async function step<T>(title: string, fn: () => Promise<T>): Promise<T> {
  const n = ++current.n;
  return test.step(title, async () => {
    await caption(`${n}. ${title}`);
    const shot = async () => {
      const { page, info } = current;
      if (page && info && !page.isClosed()) {
        const path = info.outputPath(`s${n}.png`);
        await page.screenshot({ path }).catch(() => undefined);
        await info.attach(`s${n}`, { path, contentType: 'image/png' }).catch(() => undefined);
      }
    };
    const softBefore = current.info?.errors.length ?? 0;
    try {
      const out = await fn();
      // expect.soft does not throw: a step it failed still leaves its screenshot.
      if ((current.info?.errors.length ?? 0) > softBefore) await shot();
      // a recorded story can hold each step's last screen still (stepHoldMs in ~/.laru/config.yaml), so its video can be followed
      if (STEP_HOLD_MS && current.info?.project.name === 'story') await new Promise((r) => setTimeout(r, STEP_HOLD_MS));
      return out;
    } catch (e) {
      await shot();
      throw e;
    }
  });
}

/** A step the scaffold wrote and nobody filled yet. */
export function todo(): never {
  throw new Error('step not written yet');
}

export const kx = { todo };
void CAPTION;
