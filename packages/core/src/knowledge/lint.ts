/**
 * The document's note: how complete and how assertive a piece is, 0–100, never how short. Writing never demands it — an
 * empty required section is a warning and lowers the note — but the note says what is still owed ("Lo que debe"). A
 * required section weighs 2, and so does naming an endpoint the code does not have; what is only recommended (a summary
 * that says something, an expected relation, a section's minimum length, saying it without vague words) weighs 1. A
 * diagram never lowers it: one that is there adds a point.
 */
import type { Graph } from '../graph.ts';
import { hasValue, type Piece } from './piece.ts';
import { STANDARD } from './standard.ts';

export interface NoteItem { key: string; at: string; weight: number; ok: boolean; params?: Record<string, string | number> }
export interface DocNote { score: number; items: NoteItem[]; owed: NoteItem[] }

export const SUMMARY_MIN = 40;
export const hasDiagram = (s: string) => /^```mermaid\b/m.test(s);
export const wordCount = (s: string) => (s.replace(/```[\s\S]*?```/g, ' ').match(/\S+/g) ?? []).length;

/** Words that say nothing or doubt what could be checked, outside code: what makes a document less assertive. */
const VAGUE = [
  'probablemente', 'posiblemente', 'quizás', 'quizá', 'tal vez', 'a lo mejor', 'supuestamente', 'etcétera', 'y demás', 'entre otros', 'entre otras',
  'varias cosas', 'algunas cosas', 'cosas así', 'lo necesario', 'según corresponda', 'según sea necesario', 'de alguna manera', 'se encarga de todo',
  'gestiona todo', 'por definir', 'pendiente de definir',
  'probably', 'possibly', 'maybe', 'perhaps', 'supposedly', 'and so on', 'among others', 'various things', 'some things', 'as needed', 'as appropriate',
  'somehow', 'handles everything', 'to be defined',
];
const VAGUE_RE = new RegExp(`(?<![\\p{L}])(${VAGUE.map((w) => w.replace(/ /g, '\\s+')).join('|')}|etc\\.?)(?![\\p{L}])`, 'giu');
/** placeholders, in capitals only: «todo» is a Spanish word */
const PLACEHOLDER_RE = /(?<![\p{L}])(TODO|TBD|FIXME|XXX)(?![\p{L}])|\?\?\?/gu;
const outsideCode = (s: string) => s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
export function vagueIn(text: string): string[] {
  const t = outsideCode(text);
  return [...new Set([...t.matchAll(VAGUE_RE)].map((m) => m[1].toLowerCase().replace(/\s+/g, ' ')).concat([...t.matchAll(PLACEHOLDER_RE)].map((m) => m[0])))];
}
/** The endpoints a text names in code (`GET /api/files`) that `exists` does not find. */
export function unknownEndpoints(text: string, exists: (method: string, path: string) => boolean): string[] {
  const named = [...text.replace(/```[\s\S]*?```/g, ' ').matchAll(/`(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/[^`\s]*)`/g)];
  return [...new Set(named.filter((m) => !exists(m[1], m[2])).map((m) => `${m[1]} ${m[2]}`))];
}
/** `{id}`, `:id`, `*` and `**` are one path parameter; a trailing slash and a query say nothing of the endpoint. */
const routeKey = (method: string, path: string) => `${method} ${path.split('?')[0].replace(/\/+$/, '').replace(/\{[^}]*\}|:[A-Za-z_]\w*|\*\*?/g, '{}') || '/'}`;
/** Is there such an endpoint in the code: any service of the map exposes it. */
export function endpointIn(g: Graph): (method: string, path: string) => boolean {
  const keys = new Set(g.ofType('endpoint').map((n) => { const m = /^ep:[^:]+:(\w+) (.+)$/.exec(n.id); return m ? routeKey(m[1], m[2]) : ''; }));
  return (method, path) => keys.has(routeKey(method, path));
}

const texts = (p: Piece) => Object.values(p.fields).filter((v): v is string => typeof v === 'string');

export function documentNote(p: Piece, ctx: { endpoint?: (method: string, path: string) => boolean } = {}): DocNote {
  const std = STANDARD[p.type];
  const items: NoteItem[] = [{ key: 'summary-short', at: 'summary', weight: 1, ok: p.summary.trim().length >= SUMMARY_MIN, params: { min: SUMMARY_MIN } }];
  for (const f of std?.fields ?? []) {
    const v = p.fields[f.name];
    const has = hasValue(v);
    if (f.required) items.push({ key: 'required', at: `fields.${f.name}`, weight: 2, ok: has, params: { field: f.name } });
    if (f.diagram === 'required') items.push({ key: 'diagram-missing', at: `fields.${f.name}`, weight: 2, ok: typeof v === 'string' && hasDiagram(v), params: { field: f.name } });
    if (f.minWords && has) items.push({ key: 'min-words', at: `fields.${f.name}`, weight: 1, ok: typeof v === 'string' && wordCount(v) >= f.minWords, params: { field: f.name, min: f.minWords } });
  }
  for (const r of std?.expects ?? []) items.push({ key: 'relation-expected', at: `relations.${r}`, weight: 1, ok: Boolean(p.relations?.[r as keyof NonNullable<Piece['relations']>]?.length), params: { relation: r } });
  const vague = [...new Set(texts(p).flatMap(vagueIn))];
  items.push({ key: 'vague', at: 'fields', weight: 1, ok: !vague.length, ...(vague.length ? { params: { words: vague.join(', ') } } : {}) });
  if (ctx.endpoint) { const missing = [...new Set(texts(p).flatMap((t) => unknownEndpoints(t, ctx.endpoint!)))]; items.push({ key: 'unknown-endpoint', at: 'fields', weight: 2, ok: !missing.length, ...(missing.length ? { params: { endpoints: missing.join(', ') } } : {}) }); }
  if (texts(p).some(hasDiagram)) items.push({ key: 'illustrated', at: 'fields', weight: 1, ok: true });
  const total = items.reduce((n, i) => n + i.weight, 0);
  const got = items.reduce((n, i) => n + (i.ok ? i.weight : 0), 0);
  return { score: total ? Math.round((got / total) * 100) : 100, items, owed: items.filter((i) => !i.ok) };
}
