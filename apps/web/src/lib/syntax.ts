/**
 * Colours and formatting for the code and data the screens show: JSON, SQL, HTTP heads, log lines and the cURL
 * command. Every scanner walks forward once and every lookahead is bounded or read again right after, so a 64 KB body,
 * deep nesting or an unbalanced quote costs one pass; the only regex over the whole text is the masker's mark, which
 * has a fixed length. Tokens concatenate back to the text they came from. Formatting only adds or replaces whitespace
 * between tokens, never inside a quoted string or name, a comment or a mark: what a value says, and what a mask hides,
 * never changes.
 */

export type Lang = 'json' | 'sql' | 'http' | 'log' | 'sh' | 'text';
export type TokenType = 'key' | 'str' | 'num' | 'kw' | 'param' | 'comment' | 'punct' | 'mask' | 'method' | 'status' | 'level';
/** `t` absent is plain text; `x` is the method, the status class or the level. */
export interface Token { v: string; t?: TokenType | 'ws'; x?: string }

/** Past this many characters a text is shown plain, with its marks still marked: the evidence keeps 64 KB of a body plus its cut's margin. */
export const CAP = 72 * 1024;
/** Formatted lines are filled up to this many columns. */
const WIDTH = 80;

export const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
/** 2xx, 3xx, 4xx or 5xx; undefined for anything else. */
export const statusClass = (n?: number) => (n !== undefined && n >= 100 && n < 600 ? `${Math.floor(n / 100)}xx` : undefined);

const isWs = (c: number) => c === 32 || c === 10 || c === 9 || c === 13;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isWord = (c: number) => isAlpha(c) || isDigit(c) || c === 36;
/** the end of the run of characters from `i` that `ok` accepts */
const run = (s: string, i: number, ok: (c: number) => boolean, end = s.length) => { while (i < end && ok(s.charCodeAt(i))) i++; return i; };
const eol = (s: string, i: number) => { const e = s.indexOf('\n', i); return e < 0 ? s.length : e; };
/** the masker's mark: … and four characters of an HMAC, base64url */
const MARK = /…[\w-]{4}/y;

// ---------- JSON ----------

function json(s: string): Token[] {
  const out: Token[] = [];
  const n = s.length;
  for (let i = 0; i < n;) {
    const c = s.charCodeAt(i);
    let j = i + 1;
    if (isWs(c)) { j = run(s, j, isWs); out.push({ v: s.slice(i, j), t: 'ws' }); }
    else if (c === 34) {
      // A string ends at its quote or, unbalanced, at the end of the line: JSON strings hold no raw line break.
      while (j < n) { const d = s.charCodeAt(j); if (d === 92) j += 2; else if (d === 10) break; else { j++; if (d === 34) break; } }
      j = Math.min(j, n);
      out.push({ v: s.slice(i, j), t: s.charCodeAt(run(s, j, isWs)) === 58 ? 'key' : 'str' });
    } else if (c === 123 || c === 125 || c === 91 || c === 93 || c === 44 || c === 58) out.push({ v: s[i], t: 'punct' });
    else if (c === 45 || isDigit(c)) { j = run(s, j, (d) => isDigit(d) || d === 46 || d === 101 || d === 69 || d === 43 || d === 45); out.push({ v: s.slice(i, j), t: 'num' }); }
    else if (isAlpha(c)) { j = run(s, j, isAlpha); const w = s.slice(i, j); out.push({ v: w, t: w === 'true' || w === 'false' || w === 'null' ? 'kw' : undefined }); }
    else { j = run(s, j, (d) => !isWs(d) && d !== 34 && d !== 123 && d !== 125 && d !== 91 && d !== 93 && d !== 44 && d !== 58 && d !== 45 && !isDigit(d) && !isAlpha(d)); out.push({ v: s.slice(i, j) }); }
    i = j;
  }
  return out;
}

