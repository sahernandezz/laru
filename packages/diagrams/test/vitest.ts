/** The few vitest calls the engine's tests use, over node:test and node:assert, so the tests run unchanged. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

export { describe, it };

const has = (a: unknown, b: unknown) => (typeof a === 'string' ? a.includes(b as string) : (a as unknown[]).includes(b));
function matchers(a: any, neg: boolean) {
  const t = (ok: boolean, msg: string) => assert.ok(neg ? !ok : ok, `${neg ? 'not ' : ''}${msg}`);
  return {
    toBe: (b: unknown) => (neg ? assert.notStrictEqual(a, b) : assert.strictEqual(a, b)),
    toEqual: (b: unknown) => (neg ? assert.notDeepStrictEqual(a, b) : assert.deepStrictEqual(a, b)),
    toContain: (b: unknown) => t(has(a, b), `${JSON.stringify(a)?.slice(0, 200)} contains ${JSON.stringify(b)}`),
    toMatch: (re: RegExp) => t(re.test(a), `${String(a).slice(0, 200)} matches ${re}`),
    toHaveLength: (n: number) => assert.strictEqual(a.length, n),
    toBeGreaterThan: (n: number) => assert.ok(a > n, `${a} > ${n}`),
    toBeGreaterThanOrEqual: (n: number) => assert.ok(a >= n, `${a} >= ${n}`),
    toBeLessThan: (n: number) => assert.ok(a < n, `${a} < ${n}`),
    toBeLessThanOrEqual: (n: number) => assert.ok(a <= n, `${a} <= ${n}`),
    toBeTruthy: () => assert.ok(a),
    toBeUndefined: () => assert.strictEqual(a, undefined),
    toBeNull: () => assert.strictEqual(a, null),
    toBeCloseTo: (b: number, digits = 2) => assert.ok(Math.abs(a - b) < 10 ** -digits / 2, `${a} ≈ ${b}`),
    toThrow: (re?: RegExp | string) => assert.throws(a, re as RegExp),
    toMatchObject: (b: object) => assert.partialDeepStrictEqual(a, b),
  };
}
export const expect = (a: unknown, _why?: string) => ({ ...matchers(a, false), not: matchers(a, true) });
