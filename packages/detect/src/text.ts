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