/** Two spaces a level. Only text that parses as JSON, nested at most 32 deep (deeper, the indentation would outgrow the body). */
function formatJson(s: string, toks: Token[]): Token[] {
  let d = 0, max = 0;
  for (const x of toks) if (x.t === 'punct') { if (x.v === '{' || x.v === '[') max = Math.max(max, ++d); else if (x.v === '}' || x.v === ']') d--; }
  if (max > 32) return toks;
  try { JSON.parse(s); } catch { return toks; }
  const sig = toks.filter((x) => x.t !== 'ws');
  const out: Token[] = [];
  let depth = 0;
  const nl = () => `\n${'  '.repeat(depth)}`;
  for (let i = 0; i < sig.length; i++) {
    const x = sig[i];
    if (x.t === 'punct') {
      if (x.v === '{' || x.v === '[') {
        const y = sig[i + 1];
        if (y?.t === 'punct' && (y.v === '}' || y.v === ']')) { out.push({ ...x, v: x.v + y.v }); i++; continue; }
        depth++;
        out.push({ ...x, v: x.v + nl() });
        continue;
      }
      if (x.v === '}' || x.v === ']') { depth--; out.push({ v: nl(), t: 'ws' }, x); continue; }
      if (x.v === ',') { out.push({ ...x, v: `,${nl()}` }); continue; }
      if (x.v === ':') { out.push({ ...x, v: ': ' }); continue; }
    }
    out.push(x);
  }
  return out;
}

// ---------- SQL ----------

const SQL_KW = new Set(('select from where and or not null is in exists between like ilike as on join left right inner outer full cross natural using '
  + 'group by order having limit offset fetch first next rows only insert into values update set delete returning conflict do nothing '
  + 'union all intersect except distinct case when then else end asc desc nulls last with recursive create table alter drop index '
  + 'primary foreign references default true false begin commit rollback for share nowait skip locked cast over partition window '
  + 'filter lateral lock merge matched truncate view sequence if replace add column constraint unique check').split(' '));

/** where the $tag$ (or $$) that opens at `i` ends, 0 when none does */
const dollarTag = (s: string, i: number) => { const k = run(s, i + 1, (d) => isAlpha(d) || isDigit(d)); return s.charCodeAt(k) === 36 ? k + 1 : 0; };

function sql(s: string): Token[] {
  const out: Token[] = [];
  const n = s.length;
  for (let i = 0; i < n;) {
    const c = s.charCodeAt(i);
    let j = i + 1, k = 0;
    if (isWs(c)) { j = run(s, j, isWs); out.push({ v: s.slice(i, j), t: 'ws' }); }
    else if (c === 45 && s.charCodeAt(j) === 45) {
      // `-- $1 = '…', $2 = …`, the statement's parameters as the database logged them: the rest of the line is SQL.
      const k = run(s, j + 1, (d) => d === 32);
      j = s.charCodeAt(k) === 36 && isDigit(s.charCodeAt(k + 1)) ? k : eol(s, i);
      out.push({ v: s.slice(i, j), t: 'comment' });
    } else if (c === 47 && s.charCodeAt(j) === 42) { const e = s.indexOf('*/', j + 1); j = e < 0 ? n : e + 2; out.push({ v: s.slice(i, j), t: 'comment' }); }
    else if (c === 39 || c === 34 || c === 96 || c === 91) {
      // 'string', "name", `name` (MySQL), [name] (SQL Server): a doubled closer is one inside; unbalanced, it runs to the
      // end. E'it\'s' (Postgres): a backslash also escapes the character after it.
      const q = c === 91 ? ']' : s[i];
      const esc = c === 39 && (s[i - 1] === 'E' || s[i - 1] === 'e') && !isWord(s.charCodeAt(i - 2));
      for (; j < n; j++) { if (esc && s[j] === '\\') j++; else if (s[j] === q) { if (s[j + 1] !== q) break; j++; } }
      j = Math.min(j + 1, n);
      out.push({ v: s.slice(i, j), t: c === 39 ? 'str' : undefined });
    } else if (c === 36 && isDigit(s.charCodeAt(j))) { j = run(s, j, isDigit); out.push({ v: s.slice(i, j), t: 'param' }); }
    else if (c === 36 && (k = dollarTag(s, i))) {
      // $$…$$ and $tag$…$tag$, Postgres's dollar-quoted strings: whole up to the same tag; unbalanced, to the end
      const e = s.indexOf(s.slice(i, k), k);
      j = e < 0 ? n : e + k - i;
      out.push({ v: s.slice(i, j), t: 'str' });
    } else if (c === 63) out.push({ v: '?', t: 'param' });
    else if (isDigit(c)) { j = run(s, j, (d) => isDigit(d) || d === 46); out.push({ v: s.slice(i, j), t: 'num' }); }
    else if (isAlpha(c)) {
      j = run(s, j, isWord);
      const w = s.slice(i, j);
      // a qualified name (schema.table, alias.column) is a name, even when it is spelled like a keyword
      const kw = SQL_KW.has(w.toLowerCase()) && s.charCodeAt(i - 1) !== 46 && s.charCodeAt(j) !== 46;
      out.push({ v: w, t: kw ? 'kw' : undefined });
    } else if ('(),;.=<>!+-*/%|&^~:'.includes(s[i])) out.push({ v: s[i], t: 'punct' });
    else {
      // a mask mark is one token: its four characters can hold `--`, which opens no comment there, or spell a keyword
      MARK.lastIndex = i;
      j = c === 8230 && MARK.test(s) ? MARK.lastIndex : run(s, j, (d) => d !== 8230 && !isWs(d) && !isWord(d) && !'(),;.=<>!+-*/%|&^~:\'"`?['.includes(String.fromCharCode(d)));
      out.push({ v: s.slice(i, j) });
    }
    i = j;
  }
  return out;
}

