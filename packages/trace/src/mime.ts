/**
 * A message as the sink keeps it: the envelope's headers decoded, the text and HTML parts, the attachments (name, type,
 * size, hash) and what is wrong with it. Stdlib only, linear, and it never throws: what it does not understand
 * falls back to the source. Limits: 20 levels, 500 parts, 100 KB of headers per part.
 */
import { createHash } from 'node:crypto';

export interface Address { name?: string; address: string }
export interface Attachment { name: string; type: string; size: number; sha256: string; inline?: boolean; cid?: string; /** the decoded bytes, only when asked for */ bytes?: Buffer }
export interface Parsed {
  headers: Array<[string, string]>;
  subject: string; from: string; to: string[]; cc: string[]; replyTo?: string; date?: string; messageId?: string; unsubscribe?: string;
  text?: string; html?: string; attachments: Attachment[]; lints: string[]; partial?: boolean;
}

const MAX_DEPTH = 20, MAX_PARTS = 500, MAX_HEADERS = 100 * 1024, MAX_PARSE = 5 * 1024 * 1024;

/** `=?utf-8?q?...?=` and `=?iso-8859-1?b?...?=`, and the words between two of them without their blank. */
export function decodeWords(s: string): string {
  return s.replace(/(=\?[^?\s]+\?[bq]\?[^?\s]*\?=)\s+(?==\?)/gi, '$1').replace(/=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=/gi, (_, cs: string, enc: string, body: string) => {
    const raw = enc.toLowerCase() === 'b' ? Buffer.from(body, 'base64') : qp(body.replace(/_/g, ' '), true);
    return text(raw, cs);
  });
}

// 0x80–0x9F of windows-1252, which is what mail means by iso-8859-1 (and what the WHATWG label table says): Node's decoder keeps those bytes as controls
const CP1252 = '€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f\x90‘’“”•–—˜™š›œ\x9džŸ';

function text(buf: Buffer, charset?: string): string {
  const cs = (charset ?? 'utf-8').toLowerCase().replace(/^"|"$/g, '').replace(/\*.*$/, '');
  if (/^(?:windows-1252|cp1252|iso-8859-1|latin1|iso8859-1|l1)$/.test(cs)) return buf.toString('latin1').replace(/[\x80-\x9f]/g, (c) => CP1252[c.charCodeAt(0) - 0x80]);
  try { return new TextDecoder(/^(?:us-ascii|ascii)$/.test(cs) ? 'utf-8' : cs).decode(buf); } catch { return buf.toString('latin1'); }
}

function qp(s: string, word = false): Buffer {
  const out: number[] = [];
  const t = word ? s : s.replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 61 && /^[0-9a-f]{2}$/i.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; } else if (c < 256) out.push(c); else out.push(...Buffer.from(t[i]));
  }
  return Buffer.from(out);
}

/** The head of a part: unfolded, in order, names lower-cased. */
function head(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of raw.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1][1] += ` ${line.trim()}`;
    else { const i = line.indexOf(':'); if (i > 0) out.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]); }
  }
  return out;
}

