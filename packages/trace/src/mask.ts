/**
 * Masking at capture. One implementation for the tap (inside its container) and the host, so a secret is
 * replaced before it is written anywhere. The mark is `…` plus four characters of HMAC-SHA256(env key, value):
 * the same secret reads the same everywhere in an env, and without the key (kept in tap/mask.json, 0600) a mark
 * cannot be traced back, not even for a PIN. Without a key the mark is a plain SHA-256, guessable for short values.
 * Every pattern runs in linear time, because masking runs synchronously on the tap's event loop.
 * Stdlib only: the tap imports this file by relative path from a read-only mount.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export interface Masker {
  /** free text: known values (raw, base64, base64url, also inside percent, JSON and HTML escapes, however nested) and secret patterns */
  text(s: string): string;
  /**
   * a printable peek of binary bytes (latin1): known values are found in the bytes, even glued to a length byte
   * (`7<password>`), then every non-printable byte becomes `.` and the patterns run, so a non-ASCII byte inside a
   * secret (`voilà`) reads as part of it
   */
  peek(s: string): string;
  /** headers, both directions: secret-looking names are masked whole (a known auth scheme word is kept) */
  headers(h: Record<string, string | string[] | undefined>): Record<string, string>;
  /** a query string or URL: secret-looking parameter names are masked */
  query(q: string): string;
  /** a body as text: secret-looking JSON keys (and form fields for urlencoded bodies), then known values and patterns */
  body(text: string, contentType?: string): string;
  /**
   * text cut at its start or end, masked by `mask` (text by default): the `margin` decoded characters of `s` next to the
   * cut, which could hold a piece of a known value, become `…` whatever they are, so the record says nothing about what
   * was there. Counted before masking, so the rest stays visible however much masking shortens the hidden part; a mark
   * that starts in the rest and ends in the hidden part stays whole.
   */
  cut(s: string, at: 'start' | 'end', mask?: (s: string) => string): string;
  /** only the known values, no secret patterns: what the mailbox shows of a message (its codes and links stay, the vault's values do not) */
  known(s: string): string;
  /** how many characters a cut hides (the longest form's length − 1): a record keeps this many beyond its limit, so the cut removes only them */
  margin: number;
}

/** Names whose value is a secret, in headers, JSON keys, form fields and query parameters. */
export const MASK_KEYS = /pass(?:word)?|secret|token|api[-_]?key|authori[sz]ation|cookie|credential|private|session|signature/i;

/** `tap/mask.json`: the env's mark key (32 random bytes, base64url, created once and kept) and the known values. */
export interface MaskFile { key: string; values: string[] }

/** `tap/learned.json`: the codes and tokens the sink saw in messages, written by the tap (0600) and added to the vault's values by whoever masks. */
export function readLearned(path: string): string[] {
  try { const v = JSON.parse(readFileSync(path, 'utf8')); return Array.isArray(v) ? v.map(String).slice(0, 200) : []; } catch { return []; }
}

const newKey = () => randomBytes(32).toString('base64url');

/** A missing file reads as a fresh random key and no values. */
export function readMaskFile(path: string): MaskFile {
  if (!existsSync(path)) return { key: newKey(), values: [] };
  const f = JSON.parse(readFileSync(path, 'utf8')) as Partial<MaskFile>;
  if (typeof f.key !== 'string' || !f.key || !Array.isArray(f.values)) throw new Error(`${path}: expected {"key", "values"}`);
  return { key: f.key, values: f.values.map(String) };
}

/** Writes the values and keeps the file's key; 0600 from creation, renamed into place so a reader never sees half a file. */
export function writeMaskFile(path: string, values: string[]): void {
  let key: string;
  try { key = readMaskFile(path).key; } catch { key = newKey(); }
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify({ key, values }), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path);
}

const MARKED = /^…[\w-]{4}$/;
const decode = (s: string) => {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
};
const JSON_ESCAPES: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
/** The text a JSON string body stands for, by hand: never throws, so a body full of raw newlines costs no exceptions. */
const unescapeJson = (body: string) =>
  body.replace(/\\(?:u([0-9a-fA-F]{4})|([\s\S]))/g, (_, u: string | undefined, c: string) => (u ? String.fromCharCode(parseInt(u, 16)) : JSON_ESCAPES[c] ?? c));

