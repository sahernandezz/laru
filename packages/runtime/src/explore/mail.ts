/**
 * The mailbox of an env as the host reads it: what its sinks kept (`tap/mail/messages.jsonl` and the originals in
 * `eml/`), folded into messages with their delivery states, searched, opened and answered. The tap is the only writer
 * of the journal; what the host asks of it (clear, delete, mark an SMS, reply as a phone) goes through one file per
 * command in `cmd/`, which the tap runs at most once and answers. Nothing here sends anything outside the machine.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadGraph, WorkspaceError, type Workspace } from '@laru/core';
import { createMasker, maskerOf, parseMime, readMaskFile, type Masker } from '@laru/trace';
import { parseDocument } from 'yaml';
import { ENV_NAME, envDir, envFile, listEnvs, loadEnvSpec, readState } from '../env.ts';
import { readRules } from '../rules.ts';
import { status } from '../up.ts';
import { sinksOf, SMTP_PORTS, type MockSpec } from '../types.ts';
import { FRAME_HEADERS, framePage, sanitizeHtml } from './html.ts';

export const mailDir = (ws: Workspace, env: string) => join(envDir(ws, env), 'tap', 'mail');

/** The mailbox is the one place a code or a link with a token shows: it is masked with the vault's values only, not with what the sinks learned. */
const vault = (ws: Workspace, env: string): Masker => {
  const f = join(envDir(ws, env), 'tap', 'mask.json');
  try { return maskerOf(readMaskFile(f)); } catch { return createMasker([]); }
};

interface Line { id: string; kind: string; t: number; [k: string]: any }
const read = (file: string): Line[] => {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l) as Line] : []; } catch { return []; } });
};

export interface Folded { mails: Map<string, Line>; sms: Map<string, Line>; status: Map<string, Line[]>; order: string[] }
/** The journal as facts: a message by its id, the states of an SMS in the order they came, the deleted ones gone. */
export function fold(ws: Workspace, env: string): Folded {
  const f = join(mailDir(ws, env), 'messages.jsonl');
  const all = [...read(`${f}.1`), ...read(f)];
  const out: Folded = { mails: new Map(), sms: new Map(), status: new Map(), order: [] };
  const gone = new Set<string>();
  for (const l of all) {
    if (l.kind === 'gone') gone.add(l.id);
    else if (l.kind === 'mail') { out.mails.set(l.id, l); out.order.push(l.id); }
    else if (l.kind === 'sms') { out.sms.set(l.id, l); out.order.push(l.id); }
    else if (l.kind === 'status') out.status.set(l.id, [...(out.status.get(l.id) ?? []), l]);
  }
  for (const id of gone) { out.mails.delete(id); out.sms.delete(id); out.status.delete(id); }
  out.order = out.order.filter((id) => out.mails.has(id) || out.sms.has(id));
  return out;
}

export interface Row { id: string; kind: 'mail' | 'sms'; t: number; from: string; to: string; subject: string; attachments: number; codes: string[]; lints: string[]; status: string; service?: string; direction?: string; sender?: string }

const stateOf = (st: Line[] | undefined) => st?.filter((s) => s.status).at(-1)?.status ?? 'queued';
export function rows(ws: Workspace, env: string, f: Folded = fold(ws, env)): Row[] {
  const peers = (() => { try { return readRules(ws, env).peers; } catch { return {}; } })();
  const out: Row[] = [];
  for (const id of f.order) {
    const m = f.mails.get(id);
    if (m) { out.push({ id, kind: 'mail', t: m.t, from: m.headers.from, to: (m.headers.to as string[]).join(', ') || m.envelope.rcpt.join(', '), subject: m.headers.subject, attachments: m.attachments.length, codes: m.codes, lints: m.lints, status: m.outcome, service: peers[m.from] ?? m.from }); continue; }
    const s = f.sms.get(id)!;
    out.push({ id, kind: 'sms', t: s.t, from: s.sender, to: s.to, subject: s.body, attachments: 0, codes: s.codes, lints: [], status: s.direction === 'inbound' ? 'received' : stateOf(f.status.get(id)), service: s.direction === 'inbound' ? undefined : (peers[s.from] ?? s.from), direction: s.direction, sender: s.sender });
  }
  // newest first; two received in the same millisecond, the later one first (reversed, the sort keeps that order)
  return out.reverse().sort((a, b) => b.t - a.t);
}

