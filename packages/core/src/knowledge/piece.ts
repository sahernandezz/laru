/**
 * A piece of documentation on disk: YAML frontmatter, a title, and one `##` section per field, with the
 * headings in the documentation language. Rendering is deterministic — the same piece always gives the
 * same bytes — and parsing reads back exactly what rendering wrote, plus what a person typed by hand.
 */
import { parse as parseYaml, stringify } from 'yaml';
import { STANDARD, type Field, type Lang, type PieceType } from './standard.ts';

export type Row = Record<string, string>;
export type FieldValue = string | string[] | Row[];
export const RELATIONS = ['depends_on', 'decided_by', 'implements', 'relates_to', 'realizes', 'persists_in', 'supersedes'] as const;
export type RelationName = (typeof RELATIONS)[number];

export interface Verified { fingerprint: string; commits: Record<string, string>; at: string }
export interface Piece {
  id: string;
  type: PieceType;
  kind?: string;
  title: string;
  status: string;
  summary: string;
  owner?: string;
  anchors?: string[];
  meta?: Record<string, string | string[]>;
  relations?: Partial<Record<RelationName, string[]>>;
  verified?: Verified;
  fields: Record<string, FieldValue>;
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

function renderField(f: Field, v: FieldValue, lang: Lang): string {
  if (f.type === 'markdown' || f.type === 'text') return String(v).trim();
  if (f.type === 'list') return (v as string[]).map((x) => `- ${x.trim()}`).join('\n');
  if (f.type === 'refs') return (v as string[]).map((x) => `- [[${x.trim()}]]`).join('\n');
  const cols = f.columns!;
  const rows = v as Row[];
  return [
    `| ${cols.map((c) => c.label[lang]).join(' | ')} |`,
    `|${cols.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${cols.map((c) => esc(r[c.name] ?? '')).join(' | ')} |`),
  ].join('\n');
}

export function renderPiece(p: Piece, lang: Lang): string {
  const std = STANDARD[p.type];
  const fm: Record<string, unknown> = { id: p.id, type: p.type };
  if (p.kind) fm.kind = p.kind;
  fm.title = p.title;
  fm.status = p.status;
  fm.summary = p.summary;
  if (p.owner) fm.owner = p.owner;
  if (p.anchors?.length) fm.anchors = p.anchors;
  for (const m of std.meta ?? []) if (p.meta?.[m.name] !== undefined && p.meta[m.name] !== '' && !(Array.isArray(p.meta[m.name]) && !p.meta[m.name].length)) fm[m.name] = p.meta[m.name];
  const rel = Object.fromEntries(RELATIONS.filter((r) => p.relations?.[r]?.length).map((r) => [r, p.relations![r]]));
  if (Object.keys(rel).length) fm.relations = rel;
  if (p.verified) fm.verified = p.verified;
  const sections = std.fields.filter((f) => hasValue(p.fields[f.name])).map((f) => `## ${f.label[lang]}\n\n${renderField(f, p.fields[f.name], lang)}`);
  return `---\n${stringify(fm, { lineWidth: 0 }).trimEnd()}\n---\n\n# ${p.title}\n\n${sections.join('\n\n')}\n`;
}

export const hasValue = (v: unknown) => v !== undefined && v !== null && (Array.isArray(v) ? v.length > 0 : String(v).trim() !== '');

export interface ParseIssue { at: string; key: string; message: string }

/** Reads a piece back. Unknown sections and malformed tables are reported, never silently dropped. */
export function parsePiece(src: string): { piece?: Piece; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { issues: [{ at: 'frontmatter', key: 'no-frontmatter', message: 'the file must start with a YAML frontmatter block' }] };
  let fm: Record<string, unknown>;
  try { fm = (parseYaml(m[1]) ?? {}) as Record<string, unknown>; } catch (e) { return { issues: [{ at: 'frontmatter', key: 'bad-yaml', message: (e as Error).message.split('\n')[0] }] }; }
  const type = fm.type as PieceType;
  const std = STANDARD[type];
  if (!std) return { issues: [{ at: 'type', key: 'unknown-type', message: `unknown piece type "${String(fm.type)}"` }] };

  const byHeading = new Map<string, Field>();
  for (const f of std.fields) for (const l of [...Object.values(f.label), ...(f.alias ?? [])]) byHeading.set(l.toLowerCase(), f);
  const fields: Record<string, FieldValue> = {};
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let fence = false;
  for (const line of m[2].split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^## /.test(line)) { sections.push({ heading: line.slice(3).trim(), lines: [] }); continue; }
    if (!fence && /^# /.test(line) && !sections.length) continue;
    sections.at(-1)?.lines.push(line);
  }
  for (const s of sections) {
    const f = byHeading.get(s.heading.toLowerCase());
    if (!f) { issues.push({ at: `sections["${s.heading}"]`, key: 'unknown-section', message: `"${s.heading}" is not a section of a ${type}` }); continue; }
    const text = s.lines.join('\n').trim();
    if (f.type === 'markdown' || f.type === 'text') fields[f.name] = text;
    else if (f.type === 'list' || f.type === 'refs') {
      const items: string[] = [];
      for (const l of text.split('\n')) {
        const item = l.match(/^\s*[-*]\s+(.*)$/);
        if (item) items.push(f.type === 'refs' ? item[1].replace(/^\[\[|\]\]$/g, '').trim() : item[1].trim());
        else if (l.trim() && items.length) items[items.length - 1] += ' ' + l.trim();
      }
      fields[f.name] = items;
    } else {
      const lines = text.split('\n').filter((l) => l.trim().startsWith('|'));
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = lines[0] ? cells(lines[0]) : [];
      const colOf = head.map((h) => f.columns!.find((c) => Object.values(c.label).some((l) => l.toLowerCase() === h.toLowerCase()) || c.name === h.toLowerCase()));
      head.forEach((h, i) => { if (!colOf[i]) issues.push({ at: `${f.name}.columns[${i}]`, key: 'unknown-column', message: `"${h}" is not a column of ${f.name}` }); });
      fields[f.name] = lines.slice(2).map((l) => {
        const r: Row = {};
        cells(l).forEach((c, i) => { const col = colOf[i]; if (col && c) r[col.name] = c; });
        return r;
      });
    }
  }
  const meta: Record<string, string | string[]> = {};
  for (const mm of std.meta ?? []) if (fm[mm.name] !== undefined) meta[mm.name] = fm[mm.name] as string | string[];
  const piece: Piece = {
    id: String(fm.id ?? ''), type, kind: fm.kind as string | undefined, title: String(fm.title ?? ''), status: String(fm.status ?? ''),
    summary: String(fm.summary ?? ''), owner: fm.owner as string | undefined, anchors: fm.anchors as string[] | undefined,
    meta: Object.keys(meta).length ? meta : undefined, relations: fm.relations as Piece['relations'], verified: fm.verified as Verified | undefined, fields,
  };
  return { piece, issues };
}
