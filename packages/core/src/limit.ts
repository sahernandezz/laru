/** A flow's time limit, as flow.md writes it: `30s`, `2m`, `1h`, `1500ms`. Between 1 second and 2 hours; nothing else. */
const UNIT: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
export const LIMIT_MIN = 1000;
export const LIMIT_MAX = 2 * 3_600_000;

/** The limit in milliseconds, or null when the text is not a duration in range. */
export function parseLimit(v: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(String(v ?? '').trim().toLowerCase());
  if (!m) return null;
  const ms = Math.round(Number(m[1]) * UNIT[m[2]]);
  return ms >= LIMIT_MIN && ms <= LIMIT_MAX ? ms : null;
}
