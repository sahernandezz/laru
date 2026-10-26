/**
 * A flow is documentation and a test at once: its Pasos are the steps of a recorded story and its Casos cortos are
 * short tests. The scaffold writes the spec once, UI first; the check keeps both sides saying the same thing (a step
 * renamed in flow.md and not in the spec is drift) and the spec inside Laru's e2e standard (`guide:flujos-e2e`):
 * the story is what a person does on screen, the API only prepares what another flow proves there.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { Row } from './knowledge/piece.ts';
import type { Loaded } from './knowledge/store.ts';
import { stateDir, type Workspace } from './workspace.ts';

export const specPath = (p: Pick<Loaded, 'id' | 'dir'>) => join(p.dir, `${p.id.replace(/^flow:/, '')}.spec.ts`);
const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const rows = (p: Pick<Loaded, 'fields'>, name: string) => (p.fields[name] ?? []) as Row[];
const one = (s: unknown) => String(s ?? '').replace(/\n/g, ' ');

/** The spec of a flow, UI first: a prepare() per Precondiciones row, a step() per Pasos row, a test() per Casos row. */
export function scaffoldSpec(p: Loaded): string {
  const steps = rows(p, 'steps'), cases = rows(p, 'cases'), pre = rows(p, 'preconditions');
  const click = `await page.getByRole('button', { name: '…' }).click();`;
  const see = `await expect(page.getByText('…')).toBeVisible();`;
  const used = ['expect', ...(pre.length ? ['prepare'] : []), 'step', 'story', ...(cases.some((c) => c.kind !== 'api') ? ['test'] : []), ...(cases.some((c) => c.kind === 'api') ? ['apiCase'] : []), 'todo'];
  const lines = [
    `// ${p.title}: the recorded story of ${p.id}, written to guide:flujos-e2e. Each step() is a row of its Pasos and acts`,
    `// on screen, each test() a row of its Casos cortos. Replace every '…' and todo(), keep the titles, run it until only`,
    `// its // app: expect.soft fail, then laru check.`,
    `import { ${used.sort().join(', ')} } from '@laru/flow';`,
    '',
    `story(${q(p.title)}, async ({ page, uniq, vars, api }) => {`,
    ...(pre.length ? ['  // Precondiciones, before the first step: through the API only when its «Probado en» names the flow that proves it on screen.'] : []),
    ...pre.map((r) => `  await prepare(${q(one(r.data))}, async () => todo());`),
    ...steps.flatMap((s) => [
      `  await step(${q(one(s.step))}, async () => {`,
      `    // ${s.actor}${s.service ? ` · ${s.service}` : ''}. Se espera: ${one(s.expected)}`,
      '    todo();',
      `    ${click}`,
      `    ${see}`,
      '  });',
    ]),
    '});',
    ...cases.flatMap((c) => c.kind === 'api'
      ? ['', `apiCase(${q(one(c.case))}, '… why no person can cause it from the screen', async ({ api }) => {`, `  // Se espera: ${one(c.expected)}`, '  todo();', '});']
      : ['', `test(${q(one(c.case))}, async ({ page }) => {`, `  // Se espera: ${one(c.expected)}`, '  todo();',
        ...(c.kind === 'validation'
          ? [`  await page.getByLabel('…').fill('…'); // empty, wrong format, past a limit, or not allowed`, `  ${click}`, `  ${see} // the message the person sees`]
          : [`  ${click}`, `  ${see}`]),
        '});']),
    '',
  ];
  return lines.join('\n');
}

/**
 * The source with comments, strings and regex literals blanked (their quotes kept) and every offset kept: what is
 * left is code, so brackets balance and a word inside a string is never taken for a call. `keepStrings` blanks only
 * the comments: a script passed to the page as a string is read there.
 * Known limit: a template's `${…}` is blanked with its text, and a template nested in one ends the outer early.
 */