const CLAUSES = new Set(['select', 'from', 'where', 'group', 'order', 'having', 'limit', 'offset', 'fetch', 'insert', 'values', 'update', 'set', 'delete', 'returning', 'union', 'intersect', 'except', 'window']);
const JOIN_LEAD = new Set(['left', 'right', 'inner', 'full', 'cross', 'natural']);
const STOPS = new Set([...CLAUSES, ...JOIN_LEAD, 'join', 'on']);
/** the `-- ` the scanner cuts before `$1 = …`, the parameters the database logged; any other line comment runs to its line end */
const isParams = (t: Token[], i: number) => t[i].t === 'comment' && t[i].v.startsWith('--') && t[i + 1]?.t === 'param';

/**
 * The statement broken before its clauses, AND and OR, JOIN and ON (at the top level: a subquery stays on its line);
 * a list that does not fit (columns, SET, VALUES rows) goes under its keyword, indented and filled to WIDTH. The
 * parameters the database logged after it stay on their comment line as they came, so a selection still copies them
 * commented out. Whitespace in, whitespace out: nothing else changes.
 */
function formatSql(toks: Token[]): Token[] {
  let p = toks.length;
  for (let i = toks.length - 1; i >= 0; i--) if (isParams(toks, i)) { p = i; break; }
  const out = statement(toks.slice(0, p));
  if (p === toks.length) return out;
  while (out.at(-1)?.t === 'ws') out.pop();
  if (out.length) out.push({ v: '\n', t: 'ws' });
  return out.concat(toks.slice(p));
}

