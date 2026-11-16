/**
 * The interface in Spanish or English: every text goes through tr() with the Spanish as its key, and en.ts says each in
 * English with the same `{values}`. Read from the sources with the parser Vite uses, so a new text of the interface
 * written in plain Spanish fails here, and so does an English entry that no source says any more.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { parseAst } from 'vite';
import { EN } from '../src/lib/en.ts';
import { tr } from '../src/lib/i18n.ts';

type Node = { type: string; start: number; end: number; [k: string]: unknown };
const src = join(import.meta.dirname, '../src');
const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && !f.startsWith('generated') && !/lib\/(en|i18n)\.ts$/.test(f));
const parsed = files.map((f) => {
  const text = readFileSync(join(src, f), 'utf8');
  return { f, text, ast: parseAst(text, { lang: f.endsWith('x') ? 'tsx' : 'ts' }) as unknown as Node };
});
const kids = (n: Node): Node[] => Object.entries(n).flatMap(([k, v]) => (k === 'parent' ? [] : Array.isArray(v) ? v : [v])).filter((v): v is Node => Boolean(v) && typeof (v as Node).type === 'string');
const callee = (n: Node) => { const c = n.callee as Node; return c.type === 'Identifier' ? (c.name as string) : c.type === 'MemberExpression' && !c.computed ? ((c.property as Node).name as string) : undefined; };
const line = (text: string, at: number) => text.slice(0, at).split('\n').length;
const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

/** Every key the sources say: the first argument of tr() and trx(), a string as written. */
const keys = new Map<string, string>();
for (const { f, text, ast } of parsed) {
  const walk = (n: Node) => {
    if (n.type === 'CallExpression' && ['tr', 'trx'].includes(callee(n) ?? '') && (n.callee as Node).type === 'Identifier') {
      const a = (n.arguments as Node[])[0];
      assert.ok(a?.type === 'Literal' && typeof a.value === 'string', `${f}:${line(text, n.start)}: tr() takes its Spanish as a string literal, so its English can be checked`);
      if (!keys.has(a.value as string)) keys.set(a.value as string, `${f}:${line(text, n.start)}`);
    }
    kids(n).forEach(walk);
  };
  walk(ast);
}

test('every text of the interface has its English, with the same {values}', () => {
  const missing = [...keys].filter(([k]) => !Object.hasOwn(EN, k)).map(([k, at]) => `${at} ${JSON.stringify(k)}`);
  assert.deepEqual(missing, [], 'add these to lib/en.ts');
  const off = [...keys.keys()].filter((k) => Object.hasOwn(EN, k) && holes(k).join() !== holes(EN[k]).join()).map((k) => `${JSON.stringify(k)} → ${JSON.stringify(EN[k])}`);
  assert.deepEqual(off, []);
  assert.ok(keys.size > 3000, `only ${keys.size} texts found: the search no longer reads the sources`);
});

test('en.ts holds nothing the sources no longer say', () => {
  assert.deepEqual(Object.keys(EN).filter((k) => !keys.has(k)), []);
});