export function codeOnly(src: string, keepStrings = false): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  // A slash opens a regex after an operator, an opening bracket or a keyword; after a value it divides.
  const regexHere = (code: string) => { const t = code.trimEnd(); return !t || '(,=:[!&|?{};+-*%<>~^'.includes(t.at(-1)!) || /\b(?:return|typeof|case|do|else|in|of|await|yield|void)$/.test(t); };
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i], n = src[i + 1];
    let j: number;
    if (c === '/' && n === '/') { j = src.indexOf('\n', i); if (j < 0) j = src.length; out += blank(src.slice(i, j)); i = j; continue; }
    if (c === '/' && n === '*') { j = src.indexOf('*/', i + 2); j = j < 0 ? src.length : j + 2; out += blank(src.slice(i, j)); i = j; continue; }
    if (c === '"' || c === "'" || c === '`' || (c === '/' && regexHere(out))) {
      let cls = false;
      for (j = i + 1; j < src.length; j++) {
        const d = src[j];
        if (d === '\\') { j++; continue; }
        if (d === '\n' && c !== '`') break;
        if (c === '/') { if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; continue; }
        if (d === c) break;
      }
      out += c + (keepStrings ? src.slice(i + 1, j) : blank(src.slice(i + 1, j))) + (src[j] ?? '');
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

type Range = [number, number];
interface Call { kind: string; title: string; at: number; end: number; why?: string }
/** The index of the parenthesis or brace that closes the one at `i`. */
function closing(code: string, i: number): number {
  const open = code[i], shut = open === '(' ? ')' : '}';
  for (let d = 0; i < code.length; i++) { if (code[i] === open) d++; else if (code[i] === shut && --d === 0) return i; }
  return code.length;
}
/** `name('title', …)` calls with a literal first argument (and second, as `why`), and where each one ends. */
function callsOf(src: string, code: string, name: string): Call[] {
  const lit = (from: number, quote: string) => { const to = code.indexOf(quote, from + 1); return { to, text: src.slice(from + 1, to).replace(/\\(.)/g, '$1') }; };
  const out: Call[] = [];
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*\\(\\s*(['"\`])`, 'g'))) {
    const title = lit(m.index + m[0].length - 1, m[1]);
    if (title.to < 0) continue;
    const second = code.slice(title.to + 1).match(/^\s*,\s*(['"`])/);
    out.push({ kind: name, title: title.text, at: m.index, end: closing(code, code.indexOf('(', m.index)), why: second ? lit(title.to + second[0].length, second[1]).text : undefined });
  }
  return out;
}
const inside = (c: Call, o: Call | undefined) => Boolean(o) && c.at > o!.at && c.end <= o!.end;
const span = (c: Call): Range => [c.at, c.end];
const blankOut = (code: string, ranges: Range[]) => ranges.reduce((s, [a, b]) => s.slice(0, a) + s.slice(a, b + 1).replace(/[^\n]/g, ' ') + s.slice(b + 1), code);
const positions = (code: string, re: RegExp) => [...code.matchAll(re)].map((m) => m.index);
const esc = (s: string) => s.replace(/\$/g, '\\$');
const ID = '[A-Za-z_$][\\w$]*';

/** step('…') titles inside the story() of a spec, in order. */
export function specSteps(src: string): string[] {
  const code = codeOnly(src);
  const story = callsOf(src, code, 'story')[0];
  return callsOf(src, code, 'step').filter((s) => inside(s, story)).map((s) => s.title);
}

// Web-first assertions: what the person sees, the page and its address included. A value's toBe is not one.
const VISIBLE = /\.\s*(?:toBeVisible|toBeHidden|toHaveText|toContainText|toHaveValues?|toHaveCount|toBeChecked|toBeDisabled|toBeEnabled|toBeEditable|toBeEmpty|toBeFocused|toBeInViewport|toBeAttached|toHaveAttribute|toHaveClass|toHaveCSS|toHaveId|toHaveURL|toHaveTitle|toHaveAccessible(?:Name|Description)|toHaveRole|toHaveScreenshot|toMatchAriaSnapshot)\s*\(/g;
const FORM = /\.\s*(?:fill|pressSequentially|selectOption|setInputFiles|setFiles|check|uncheck)\s*\(|\.keyboard\s*\.\s*(?:type|insertText)\s*\(/g;
const WAIT = /\.\s*waitForTimeout\s*\(|(?<![\w$.])(?:setTimeout|sleep)\s*\(/g;
// What acts underneath the screen: a service reached without it (the api fixture, fetch, a request context) or a
// session the script sets itself (an injected script, cookies, storage, headers, a context's storageState,
// extraHTTPHeaders or httpCredentials, written in full or as a shorthand).
const UNDER = /(?<![\w$.])api\s*\(|\bfetch\s*\(|\.\s*request\b(?!\s*\()|(?<![\w$.])request\s*\.\s*(?:get|post|put|patch|delete|head|newContext)\s*\(|\.\s*(?:addInitScript|addCookies|clearCookies|setExtraHTTPHeaders)\s*\(|(?<![\w$.])(?:storageState|extraHTTPHeaders|httpCredentials)\b|\b(?:localStorage|sessionStorage)\s*\.\s*(?:setItem|removeItem|clear)\s*\(|\bdocument\s*\.\s*cookie\s*=(?!=)/g;
// What fakes the screen or what is behind it: a mocked route, a synthetic event, a script injected in the page.
const FAKE = /\.\s*(?:route|routeFromHAR|routeWebSocket|dispatchEvent|addScriptTag)\s*\(/g;
const EVALUATE = /\.\s*(?:evaluate|evaluateHandle|evaluateAll|\$\$?eval)\s*\(/g;
const DOM_WRITE = /\.\s*(?:click|submit|requestSubmit|setAttribute|removeAttribute|toggleAttribute|remove|append|appendChild|prepend|insertBefore|insertAdjacent(?:HTML|Element|Text)|replaceWith|replaceChildren)\s*\(|\.\s*(?:value|checked|selected|innerHTML|outerHTML|innerText|textContent|disabled|hidden|className)\s*=(?!=)/g;
// A case taken out of the run: skipped, left as fixme, expected to fail, or the others hidden by an only.
const HIDDEN = /(?<![\w$.])test\s*(?:\.\s*describe\s*)?\.\s*(?:skip|fixme|fail|only)\b|[iI]nfo\s*(?:\(\s*\))?\s*\.\s*(?:skip|fixme|fail)\s*\(/g;
const EXPECT = /(?<![\w$.])expect\s*(?:\.\s*(?:soft|poll)\s*)?\(/g;

const within = (i: number, rs: Range[]) => rs.some(([a, b]) => i >= a && i < b);

/** Every (…) and {…} of the code, as [open, close]. */
function groups(code: string): Range[] {
  const out: Range[] = [], open: number[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '(' || code[i] === '{') open.push(i);
    else if ((code[i] === ')' || code[i] === '}') && open.length) out.push([open.pop()!, i]);
  }
  return out;
}
/** The innermost bracket pair around `p`, or the whole code. */
const scopeOf = (gs: Range[], len: number, p: number) => gs.reduce<Range>((s, g) => (g[0] < p && g[1] > p && g[0] > s[0] ? g : s), [-1, len]);

/** The index of the bracket that opens the one that closes at `i`. */
function opening(code: string, i: number): number {
  const shut = code[i], open = shut === ')' ? '(' : shut === ']' ? '[' : '{';
  for (let d = 0; i >= 0; i--) { if (code[i] === shut) d++; else if (code[i] === open && --d === 0) return i; }
  return 0;
}

/** Where the statement that starts at `i` ends: the first `;` or line break (or `,`) outside brackets, or the bracket around it. */
function statementEnd(code: string, i: number, comma = false): number {
  for (let d = 0; i < code.length; i++) {
    const c = code[i];
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) { if (--d < 0) break; }
    else if (d === 0 && (c === ';' || c === '\n' || (comma && c === ','))) break;
  }
  return i;
}

/** Where the statement around `i` starts, within the function body that starts at `open`: after the last `;`, line break or block of its own block. */
function statementStart(code: string, open: number, i: number): number {
  let start = open;
  for (let j = i - 1, d = 0; j > open; j--) {
    if (')]}'.includes(code[j])) d++;
    else if ('([{'.includes(code[j])) { if (d) d--; else if (code[j] === '{') { start = j; break; } }
  }
  let s = code[start] === '{' ? start + 1 : start;
  for (let j = s, d = 0; j < i; j++) {
    const c = code[j];
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) { if (--d === 0 && c === '}') s = j + 1; }
    else if (!d && (c === ';' || c === '\n')) s = j + 1;
  }
  return s;
}

/** The body of every function the code writes, as [start, end): arrows, function expressions and declarations, methods. */
function functionBodies(code: string): Range[] {
  const out: Range[] = [];
  for (const m of code.matchAll(/=>\s*/g)) {
    const open = m.index + m[0].length;
    out.push([open, code[open] === '{' ? closing(code, open) : statementEnd(code, open, true)]);
  }
  for (const m of code.matchAll(/\)\s*(?::[^{};=()]*)?\{/g)) {
    const o = opening(code, m.index), before = code.slice(Math.max(0, o - 80), o).trimEnd();
    // `function (…) {`, `name(…) {`: a block after the parentheses of anything but if, for, while, switch or catch.
    if (/[\w$]$/.test(before) && !/(?<![\w$.])(?:if|for|while|switch|catch)$/.test(before)) {
      const open = m.index + m[0].length - 1;
      out.push([open, closing(code, open)]);
    }
  }
  return out;
}

interface Fn { name: string; at: number; open: number; end: number; params: string[] }
/** The names of a parameter list: each parameter's own name, none of a destructured one. */
function paramNames(list: string): string[] {
  const out: string[] = [];
  for (let i = 0, d = 0, from = 0; i <= list.length; i++) {
    const c = list[i] ?? ',';
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) d--;
    else if (c === ',' && !d) {
      const n = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(list.slice(from, i))?.[1];
      if (n) out.push(n);
      from = i + 1;
    }
  }
  return out;
}
/**
 * Functions the code declares (`function f(…) {…}`, `const f = async (…) => …`, `const f = async x => …`,
 * `const f = async function (…) {…}`): the declaration runs from `at`, its body from `open`, both to `end`.
 */
function helpers(code: string): Fn[] {
  const out: Fn[] = [];
  const re = new RegExp(`\\bfunction\\s*\\*?\\s*(${ID})\\s*(?:<[^>]*>)?\\s*\\(|\\b(?:const|let|var)\\s+(${ID})\\s*(?::[^=;]*?)?=\\s*(?:async\\b\\s*)?(?:function\\b\\s*\\*?\\s*(?:${ID})?\\s*(?:<[^>]*>)?\\s*\\(|(?:<[^>]*>\\s*)?\\(|${ID}\\s*=>)`, 'g');
  for (const m of code.matchAll(re)) {
    const named = m[1] !== undefined || /\bfunction\b[^(]*\($/.test(m[0]);
    const after = m[0].endsWith('(') ? closing(code, m.index + m[0].length - 1) + 1 : m.index + m[0].length;
    const head = code.slice(after).match(/^\s*(?::[^{=;]*)?\s*(=>)?\s*/)!;
    const arrow = m[0].endsWith('=>') || Boolean(head[1]);
    if (!named && !arrow) continue;
    const open = after + head[0].length;
    const params = paramNames(m[0].endsWith('(') ? code.slice(m.index + m[0].length, after - 1) : /([\w$]+)\s*=>$/.exec(m[0])?.[1] ?? '');
    if (code[open] === '{') out.push({ name: m[1] ?? m[2], at: m.index, open, end: closing(code, open) + 1, params });
    // An expression body runs to the end of its statement.
    else if (arrow) out.push({ name: m[2], at: m.index, open, end: statementEnd(code, open), params });
  }
  return out;
}

/** What `name` holds where `at` reads it: what is assigned to it in the scope of its declaration, and a function of that name. */
function bound(code: string, name: string, at: number, gs: Range[], fns: Fn[]): Range[] {
  const decl = positions(code, new RegExp(`\\b(?:const|let|var)\\s+${esc(name)}(?![\\w$])`, 'g')).map((p) => scopeOf(gs, code.length, p)).filter(([a, b]) => at > a && at < b).sort((x, y) => y[0] - x[0])[0];
  const given = decl ? positions(code, new RegExp(`(?<![\\w$.])${esc(name)}\\s*(?::[^=;]*?)?=(?![=>])`, 'g')).filter((i) => i > decl[0] && i < decl[1]) : [];
  return [...given.map((i): Range => { const v = code.indexOf('=', i) + 1; return [v, statementEnd(code, v)]; }), ...fns.filter((f) => f.name === name).map((f): Range => [f.open, f.end])];
}

/** Where the expression read by the member access at `dot` starts: back over names, dots (`?.` too), calls and indexes. */
function chainStart(code: string, dot: number): number {
  let start = dot;
  for (let j = dot; ;) {
    if (code[j - 1] === '?') j--;
    while (j > 0 && /\s/.test(code[j - 1])) j--;
    if (code[j - 1] === ')' || code[j - 1] === ']') j = opening(code, j - 1);
    else if (/[\w$]/.test(code[j - 1] ?? '')) while (j > 0 && /[\w$]/.test(code[j - 1])) j--;
    else return start;
    start = j;
    if ('(['.includes(code[j]) && /[\w$)\]]/.test(code[j - 1] ?? '')) continue; // on to the callee of a call or an index
    while (j > 0 && /\s/.test(code[j - 1])) j--;
    if (code[j - 1] !== '.') return start;
    j--;
  }
}

/** Whether the call whose parentheses open at `o` has a second argument. */
function twoArgs(code: string, o: number): boolean {
  for (let d = 0, k = o + 1, c = closing(code, o); k < c; k++) { if ('([{'.includes(code[k])) d++; else if (')]}'.includes(code[k])) d--; else if (code[k] === ',' && !d) return true; }
  return false;
}

/** Whether the catch block that opens at `open` always throws again: a `throw` of its own, under no if, else, loop or nested block. */
function rethrows(code: string, open: number): boolean {
  const end = closing(code, open);
  for (let i = open + 1, d = 0; i < end; i++) {
    if ('([{'.includes(code[i])) d++;
    else if (')]}'.includes(code[i])) d--;
    else if (!d && /^throw\b/.test(code.slice(i, i + 6)) && !/[\w$.]/.test(code[i - 1])) {
      const before = code.slice(open + 1, i).trimEnd(), last = open + before.length;
      if (code[last] === ')' ? !/(?<![\w$.])(?:if|while|for)\s*$/.test(code.slice(0, opening(code, last))) : !/(?<![\w$.])else$/.test(before)) return true;
    }
  }
  return false;
}

/** Whether a name of `names` is written in [a, b). */
const mentions = (code: string, names: string[], a: number, b: number) => names.length > 0 && positions(code, new RegExp(`(?<![\\w$.])(?:${names.map(esc).join('|')})(?![\\w$])`, 'g')).some((i) => i >= a && i < b);

interface Spot { at: number; covers: Range[] }
/**
 * What swallows a failure, so that nothing it covers checks anything: a `.catch(…)` or a two-argument `.then(…)` on an
 * expression (on a name, also what the name holds), `Promise.allSettled/any/race(…)`, a `try` whose `catch` does not
 * always throw again, and a call of a helper that does one of these to what it is handed (`known`: imported ones).
 */
function swallowing(code: string, fns: Fn[], known: Iterable<string> = []): { names: Set<string>; spots: Spot[] } {
  const gs = groups(code), base: Spot[] = [];
  const args = (at: number): Range => { const o = code.indexOf('(', at); return [o, closing(code, o)]; };
  for (const m of code.matchAll(/\.\s*(catch|then)\s*\(/g)) {
    if (m[1] === 'then' && !twoArgs(code, m.index + m[0].length - 1)) continue;
    const from = chainStart(code, m.index), head = /^[A-Za-z_$][\w$]*/.exec(code.slice(from))?.[0];
    base.push({ at: m.index, covers: [[from, m.index], ...(head ? bound(code, head, from, gs, fns) : [])] });
  }
  for (const m of code.matchAll(/(?<![\w$.])Promise\s*\.\s*(?:allSettled|any|race)\s*\(/g)) base.push({ at: m.index, covers: [args(m.index)] });
  for (const m of code.matchAll(/\btry\s*\{/g)) {
    const open = m.index + m[0].length - 1, end = closing(code, open);
    const c = /^\s*catch\s*(?:\([^)]*\)\s*)?\{/.exec(code.slice(end + 1));
    if (c && !rethrows(code, end + c[0].length)) base.push({ at: m.index, covers: [[open, end]] });
  }
  const names = new Set(known), aliases = aliasesOf(code);
  const spots = () => [...base, ...callsTo(code, names).map((at) => ({ at, covers: [args(at)] }))];
  for (let grew = true; grew;) {
    grew = false;
    const now = spots();
    for (const f of fns) if (!names.has(f.name) && now.some((s) => s.at >= f.open && s.at < f.end && s.covers.some(([a, b]) => mentions(code, f.params, a, b)))) { names.add(f.name); grew = true; }
    for (const [a, b] of aliases) if (!names.has(a) && names.has(b)) { names.add(a); grew = true; }
  }
  return { names, spots: spots() };
}

/** What the person sees or gets: a web-first assertion, or a download the browser saves. */
const seenAt = (src: string, code: string) => [...positions(code, VISIBLE), ...[...src.matchAll(/\.\s*waitForEvent\s*\(\s*(['"`])download\1/g)].filter((m) => code[m.index] === '.').map((m) => m.index)];

/** Each evaluate() whose script, written as a function or a string, or named (`evaluate(script)`), matches `re`. */
function inPage(src: string, code: string, re: RegExp, fns: Fn[]): number[] {
  const text = codeOnly(src, true), gs = groups(code);
  return [...code.matchAll(EVALUATE)].filter((m) => {
    const from = m.index + m[0].length, name = /^\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(code.slice(from))?.[1];
    return [[from, closing(code, from - 1)] as Range, ...(name ? bound(code, name, from, gs, fns) : [])].some(([a, b]) => re.test(text.slice(a, b)));
  }).map((m) => m.index);
}

/** A mocked route, a synthetic event or an injected script anywhere, and an evaluate() that changes the page. Known limit: other writes from a script are not seen. */
const faked = (src: string, code: string, fns: Fn[]) => [...positions(code, FAKE), ...inPage(src, code, new RegExp(DOM_WRITE.source), fns)];

/** What acts underneath: the code itself, and a script run in the page that does it. */
const below = (src: string, code: string, fns: Fn[]) => [...new Set([...underneath(code), ...inPage(src, code, new RegExp(UNDER.source), fns)])];

/** What the scaffold leaves to write: todo() and every literal that starts with '…'. */
const placeholders = (src: string, code: string) => [...positions(code, /(?<![\w$.])todo\s*\(/g), ...[...src.matchAll(/(['"`])…/g)].filter((m) => code[m.index] === m[1]).map((m) => m.index)];

/**
 * Where the code acts underneath the screen: UNDER, and every use of a name that holds the api fixture or a request
 * context, within that name's scope. A fixture destructured or renamed (`({ api: client })`) holds it in its function;
 * a binding anywhere holds it in the scope of the name's declaration (`let gw` on top, `gw = await api(…)` in a hook),
 * and so does an alias (`const http = page.request`). A name in a parameter list or its own declaration is not a use.
 * Known limit: a scope is the brackets around the declaration, so `for (const x of …)` scopes x to its parentheses.
 */
function underneath(code: string): number[] {
  const gs = groups(code), len = code.length;
  const scope = (p: number) => scopeOf(gs, len, p);
  const params = gs.filter(([o, c]) => code[o] === '(' && (/^\s*(?::[^=;{}()]*)?=>/.test(code.slice(c + 1, c + 120)) || /\bfunction\b\s*\*?\s*[\w$]*\s*(?:<[^>]*>)?\s*$/.test(code.slice(Math.max(0, o - 60), o))));
  const scopes = new Map<string, Range[]>();
  const bind = (name: string, r: Range) => {
    const rs = scopes.get(name) ?? [];
    if (rs.some((x) => x[0] === r[0])) return false;
    scopes.set(name, [...rs, r]);
    return true;
  };
  for (const [o, c] of params) for (const [bo, bc] of gs) {
    if (bo <= o || bc >= c || code[bo] !== '{' || scope(bo)[0] !== o) continue;
    for (const m of code.slice(bo + 1, bc).matchAll(new RegExp(`(?<![\\w$.])(api|request)(?![\\w$])(?:\\s*:\\s*(${ID}))?`, 'g'))) bind(m[2] ?? m[1], scope(o));
  }
  const uses = (name: string) => positions(code, new RegExp(`(?<![\\w$.])(?<!\\b(?:const|let|var)\\s+)${esc(name)}(?![\\w$])(?!\\s*:)`, 'g'))
    .filter((i) => !params.some(([o, c]) => i > o && i < c) && scopes.get(name)!.some(([a, b]) => i > a && i < b));
  const all = () => [...new Set([...positions(code, UNDER), ...[...scopes.keys()].flatMap(uses)])].sort((a, b) => a - b);
  const assign = new RegExp(`(?<![\\w$.])(${ID})\\s*(?::[^=;]*?)?=(?![=>])\\s*(?:(?:await\\b|\\()\\s*)*`, 'g');
  for (let grew = true; grew;) {
    grew = false;
    const at = all();
    for (const m of code.matchAll(assign)) {
      // The value is a context: api(…) or a call of what holds it, an alias, page.request, request.newContext(…). A
      // value read through one (`(await gw.get(…)).json()`) is data, not a context.
      const from = m.index + m[0].length;
      const chain = new RegExp(`^${ID}(?:\\s*\\.\\s*${ID})*`).exec(code.slice(from))?.[0];
      if (!chain) continue;
      const to = from + chain.length;
      const holds = /^\s*\(/.test(code.slice(to)) ? at.includes(to - /[\w$]+$/.exec(chain)![0].length) || /\brequest\s*\.\s*newContext$/.test(chain) : at.some((p) => p >= from && p < to);
      if (!holds) continue;
      const decls = positions(code, new RegExp(`\\b(?:const|let|var)\\s+${esc(m[1])}(?![\\w$])`, 'g')).map(scope).filter(([a, b]) => m.index > a && m.index < b);
      if (bind(m[1], decls.reduce<Range>((s, r) => (r[0] > s[0] ? r : s), [-1, len]))) grew = true;
    }
  }
  return all();
}

/** `const a = b`, `const { b: a } = o` (a is o.b) and `export { b as a }`: a name that is another one. */
const aliasesOf = (code: string): Array<[string, string]> => [
  ...[...code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${ID})\\s*(?::[^=;]*?)?=\\s*(${ID}(?:\\s*\\.\\s*${ID})*)\\s*(?=[;\\n]|$)`, 'g'))].map((m): [string, string] => [m[1], m[2].replace(/\s+/g, '')]),
  ...[...code.matchAll(new RegExp(`\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*(?::[^=;]*?)?=\\s*(${ID}(?:\\s*\\.\\s*${ID})*)\\s*(?=[;\\n]|$)`, 'g'))].flatMap((m) => m[1].split(',')
    .map((s) => /^\s*([\w$]+)(?:\s*:\s*([\w$]+))?/.exec(s)).filter((x): x is RegExpExecArray => x !== null).map((x): [string, string] => [x[2] ?? x[1], `${m[2].replace(/\s+/g, '')}.${x[1]}`])),
  ...[...code.matchAll(/\bexport\s*\{([^}]*)\}/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)).filter((x) => x.length === 2).map(([b, a]): [string, string] => [a, b])),
];
/** Calls of the names, a namespace's (`vf.signIn(…)`) included; a function's own declaration is not one. */
const callsTo = (code: string, names: Iterable<string>) => {
  const alt = [...names].map((n) => n.split('.').map(esc).join('\\s*\\.\\s*'));
  return alt.length ? positions(code, new RegExp(`(?<![\\w$.])(?<!\\bfunction\\s*\\*?\\s*)(?:${alt.join('|')})\\s*\\(`, 'g')) : [];
};

/**
 * The positions plus the calls to helpers whose bodies hold one, helpers calling helpers and aliases too: a helper does
 * what its body does. `known` names what does it already (imported helpers); a position in `exclude` marks no helper.
 */
function through(code: string, base: number[], fns: Fn[], known: Iterable<string> = [], exclude: Range[] = []): { at: number[]; names: Set<string> } {
  const names = new Set(known), aliases = aliasesOf(code);
  for (let grew = true; grew;) {
    grew = false;
    const now = [...base, ...callsTo(code, names)].filter((p) => !within(p, exclude));
    for (const f of fns) if (!names.has(f.name) && now.some((p) => p >= f.open && p < f.end)) { names.add(f.name); grew = true; }
    for (const [a, b] of aliases) if (!names.has(a) && names.has(b)) { names.add(a); grew = true; }
  }
  return { at: [...new Set([...base, ...callsTo(code, names)])].sort((a, b) => a - b), names };
}

/**
 * A form is known by the function whose own body fills it: `<module>#<name>`, `#<name>` in the spec itself. `fills`:
 * the forms each name fills itself; `forms`: those it fills, itself or through the functions it calls.
 */
interface Forms { forms: Map<string, Set<string>>; fills: Map<string, Set<string>> }
/** The forms of each name of the code, its functions and aliases, on top of the imported ones (`known`). */
function formsOf(code: string, fns: Fn[], known: Forms, self: string): Forms {
  const copy = (m: Map<string, Set<string>>) => new Map([...m].map(([n, o]) => [n, new Set(o)]));
  const out: Forms = { forms: copy(known.forms), fills: copy(known.fills) };
  const add = (m: Map<string, Set<string>>, n: string, o: Iterable<string>) => { const s = m.get(n) ?? new Set<string>(), size = s.size; for (const x of o) s.add(x); m.set(n, s); return s.size > size; };
  for (const i of positions(code, FORM)) {
    const around = fns.filter((f) => i >= f.open && i < f.end);
    const inner = around.reduce<Fn | undefined>((s, f) => (!s || f.open > s.open ? f : s), undefined);
    if (inner) add(out.fills, inner.name, [`${self}#${inner.name}`]);
    for (const f of around) add(out.forms, f.name, [`${self}#${inner!.name}`]);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const [n, o] of [...out.forms]) for (const i of callsTo(code, [n])) for (const f of fns) if (i >= f.open && i < f.end && add(out.forms, f.name, o)) grew = true;
    for (const [a, b] of aliasesOf(code)) for (const m of [out.forms, out.fills]) if (m.has(b) && add(m, a, m.get(b)!)) grew = true;
  }
  return out;
}

/**
 * The forms the validation cases among `tests` test: the one each fills last itself, inline or by calling the function
 * that fills it (`fills`); a helper that fills it on the way somewhere (`signIn`) is not testing it.
 */
function validatedForms(code: string, fills: Map<string, Set<string>>, tests: Call[], p: Pick<Loaded, 'fields'>): string[] {
  const validation = new Set(rows(p, 'cases').filter((c) => c.kind === 'validation').map((c) => String(c.case).trim()));
  const at: Array<[number, Set<string>]> = [...positions(code, FORM).map((i): [number, Set<string>] => [i, new Set()]), ...[...fills].flatMap(([n, o]) => callsTo(code, [n]).map((i): [number, Set<string>] => [i, o]))];
  return tests.filter((t) => validation.has(t.title.trim())).flatMap((t) => {
    const last = at.filter(([i]) => i > t.at && i < t.end).sort((a, b) => b[0] - a[0])[0];
    return last ? [...last[1]] : [];
  });
}

type Kind = 'seen' | 'check' | 'under' | 'fake' | 'swallow';
type Does = Record<Kind, Set<string>> & Forms;
type Read = (from: string) => string | undefined;
const KINDS: Kind[] = ['seen', 'check', 'under', 'fake', 'swallow'];
const nothing = () => ({ ...Object.fromEntries(KINDS.map((k) => [k, new Set<string>()])), forms: new Map(), fills: new Map() }) as Does;
/** The name an exported `n` takes where `import { name as local }` brings it, if it brings it. */
const localOf = (name: string, local: string, n: string) => (name === '*' ? (local ? `${local}.${n}` : n) : n === name || n.startsWith(`${name}.`) ? local + n.slice(name.length) : undefined);

/**
 * `import`, `export … from` and `await import(…)` of a source: the module, and each local name with the name it has
 * there (`default` its default export, `*` all of them, under `local.` or, for `export *`, as they are).
 */
function importsOf(src: string, code: string): Array<{ from: string; names: Array<{ name: string; local: string }> }> {
  const written = [...src.matchAll(/^[ \t]*(import|export)\s+(?!type\b)([^'";]*?)\s*from\s*(['"])([^'"]+)\3/gm)].filter((m) => code[m.index + m[0].indexOf(m[1])] === m[1][0]).map((m) => {
    const names: Array<{ name: string; local: string }> = [];
    const def = m[1] === 'import' ? /^[\w$]+/.exec(m[2]) : null;
    if (def) names.push({ name: 'default', local: def[0] });
    const star = /\*(?:\s*as\s+([\w$]+))?/.exec(m[2]);
    if (star) names.push({ name: '*', local: star[1] ?? '' });
    for (const s of /\{([^}]*)\}/.exec(m[2])?.[1].split(',') ?? []) {
      const [name, local] = s.trim().split(/\s+as\s+/);
      if (name && !name.startsWith('type ')) names.push({ name, local: local ?? name });
    }
    return { from: m[4], names };
  });
  // `const vf = await import('…')` is a namespace, `const { a, b: c } = await import('…')` a few of its names.
  const loaded = [...src.matchAll(/\b(?:const|let|var)\s+(?:([\w$]+)|\{([^}]*)\})\s*(?::[^=;]*?)?=\s*(?:await\s+)?import\s*\(\s*(['"])([^'"]+)\3\s*\)/g)].filter((m) => code[m.index] !== ' ').map((m) => ({
    from: m[4],
    names: m[1] ? [{ name: '*', local: m[1] }] : m[2].split(',').map((s) => /^\s*([\w$]+)(?:\s*:\s*([\w$]+))?/.exec(s)).filter((x): x is RegExpExecArray => x !== null).map((x) => ({ name: x[1], local: x[2] ?? x[1] })),
  }));
  return [...written, ...loaded];
}

/** A specifier written in module `at`, as the spec would write it: `@support/…`, or relative to the spec. */
function joinSpec(at: string, from: string): string {
  if (!at || !from.startsWith('.')) return from;
  const sup = at.startsWith('@support/'), j = posix.join(posix.dirname(sup ? at.slice('@support/'.length) : at), from);
  return sup ? `@support/${j}` : j.startsWith('.') ? j : `./${j}`;
}

/** What each name a source imports does, following the workspace's own modules through their imports and re-exports. */
function imported(src: string, code: string, read: Read, at: string, memo: Map<string, Does | null>): Does {
  const known = nothing();
  for (const i of importsOf(src, code)) {
    const does = moduleDoes(joinSpec(at, i.from), read, memo);
    if (does) for (const { name, local } of i.names) {
      for (const k of KINDS) for (const n of does[k]) { const l = localOf(name, local, n); if (l) known[k].add(l); }
      for (const m of ['forms', 'fills'] as const) for (const [n, o] of does[m]) { const l = localOf(name, local, n); if (l) known[m].set(l, o); }
    }
  }
  return known;
}

/**
 * A module of the workspace: what each of its names does (`default` its default export, `default.x` a member of it).
 * Known limit: a module is known by its specifier, so two flows' `./helpers` next to each spec are taken for one.
 */
function moduleDoes(from: string, read: Read, memo: Map<string, Does | null>): Does | null {
  if (memo.has(from)) return memo.get(from)!;
  memo.set(from, null); // an import cycle adds nothing
  const src = read(from);
  if (src === undefined) return null;
  // `export default …` read as `const $default=…`, offsets kept: a default export is one more helper or alias.
  const code = codeOnly(src).replace(/\bexport(\s+)default(\s+)/g, (m) => 'const $default='.padEnd(m.length));
  const fns = helpers(code), known = imported(src, code, read, from, memo);
  const sw = swallowing(code, fns, known.swallow), lost = sw.spots.flatMap((s) => s.covers);
  const base: Record<Exclude<Kind, 'swallow'>, number[]> = { seen: seenAt(src, code), check: positions(code, EXPECT), under: below(src, code, fns), fake: faked(src, code, fns) };
  const members = (/\bconst \$default=\s*\{([^}]*)\}/.exec(code)?.[1].split(',') ?? []).map((s) => s.trim().split(/\s*:\s*/)).filter(([n]) => n);
  const exported = (names: Iterable<string>) => {
    const out = new Set([...names].map((n) => (n === '$default' ? 'default' : n)));
    for (const [key, value = key] of members) if ([...names].includes(value)) out.add(`default.${key}`);
    return out;
  };
  const does = nothing();
  for (const k of KINDS) does[k] = exported(k === 'swallow' ? sw.names : through(code, base[k], fns, known[k], k === 'seen' ? lost : []).names);
  const f = formsOf(code, fns, known, from);
  for (const m of ['forms', 'fills'] as const) for (const [n, o] of f[m]) for (const x of exported([n])) does[m].set(x, o);
  memo.set(from, does);
  return does;
}

export type FlowCheckKey = 'flow-spec-missing' | 'flow-steps-drift' | 'flow-cases-drift' | 'flow-e2e-api' | 'flow-e2e-invisible' | 'flow-e2e-wait' | 'flow-e2e-prepare' | 'flow-e2e-validation' | 'flow-e2e-api-case' | 'flow-e2e-fake' | 'flow-e2e-hidden' | 'flow-e2e-todo' | 'flow-message-unchecked';
export interface FlowCheck { id: string; spec: string; line?: number; level: 'error' | 'warning'; key: FlowCheckKey; message: string }
const UNDER_WHAT = 'the API, fetch, a request context, or a session the script sets';

/**
 * The spec against the e2e standard. `proves(id, data)`: flow `id` walks on screen the path that makes `data`, so this
 * flow may prepare it underneath. `validates(id)`: flow `id`, named in «Validaciones en», holds validation cases played
 * on screen, and these are the forms they test (`holdsValidations`). `read(from)`: the source of a module the spec
 * imports, when it is the workspace's own (support/ or a relative path); an imported helper then counts for what it
 * does, its own imports followed: what the person sees or gets, a check, something underneath, a fake, a failure it
 * swallows, the forms it fills.
 */
export function lintSpec(src: string, p: Pick<Loaded, 'id' | 'fields'>, proves: (id: string, data: string) => boolean, read: Read = () => undefined, validates: (id: string) => Set<string> | undefined = () => undefined): Array<{ line: number; key: FlowCheckKey; message: string }> {
  const out: Array<{ line: number; key: FlowCheckKey; message: string }> = [];
  const lineAt = (at: number) => src.slice(0, at).split('\n').length;
  const add = (at: number, key: FlowCheckKey, message: string) => out.push({ line: lineAt(at), key, message });
  const code = codeOnly(src);
  const fns = helpers(code);
  const known = imported(src, code, read, '', new Map());
  const story = callsOf(src, code, 'story')[0];
  const steps = callsOf(src, code, 'step').filter((s) => inside(s, story));
  const preps = callsOf(src, code, 'prepare');
  const tests = callsOf(src, code, 'test').filter((t) => !inside(t, story));
  const apiCases = callsOf(src, code, 'apiCase');
  const pre = rows(p, 'preconditions'), cases = rows(p, 'cases');
  const caseOf = (title: string) => cases.find((c) => String(c.case).trim() === title.trim());
  const spans: Range[] = fns.map((f) => [f.at, f.end - 1]);
  const prepSpans = preps.map(span);
  // What a prepare() does underneath stays in it: a helper of the spec that prepares does not act underneath for that,
  // and a name it is handed on its own (`account(api, name)`, `account({ api })`) is the preparation's.
  const preparers = [...through(code, preps.map((r) => r.at), fns).names];
  const handed = callsTo(code, preparers).map((at) => ({ at, end: closing(code, code.indexOf('(', at)) }));
  const under = through(code, below(src, code, fns), fns, known.under, prepSpans).at.filter((i) => !(handed.some((c) => i > c.at && i < c.end) && /^[\w$]+\s*[,)\]}]/.test(code.slice(i))));
  const sw = swallowing(code, fns, known.swallow), lost = sw.spots.flatMap((s) => s.covers);
  const visible = through(code, seenAt(src, code), fns, known.seen, lost).at.filter((i) => !within(i, lost));
  // expect.soft, and a name that holds it (`const { soft } = expect`).
  const soft = through(code, [], [], ['expect.soft']).at;
  const checks = through(code, positions(code, EXPECT), fns, known.check).at;
  const fake = through(code, faked(src, code, fns), fns, known.fake).at;
  const { forms, fills } = formsOf(code, fns, known, '');
  // The first position in [from, to) that is still code in `text` (a blanked range is spaces).
  const first = (text: string, from: number, to: number, ps: number[]) => ps.find((i) => i >= from && i < to && text[i] !== ' ') ?? -1;
  const hit = (text: string, c: Call, ps: number[]) => first(text, c.at, c.end, ps);
  const declared = blankOut(code, prepSpans);

  // A preparation is what exists before the flow: written in the story before its first step, or in a case before its
  // first action, awaited there, or in a helper of the spec, whose calls are preparations in turn. Written in any other
  // function (a callback, an event handler, an object's method, a hook) it runs whenever that function runs.
  const sites = [...preps.map((r) => ({ at: r.at, end: r.end, what: `prepare('${r.title}')` })), ...handed.map((c) => ({ ...c, what: `${/^[\w$]+/.exec(code.slice(c.at))![0]}(), which calls prepare(),` }))];
  const bodies = functionBodies(code);
  const fnAt = (i: number) => bodies.filter(([a, b]) => i >= a && i < b).reduce<Range | undefined>((s, r) => (!s || r[0] > s[0] ? r : s), undefined);
  const bodyOf = (c: Call) => bodies.filter(([a, b]) => a > c.at && b <= c.end).reduce<Range | undefined>((s, r) => (!s || r[0] < s[0] ? r : s), undefined);
  const ofSite = (i: number) => sites.some((s) => (i > s.at && i < s.end) || (s.at > i && s.at < statementEnd(code, i)));
  const firstAction = (c: Call) => positions(code, /\bawait\b/g).find((i) => i > c.at && i < c.end && fnAt(i) === bodyOf(c) && !ofSite(i)) ?? c.end;
  // A case taken out of the run (flow-e2e-hidden) is still a case.
  const whole = [...tests, ...apiCases, ...callsOf(src, code, 'test\\s*\\.\\s*(?:skip|only|fixme|fail)')];
  const placed = (at: number) => {
    const f = fnAt(at);
    if (!f || !(code[f[0]] !== '{' || /\b(?:await|return)\b/.test(code.slice(statementStart(code, f[0], at), at)))) return false;
    return fns.some((h) => h.open === f[0]) || (story !== undefined && f === bodyOf(story) && at < (steps[0]?.at ?? story.end)) || whole.some((c) => f === bodyOf(c) && at < firstAction(c));
  };
  for (const s of sites) if (!placed(s.at)) add(s.at, 'flow-e2e-prepare', `${s.what} is not where a precondition goes: what exists before the flow is prepared before the story's first step or a case's first action, awaited where it is written, in the story, the case or a helper of the spec (not in a callback, an event handler, an object's method or a hook); what changes during the flow, a person does on screen`);
  // A helper that prepares is called or given another name (`const s = account`); handed on as a value (`later(account)`,
  // `{ account }`, `once('response', account)`) it runs whenever what holds it calls it.
  const asValue = preparers.length ? positions(code, new RegExp(`(?<![\\w$.])(?:${preparers.map(esc).join('|')})(?![\\w$])(?!\\s*[(:])`, 'g')).filter((i) => !/\b(?:const|let|var)\s+(?:[\w$]+\s*(?::[^=;]*?)?=\s*)?$/.test(code.slice(Math.max(0, i - 80), i))) : [];
  for (const i of asValue) add(i, 'flow-e2e-prepare', `${/^[\w$]+/.exec(code.slice(i))![0]}() calls prepare() and is handed on as a value: it runs whenever what holds it calls it; call it, awaited, before the story's first step or a case's first action`);

  for (const s of steps) {
    const a = hit(declared, s, under);
    if (a >= 0) add(a, 'flow-e2e-api', `step('${s.title}') acts underneath the screen (${UNDER_WHAT}): a person does it on screen; what the screen cannot show goes to observed, as a complement`);
    if (hit(code, s, visible) < 0) add(s.at, 'flow-e2e-invisible', `step('${s.title}') checks nothing the person sees or gets: its «Se espera» is an expect on the screen (toBeVisible, toHaveText…) or the download the browser saves`);
  }
  if (story) {
    const a = hit(blankOut(declared, [...steps.map(span), ...spans]), story, under);
    if (a >= 0) add(a, 'flow-e2e-prepare', `the story acts underneath outside prepare() (${UNDER_WHAT}): data that exists before the flow goes in prepare('<Precondiciones row>', …)`);
  }
  // Hooks and the top of the spec: all that is not the story, a case or a helper (a helper counts where it is called).
  const top = first(blankOut(declared, [...[story, ...tests, ...apiCases].filter(Boolean).map((c) => span(c!)), ...spans]), 0, code.length, under);
  if (top >= 0) add(top, 'flow-e2e-prepare', `a hook or the top of the spec acts underneath (${UNDER_WHAT}): data that exists before the flow goes in prepare('<Precondiciones row>', …), inside the story or the case`);
  for (const r of preps) {
    const row = pre.find((x) => String(x.data).trim() === r.title.trim());
    if (!row) add(r.at, 'flow-e2e-prepare', `prepare('${r.title}') is not a row of Precondiciones: declare it there`);
    else if (hit(code, r, under) >= 0 && !(row.proven && row.proven !== p.id && proves(String(row.proven), String(row.data)))) add(r.at, 'flow-e2e-prepare', `prepare('${r.title}') acts underneath and no other flow walks that path on screen: name in «Probado en» a flow that makes it through the interface (not underneath itself, and relying only on flows that do the same), or make it through the interface`);
  }
  for (const t of tests) {
    const a = hit(declared, t, under);
    if (a >= 0) add(a, 'flow-e2e-api-case', `test('${t.title}') acts underneath (${UNDER_WHAT}): do it on screen, or, when no person can cause it from the screen, make it apiCase('${t.title}', '<why>', …) with Tipo api`);
    else if (caseOf(t.title)?.kind === 'api') add(t.at, 'flow-e2e-api-case', `Casos cortos marks «${t.title}» as api and the spec plays it on screen: one of the two is wrong`);
    if (hit(code, t, visible) < 0) add(t.at, 'flow-e2e-invisible', `test('${t.title}') checks nothing the person sees or gets: its «Se espera» is an expect on the screen`);
  }
  for (const c of apiCases) {
    if (!c.why?.trim()) add(c.at, 'flow-e2e-api-case', `apiCase('${c.title}') does not say why no person can cause it from the screen`);
    if (caseOf(c.title)?.kind !== 'api') add(c.at, 'flow-e2e-api-case', `apiCase('${c.title}') and Casos cortos does not mark it api`);
  }
  const titles = [...tests, ...apiCases];
  for (const c of cases) if (!titles.some((t) => t.title.trim() === String(c.case).trim())) add(story?.at ?? 0, 'flow-cases-drift', `Casos cortos has «${c.case}» and the spec has no test('${c.case}')`);
  for (const t of titles) if (!caseOf(t.title)) add(t.at, 'flow-cases-drift', `the spec has test('${t.title}') and Casos cortos has no such row`);
  // Each form the story fills has its validation cases: one it fills itself, here; one it fills through an imported
  // helper, a validation case that tests that same form (`validatedForms`), here or in a flow «Validaciones en» names.
  const named = ((p.fields.validated ?? []) as string[]).map((x) => String(x).trim()).filter(Boolean);
  const covered = new Set(validatedForms(code, fills, tests, p));
  for (const id of named) {
    const v = id === p.id ? undefined : validates(id);
    if (v) for (const x of v) covered.add(x);
    else add(story?.at ?? 0, 'flow-e2e-validation', `«Validaciones en» names ${id}, which holds no validation case played on screen: name the flow whose Casos cortos test that form (Tipo validation, its spec clean), or give this flow its own`);
  }
  const ownForm = [...positions(code, FORM), ...callsTo(code, [...forms].filter(([, o]) => [...o].some((x) => x.startsWith('#'))).map(([n]) => n))];
  const own = steps.map((s) => hit(code, s, ownForm)).find((i) => i >= 0);
  if (own !== undefined && !cases.some((c) => c.kind === 'validation')) add(own, 'flow-e2e-validation', 'the story fills a form and Casos cortos has no validation case: empty, format, limits, permission, each checking the message the person sees');
  const told = new Set<string>();
  for (const s of steps) for (const [n, o] of forms) for (const at of callsTo(code, [n]).filter((i) => i > s.at && i < s.end)) {
    const open = [...o].filter((x) => !x.startsWith('#') && !covered.has(x) && !told.has(x));
    for (const x of open) told.add(x);
    if (open.length) add(at, 'flow-e2e-validation', `the story fills a form through ${n}() and no validation case tests it: give this flow a validation case that fills it last with the function that fills it (not one that fills it on the way, like a sign-in that waits for the next page), or name in «Validaciones en» a flow whose validation case does`);
  }
  for (const i of positions(code, WAIT)) add(i, 'flow-e2e-wait', 'a fixed wait: wait for what the person sees (await expect(…).toBeVisible())');
  for (const i of fake) if (!fns.some((f) => i >= f.open && i < f.end)) add(i, 'flow-e2e-fake', 'a mocked route, a synthetic event or the page changed by a script: the flow runs against the real services and the person changes the page; what no person can cause from the screen is an apiCase');
  for (const i of positions(code, HIDDEN)) add(i, 'flow-e2e-hidden', 'a case skipped, left as fixme, expected to fail or hidden by an only: it runs; a deviation of the app is an expect.soft on what it should do, with // app:');
  for (const s of sw.spots) if (checks.some((i) => within(i, s.covers))) add(s.at, 'flow-e2e-hidden', 'a check whose failure is swallowed (a .catch or a two-argument .then on it, Promise.allSettled, any or race around it, a try whose catch does not always throw again, or a helper that does that to what it is handed) checks nothing: let it fail; a deviation of the app is an expect.soft on what it should do, with // app:');
  // The finish line is a run where only the soft checks marked // app: fail: each one says what the app does today.
  const text = codeOnly(src, true);
  const marked = new Set([...src.matchAll(/\/\/\s*app:/g)].filter((m) => text[m.index] === ' ').map((m) => lineAt(m.index)));
  for (const i of soft) if (!marked.has(lineAt(i)) && !marked.has(lineAt(i) - 1)) add(i, 'flow-e2e-hidden', 'an expect.soft with no // app: on its line or the line before: a soft check is a deviation of the app, and its // app: says what the app does today');
  for (const m of code.matchAll(/(?<![\w$.])expect\s*\.\s*configure\s*\(/g)) if (/\bsoft\s*:\s*true\b/.test(code.slice(m.index, closing(code, m.index + m[0].length - 1)))) add(m.index, 'flow-e2e-hidden', 'expect.configure({ soft: true }) makes every check soft: each deviation of the app is its own expect.soft, with // app:');
  const unwritten = new Set<Call>();
  for (const i of placeholders(src, code)) {
    const c = [...(story ? [story] : []), ...steps, ...preps, ...tests, ...apiCases].filter((b) => i > b.at && i <= b.end).sort((a, b) => b.at - a.at)[0];
    if (!c) add(i, 'flow-e2e-todo', "a todo() or a '…' of the scaffold is still here");
    else if (!unwritten.has(c)) { unwritten.add(c); add(c.at, 'flow-e2e-todo', `${c.kind}('${c.title}') is not written yet: the scaffold's todo() or '…' is still there`); }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** A Pasos row with no step, a step with no Pasos row, and the order. */
function stepsDrift(src: string, p: Pick<Loaded, 'fields'>): string[] {
  const want = rows(p, 'steps').map((s) => String(s.step).trim()), got = specSteps(src).map((s) => s.trim());
  const out = [...want.filter((w) => !got.includes(w)).map((w) => `Pasos has «${w}» and the spec has no step('${w}')`), ...got.filter((g) => !want.includes(g)).map((g) => `the spec has step('${g}') and Pasos has no such row`)];
  return out.length || want.join('\n') === got.join('\n') ? out : ['the spec plays the steps in another order than Pasos'];
}

const WALKS = new Set<FlowCheckKey>(['flow-e2e-api', 'flow-e2e-invisible', 'flow-e2e-prepare', 'flow-e2e-fake', 'flow-e2e-hidden', 'flow-e2e-todo']);
/**
 * Whether flow `f`, named in another flow's «Probado en» for `data`, walks that path on screen: its story plays its
 * Pasos, one step() each, in order, each one checking what the person sees; its spec acts underneath only in declared
 * preparations, fakes, hides and leaves nothing unwritten; it does not prepare `data` underneath itself; and each flow
 * its own «Probado en» names does the same (`proves` checks them, and says no to a flow already on the chain: a cycle
 * vouches for nothing). Known limit: that its path is the one that makes `data` is the author's word; a «Prueba» field on
 * each flow would let Laru hold it.
 */
export function provesOnScreen(src: string, f: Pick<Loaded, 'id' | 'fields'>, data: string, proves: (id: string, data: string) => boolean, read?: Read): boolean {
  const asked = new Set<string>();
  const found = lintSpec(src, f, (id, d) => { asked.add(d.trim()); return proves(id, d); }, read);
  return specSteps(src).length > 0 && !stepsDrift(src, f).length && !asked.has(data.trim()) && !found.some((x) => WALKS.has(x.key));
}

const HOLDS = new Set<FlowCheckKey>([...WALKS, 'flow-cases-drift', 'flow-e2e-api-case']);
/**
 * The forms flow `f`, named in another flow's «Validaciones en», tests, or undefined when it holds no validation cases:
 * its Casos cortos has some, and its spec plays every case written and visible, nothing hidden, faked or prepared
 * without a flow that proves it. A validation case tests the form it fills last itself (`validatedForms`).
 */
export function holdsValidations(src: string, f: Pick<Loaded, 'id' | 'fields'>, proves: (id: string, data: string) => boolean, read: Read = () => undefined): Set<string> | undefined {
  if (!rows(f, 'cases').some((c) => c.kind === 'validation') || lintSpec(src, f, proves, read).some((x) => HOLDS.has(x.key))) return undefined;
  const code = codeOnly(src), story = callsOf(src, code, 'story')[0];
  const { fills } = formsOf(code, helpers(code), imported(src, code, read, '', new Map()), '');
  return new Set(validatedForms(code, fills, callsOf(src, code, 'test').filter((t) => !inside(t, story)), f));
}

/** How many mail or SMS the flow's app sent in its last run (the story's, from `runs/index.jsonl`); 0 when it has none or was never run. */
function messagesOf(ws: Workspace, slug: string): number {
  const f = join(stateDir(ws), 'runs', 'index.jsonl');
  if (!existsSync(f)) return 0;
  let n = 0;
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.includes(`"flow":"${slug}"`)) continue;
    try { const r = JSON.parse(l) as { flow: string; status: string; msg?: number }; if (r.flow === slug && r.status !== 'error') n = r.msg ?? 0; } catch { /* a line cut by a crash */ }
  }
  return n;
}

/** Both directions: a Pasos row with no step, and a step with no Pasos row; the order counts too. Then the standard. */
export function checkFlowSpec(ws: Workspace, p: Loaded, byId: Map<string, Loaded> = new Map()): FlowCheck[] {
  const spec = specPath(p);
  const file = join(ws.root, spec);
  if (!existsSync(file)) return [{ id: p.id, spec, level: 'warning', key: 'flow-spec-missing', message: `${p.id} has no spec; laru flow scaffold ${p.id}` }];
  const src = readFileSync(file, 'utf8');
  const out: FlowCheck[] = stepsDrift(src, p).map((message) => ({ id: p.id, spec, level: 'warning', key: 'flow-steps-drift', message }));
  // `@support/x` is the workspace's support/x.ts (the runner's alias); a relative import is next to the spec.
  const reader = (dir: string) => (from: string) => {
    const base = from.startsWith('@support/') ? join(ws.root, 'support', from.slice('@support/'.length)) : from.startsWith('.') ? join(ws.root, dir, from) : null;
    const hit = base ? [base, `${base}.ts`].find((f) => existsSync(f) && statSync(f).isFile()) : undefined;
    return hit ? readFileSync(hit, 'utf8') : undefined;
  };
  // A flow named in «Probado en» or «Validaciones en» is checked the same way, down the chain; one already on the
  // chain vouches for nothing. Known limit: each link is linted again on every path to it, fine for a few dozen flows.
  const named = (id: string, chain: Set<string>) => {
    const f = byId.get(id);
    const other = f?.type === 'flow' && !chain.has(id) ? join(ws.root, specPath(f)) : null;
    return other && existsSync(other) ? { f: f!, src: readFileSync(other, 'utf8'), proves: proving(new Set([...chain, id])) } : undefined;
  };
  const proving = (chain: Set<string>) => (id: string, data: string): boolean => { const o = named(id, chain); return Boolean(o && provesOnScreen(o.src, o.f, data, o.proves, reader(o.f.dir))); };
  const proves = proving(new Set());
  const validates = (id: string) => { const o = named(id, new Set()); return o && holdsValidations(o.src, o.f, o.proves, reader(o.f.dir)); };
  for (const l of lintSpec(src, p, proves, reader(p.dir), validates)) out.push({ id: p.id, spec, level: 'warning', ...l });
  // what the app sends to a mailbox is checked there: the flow's last run saw messages and its spec never asks for one
  const sent = messagesOf(ws, p.id.replace(/^flow:/, ''));
  if (sent > 0 && !/(?<![\w$.])(?:mail|sms)\s*\.\s*(?:waitFor|code|links|all)\b/.test(src)) out.push({ id: p.id, spec, level: 'warning', key: 'flow-message-unchecked', message: `${p.id}: the app sent ${sent} mail or SMS in its last run and the spec never checks them; wait for them with mail.waitFor or sms.waitFor (and use the link or code they carry)` });
  return out;
}