function statement(t: Token[]): Token[] {
  const n = t.length;
  const sig = (x: Token) => x.t !== 'ws' && x.t !== 'comment';
  const next = new Int32Array(n);
  for (let i = n - 1, after = n; i >= 0; i--) { next[i] = after; if (sig(t[i])) after = i; }
  const word = (i: number) => (t[i]?.t === 'kw' ? t[i].v.toLowerCase() : '');

  const out: Token[] = [];
  let col = 0;
  const emit = (x: Token) => { out.push(x); const nl = x.v.lastIndexOf('\n'); col = nl < 0 ? col + x.v.length : x.v.length - nl - 1; };
  const brk = (indent: number) => {
    while (out.at(-1)?.t === 'ws') out.pop();
    if (out.length) emit({ v: `\n${' '.repeat(indent)}`, t: 'ws' });
  };
  /** How long what starts at `i` is, up to the end of its list item (or its whole list) at its own depth; it stops counting past WIDTH. */
  const span = (i: number, item: boolean) => {
    let len = 0;
    for (let j = i, d = 0; j < n && len <= WIDTH; j++) {
      const x = t[j];
      if (x.t === 'punct') {
        if (x.v === '(') d++;
        else if (x.v === ')') { if (!d--) break; }
        else if (!d && ((item && x.v === ',') || x.v === ';')) break;
      } else if (!d && x.t === 'kw' && STOPS.has(x.v.toLowerCase())) break;
      len += x.t === 'ws' ? 1 : x.v.length;
    }
    return len;
  };

  let depth = 0, first = true, prev = '', clause = '', between = false, semi = false, cols = false;
  /** the depth whose commas fill lines, -1 for none; `paren`: its closing parenthesis goes on a line of its own */
  let list = -1, paren = false;
  const open = (at: number, indent: number) => { list = at; brk(indent); };
  for (let i = 0; i < n; i++) {
    const x = t[i];
    if (x.t === 'ws') {
      // one space between tokens; what comes before the first token stays as it came. A line break stays after a line
      // comment, and between two strings: Postgres joins 'a'\n'b' into one constant only across a line break.
      if (!out.length) emit(x);
      else if (out.at(-1)!.t !== 'ws') emit({ v: out.at(-1)!.v.startsWith('--') || (out.at(-1)!.t === 'str' && t[i + 1]?.t === 'str' && x.v.includes('\n')) ? '\n' : ' ', t: 'ws' });
      continue;
    }
    if (x.t === 'comment') { emit(x); continue; }
    if (semi) { brk(0); semi = false; }
    const w = word(i);
    if (x.t === 'punct') {
      if (x.v === '(') {
        emit(x);
        depth++;
        // INSERT INTO t (a, b, …): the column list
        if (cols && depth === 1) { cols = false; if (col + span(next[i], false) > WIDTH) { open(1, 2); paren = true; } }
      } else if (x.v === ')') {
        if (paren && depth === list) { brk(0); list = -1; paren = false; }
        depth = Math.max(0, depth - 1);
        emit(x);
      } else if (x.v === ',' && depth === list) {
        emit(x);
        const j = next[i];
        if (j < n) { if (col + 1 + span(j, true) > WIDTH) brk(2); else emit({ v: ' ', t: 'ws' }); }
      } else {
        emit(x);
        if (x.v === ';' && !depth) { semi = true; first = true; list = -1; paren = false; }
      }
      prev = x.v;
      continue;
    }
    if (!depth && w && !first) {
      let b = -1;
      if (CLAUSES.has(w)) b = (w === 'from' && prev === 'delete') || (w === 'update' && (prev === 'do' || prev === 'for')) ? -1 : 0;
      else if (w === 'on') b = word(next[i]) === 'conflict' ? 0 : 2;
      else if (w === 'join') b = JOIN_LEAD.has(prev) || prev === 'outer' ? -1 : 0;
      else if (JOIN_LEAD.has(w)) b = word(next[i]) === 'join' || word(next[i]) === 'outer' ? 0 : -1;
      else if (w === 'and' || w === 'or') { if (w === 'and' && between) between = false; else b = 2; }
      if (b >= 0) { brk(b); list = -1; paren = false; }
    }
    if (!depth && w === 'between') between = true;
    if (!depth && CLAUSES.has(w)) { clause = w; cols = w === 'insert'; }
    emit(x);
    first = false;
    prev = w || x.v;
    // SELECT [DISTINCT] a, b, …, SET a = 1, …, VALUES (…), (…): a list that does not fit goes under its keyword
    if (!depth && (clause === 'select' || clause === 'set' || clause === 'values') && (w === clause || w === 'distinct' || w === 'all')) {
      const nw = word(next[i]);
      if (nw !== 'distinct' && nw !== 'all' && next[i] < n && col + 1 + span(next[i], false) > WIDTH) open(0, 2);
    }
  }
  return out;
}