const HEX2 = /^[0-9a-fA-F]{2}$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const ENTITY = /#[xX]([0-9a-fA-F]{1,6});|#(\d{1,7});|(amp|lt|gt|quot|apos);/y;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const hexAt = (s: string, i: number, n: number) => ((n === 2 ? HEX2 : HEX4).test(s.slice(i, i + n)) ? String.fromCharCode(parseInt(s.slice(i, i + n), 16)) : undefined);
/** The escape that `c` (a `%`, `\` or `&` read at s[i - 1], or one an escape just produced) starts at `i`: its character and the index past it. */
function escapeAt(c: string, s: string, i: number): [string, number] | undefined {
  let x;
  if (c === '&') {
    ENTITY.lastIndex = i;
    const m = ENTITY.exec(s);
    const n = m && !m[3] ? parseInt(m[1] ?? m[2], m[1] ? 16 : 10) : 0;
    return m && n <= 0x10ffff ? [m[3] ? NAMED[m[3]] : String.fromCodePoint(n), ENTITY.lastIndex] : undefined; // above U+FFFF: two UTF-16 units
  }
  if (s[i] === 'u') return (x = hexAt(s, i + 1, 4)) ? [x, i + 5] : undefined; // \uXXXX, and JS escape()'s %uXXXX
  if (c === '%') return (x = hexAt(s, i, 2)) ? [x, i + 2] : undefined;
  const e = s[i];
  return e !== undefined && '"\\/bfnrt'.includes(e) ? [JSON_ESCAPES[e] ?? e, i + 1] : undefined;
}
/**
 * The text with percent escapes (any encoder, any hex case; bytes as latin1 characters; JS `%uXXXX`), JSON escapes and
 * HTML or XML entities (`&amp;`, `&#x24;`, `&#39;`) decoded, however deeply nested (`%252A`, `\\\"`, `%5Cn`, `&amp;lt;`),
 * in one linear pass: an escape that yields `%`, `\` or `&` starts the next one. `at[j]` is where the view's character
 * j starts in `s`, so a match in the view maps back to the span it came from. Undefined when there is nothing to decode.
 */
function viewOf(s: string): { d: string; at: number[] } | undefined {
  if (!/[%\\&]/.test(s)) return;
  let d = '';
  const at: number[] = [];
  for (let i = 0; i < s.length;) {
    at.push(i);
    let c = s[i++];
    for (let e; (c === '%' || c === '\\' || c === '&') && (e = escapeAt(c, s, i));) [c, i] = e;
    if (c.length > 1) at.push(at.at(-1)!); // an entity above U+FFFF: both its units start there
    d += c;
  }
  at.push(s.length);
  return { d, at };
}

const lowerHex = (s: string) => s.replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase());
/**
 * The forms a value is looked for in, in the text and in its decoded view (where its escaped forms read raw): raw, with
 * + for spaces (form encoding, decoded), as UTF-8 bytes (percent-encoded, decoded), and base64 (padded or not) and
 * base64url. Also escaped as the common encoders write it (JSON once and twice; encodeURIComponent, with + for spaces,
 * and URLSearchParams, in either hex case), found in the text where the view reads it as something else: after
 * literal text that its first characters complete as an escape (`100%25` + `ab3F%2B…` reads `100\xab3F+…`), or a
 * value whose own view is under 6 characters (`%41%42%43`). A form that holds escapes itself (`Ab%41Cd`) reads in the view as its own
 * view does, whatever encoded it (`Ab%2541Cd` and `Ab%41Cd` both read `AbACd`), so that view is a form too.
 */
function formsOf(v: string): string[] {
  const b64 = Buffer.from(v).toString('base64');
  const json = JSON.stringify(v).slice(1, -1);
  const uris = [encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, '+'), new URLSearchParams({ '': v }).toString().slice(1)];
  return [v, v.replace(/ /g, '+'), Buffer.from(v).toString('latin1'), b64, b64.replace(/=+$/, ''), Buffer.from(v).toString('base64url'),
    json, JSON.stringify(json).slice(1, -1), ...uris, ...uris.map(lowerHex)];
}
/** A multi-line value (a PEM key) is also known line by line: each base64-looking line, so a re-wrapped or cut copy is still masked. */
const linesOf = (v: string) => v.split(/\r?\n|\\r?\\n/).map((l) => l.trim()).filter((l) => l !== v && /^[\w+/=-]{6,}$/.test(l));

