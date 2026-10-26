/**
 * The document's note: how complete a piece is, 0–100. Writing never demands it — an empty required section is a
 * warning and lowers the note — but the note says what is still owed ("Lo que debe"). A required section weighs 2,
 * what is only recommended (a summary that says something, an expected relation, a section's minimum length) weighs 1.
 */
import { hasValue, type Piece } from './piece.ts';
import { STANDARD } from './standard.ts';

export interface NoteItem { key: string; at: string; weight: number; ok: boolean; params?: Record<string, string | number> }
export interface DocNote { score: number; items: NoteItem[]; owed: NoteItem[] }

export const SUMMARY_MIN = 40;
export const hasDiagram = (s: string) => /^```mermaid\b/m.test(s);
export const wordCount = (s: string) => (s.replace(/```[\s\S]*?```/g, ' ').match(/\S+/g) ?? []).length;

export function documentNote(p: Piece): DocNote {
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
  const total = items.reduce((n, i) => n + i.weight, 0);
  const got = items.reduce((n, i) => n + (i.ok ? i.weight : 0), 0);
  return { score: total ? Math.round((got / total) * 100) : 100, items, owed: items.filter((i) => !i.ok) };
}