// ---------- HTTP ----------

/** a=1&b=2: names and values */
function pairs(out: Token[], q: string) {
  for (let i = 0; i <= q.length;) {
    let e = q.indexOf('&', i);
    if (e < 0) e = q.length;
    const part = q.slice(i, e), eq = part.indexOf('=');
    if (part && eq < 0) out.push({ v: part, t: 'key' });
    else if (part) out.push({ v: part.slice(0, eq), t: 'key' }, { v: '=', t: 'punct' }, { v: part.slice(eq + 1), t: 'str' });
    if (e < q.length) out.push({ v: '&', t: 'punct' });
    i = e + 1;
  }
}

/** A request line (METHOD path?query), a status line (HTTP/1.1 200 OK) and `name: value` headers. */
function http(s: string): Token[] {
  const out: Token[] = [];
  for (let i = 0, line = 0; i < s.length; line++) {
    const e = eol(s, i);
    const l = s.slice(i, e);
    const sp = l.indexOf(' ');
    if (!line && sp > 0 && METHODS.has(l.slice(0, sp))) {
      out.push({ v: l.slice(0, sp), t: 'method', x: l.slice(0, sp).toLowerCase() }, { v: ' ', t: 'ws' });
      const q = l.indexOf('?', sp);
      out.push({ v: l.slice(sp + 1, q < 0 ? undefined : q) });
      if (q >= 0) { out.push({ v: '?', t: 'punct' }); pairs(out, l.slice(q + 1)); }
    } else if (l.startsWith('HTTP/') && sp > 0 && /^\d{3}\b/.test(l.slice(sp + 1, sp + 5))) {
      const code = l.slice(sp + 1, sp + 4);
      out.push({ v: l.slice(0, sp + 1) }, { v: code, t: 'status', x: statusClass(Number(code)) }, { v: l.slice(sp + 4) });
    } else {
      const c = l.indexOf(':');
      if (c > 0 && !l.slice(0, c).includes(' ')) out.push({ v: l.slice(0, c), t: 'key' }, { v: ':', t: 'punct' }, { v: l.slice(c + 1) });
      else out.push({ v: l });
    }
    if (e < s.length) out.push({ v: '\n', t: 'ws' });
    i = e + 1;
  }
  return out;
}

// ---------- logs ----------

const LEVELS: Record<string, string> = { ERROR: 'error', FATAL: 'error', SEVERE: 'error', PANIC: 'error', WARN: 'warn', WARNING: 'warn', INFO: 'info', NOTICE: 'info', DEBUG: 'debug', TRACE: 'debug' };
/** an ISO time at the start of a line: fixed length, so it costs nothing on any input */
const TIME = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d{1,9})?(?:Z|[+-]\d\d:?\d\d)?/y;
const isLogWord = (c: number) => isWord(c) || c === 46 || c === 45;

/**
 * Time, level, logger, [thread], HTTP methods, key= and the status after a quoted request line: the structure. A log's
 * "quoted text" is mostly prose (a message, a user agent), so it stays plain, but for the method of a request line.
 */