const word = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const ESCAPE_END = /(?:%([0-9a-fA-F]{2})|[%\\]u([0-9a-fA-F]{4}))$/;
/** The character before `i` as the token boundary reads it: through a percent or `\u` escape that ends there (`100%25` + a value: `%`). */
const charBefore = (s: string, i: number) => {
  const m = ESCAPE_END.exec(s.slice(Math.max(0, i - 6), i));
  return m ? parseInt(m[1] ?? m[2], 16) : s.charCodeAt(i - 1);
};

// Scanning pieces for JSON keys and `key=value`. Sticky or global, used synchronously only.
const STRING = /"([^"\\]*(?:\\[\s\S][^"\\]*)*)"?/y;
const SPACE = /\s*/y;
const SCALAR = /[^,}\]\s]*/y;
const NESTING = /["{}[\]]/g;
const KEY = /(?<![\w.-])([\w.-]+)=/g;
const VALUE = /[^\s&"'\\,;<>]+/y;
const SCHEME = /^((?:Basic|Bearer|Digest|DPoP|HOBA|Mutual|Negotiate|NTLM|OAuth|SCRAM-SHA-\d+|vapid|AWS4-HMAC-SHA256|Token|Bot|ApiKey)\s+)?([\s\S]*)$/i;

/** The JSON string at `i` (which holds a quote): its escaped body and the index past it, or the end of `s` when cut. */
const stringAt = (s: string, i: number) => {
  STRING.lastIndex = i;
  const body = STRING.exec(s)![1];
  return { body, end: STRING.lastIndex };
};
/** Index past the JSON value at `i`: a string, an object or array (nesting counted, strings skipped) or a scalar; the end of `s` when cut. */
function valueEnd(s: string, i: number): number {
  if (s[i] === '"') return stringAt(s, i).end;
  if (s[i] === '{' || s[i] === '[') {
    let depth = 0;
    NESTING.lastIndex = i;
    for (let m; (m = NESTING.exec(s));) {
      if (m[0] === '"') NESTING.lastIndex = stringAt(s, m.index).end;
      else if (m[0] === '{' || m[0] === '[') depth++;
      else if (--depth === 0) return NESTING.lastIndex;
    }
    return s.length;
  }
  SCALAR.lastIndex = i;
  SCALAR.exec(s);
  return SCALAR.lastIndex;
}

export function createMasker(known: string[], key?: string, o: { short?: string[] } = {}): Masker {
  const mark = (v: string) => '…' + (key ? createHmac('sha256', key) : createHash('sha256')).update(v).digest('base64url').slice(0, 4);
  /** Empty values stay empty and marks are not marked again, so masking twice changes nothing. */
  const hide = (v: string) => (v === '' || MARKED.test(v) ? v : mark(v));

  // Every form a known value travels in maps to the mark of the value itself.
  const forms = new Map<string, string>();
  for (const v of new Set(known)) {
    if (v.length < 6) continue;
    const m = mark(v);
    for (const part of [v, ...linesOf(v)]) {
      for (const f of formsOf(part)) {
        forms.set(f, m);
        const d = viewOf(f)?.d;
        if (d && d.length >= 6) forms.set(d, m);
      }
    }
  }
  // A code of four or five characters (a PIN, an SMS code) is too short for the forms above, which would mark any word that holds it: it goes by whole word only.
  const shorts = [...new Set(o.short ?? [])].filter((v) => v.length >= 4 && v.length < 6 && /^[\w-]+$/.test(v));
  const shortRe = shorts.length ? new RegExp(`(?<![\\w-])(?:${shorts.map((v) => v.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})(?![\\w-])`, 'g') : null;
  const sorted = [...forms.keys()].sort((a, b) => b.length - a.length);
  // Forms by their first four characters (every form has six or more), longest first, with the prefix they all share
  // (a PEM's forms share their BEGIN line): one lookup per position, however many values and forms there are.
  const byHead = new Map<string, { common: string; forms: string[] }>();
  for (const f of sorted) {
    const b = byHead.get(f.slice(0, 4));
    if (!b) byHead.set(f.slice(0, 4), { common: f, forms: [f] });
    else {
      b.forms.push(f);
      let n = 0;
      while (b.common[n] === f[n] && n < b.common.length) n++;
      b.common = b.common.slice(0, n);
    }
  }
  /** The longest form's length but one: a cut hides this many characters, decoded, so no piece of any form is left at it. */
  const margin = Math.max(0, (sorted[0]?.length ?? 0) - 1);
  /** Where known forms are in `s`, as [start, end, mark]: only where they are not part of a longer [A-Za-z0-9_] token, unless `loose`. */
  const spans = (s: string, loose: boolean) => {
    const out: Array<[number, number, string]> = [];
    for (let i = 0; i + 6 <= s.length;) {
      const b = byHead.get(s.slice(i, i + 4));
      const f = b && s.startsWith(b.common, i) && b.forms.find((f) => s.startsWith(f, i)
        && (loose || ((!word(f.charCodeAt(0)) || !word(charBefore(s, i))) && (!word(f.charCodeAt(f.length - 1)) || !word(s.charCodeAt(i + f.length))))));
      if (!f) {
        i++;
        continue;
      }
      out.push([i, i + f.length, forms.get(f)!]);
      i += f.length;
    }
    return out;
  };
  /** Each span replaced by its mark; `at` maps a decoded view's indices back to `s`. */
  const replace = (s: string, list: Array<[number, number, string]>, at?: number[]) => {
    let out = '';
    let last = 0;
    for (const [a, b, m] of list) {
      out += s.slice(last, at ? at[a] : a) + m;
      last = at ? at[b] : b;
    }
    return out + s.slice(last);
  };
  /** Known values in the text as it is, then in its decoded view, where the boundary is what the escape stood for (`%3D` is `=`). */
  const knownValues = (s: string, loose: boolean) => {
    const once = replace(s, spans(s, loose));
    const view = viewOf(once);
    return view ? replace(once, spans(view.d, loose), view.at) : once;
  };

  // Order matters: a PEM block or a JWT is marked whole before the Bearer rule sees what is left. Linear time: where a
  // pattern could start inside a run of its own characters, a lookbehind lets it start only where the run does.
  const patterns: Array<[RegExp, (...g: string[]) => string]> = [
    // A PEM block, also JSON-escaped (once or twice), and cut before its END line by the tee or a peek.
    [/-----BEGIN ([A-Z0-9 ]{1,64})-----((?:[\w+/=\s:,.…]|-(?!----)|\\+[nrt])*)(-----END \1-----)?/g,
      (m, label, body, end = '') => (MARKED.test(body) ? m : `-----BEGIN ${label}-----${mark(m)}${end}`)],
    [/(?<![\w-])eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g, (m) => mark(m)],
    [/\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}/g, (m) => mark(m)],
    [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):([^\s@/]+)@/gi, (_, head, pass) => `${head}:${hide(decode(pass))}@`],
    [/\b(Bearer|Basic)( +)([\w.~+/=-]+)/gi, (_, scheme, sp, token) => `${scheme}${sp}${hide(token)}`],
  ];
  /** `key=value` under a secret-looking key, in logs or in URLs inside bodies; covers AWS4 `Credential=` and `Signature=`. */
  const keyValues = (s: string) => {
    let out = '';
    let last = 0;
    KEY.lastIndex = 0;
    for (let k; (k = KEY.exec(s));) {
      if (!MASK_KEYS.test(k[1])) continue;
      VALUE.lastIndex = KEY.lastIndex;
      const v = VALUE.exec(s)?.[0];
      if (!v) continue;
      out += s.slice(last, KEY.lastIndex) + hide(decode(v));
      last = KEY.lastIndex = VALUE.lastIndex;
    }
    return out + s.slice(last);
  };
  /** Secret-looking JSON keys mask their whole value (an array or object too, or what is left of it when cut); escaped JSON inside a string is read one level down. */
  const jsonKeys = (s: string): string => {
    let out = '';
    let last = 0;
    for (let i = s.indexOf('"'); i >= 0; i = s.indexOf('"', i)) {
      const str = stringAt(s, i);
      SPACE.lastIndex = str.end;
      SPACE.exec(s);
      if (s[SPACE.lastIndex] !== ':') {
        if (str.body.includes('\\"')) {
          const inner = unescapeJson(str.body);
          const masked = jsonKeys(inner);
          if (masked !== inner) {
            out += s.slice(last, i + 1) + JSON.stringify(masked).slice(1, -1);
            last = i + 1 + str.body.length;
          }
        }
        i = str.end;
        continue;
      }
      SPACE.lastIndex++;
      SPACE.exec(s);
      const v = SPACE.lastIndex;
      if (!MASK_KEYS.test(unescapeJson(str.body))) {
        i = v; // keys inside the value are read too
        continue;
      }
      const end = valueEnd(s, v);
      const raw = s.slice(v, end);
      if (!/^(?:null|true|false)?$/.test(raw)) {
        out += s.slice(last, v) + `"${hide(raw[0] === '"' ? unescapeJson(stringAt(s, v).body) : raw)}"`;
        last = end;
      }
      i = Math.max(end, v + 1);
    }
    return out + s.slice(last);
  };
  const formKeys = (s: string) =>
    s.replace(/(^|&)([^=&#]*)=([^&#]*)/g, (m, sep: string, k: string, v: string) => (MASK_KEYS.test(decode(k)) ? `${sep}${k}=${hide(decode(v))}` : m));

  /** A peek is searched for known values in its bytes, then made printable for the patterns. */
  const known_ = (s: string, loose = false) => {
    const out = forms.size ? knownValues(s, loose) : s;
    return shortRe ? out.replace(shortRe, (m) => mark(m)) : out;
  };
  const text = (s: string, peek = false) => {
    let out = known_(s, peek);
    if (peek) out = out.replace(/[^\x20-\x7e…]/g, '.');
    for (const [re, fn] of patterns) out = out.replace(re, fn);
    return keyValues(out);
  };
  /** Where the mark that covers `all[j]` starts, or -1. */
  const markAt = (all: string, j: number) => {
    for (let q = j; q >= Math.max(0, j - 4); q--) if (MARKED.test(all.slice(q, q + 5))) return q;
    return -1;
  };

  return {
    text: (s) => text(s),
    known: (s) => known_(s),
    peek: (s) => text(s, true),
    headers(h) {
      const out: Record<string, string> = {};
      for (const [k, raw] of Object.entries(h)) {
        if (raw === undefined) continue;
        const v = Array.isArray(raw) ? raw.join(', ') : String(raw);
        out[k] = !MASK_KEYS.test(k) ? text(v)
          : /^(proxy-)?authorization$/i.test(k) ? v.replace(SCHEME, (_, scheme = '', rest: string) => scheme + hide(rest))
          : hide(v);
      }
      return out;
    },
    query(q) {
      // A bare query string (what the tap passes) may hold a '?' inside a value; only a path or URL before it splits.
      const at = q.indexOf('?');
      const [head, qs] = at >= 0 && !/[=&]/.test(q.slice(0, at)) ? [q.slice(0, at + 1), q.slice(at + 1)] : q.includes('=') ? ['', q] : [q, ''];
      return text(head + formKeys(qs));
    },
    body(s, contentType = '') {
      return text(jsonKeys(/x-www-form-urlencoded/i.test(contentType) ? formKeys(s) : s));
    },
    cut(s, at, mask = text) {
      const all = mask(s);
      if (!margin) return all;
      // Never a prefix oracle: what is hidden does not depend on what is there. Counted in s's decoded characters, so a
      // percent-encoded piece (three or more characters each) goes whole too.
      const view = viewOf(s);
      const len = view ? view.d.length : s.length;
      const n = Math.min(margin, len);
      const k = at === 'end' ? len - n : n;
      const i = view ? view.at[k] : k;
      // What stays, masked alone, reads as the whole masked text does up to where the hidden part changed the masking:
      // a value that starts in it and ends in the hidden part, which only the whole text masks.
      const part = mask(at === 'end' ? s.slice(0, i) : s.slice(i));
      let c = 0;
      if (at === 'end') {
        while (c < part.length && all[c] === part[c]) c++;
        const q = c < part.length ? markAt(all, c) : -1;
        return `${all.slice(0, q < 0 ? c : q + 5)}…`;
      }
      while (c < part.length && all[all.length - 1 - c] === part[part.length - 1 - c]) c++;
      const q = c < part.length ? markAt(all, all.length - 1 - c) : -1;
      return `…${all.slice(q < 0 ? all.length - c : q)}`;
    },
    margin,
  };
}
