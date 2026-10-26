/**
 * The sink: a mock that *receives* what an app sends out, mail by SMTP and SMS by Twilio's API, keeps it in the env's
 * mailbox (`tap/mail/messages.jsonl`, one line per fact, and the original in `eml/`) and sends nothing anywhere. It has
 * no relay, no forward and no «release». It reaches the app only to call back its own status webhook, inside the env.
 * Stdlib only, like the tap.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import type { SecureContext } from 'node:tls';
import { classify, codesOf, smsSegments, textLinks, tokensOf, type Link, type LinkEnv } from '../../trace/src/messages.ts';
import type { Masker } from '../../trace/src/mask.ts';
import { htmlLinks, parseMime, remoteResources } from '../../trace/src/mime.ts';
import type { FaultRule, MockSpec, TrafficRecord } from '../src/types.ts';
import { LIMITS, smtpSession, type Fault, type Transaction } from './smtp.ts';
import type { Mock, MockRequest, MockResult } from './mocks.ts';

export interface SinkHost {
  /** the tap's state dir: the mailbox is `<out>/mail` */
  out: string;
  svc: string;
  open(file: string): { write(l: string): void; close(): Promise<void> };
  log(msg: string): void;
  masker(): Masker;
  /** what the messages carry that opens something (codes, tokens): masked everywhere but in the mailbox */
  learn(values: string[]): void;
  faults(stage: string, who?: string): FaultRule[];
  /** which names a link can have to be the env's own, and which are production */
  linkEnv?: LinkEnv;
  record(rec: Partial<TrafficRecord>): void;
  /** the app's own webhook, inside the env: http only, resolved by the env's route table, no redirects, 10 s, 64 KB */
  call(url: string, form: Record<string, string>, headers: Record<string, string>): Promise<{ http?: number; ms: number; body?: string; skipped?: string }>;
  tls?: SecureContext;
  /** what the env's sinks have in common (one mailbox: its journal, timers and command poller); it outlives a rules reload */
  shared: Record<string, any>;
}

export const RETENTION = { messages: 500, days: 7, bytes: 200 * 1024 * 1024 };

/** Twilio's error bodies: the code of each HTTP status the API answers with, and what their delivery codes say. */
const TWILIO_ERRORS: Record<number, { code: number; message: string }> = {
  400: { code: 21211, message: "The 'To' number is not a valid phone number." },
  401: { code: 20003, message: 'Authenticate' },
  404: { code: 20404, message: 'The requested resource was not found' },
  429: { code: 20429, message: 'Too many requests' },
};
export const DELIVERY_ERRORS: Record<number, string> = { 30003: 'Unreachable destination handset', 30005: 'Unknown destination handset', 30006: 'Landline or unreachable carrier', 30007: 'Carrier violation' };

const twilioBody = (status: number) => {
  const e = TWILIO_ERRORS[status] ?? { code: status * 100 / 10, message: 'Error' };
  return JSON.stringify({ code: e.code, message: e.message, more_info: `https://www.twilio.com/docs/errors/${e.code}`, status });
};

/** X-Twilio-Signature: HMAC-SHA1 of the URL as the app gave it plus the parameters sorted by name, base64, with the account's Auth Token. */
export const twilioSignature = (token: string, url: string, params: Record<string, string>) =>
  createHmac('sha1', token).update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');