/** `type/sub; a=b; c*=utf-8''x` → the type and its parameters, with RFC 2231 continuations and encodings joined. */
export function params(v: string): { value: string; p: Record<string, string> } {
  const parts: string[] = [];
  let cur = '', q = false;
  for (const ch of v) { if (ch === '"') q = !q; if (ch === ';' && !q) { parts.push(cur); cur = ''; } else cur += ch; }
  parts.push(cur);
  const raw: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i > 0) raw[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1');
  }
  const p: Record<string, string> = {};
  const joined = new Map<string, Array<[number, string, boolean]>>();
  for (const [k, val] of Object.entries(raw)) {
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(k);
    if (!m || (!m[2] && !m[3])) { p[k] = val; continue; }
    (joined.get(m[1]) ?? joined.set(m[1], []).get(m[1])!).push([Number(m[2] ?? 0), val, !!m[3]]);
  }
  for (const [k, list] of joined) {
    list.sort((a, b) => a[0] - b[0]);
    const first = /^([^']*)'[^']*'(.*)$/s.exec(list[0][1]);
    const charset = list[0][2] ? first?.[1] : undefined;
    const body = list.map(([, v2, enc], i) => (enc ? (i === 0 && first ? first[2] : v2) : v2)).join('');
    p[k] = list[0][2] ? text(Buffer.from(body.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1'), charset) : body;
  }
  return { value: parts[0].trim().toLowerCase(), p };
}

export function addresses(v: string): Address[] {
  const out: Address[] = [];
  let cur = '', q = false, a = 0;
  const flush = () => {
    const s = cur.trim(); cur = '';
    if (!s) return;
    const m = /^(.*?)<([^<>]*)>\s*$/s.exec(s);
    const name = m ? decodeWords(m[1].trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1')) : '';
    const address = (m ? m[2] : s.replace(/\(.*?\)/g, '')).trim();
    if (address) out.push({ ...(name ? { name } : {}), address });
  };
  for (const ch of v) { if (ch === '"') q = !q; else if (!q && ch === '<') a++; else if (!q && ch === '>') a--; if (ch === ',' && !q && a <= 0) flush(); else cur += ch; }
  flush();
  return out;
}
export const show = (a: Address) => (a.name ? `${a.name} <${a.address}>` : a.address);

function body(raw: Buffer, enc: string | undefined): Buffer {
  switch ((enc ?? '').toLowerCase()) {
    case 'base64': return Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    case 'quoted-printable': return qp(raw.toString('latin1'));
    default: return raw;
  }
}

/** Headers are ASCII; a client that sends 8-bit ones (SMTPUTF8) sends UTF-8, and an old one Latin-1. */
const hdr = (b: Buffer): string => { try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return b.toString('latin1'); } };
const split = (buf: Buffer): [string, Buffer] => {
  const a = buf.indexOf('\r\n\r\n'), b = buf.indexOf('\n\n');
  const [i, n] = a >= 0 && (b < 0 || a <= b) ? [a, 4] : b >= 0 ? [b, 2] : [-1, 0];
  if (i < 0) return buf.length && /^[\w-]+:/.test(buf.toString('latin1', 0, 100)) ? [hdr(buf.subarray(0, MAX_HEADERS)), Buffer.alloc(0)] : ['', buf];
  return [hdr(buf.subarray(0, Math.min(i, MAX_HEADERS))), buf.subarray(i + n)];
};

/** The text of a message, whatever its parts: the first text/plain and the first text/html that are not attachments. */
export function parseMime(src: Buffer, o: { bytes?: boolean } = {}): Parsed {
  const out: Parsed = { headers: [], subject: '', from: '', to: [], cc: [], attachments: [], lints: [] };
  let parts = 0;
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const walk = (buf: Buffer, depth: number, top: boolean) => {
    if (++parts > MAX_PARTS || depth > MAX_DEPTH) { out.partial = true; return; }
    const [h, rest] = split(buf);
    const hs = head(h);
    if (top) out.headers = hs;
    const get = (n: string) => hs.find(([k]) => k === n)?.[1];
    const ct = params(get('content-type') ?? 'text/plain; charset=us-ascii');
    const cd = params(get('content-disposition') ?? '');
    const enc = get('content-transfer-encoding');
    if (ct.value.startsWith('multipart/') && ct.p.boundary) {
      const b = `--${ct.p.boundary}`;
      const s = rest.toString('latin1');
      const at: number[] = [];
      for (let i = s.indexOf(b); i >= 0; i = s.indexOf(b, i + b.length)) if (i === 0 || s[i - 1] === '\n') at.push(i);
      for (let i = 0; i < at.length; i++) {
        const from = s.indexOf('\n', at[i]);
        if (from < 0 || s.slice(at[i] + b.length, at[i] + b.length + 2) === '--') break;
        const end = i + 1 < at.length ? at[i + 1] : s.length;
        walk(rest.subarray(from + 1, Math.max(from + 1, end - (s[end - 2] === '\r' ? 2 : 1))), depth + 1, false);
      }
      return;
    }
    const data = body(rest, enc);
    const name = cd.p.filename ?? ct.p.name;
    const attached = cd.value === 'attachment' || !!name || (!ct.value.startsWith('text/') && ct.value !== 'message/rfc822') || ct.value === 'text/calendar';
    if (!attached && ct.value === 'text/plain') out.text ??= text(data, ct.p.charset).replace(/\r\n/g, '\n');
    else if (!attached && ct.value === 'text/html') out.html ??= text(data, ct.p.charset);
    else out.attachments.push({ name: decodeWords(name ?? `${ct.value.replace('/', '-')}`), type: ct.value, size: data.length, sha256: sha(data), ...(cd.value === 'inline' || get('content-id') ? { inline: true } : {}), ...(get('content-id') ? { cid: get('content-id')!.replace(/^<|>$/g, '') } : {}), ...(o.bytes ? { bytes: data } : {}) });
  };
  try {
    const buf = src.length > MAX_PARSE ? src.subarray(0, 8192) : src;
    walk(buf, 0, true);
    if (src.length > MAX_PARSE) out.partial = true;
  } catch { out.partial = true; }
  const h = (n: string) => out.headers.find(([k]) => k === n)?.[1];
  out.subject = decodeWords(h('subject') ?? '');
  out.from = addresses(h('from') ?? '').map(show).join(', ');
  out.to = addresses(out.headers.filter(([k]) => k === 'to').map(([, v]) => v).join(',')).map(show);
  out.cc = addresses(out.headers.filter(([k]) => k === 'cc').map(([, v]) => v).join(',')).map(show);
  if (h('reply-to')) out.replyTo = addresses(h('reply-to')!).map(show).join(', ');
  out.date = h('date'); out.messageId = h('message-id'); out.unsubscribe = h('list-unsubscribe');
  if (!out.text && !out.html) out.lints.push('no-body');
  if (!out.messageId) out.lints.push('no-message-id');
  if (!out.date) out.lints.push('no-date');
  if (!out.text && out.html) out.lints.push('no-text-part');
  for (const k of ['from', 'to', 'subject', 'date']) if (out.headers.filter(([n]) => n === k).length > 1 && k !== 'to') out.lints.push(`repeated-${k}`);
  if (src.toString('latin1', 0, Math.min(src.length, MAX_PARSE)).split('\n').some((l) => l.length > 998)) out.lints.push('line-over-998');
  if (out.unsubscribe && !/^<[^<>]+>(\s*,\s*<[^<>]+>)*$/.test(out.unsubscribe)) out.lints.push('bad-list-unsubscribe');
  return out;
}

/** The hrefs of an HTML text with the text they show: enough for «the text says one thing and the link goes to another». */
export function htmlLinks(html: string): Array<{ url: string; text: string; tiny?: boolean }> {
  const out: Array<{ url: string; text: string }> = [];
  for (const m of html.slice(0, 524288).matchAll(/<a\b[^>]{0,2000}?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]{0,2000}>([\s\S]{0,2000}?)<\/a\s*>/gi)) {
    out.push({ url: unent(m[1] ?? m[2] ?? m[3] ?? ''), text: unent(m[4].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()) });
  }
  return out;
}
const unent = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[e]!);

/** Every remote resource an HTML asks for (images, styles, scripts, frames), with why it matters. */
export function remoteResources(html: string): Array<{ url: string; why: string }> {
  const out: Array<{ url: string; why: string }> = [];
  const h = html.slice(0, 524288);
  for (const m of h.matchAll(/<(img|script|link|iframe|embed|object|source|video|audio|input)\b([^>]{0,2000})>/gi)) {
    const u = /\b(?:src|href|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[2]);
    const url = u ? unent(u[1] ?? u[2] ?? u[3] ?? '') : '';
    if (!/^(?:https?:)?\/\//i.test(url)) continue;
    const tiny = /\b(?:width|height)\s*=\s*["']?[01]\b/i.test(m[2]) || /display\s*:\s*none/i.test(m[2]);
    out.push({ url, why: m[1].toLowerCase() === 'script' ? 'script' : m[1].toLowerCase() === 'link' ? 'style' : tiny ? 'tracking pixel' : m[1].toLowerCase() === 'img' ? 'image' : m[1].toLowerCase() });
  }
  for (const m of h.matchAll(/url\(\s*["']?((?:https?:)?\/\/[^)"']+)/gi)) out.push({ url: m[1], why: 'css url()' });
  for (const m of h.matchAll(/@import\s+(?:url\()?\s*["']?((?:https?:)?\/\/[^)"';\s]+)/gi)) out.push({ url: m[1], why: 'css @import' });
  return out;
}
