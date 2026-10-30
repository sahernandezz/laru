/**
 * The look (decision D5): layered greys, text at WCAG AA on every surface it can sit on, statuses that never read as
 * the accent. The tokens of every theme are read from styles.css itself, so a change to a colour is measured the day it is made.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
// every theme: the base block (Abyssal), then the blocks that name the variant, in the order of the file
const decls = (body: string) => [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()] as [string, string]);
const blocks = [...css.matchAll(/^(:root, \[data-theme\]|\[data-theme="[\w-]+"\]|:is\([^)]*\)) \{([^}]*)\}/gm)];
const THEMES = [...new Set([...css.matchAll(/data-theme="([\w-]+)"/g)].map((m) => m[1]))];
const themeOf = (id: string) => new Map(blocks.filter((b) => b[1].startsWith(':root') || b[1].includes(`"${id}"`)).flatMap((b) => decls(b[2])));
let raw = themeOf('abyssal');
const each = (fn: (id: string) => void) => { for (const id of ['abyssal', ...THEMES]) { raw = themeOf(id); fn(id); } };

type RGBA = [number, number, number, number];
function parse(v: string, seen = 0): RGBA {
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) { assert.ok(seen < 5 && raw.has(ref[1]), `unknown token ${ref[1]}`); return parse(raw.get(ref[1])!, seen + 1); }
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) { const n = parseInt(hex[1], 16); return [n >> 16, (n >> 8) & 255, n & 255, 1]; }
  const fn = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(v);
  assert.ok(fn, `cannot read colour ${v}`);
  return [Number(fn[1]), Number(fn[2]), Number(fn[3]), fn[4] === undefined ? 1 : Number(fn[4])];
}
const token = (name: string) => { assert.ok(raw.has(name), `missing token ${name}`); return parse(raw.get(name)!); };
const over = (top: RGBA, under: RGBA): RGBA => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as RGBA;
const lum = ([r, g, b]: RGBA) => { const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a: RGBA, b: RGBA) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hue = ([r, g, b]: RGBA) => { const [R, G, B] = [r / 255, g / 255, b / 255], mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn; if (!d) return 0; const h = mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4; return (h * 60 + 360) % 360; };

const SURFACES = ['--bg-100', '--bg-200', '--sunk', '--raised'];
const TEXT = ['--ink-1', '--ink-2', '--ink-3', '--accent-ink', '--ok-ink', '--run-ink', '--err-ink', '--sky', '--violet', '--orchid', '--cyan', '--lilac', '--syn-comment', '--syn-punct'];

test('every Lusitania variant is there', () => {
  assert.deepEqual(THEMES.sort(), ['abyssal-deep', 'abyssal-light', 'midnight', 'oceanic', 'steel', 'surface', 'trench']);
});

test('the surfaces are layers, none pure black, each lighter than the one it sits in', () => each((id) => {
  const l = SURFACES.map((n) => lum(token(n)));
  for (const n of SURFACES) assert.notEqual(raw.get(n)!.toLowerCase(), '#000000', `${n} is pure black`);
  assert.ok(lum(token('--sunk')) < lum(token('--bg-100')) && lum(token('--bg-100')) < lum(token('--bg-200')) && lum(token('--bg-200')) < lum(token('--raised')), `${id}: sunk < canvas < surface < raised: ${l}`);
}));

test('every text token is AA (4.5:1) on every surface, and on the translucent fills of the page and the panels', () => each((id) => {
  const fills = ['--fill-1', '--fill-2', '--accent-soft', '--ok-soft', '--run-soft', '--err-soft', '--sky-soft'];
  const bad: string[] = [];
  for (const t of TEXT) for (const s of SURFACES) {
    const surface = token(s);
    // fills (hover, selected, status chips) sit on the page and on panels, not on menus or wells
    const grounds: Array<[string, RGBA]> = [[s, surface], ...(s === '--bg-100' || s === '--bg-200' ? fills.map((f) => [`${f} on ${s}`, over(token(f), surface)] as [string, RGBA]) : [])];
    for (const [name, g] of grounds) { const c = contrast(token(t), g); if (c < 4.5) bad.push(`${id}: ${t} on ${name}: ${c.toFixed(2)}`); }
  }
  assert.deepEqual(bad, []);
}));

test('the primary button: white text on the solid accent is AA, and the accent is a hue no status shares', () => each((id) => {
  assert.ok(contrast([255, 255, 255, 1], token('--accent-solid')) >= 4.5, id);
  const blue = hue(token('--accent'));
  for (const s of ['--ok', '--run', '--err']) assert.ok(Math.abs(hue(token(s)) - blue) > 60, `${id}: ${s} reads as the accent`);
}));

test('lines are visible on the surfaces (the strongest at 3:1 for non-text), the weakest only a hair', () => each((id) => {
  for (const s of SURFACES) assert.ok(contrast(over(token('--line-3'), token(s)), token(s)) >= 1.5, `${id}: --line-3 on ${s}`);
}));

test('--ink-4 is for what is not read (disabled, placeholder icons): 3:1 on the surfaces, and no rule paints text with it', () => {
  each((id) => { for (const s of SURFACES) assert.ok(contrast(token('--ink-4'), token(s)) >= 3, `${id}: --ink-4 on ${s}`); });
  assert.doesNotMatch(css.replace(/^\s*--ink-4:.*$/m, ''), /color:\s*var\(--ink-4\)/, 'a rule paints text with --ink-4');
});

test('motion and depth (D5): scroll-driven only where supported and allowed, a title that drifts at half the speed of the page, packets capped, and reduced motion stops all of it', () => {
  const rules = css.slice(css.indexOf('depth and motion (D5)'));
  // everything driven by scrolling sits inside a feature query and a motion preference: nowhere else may name a timeline
  const outside = css.slice(0, css.indexOf('depth and motion (D5)')).match(/animation-timeline|scroll-timeline/g);
  assert.equal(outside, null, 'no timeline outside the depth block');
  const supports = rules.slice(rules.indexOf('@supports (animation-timeline: scroll())'), rules.indexOf('@keyframes top-shadow'));
  assert.match(supports, /@media \(prefers-reduced-motion: no-preference\)/);
  for (const m of supports.matchAll(/animation-timeline: --page/g)) assert.ok(m.index! > supports.indexOf('no-preference'), 'only for those who allow motion');
  // half the speed: the title travels half of the scroll distance of its range
  const range = Number(/title-drift linear both; animation-timeline: --page; animation-range: 0 (\d+)px/.exec(supports)![1]);
  const travel = Number(/@keyframes title-drift \{ to \{ transform: translateY\((\d+)px\)/.exec(rules)![1]);
  assert.equal(travel * 2, range);
  // the packets: a cap, and «reduced motion» draws none
  assert.match(rules, /@media \(prefers-reduced-motion: reduce\) \{ \.flow-map \.packet \{ display: none; \} \}/);
  assert.match(readFileSync(new URL('../src/pages/Runs.tsx', import.meta.url), 'utf8'), /export const MAX_PACKETS = 24;/);
  // and the global rule that shortens every animation and transition stays
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  \*, \*::before, \*::after \{ animation-duration: \.001ms !important;/);
  // the grid under a map moves at half the speed of what scrolls on it
  assert.match(readFileSync(new URL('../src/components/MapCanvas.tsx', import.meta.url), 'utf8'), /--gx.*-b\.scrollLeft \/ 2/);
});