// A word the interface shows that is the same in both languages, or code shown as such
const SAME = /^[\s\d.,:;·…×→←↑↓⇧⌘()[\]{}/+\-–—%#@'"`|<>=!?›‹*_]*(Laru|Docker|Docker Compose|Kafka|RabbitMQ|Redis|MongoDB|SQL|HTTP|SSE|JSON|SVG|CSV|GiB|GB|MB|KB|SMS|SMTP|URL|CPU|PK|Mermaid|GitHub|Endpoints|Endpoint|Runs|Run|run|runs|Logs|Compose|Mock|ETag|TTL|NULL|STOP|cURL|Ctrl|Esc|Enter|Intro|P|R|M|ms|s|p|E2E|OK|id|Web|Front|Stack|Broker|SQS|Kiro|Claude|Codex|main|audit|payments|mc|build|laru|mock|Personal)?[\s\d.,:;·…×→←↑↓⇧⌘()[\]{}/+\-–—%#@'"`|<>=!?›‹*_]*$/;
/** a path, a file, a key: one token with the marks only code has */
const codeish = (t: string) => !/\s/.test(t) && /[./~:_<>[\]*@$]/.test(t);
const UI_ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label']);
const CODE = new Set(['code', 'kbd', 'pre', 'samp', 'Code', 'CodeBlock']);
/** Spanish that is only ever said in Spanish: the core's English is shown instead in English (lib/es.ts) */
const SPANISH_ONLY = new Set(['REASON', 'ISSUE', 'DIAGRAM_RULE', 'findingText', 'WHY', 'checkNote', 'rabbitText', 'laruLine', 'importWarning', 'workspaceError', 'de']);
/** each language says its own name */
const OWN_NAME = new Set(['Español']);
/** Spanish words that are names in the code: URL parameters (`?flujo=`, `?estado=`), a stop's id, a step's status, an element id's base, a prune's kind, a verdict the service sends */
const IDS = new Set(['flujo', 'estado', 'todo', 'fallo', 'pieza', 'preparacion', 'respuesta', 'media', 'sin referencia']);
/** the words only the Spanish says: in a key of en.ts and in no English of it */
const words = (s: string) => s.toLowerCase().match(/[a-záéíóúñü]{3,}/g) ?? [];
const english = new Set(Object.values(EN).flatMap(words));
const SPANISH = new Set(Object.keys(EN).flatMap(words).filter((w) => !english.has(w)));
const NOT_SAID = new Set(['className', 'id', 'key', 'htmlFor', 'href', 'role', 'type', 'name', 'value', 'to', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-current', 'aria-haspopup', 'aria-activedescendant']);
const SKIP_ARGS = new Set(['test', 'match', 'exec', 'replace', 'startsWith', 'endsWith', 'includes', 'split', 'get', 'has', 'querySelector', 'getItem', 'setItem', 'log', 'warn', 'error']);

test('no Spanish text is left outside tr()', () => {
  const found: string[] = [];
  const spanish = (s: string) => {
    if (/[áéíóúñ¿¡]/i.test(s)) return !OWN_NAME.has(s);
    const t = s.trim();
    if (IDS.has(t) || !/\s/.test(t) && /[./~:_<>[\]*@$?=&]|\w-\w/.test(t)) return false;
    return words(s).some((w) => SPANISH.has(w));
  };
  for (const { f, text, ast } of parsed) {
    const say = (n: Node, s: string) => found.push(`${f}:${line(text, n.start)} ${JSON.stringify(s.replace(/\s+/g, ' ').trim())}`);
    const walk = (n: Node, inCode: boolean) => {
      if (n.type === 'CallExpression' && (callee(n) === 'tr' || callee(n) === 'trx')) return;
      if (n.type === 'CallExpression' && SKIP_ARGS.has(callee(n) ?? '')) { walk(n.callee as Node, inCode); return; }
      if (/^(Import|Export)/.test(n.type) && n.type !== 'ExportNamedDeclaration' || /^TS/.test(n.type) && !/^TS(As|NonNull|Satisfies)Expression$/.test(n.type)) return;
      // a case's test compares; what it does is said
      if (n.type === 'SwitchCase') { (n.consequent as Node[]).forEach((k) => walk(k, inCode)); return; }
      if ((n.type === 'VariableDeclarator' || n.type === 'FunctionDeclaration') && SPANISH_ONLY.has(((n.id as Node | null)?.name as string) ?? '')) return;
      if (n.type === 'BinaryExpression' && /^(===|!==|==|!=)$/.test(n.operator as string)) return;
      if (n.type === 'Property' && !n.computed) { walk(n.value as Node, inCode); return; }
      if (n.type === 'JSXElement') {
        const name = ((n.openingElement as Node).name as Node).name as string;
        kids(n).forEach((k) => walk(k, inCode || CODE.has(name)));
        return;
      }
      if (n.type === 'JSXAttribute') {
        const name = (n.name as Node).name as string, v = n.value as Node | null;
        if (NOT_SAID.has(name) || /^data-/.test(name)) return;
        if (UI_ATTRS.has(name) && v?.type === 'Literal' && /\p{L}/u.test(v.value as string) && !SAME.test(v.value as string) && !codeish(v.value as string)) { say(v, `${name}=${v.value}`); return; }
        if (v) walk(v, inCode);
        return;
      }
      if (n.type === 'JSXText') {
        const t = (n.value as string).replace(/\s+/g, ' ').trim();
        if (inCode ? spanish(t) : /\p{L}/u.test(t) && !SAME.test(t) && !codeish(t)) say(n, t);
        return;
      }
      const s = n.type === 'Literal' && typeof n.value === 'string' ? (n.value as string) : n.type === 'TemplateElement' ? ((n.value as { cooked: string }).cooked ?? '') : undefined;
      if (s !== undefined && spanish(s)) say(n, s);
      kids(n).forEach((k) => walk(k, inCode));
    };
    walk(ast, false);
  }
  assert.deepEqual(found, [], 'wrap these in tr() and give them their English in lib/en.ts');
});

test('a word with two meanings says only the word in Spanish, and each meaning in English', () => {
  // the tests run in the sources' language
  assert.equal(tr('Tema@@Kafka'), 'Tema');
  assert.notEqual(EN['Tema@@Kafka'], EN['Tema']);
  assert.equal(tr('{n} filas', { n: 3 }), '3 filas');
});