export async function loadSink(name: string, spec: MockSpec, host: SinkHost, mine: Record<string, any>): Promise<Mock> {
  // `mine` is this sink's own (the Twilio token); `state` is the mailbox's, shared by both of them: one journal, one poller, one set of timers
  const state = host.shared;
  const dir = join(host.out, 'mail');
  mkdirSync(join(dir, 'eml'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'cmd'), { recursive: true, mode: 0o700 });
  // The store, the timers and what was learned outlive a rules reload (the mock is rebuilt, `state` is not).
  state.journal ??= host.open(join(dir, 'messages.jsonl'));
  state.timers ??= new Set<NodeJS.Timeout>();
  state.sms ??= new Map<string, Record<string, any>>();
  const journal = state.journal as ReturnType<SinkHost['open']>;
  const write = (line: Record<string, unknown>) => journal.write(JSON.stringify({ v: 1, t: Date.now(), ...line }));
  const later = (ms: number, fn: () => void) => { const t = setTimeout(() => { state.timers.delete(t); fn(); }, ms); state.timers.add(t); };

  // ---- retention: the newest 500 messages, 7 days and 200 MB; the oldest originals go first
  const prune = () => {
    try {
      const dirEml = join(dir, 'eml');
      const files = readdirSync(dirEml).map((f) => ({ f, ...statSync(join(dirEml, f)) })).sort((a, b) => b.mtimeMs - a.mtimeMs);
      let bytes = 0;
      files.forEach((x, i) => { bytes += x.size; if (i >= RETENTION.messages || bytes > RETENTION.bytes || Date.now() - x.mtimeMs > RETENTION.days * 864e5) rmSync(join(dirEml, x.f), { force: true }); });
    } catch { /* a mailbox that is not there yet has nothing to prune */ }
  };
  state.prune ??= setInterval(prune, 3600_000).unref();

  const learnFrom = (texts: string[], urls: string[]) => host.learn([...texts.flatMap(codesOf), ...urls.flatMap(tokensOf)]);

  // ---- SMTP
  const accept = async (t: Transaction, port: number, from: string): Promise<{ code: number; text: string }> => {
    const id = randomUUID();
    const raw = t.data;
    const p = raw ? parseMime(raw) : undefined;
    const outcome = (host.faults('DELIVERY', t.envelope.rcpt[0]).find((f) => f.status && f.status >= 500)) ? 'bounced' : 'accepted';
    const text = p?.text ?? '';
    const links: Link[] = [];
    const seen = new Set<string>();
    const add = (url: string, txt: string | undefined, hint?: 'tracking' | 'unsubscribe') => { if (!url || seen.has(url)) return; seen.add(url); links.push({ url, ...(txt ? { text: txt } : {}), class: classify(url, hint, host.linkEnv) }); };
    for (const l of p?.html ? htmlLinks(p.html) : []) add(l.url, l.text);
    for (const u of textLinks(text)) add(u, undefined);
    for (const u of (p?.unsubscribe ?? '').matchAll(/<([^<>]+)>/g)) add(u[1], undefined, 'unsubscribe');
    const codes = codesOf(text);
    const remote = p?.html ? remoteResources(p.html) : [];
    const lints = [...(p?.lints ?? [])];
    if (links.some((l) => l.class === 'production')) lints.push('production-link');
    if (p?.html && htmlLinks(p.html).some((l) => /^https?:\/\//i.test(l.text) && l.text !== l.url)) lints.push('link-text-differs');
    if (raw) { try { writeFileSync(join(dir, 'eml', `${id}.eml`), raw, { mode: 0o600 }); } catch (e) { host.log(`mail: ${(e as Error).message}`); } }
    learnFrom([text], links.map((l) => l.url));
    const k = host.masker();
    write({
      id, kind: 'mail', from, sink: name, port, tls: t.tls, ...(t.auth ? { auth: t.auth } : {}), envelope: t.envelope, size: t.size, ...(raw && !p?.partial ? { eml: `eml/${id}.eml` } : raw ? { eml: `eml/${id}.eml`, partial: true } : { partial: true }),
      headers: { from: p?.from ?? '', to: p?.to ?? [], cc: p?.cc ?? [], ...(p?.replyTo ? { replyTo: p.replyTo } : {}), subject: p?.subject ?? '', ...(p?.date ? { date: p.date } : {}), ...(p?.messageId ? { messageId: p.messageId } : {}), ...(p?.unsubscribe ? { unsubscribe: p.unsubscribe } : {}) },
      text: k.known(text.slice(0, 32768)), htmlBytes: p?.html?.length ?? 0,
      attachments: (p?.attachments ?? []).map(({ name: n, type, size, sha256, inline }) => ({ name: n, type, size, sha256, ...(inline ? { inline } : {}) })),
      links: links.map((l) => ({ ...l, url: k.known(l.url) === l.url ? l.url : k.known(l.url) })), codes, remote, lints, session: t.session, outcome, reply: '250 2.0.0 queued',
    });
    // the cap holds as messages arrive, not only every hour
    if ((state.received = (state.received ?? 0) + 1) % 25 === 0) prune();
    host.record({ kind: 'tcp', t0: Date.now() - 1, from, svc: host.svc, port, mock: 'sink', status: 250, msg: { id, kind: 'mail', to: t.envelope.rcpt.join(', '), subject: p?.subject ?? '' } });
    if (outcome === 'bounced') later(host.faults('DELIVERY').reduce((s, f) => s + (f.latency ?? 0), 0), () => bounce(t, p?.subject ?? '', id));
    return { code: 250, text: `queued as ${id}` };
  };

  /** A rebound after accepting: a delivery-status notification to the sender, in the mailbox. */
  const bounce = (t: Transaction, subject: string, id: string) => {
    const bid = randomUUID();
    const text = `Your message to ${t.envelope.rcpt.join(', ')} could not be delivered (550 injected by Laru).`;
    write({ id: bid, kind: 'mail', from: name, sink: name, port: 0, tls: 'none', envelope: { from: '', rcpt: [t.envelope.from] }, size: text.length,
      headers: { from: 'MAILER-DAEMON', to: [t.envelope.from], cc: [], subject: `Undelivered Mail Returned to Sender: ${subject}` }, text, htmlBytes: 0, attachments: [], links: [], codes: [], remote: [], lints: [], session: [], outcome: 'accepted', reply: '250 2.0.0', fault: `bounce of ${id}` });
  };

  const fault = (stage: string, who?: string): Fault | undefined => {
    const fs = host.faults(stage, who);
    if (!fs.length) return;
    const status = fs.find((f) => f.status)?.status;
    return { latency: fs.reduce((s, f) => s + (f.latency ?? 0), 0) || undefined, abort: fs.some((f) => f.abort), status };
  };

  // ---- Twilio
  const form = (req: MockRequest) => Object.fromEntries(new URLSearchParams(req.body.toString('utf8')));
  const json = (status: number, body: unknown, extra: Partial<MockResult> = {}): MockResult => ({ status, headers: { 'content-type': 'application/json', 'x-laru-mock': 'sink' }, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), mock: 'sink', ...extra });

  const status = (sid: string, to: string, st: string, code?: number) => {
    const m = state.sms.get(sid);
    if (m) m.status = st;
    write({ id: sid, kind: 'status', status: st, ...(code ? { code } : {}) });
    const cb = m?.callback as string | undefined;
    if (!cb) return;
    if (st === 'queued') return;
    const params: Record<string, string> = { MessageSid: sid, SmsSid: sid, SmsStatus: st, MessageStatus: st, AccountSid: m!.account, From: m!.sender, To: to, ApiVersion: '2010-04-01', ...(code ? { ErrorCode: String(code) } : {}) };
    const sig = mine.token && !String(m!.account).startsWith('SK') ? twilioSignature(mine.token, cb, params) : undefined;
    void host.call(cb, params, sig ? { 'x-twilio-signature': sig } : {}).then((r) => {
      write({ id: sid, kind: 'status', status: st, ...(code ? { code } : {}), callback: { url: cb, ...(r.http ? { http: r.http } : {}), ms: r.ms, ...(r.skipped ? { skipped: r.skipped } : {}), signed: sig ? true : mine.token ? false : 'unverifiable' } });
      host.record({ kind: 'http', t0: Date.now() - r.ms, t1: Date.now(), from: name, svc: new URL(cb).hostname, port: Number(new URL(cb).port || 80), method: 'POST', path: new URL(cb).pathname, status: r.http, mock: 'callback', msg: { id: sid, kind: 'sms', to, cb: st } });
    });
  };

  const send = (req: MockRequest, account: string): MockResult => {
    const f = form(req);
    const faults = host.faults('POST', f.To);
    const bad = faults.find((x) => x.status);
    if (bad?.status) return json(bad.status, twilioBody(bad.status));
    const body = f.Body ?? '';
    if (!f.To || !body) return json(400, { code: 21604, message: "A 'To' phone number and a 'Body' are required", more_info: 'https://www.twilio.com/docs/errors/21604', status: 400 });
    if (body.length > 1600) return json(400, { code: 21617, message: 'The concatenated message body exceeds the 1600 character limit', more_info: 'https://www.twilio.com/docs/errors/21617', status: 400 });
    const sid = `SM${randomBytes(16).toString('hex')}`;
    const seg = smsSegments(body);
    const cb = f.StatusCallback;
    state.sms.set(sid, { account, sender: f.From ?? f.MessagingServiceSid ?? '', to: f.To, body, status: 'queued', callback: cb });
    write({ id: sid, kind: 'sms', from: name, sink: name, provider: 'twilio', sid, sender: f.From ?? f.MessagingServiceSid ?? '', to: f.To, body: host.masker().known(body), chars: seg.chars, segments: seg.segments, encoding: seg.encoding, direction: 'outbound', ...(cb ? { callback: cb } : {}), codes: codesOf(body) });
    write({ id: sid, kind: 'status', status: 'queued' });
    learnFrom([body], []);
    const d = host.faults('DELIVERY', f.To);
    const lag = d.reduce((s, x) => s + (x.latency ?? 0), 0);
    const failed = d.find((x) => x.code)?.code;
    if (spec.deliver !== 'manual') {
      later(200, () => status(sid, f.To, 'sent'));
      later(500 + lag, () => (failed ? status(sid, f.To, 'undelivered', failed) : status(sid, f.To, 'delivered')));
    }
    return json(201, { sid, account_sid: account, from: f.From ?? null, to: f.To, status: 'queued', num_segments: String(seg.segments), direction: 'outbound-api', api_version: '2010-04-01', uri: `/2010-04-01/Accounts/${account}/Messages/${sid}.json`, date_created: new Date().toUTCString() }, { msg: { id: sid, kind: 'sms', to: f.To }, hideReq: true });
  };

  /** The commands the screen leaves in `cmd/`: each runs at most once (renamed before acting, answered in a `.res`). */
  const poll = () => {
    const cmd = join(dir, 'cmd');
    for (const f of readdirSync(cmd).filter((n) => n.endsWith('.json'))) {
      const id = f.slice(0, -5);
      try { renameSync(join(cmd, f), join(cmd, `${id}.run`)); } catch { continue; }
      let res: Record<string, unknown> = { ok: false, error: 'interrupted' };
      try {
        const c = JSON.parse(readFileSync(join(cmd, `${id}.run`), 'utf8')) as { op: string; id?: string; ids?: string[]; status?: string; code?: number; from?: string; body?: string };
        if (c.op === 'clear') { truncateSync(join(dir, 'messages.jsonl'), 0); for (const e of readdirSync(join(dir, 'eml'))) rmSync(join(dir, 'eml', e), { force: true }); state.sms.clear(); res = { ok: true }; }
        else if (c.op === 'delete') { for (const x of c.ids ?? (c.id ? [c.id] : [])) { write({ kind: 'gone', id: x }); rmSync(join(dir, 'eml', `${x}.eml`), { force: true }); } res = { ok: true }; }
        else if (c.op === 'sms-status' && c.id && c.status) { const t = state.twilio; if (!t) res = { ok: false, error: 'this env has no SMS sink' }; else { t.status(c.id, state.sms.get(c.id)?.to ?? '', c.status, c.code); res = { ok: true }; } }
        else if (c.op === 'sms-reply' && c.from) {
          const t = state.twilio;
          if (!t) res = { ok: false, error: 'this env has no SMS sink' };
          else if (!t.spec.inbound) res = { ok: false, error: `${t.name} has no webhook for incoming texts: set mocks.${t.name}.inbound in envs/<env>.yaml` };
          else { t.reply(c.from, c.body ?? '').then((r: unknown) => writeFileSync(join(cmd, `${id}.res`), JSON.stringify(r)), (e: Error) => writeFileSync(join(cmd, `${id}.res`), JSON.stringify({ ok: false, error: e.message }))); rmSync(join(cmd, `${id}.run`), { force: true }); continue; }
        }
        else res = { ok: false, error: `unknown command ${c.op}` };
      } catch (e) { res = { ok: false, error: (e as Error).message }; }
      writeFileSync(join(cmd, `${id}.res`), JSON.stringify(res));
      rmSync(join(cmd, `${id}.run`), { force: true });
    }
    for (const f of readdirSync(cmd).filter((n) => n.endsWith('.res'))) if (Date.now() - statSync(join(cmd, f)).mtimeMs > 60_000) rmSync(join(cmd, f), { force: true });
  };
  // a command that was running when the tap went down is closed as interrupted, never repeated
  for (const f of readdirSync(join(dir, 'cmd')).filter((n) => n.endsWith('.run'))) { const id = f.slice(0, -4); if (!existsSync(join(dir, 'cmd', `${id}.res`))) writeFileSync(join(dir, 'cmd', `${id}.res`), JSON.stringify({ ok: false, error: 'interrupted' })); rmSync(join(dir, 'cmd', f), { force: true }); }
  state.poll ??= setInterval(() => { try { poll(); } catch (e) { host.log(`mail cmd: ${(e as Error).message}`); } }, 500).unref();

  /** A reply from a person's phone to the app's inbound webhook, signed; its TwiML answer may hold a `<Message>` that joins the thread. */
  async function reply(from: string, body: string) {
    const to = [...state.sms.values()].at(-1)?.sender ?? '';
    const sid = `SM${randomBytes(16).toString('hex')}`;
    const params = { From: from, To: to, Body: body, MessageSid: sid, NumMedia: '0', AccountSid: [...state.sms.values()].at(-1)?.account ?? '', ApiVersion: '2010-04-01' };
    write({ id: sid, kind: 'sms', from: name, sink: name, provider: 'twilio', sid, sender: from, to, body: host.masker().known(body), ...smsOf(body), direction: 'inbound', codes: [] });
    write({ id: sid, kind: 'status', status: 'received' });
    const sig = mine.token ? twilioSignature(mine.token, spec.inbound!, params) : undefined;
    const r = await host.call(spec.inbound!, params, sig ? { 'x-twilio-signature': sig } : {});
    host.record({ kind: 'http', t0: Date.now() - r.ms, t1: Date.now(), from: name, svc: new URL(spec.inbound!).hostname, port: Number(new URL(spec.inbound!).port || 80), method: 'POST', path: new URL(spec.inbound!).pathname, status: r.http, mock: 'callback', msg: { id: sid, kind: 'sms', to, cb: 'received' } });
    const m = /<Message[^>]*>([^<]*)<\/Message>/i.exec(r.body ?? '');
    if (m) {
      const out = `SM${randomBytes(16).toString('hex')}`;
      write({ id: out, kind: 'sms', from: name, sink: name, provider: 'twilio', sid: out, sender: to, to: from, body: host.masker().known(m[1]), ...smsOf(m[1]), direction: 'outbound', codes: [] });
    }
    return { ok: true, http: r.http, ...(r.skipped ? { skipped: r.skipped } : {}) };
  }
  const smsOf = (b: string) => { const s = smsSegments(b); return { chars: s.chars, segments: s.segments, encoding: s.encoding }; };

  const authOf = (req: MockRequest) => {
    const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const [user, pass] = m ? Buffer.from(m[1], 'base64').toString().split(':') : ['', ''];
    return { user, pass };
  };

  if (spec.sink === 'twilio') state.twilio = { name, spec, status, reply };
  return {
    name,
    mode: 'sink',
    sink: true,
    quiet: true,
    implicitTls: spec.implicitTls ?? (spec.sink === 'smtp' ? [465] : []),
    async http(req) {
      if (spec.sink !== 'twilio') return null;
      const a = authOf(req);
      if (a.pass) mine.token = a.pass; // kept in memory only, never written; it signs the status calls
      const m = /^\/2010-04-01\/Accounts\/([^/]+)\/Messages(?:\/(SM[0-9a-f]+))?\.json$/.exec(req.path);
      if (!m) return json(404, twilioBody(404));
      const f = fault('POST');
      if (f?.latency) await new Promise((r) => setTimeout(r, f.latency));
      if (req.method === 'POST' && !m[2]) return send(req, m[1]);
      if (req.method === 'GET' && m[2]) { const s = state.sms.get(m[2]); return s ? json(200, { sid: m[2], account_sid: m[1], from: s.sender, to: s.to, status: s.status }) : json(404, twilioBody(404)); }
      if (req.method === 'GET') return json(200, { messages: [...state.sms].map(([sid, s]) => ({ sid, from: s.sender, to: s.to, status: s.status })) });
      return json(405, { code: 20004, message: 'Method not allowed', status: 405 });
    },
    recorded() {},
    tcp(socket: Socket, c: { port: number; implicit: boolean; from: string }) {
      // at most 50 conversations at once: the 51st is told to come back, not queued
      if ((state.conns ?? 0) >= LIMITS.conns) { socket.end('421 4.3.2 too many connections, try again later\r\n', () => socket.destroy()); return; }
      state.conns = (state.conns ?? 0) + 1;
      socket.once('close', () => { state.conns--; });
      smtpSession(socket, {
        host: `${name}`, tls: host.tls, requireTls: spec.tls === 'required', implicit: c.implicit,
        fault, log: host.log, accept: (t) => accept(t, c.port, c.from),
      });
    },
    stop() { for (const t of state.timers as Set<NodeJS.Timeout>) clearTimeout(t); state.timers.clear(); clearInterval(state.prune); clearInterval(state.poll); void journal.close(); },
  } as Mock;
}

