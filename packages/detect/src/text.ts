/** Small text helpers shared by the detectors. */

/** Line number (1-based) of a character offset, precomputed once per file. */
export function lineIndex(src: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Blanks out comments but keeps offsets, so line numbers stay true. Strings are left alone. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'`\\])\/\/[^\n]*/g, (m, pre?: string) => {
    const keep = pre ?? '';
    return keep + m.slice(keep.length).replace(/[^\n]/g, ' ');
  });
}

/** What the bracket at `open` encloses, strings skipped, and where it closes (unclosed: the next 400 characters). */
export function enclosed(src: string, open: number): { inner: string; end: number } {
  const o = src[open], c = o === '(' ? ')' : o === '{' ? '}' : o === '<' ? '>' : ']';
  let depth = 0, quote = '';
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === o) depth++;
    else if (ch === c && --depth === 0) return { inner: src.slice(open + 1, i), end: i };
  }
  return { inner: src.slice(open + 1, open + 400), end: src.length };
}

/** A parameter list split at its own commas, never at one inside `<>`, `()`, `{}` or a string. */
export function topLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = '', from = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('<({['.includes(ch)) depth++;
    else if ('>)}]'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { out.push(list.slice(from, i)); from = i + 1; }
  }
  return [...out, list.slice(from)].map((s) => s.trim()).filter(Boolean);
}

/** The status a name stands for, in Spring's `HttpStatus`, JAX-RS's `Status` and the exceptions both throw. */
export const STATUS_NAME: Record<string, number> = {
  OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, PARTIAL_CONTENT: 206, MOVED_PERMANENTLY: 301, FOUND: 302, SEE_OTHER: 303, NOT_MODIFIED: 304,
  TEMPORARY_REDIRECT: 307, BAD_REQUEST: 400, UNAUTHORIZED: 401, PAYMENT_REQUIRED: 402, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  NOT_ACCEPTABLE: 406, CONFLICT: 409, GONE: 410, PRECONDITION_FAILED: 412, PAYLOAD_TOO_LARGE: 413, REQUEST_ENTITY_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415, UNPROCESSABLE_ENTITY: 422, LOCKED: 423, TOO_MANY_REQUESTS: 429, INTERNAL_SERVER_ERROR: 500, NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502, SERVICE_UNAVAILABLE: 503, GATEWAY_TIMEOUT: 504,
};
/** `NotFoundException`, `BadRequestException`…: what JAX-RS and Nest answer when a handler throws one. */
export const EXCEPTION_STATUS: Record<string, number> = {
  BadRequest: 400, NotAuthorized: 401, Unauthorized: 401, Forbidden: 403, NotFound: 404, NotAllowed: 405, MethodNotAllowed: 405, NotAcceptable: 406,
  Conflict: 409, Gone: 410, PayloadTooLarge: 413, NotSupported: 415, UnsupportedMediaType: 415, UnprocessableEntity: 422, InternalServerError: 500,
  ServerError: 500, ServiceUnavailable: 503,
};

/** Every string literal ("…" or '…') inside a fragment. */
export const strings = (s: string): string[] => [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1] ?? m[2]);

/** `@X("v")` → v; `@X(name = "v")` → v when `name` is one of `names`. A literal only counts in first position. */
export function annotationValue(args: string | undefined, ...names: string[]): string | undefined {
  if (!args) return undefined;
  for (const n of names) {
    const m = args.match(new RegExp(`\\b${n}\\s*=\\s*\\{?\\s*["']([^"']*)["']`));
    if (m) return m[1];
  }
  return args.replace(/^\s*\(\s*/, '').match(/^\{?\s*["']([^"']*)["']/)?.[1];
}

/** Placeholder `{x}`, `:x` and `${x}` path parameters all become `{}` so paths can be compared. */
export const normalizePath = (p: string): string =>
  ('/' + p).replace(/\/+/g, '/').replace(/\$\{[^}]*\}|\{[^}]*\}|:[A-Za-z_]\w*/g, '{}').replace(/(.)\/$/, '$1');

/** MicroProfile / Spring relaxed binding: `stripe.webhook-secret` → `STRIPE_WEBHOOK_SECRET`. */
export const envName = (key: string): string => key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