function log(s: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < s.length;) {
    const e = eol(s, i);
    // `bare`: up to where this line is known to hold no ], so a run of [ is read once, not once per [
    let j = i, leveled = false, quoted = false, bare = i;
    TIME.lastIndex = i;
    if (TIME.test(s)) { j = TIME.lastIndex; out.push({ v: s.slice(i, j), t: 'comment' }); }
    while (j < e) {
      const c = s.charCodeAt(j);
      let k = j + 1;
      if (c === 32 || c === 9) { k = run(s, k, (d) => d === 32 || d === 9, e); out.push({ v: s.slice(j, k), t: 'ws' }); j = k; continue; }
      const was = quoted;
      quoted = false;
      if (c === 91) {
        // [thread], [22/Oct/2026:08:41:13 +0000]: short, so its ] is looked for within 80 characters only
        const b = run(s, Math.max(k, bare), (d) => d !== 93, Math.min(e, j + 80));
        if (s.charCodeAt(b) === 93 && b < e) { k = b + 1; out.push({ v: s.slice(j, k), t: 'comment' }); } else { bare = b; out.push({ v: '[' }); }
      } else if (c === 34) {
        const q = s.indexOf('"', k);
        if (q < 0 || q > e) out.push({ v: '"' });
        else {
          // "GET /path HTTP/1.1": the method keeps its colour inside the quotes
          const sp = run(s, k, (d) => d !== 32, Math.min(q, k + 8));
          const m = s.charCodeAt(sp) === 32 ? s.slice(k, sp) : '';
          if (METHODS.has(m)) out.push({ v: '"' }, { v: m, t: 'method', x: m.toLowerCase() }, { v: s.slice(sp, q + 1) });
          else out.push({ v: s.slice(j, q + 1) });
          k = q + 1;
          quoted = true;
        }
      } else if (isLogWord(c)) {
        k = run(s, k, isLogWord, e);
        const w = s.slice(j, k);
        let lv: string | undefined;
        if (!leveled && j - i <= 64 && (lv = LEVELS[w])) { leveled = true; out.push({ v: w, t: 'level', x: lv }); }
        else if (METHODS.has(w)) out.push({ v: w, t: 'method', x: w.toLowerCase() });
        else if (was && w.length === 3 && /^[1-5]\d\d$/.test(w)) out.push({ v: w, t: 'status', x: `${w[0]}xx` });
        else if (s.charCodeAt(k) === 61 && isAlpha(c)) out.push({ v: w, t: 'key' });
        else {
          // a logger (c.v.gateway.controller.ProxyController   : message)
          const colon = run(s, k, (d) => d === 32, e);
          const logger = isAlpha(c) && s.charCodeAt(colon) === 58 && w.split('.').length > 2;
          out.push({ v: w, t: logger ? 'key' : undefined });
        }
      } else { k = run(s, k, (d) => !isLogWord(d) && d !== 32 && d !== 9 && d !== 91 && d !== 34, e); out.push({ v: s.slice(j, k) }); }
      j = k;
    }
    if (e < s.length) out.push({ v: '\n', t: 'ws' });
    i = e + 1;
  }
  return out;
}

// ---------- shell ----------

/** A command per line (a trailing backslash continues it): the command, -flags, 'quoted' and "quoted" strings, # comments. */
function sh(s: string): Token[] {
  const out: Token[] = [];
  let cmd = true, method = false;
  const n = s.length;
  for (let i = 0; i < n;) {
    const c = s.charCodeAt(i);
    let j = i + 1;
    if (isWs(c)) { j = run(s, j, isWs); const v = s.slice(i, j); if (v.includes('\n') && out.at(-1)?.v !== '\\') cmd = true; out.push({ v, t: 'ws' }); }
    else if (c === 92) { j = s[j] === '\n' ? j : Math.min(n, j + 1); out.push({ v: s.slice(i, j), t: 'punct' }); }
    else if (c === 35 && (i === 0 || isWs(s.charCodeAt(i - 1)))) { j = eol(s, i); out.push({ v: s.slice(i, j), t: 'comment' }); }
    else if (c === 39) { const e = s.indexOf("'", j); j = e < 0 ? n : e + 1; out.push({ v: s.slice(i, j), t: 'str' }); }
    else if (c === 34) { while (j < n) { const d = s.charCodeAt(j); if (d === 92) j += 2; else { j++; if (d === 34) break; } } j = Math.min(j, n); out.push({ v: s.slice(i, j), t: 'str' }); }
    else {
      j = run(s, j, (d) => !isWs(d) && d !== 39 && d !== 34 && d !== 92);
      const w = s.slice(i, j);
      const flag = !cmd && c === 45;
      out.push(cmd ? { v: w, t: 'kw' } : flag ? { v: w, t: 'key' } : method && METHODS.has(w) ? { v: w, t: 'method', x: w.toLowerCase() } : { v: w });
      cmd = false;
      method = flag && (w === '-X' || w === '--request');
    }
    i = j;
  }
  return out;
}