/** `de:ana para:luis -asunto:pedido tiene:adjunto código:482913 etiqueta:pedido servicio:api run:12 flujo:x` and free words, all combinable, `-` negates. */
export function matches(r: Row, m: Line | undefined, q: string): boolean {
  const terms = [...q.matchAll(/(-?)(?:(de|para|cc|asunto|tiene|servicio|código|codigo|etiqueta|from|to|subject|has|service|code|tag):)?("[^"]*"|\S+)/gi)];
  const hay = (s: string, w: string) => s.toLowerCase().includes(w.toLowerCase());
  for (const [, neg, key, raw] of terms) {
    const w = raw.replace(/^"|"$/g, '');
    const k = (key ?? '').toLowerCase();
    const ok = !k ? [r.subject, r.from, r.to, m?.text ?? ''].some((s) => hay(s, w))
      : k === 'de' || k === 'from' ? hay(r.from, w)
      : k === 'para' || k === 'to' ? hay(r.to, w) || (m?.envelope?.rcpt ?? []).some((x: string) => hay(x, w))
      : k === 'cc' ? (m?.headers?.cc ?? []).some((x: string) => hay(x, w))
      : k === 'asunto' || k === 'subject' ? hay(r.subject, w)
      : k === 'tiene' || k === 'has' ? (/adjunto|attachment/i.test(w) ? r.attachments > 0 : /enlace|link/i.test(w) ? (m?.links?.length ?? 0) > 0 : /c[oó]digo|code/i.test(w) ? r.codes.length > 0 : false)
      : k === 'servicio' || k === 'service' ? hay(r.service ?? '', w)
      : k === 'etiqueta' || k === 'tag' ? r.to.split(',').some((a) => new RegExp(`\\+${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@`, 'i').test(a))
      : r.codes.some((c) => c.includes(w));
    if (neg ? ok : !ok) return false;
  }
  return true;
}

export function list(ws: Workspace, env: string, o: { kind?: 'mail' | 'sms' | 'all'; query?: string; since?: number; limit?: number } = {}) {
  const f = fold(ws, env);
  const all = rows(ws, env, f);
  const counts = { all: all.length, mail: all.filter((r) => r.kind === 'mail').length, sms: all.filter((r) => r.kind === 'sms').length };
  const k = vault(ws, env);
  const kept = all.filter((r) => (!o.kind || o.kind === 'all' || r.kind === o.kind) && (!o.since || r.t > o.since) && matches(r, f.mails.get(r.id) ?? f.sms.get(r.id), o.query ?? '')).slice(0, o.limit ?? 500);
  return { counts, messages: kept.map((r) => ({ ...r, subject: k.known(r.subject), codes: r.codes })) };
}

export interface Message extends Row { unmasked: true; envelope?: { from: string; rcpt: string[] }; headers: Array<[string, string]>; text?: string; links: Array<{ url: string; text?: string; class: string }>; remote: Array<{ url: string; why: string }>; attachments_: Array<{ name: string; type: string; size: number; sha256: string; inline?: boolean }>; session?: Array<{ d: string; l: string }>; states?: Line[]; auth?: Line['auth']; tls?: string; eml: boolean; fault?: string; segments?: { n: number; encoding: string; chars: number } }

/** One message with what the screen shows of it. Codes and links are in plain view and say so: the vault's values are not. */
export function message(ws: Workspace, env: string, id: string): (Message & { attachments: number }) | undefined {
  const f = fold(ws, env);
  const row = rows(ws, env, f).find((r) => r.id === id);
  if (!row) return;
  const k = vault(ws, env);
  const m = f.mails.get(id);
  if (m) {
    const eml = join(mailDir(ws, env), 'eml', `${id}.eml`);
    const have = existsSync(eml);
    const p = have ? parseMime(readFileSync(eml)) : undefined;
    return { ...row, unmasked: true, envelope: m.envelope, headers: (p?.headers ?? []).map(([n, v]) => [n, k.known(v)] as [string, string]), text: m.text, links: m.links, remote: m.remote, attachments_: m.attachments, session: m.session, auth: m.auth, tls: m.tls, eml: have, ...(m.fault ? { fault: m.fault } : {}) };
  }
  const s = f.sms.get(id)!;
  return { ...row, unmasked: true, headers: [], text: k.known(s.body), links: [], remote: [], attachments_: [], states: f.status.get(id), eml: false, segments: { n: s.segments, encoding: s.encoding, chars: s.chars } };
}

/** The part of a message the frame, the download or the source asks for. Bytes never pass through `json()`. */
export function part(ws: Workspace, env: string, id: string, what: 'html' | 'eml' | { attachment: number }, o: { width?: number } = {}): { status: number; headers: Record<string, string>; body: Buffer } {
  if (!/^[0-9a-f-]{36}$/.test(id)) return { status: 400, headers: { 'content-type': 'text/plain' }, body: Buffer.from('bad id') };
  const file = join(mailDir(ws, env), 'eml', `${id}.eml`);
  if (!existsSync(file)) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('the original is gone (retention or «Vaciar buzón»)') };
  const raw = readFileSync(file);
  const k = vault(ws, env);
  if (what === 'eml') return { status: 200, headers: { 'content-type': 'message/rfc822', 'content-disposition': `attachment; filename="${id}.eml"`, 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'cache-control': 'no-store' }, body: Buffer.from(k.known(raw.toString('latin1')), 'latin1') };
  const p = parseMime(raw, { bytes: true });
  if (what === 'html') {
    const cid: Record<string, string> = {};
    for (const a of p.attachments) if (a.cid && a.bytes && /^image\/(?:png|jpe?g|gif|webp)$/.test(a.type) && a.bytes.length < 1024 * 1024) cid[a.cid] = `data:${a.type};base64,${a.bytes.toString('base64')}`;
    const clean = p.html ? sanitizeHtml(k.known(p.html), cid) : { html: `<pre style="white-space:pre-wrap;font:inherit">${(p.text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`, blocked: [] };
    return { status: 200, headers: { ...FRAME_HEADERS, 'x-laru-blocked': encodeURIComponent(JSON.stringify(clean.blocked.slice(0, 50))) }, body: Buffer.from(framePage(clean.html, o.width)) };
  }
  const a = p.attachments[what.attachment];
  if (!a?.bytes) return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('no such attachment') };
  const name = a.name.replace(/[\\/\u0000-\u001f"]/g, '_');
  // always a download, never drawn here: an SVG or an HTML attachment is a document with scripts
  return { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'cache-control': 'no-store' }, body: a.bytes };
}

/** What the screen needs before it has a message: what receives in this env, on which ports, and what is not covered. */
export function sinkReport(ws: Workspace, env: string) {
  const spec = loadEnvSpec(ws, env);
  const state = readState(ws, env);
  const smtp = sinksOf(spec.mocks, 'smtp');
  const twilio = sinksOf(spec.mocks, 'twilio');
  const dir = mailDir(ws, env);
  return {
    env, sinks: [
      ...smtp.map((n) => ({ name: n, kind: 'smtp' as const, ports: Object.entries(state?.ports?.[n] ?? {}).map(([c, h]) => ({ container: Number(c), host: h })), containerPorts: SMTP_PORTS })),
      ...twilio.map((n) => ({ name: n, kind: 'twilio' as const, ports: [], containerPorts: [443] })),
    ],
    hasSinks: smtp.length + twilio.length > 0,
    egress: spec.egress ?? 'open',
    running: existsSync(dir),
  };
}

/** A command for the tap: written whole, run once, answered in `.res`. Without a tap that answers, nothing is queued for later. */
export async function command(ws: Workspace, env: string, cmd: Record<string, unknown>, wait = 5000): Promise<Record<string, any>> {
  const dir = join(mailDir(ws, env), 'cmd');
  if (!existsSync(dir)) throw new Error(`${env} has no mailbox: it is not running or has no mail or SMS sink`);
  const id = randomUUID();
  writeFileSync(join(dir, `${id}.tmp`), JSON.stringify(cmd), { mode: 0o600 });
  renameSync(join(dir, `${id}.tmp`), join(dir, `${id}.json`));
  const res = join(dir, `${id}.res`);
  for (const t = Date.now(); Date.now() - t < wait;) {
    if (existsSync(res)) { const r = JSON.parse(readFileSync(res, 'utf8')); rmSync(res, { force: true }); return r; }
    await new Promise((r) => setTimeout(r, 100));
  }
  rmSync(join(dir, `${id}.json`), { force: true });
  throw new Error('the env\'s tap did not answer in time: is it running?');
}

export const clear = (ws: Workspace, env: string) => command(ws, env, { op: 'clear' });
export const remove = (ws: Workspace, env: string, ids: string[]) => command(ws, env, { op: 'delete', ids });
export const smsStatus = (ws: Workspace, env: string, id: string, status: 'delivered' | 'undelivered' | 'failed' | 'sent', code?: number) => command(ws, env, { op: 'sms-status', id, status, ...(code ? { code } : {}) });
export const smsReply = (ws: Workspace, env: string, from: string, body: string) => command(ws, env, { op: 'sms-reply', from, body }, 15000);

/** Wait for the next message after `since` that meets the filter, up to `ms` (60 s at most). */
export async function wait(ws: Workspace, env: string, o: { kind?: 'mail' | 'sms'; query?: string; since?: number; ms?: number }) {
  const since = o.since ?? Date.now();
  for (const t = Date.now(); Date.now() - t < Math.min(o.ms ?? 15000, 60000);) {
    const hit = list(ws, env, { kind: o.kind, query: o.query, since, limit: 1 }).messages[0];
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
}

export interface Detected { name: string; kind: 'smtp' | 'sms' | 'http'; provider: string; via?: string; services: string[]; /** a sink in the env stands for it */ intercepted: boolean }

/** What the map says the app sends by mail or SMS, and whether this env's sinks already receive it. */
export function detected(ws: Workspace, env?: string): Detected[] {
  let g;
  try { g = loadGraph(ws); } catch { return []; }
  const spec = env ? (() => { try { return loadEnvSpec(ws, env); } catch { return undefined; } })() : undefined;
  const sinks = spec?.mocks ?? {};
  const anySmtp = sinksOf(sinks, 'smtp').length > 0;
  return g.ofType('external').filter((n) => n.attrs?.messaging).map((n) => {
    const kind = n.attrs!.messaging as Detected['kind'];
    const via = typeof n.attrs?.via === 'string' ? n.attrs.via : undefined;
    // an SMTP server read from a variable is moved by the env to its sink's name, so any SMTP sink covers it; a fixed name needs its own
    return { name: n.name, kind, provider: String(n.attrs?.provider ?? ''), ...(via ? { via } : {}), services: g.inOf(n.id).map((f) => f.s.replace(/^svc:/, '')), intercepted: sinks[n.name]?.mode === 'sink' || (kind === 'smtp' && !!via && anySmtp) };
  });
}

/** What «Interceptar» would write: the mocks that make an env receive what is detected. An API provider is not served: it says so. */
export function plan(ws: Workspace, env: string, o: { as?: string } = {}) {
  // the name becomes a file under envs/: a name that is not an env's (a path, `..`, a slash) is refused before anything is read or written
  if (o.as !== undefined && !ENV_NAME.test(o.as)) throw new WorkspaceError('the new env\'s name is kebab-case (letters, digits and dashes)', 'as');
  const found = detected(ws, env);
  const mocks: Record<string, MockSpec> = {};
  const unserved: Detected[] = [];
  for (const d of found) {
    if (d.kind === 'http') unserved.push(d);
    else if (!d.intercepted) mocks[d.name] = d.kind === 'smtp' ? { mode: 'sink', sink: 'smtp' } : { mode: 'sink', sink: 'twilio' };
  }
  const as = o.as ?? env;
  return { from: env, as, file: `envs/${as}.yaml`, mocks, unserved, detected: found, notes: [
    ...(as !== env ? [`${as} extends ${env}: the same services, with a mailbox`] : [`${env} itself gets the mocks`]),
    ...unserved.map((d) => `${d.services.join(', ')} sends by ${d.provider}'s API, which a mailbox does not serve; real messages can leave. Use SMTP in local`),
  ] };
}

/** Writes `envs/<as>.yaml` with the sinks (idempotent: what is there is kept). Without `confirm` it only says what it would do. */
export function enable(ws: Workspace, env: string, o: { as?: string; confirm?: boolean } = {}) {
  if (!ENV_NAME.test(env) || !listEnvs(ws).includes(env)) throw new WorkspaceError(`no env "${env}"`);
  const p = plan(ws, env, o);
  if (!o.confirm || !Object.keys(p.mocks).length) return { ...p, wrote: false };
  const file = p.as === env ? envFile(ws, env) : join(ws.root, 'envs', `${p.as}.yaml`);
  const doc = existsSync(file) ? parseDocument(readFileSync(file, 'utf8')) : parseDocument(`extends: ${env}\n`);
  for (const [n, m] of Object.entries(p.mocks)) if (!doc.hasIn(['mocks', n])) doc.setIn(['mocks', n], m);
  mkdirSync(join(ws.root, 'envs'), { recursive: true });
  writeFileSync(file, String(doc));
  loadEnvSpec(ws, p.as); // what was written has to load
  return { ...p, wrote: true };
}

/**
 * Where a link of a message can be opened from this Mac: a name of the env goes to that service's entrance; any other
 * (production, the internet) only to the front's, rewritten, never as it is. The address is the entrance's origin
 * *concatenated* with the link's path and query (a `//other.host` must not change the host), and checked.
 */
export async function withOpen<T extends { links: Array<{ url: string; class: string }> }>(ws: Workspace, env: string, m: T): Promise<T & { links: Array<{ url: string; class: string; text?: string; open?: string; rewritten?: boolean }> }> {
  if (!m.links.length) return m;
  const st = await status(ws, env).catch(() => undefined);
  const http = (st?.addresses ?? []).filter((a) => a.kind === 'http');
  const front = http.find((a) => /^(?:web|frontend|front|nginx|proxy|gateway|ui)\b/.test(a.service)) ?? http[0];
  const to = (origin: string, u: URL) => { const r = `${origin}${u.pathname}${u.search}`; try { return new URL(r).origin === origin ? r : undefined; } catch { return undefined; } };
  return { ...m, links: m.links.map((l) => {
    if (l.class === 'blocked-scheme') return l;
    let u: URL;
    try { u = new URL(l.url); } catch { return l; }
    const own = http.find((a) => a.service === u.hostname);
    const a = own ?? front;
    if (!a) return l;
    const open = to(new URL(a.url).origin, u);
    return open ? { ...l, open, rewritten: !own } : l;
  }) };
}