// ---------- marks, and all together ----------

/**
 * The masker's marks become one `mask` token each, whatever token they fell in: cut out of a string, glued back from
 * pieces a scanner split. A mark is … and four characters of an HMAC, or a bare … where a cut text starts or ends;
 * an ellipsis anywhere else is just text. Done after formatting, on the text as shown, so the formatter sees every
 * comment and string whole: formatting changes only whitespace between tokens, no mark holds any, and the SQL scanner
 * keeps a bare mark as one token, so no break lands inside one.
 */
function marks(s: string, toks: Token[]): Token[] {
  const re = /…[\w-]{4}|^…|…$/g;
  let m = re.exec(s);
  if (!m) return toks;
  const out: Token[] = [];
  const mask = (v: string) => { const last = out.at(-1); if (last?.t === 'mask') last.v += v; else out.push({ v, t: 'mask' }); };
  let pos = 0;
  for (const x of toks) {
    const end = pos + x.v.length;
    let at = 0;
    while (m && m.index < end) {
      const a = Math.max(m.index - pos, at), b = Math.min(m.index + m[0].length - pos, x.v.length);
      if (a > at) out.push({ ...x, v: x.v.slice(at, a) });
      if (b > a) mask(x.v.slice(a, b));
      at = Math.max(at, b);
      if (m.index + m[0].length > end) break;
      m = re.exec(s);
    }
    if (at < x.v.length) out.push(at ? { ...x, v: x.v.slice(at) } : x);
    pos = end;
  }
  return out;
}

const SCAN: Record<Exclude<Lang, 'text'>, (s: string) => Token[]> = { json, sql, http, log, sh };

/** The text as tokens to colour; `format` re-indents JSON and SQL (whitespace only). Past CAP, plain text with its marks. */
export function highlight(text: string, lang: Lang, format = false): Token[] {
  const plain = lang === 'text' || text.length > CAP;
  let toks: Token[] = plain ? [{ v: text }] : SCAN[lang as keyof typeof SCAN](text);
  if (format && !plain) toks = lang === 'json' ? formatJson(text, toks) : lang === 'sql' ? formatSql(toks) : toks;
  toks = marks(toks.map((x) => x.v).join(''), toks);
  // adjacent tokens of the same kind become one span
  const out: Token[] = [];
  for (const x of toks) {
    const t = x.t === 'ws' ? undefined : x.t;
    const last = out.at(-1);
    if (last && last.t === t && last.x === x.x) last.v += x.v;
    else out.push(t === x.t ? { ...x } : { v: x.v, x: x.x });
  }
  return out;
}

/**
 * The tokens line by line, each line with its indentation in columns (the spaces and tabs it opens with, a tab running
 * to the next multiple of 8 as CSS's tab-size does), so a block can wrap a long line under its own indentation instead
 * of at the margin. A token across lines is cut at its line ends.
 */
export function toLines(toks: Token[]): Array<{ indent: number; toks: Token[] }> {
  const lines = [{ indent: 0, toks: [] as Token[] }];
  for (const t of toks) t.v.split('\n').forEach((v, k) => { if (k) lines.push({ indent: 0, toks: [] }); if (v) lines.at(-1)!.toks.push({ ...t, v }); });
  for (const l of lines) for (const c of /^[ \t]*/.exec(l.toks[0]?.v ?? '')![0]) l.indent += c === '\t' ? 8 - (l.indent % 8) : 1;
  return lines;
}

/** JSON when the type says so or the text opens like it; plain text otherwise. */
export function langOf(text: string, type = ''): Lang {
  if (/json/i.test(type)) return 'json';
  const i = run(text, 0, isWs);
  return text[i] === '{' || text[i] === '[' ? 'json' : 'text';
}
