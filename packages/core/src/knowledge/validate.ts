/**
 * Validation answers by position — `fields.steps[2].service` — with a stable key, so the interface can say it
 * in Spanish and the AI can fix exactly that field. Errors never reach disk; warnings do, and `check` lists them.
 */
import { kindOfCode, lintDiagramOfKind, mermaidBlocks } from '@laru/diagrams';
import { parseLimit } from '../limit.ts';
import { hasValue, RELATIONS, type Piece } from './piece.ts';
import { isContainer, STANDARD, type ContainerType } from './standard.ts';

export interface Issue { level: 'error' | 'warning'; at: string; key: string; message: string; params?: Record<string, string | number> }

export interface ValidateContext {
  /** Does this id exist: a piece, a map node, or another piece in the same write? */
  exists: (id: string) => boolean;
  /** Closest known ids, for "did you mean". */
  suggest?: (id: string) => string[];
  parent?: { id: string; type: ContainerType } | null;
  /** files an anchor matches; undefined when the repo is unknown */
  resolveAnchor?: (anchor: string) => string[] | undefined;
}

const ID = /^([a-z][a-z-]*):([a-z0-9][a-z0-9._-]*)$/;
const ANCHOR = /^([a-z0-9][a-z0-9-]*):([^#\s]+)(#[\w.$]+\*?)?$/;

export function validatePiece(p: Piece, ctx: ValidateContext): Issue[] {
  const out: Issue[] = [];
  const err = (at: string, key: string, message: string, params?: Issue['params']) => out.push({ level: 'error', at, key, message, params });
  const warn = (at: string, key: string, message: string, params?: Issue['params']) => out.push({ level: 'warning', at, key, message, params });
  const std = STANDARD[p.type];
  if (!std) { err('type', 'unknown-type', `unknown piece type "${p.type}"`); return out; }

  const idm = p.id.match(ID);
  if (!idm) err('id', 'id-format', 'an id is `<prefix>:<kebab-case>`, e.g. `mod:returns`');
  else if (idm[1] !== std.prefix) err('id', 'id-prefix', `a ${p.type} id starts with \`${std.prefix}:\``, { prefix: std.prefix });
  if (!p.title.trim()) err('title', 'required', 'required');
  else if (p.title.length > 120) warn('title', 'too-long', 'at most 120 characters', { max: 120 });
  if (!p.summary.trim()) err('summary', 'required', 'required: one sentence the AI reads to decide whether to open the piece');
  else if (p.summary.length > 240) warn('summary', 'too-long', 'one sentence, at most 240 characters', { max: 240 });
  if (std.legacyStatuses?.includes(p.status)) warn('status', 'legacy-status', `"${p.status}" is an older status; use ${std.statuses.join(', ')}`, { options: std.statuses.join(', ') });
  else if (!std.statuses.includes(p.status)) warn('status', 'bad-enum', `one of ${std.statuses.join(', ')}`, { options: std.statuses.join(', ') });
  if (std.kinds && !std.kinds.includes(p.kind ?? '')) warn('kind', 'bad-enum', `one of ${std.kinds.join(', ')}`, { options: std.kinds.join(', ') });
  if (!std.kinds && p.kind) warn('kind', 'not-allowed', `a ${p.type} has no kind`);
  if (p.owner && /\s/.test(p.owner.trim()) && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(p.owner.trim())) warn('owner', 'owner-person', 'owners are teams or roles, never people');

  // Where it lives.
  if (ctx.parent !== undefined) {
    if (p.type === 'application') { if (ctx.parent) err('in', 'wrong-parent', 'the application is the root'); }
    else if (!ctx.parent) err('in', 'required', `a ${p.type} lives inside ${std.livesIn.join(' or ')}`);
    else if (!std.livesIn.includes(ctx.parent.type)) warn('in', 'wrong-parent', `a ${p.type} cannot live in a ${ctx.parent.type}; it lives in ${std.livesIn.join(' or ')}`, { parent: ctx.parent.type, allowed: std.livesIn.join(', ') });
  }

  // Code anchors.
  const needsAnchors = std.anchors === 'required' || (p.type === 'module' && p.kind !== 'area');
  if (std.anchors === 'no' && p.anchors?.length) warn('anchors', 'not-allowed', `a ${p.type} has no code anchors`);
  if (needsAnchors && !p.anchors?.length) (std.anchors === 'required' ? err : warn)('anchors', 'anchor-required', 'anchor it to the code it talks about, e.g. `repo:src/main/java/acme/returns/**`');
  p.anchors?.forEach((a, i) => {
    if (!ANCHOR.test(a)) { err(`anchors[${i}]`, 'anchor-format', '`<repo>:<path or glob>[#Symbol]`'); return; }
    const files = ctx.resolveAnchor?.(a);
    if (files === undefined) warn(`anchors[${i}]`, 'unknown-repo', `no repo "${a.split(':')[0]}" in this workspace`, { repo: a.split(':')[0] });
    else if (!files.length) warn(`anchors[${i}]`, 'anchor-empty', 'matches no file at the reference branch yet');
  });

  const checkRef = (at: string, id: string, prefixes?: string[]) => {
    if (prefixes && !prefixes.some((pre) => id.startsWith(pre))) { warn(at, 'ref-wrong-type', `expected an id starting with ${prefixes.join(' or ')}`, { prefixes: prefixes.join(' ') }); return; }
    if (!ctx.exists(id)) { const s = ctx.suggest?.(id) ?? []; warn(at, 'unknown-ref', `"${id}" does not exist${s.length ? `; did you mean ${s.join(' or ')}?` : ''}`, { id, suggestion: s.join(', ') }); }
  };
  for (const m of std.meta ?? []) {
    const v = p.meta?.[m.name];
    if (v === undefined) continue;
    if (m.name === 'timeout' && p.type === 'flow') { if (parseLimit(v) === null) err('timeout', 'bad-timeout', 'a duration like 30s, 2m or 1h, between 1 second and 2 hours', { value: String(v) }); continue; }
    if (m.name === 'number' && !/^DEC-\d{4,}$/.test(String(v))) { err('number', 'bad-number', 'DEC-0001: DEC- and at least four digits', { value: String(v) }); continue; }
    (Array.isArray(v) ? v : [v]).forEach((id, i) => m.ref && checkRef(Array.isArray(v) ? `${m.name}[${i}]` : m.name, id, m.ref));
  }
  for (const [r, ids] of Object.entries(p.relations ?? {})) {
    if (!(RELATIONS as readonly string[]).includes(r)) { warn(`relations.${r}`, 'unknown-relation', `relations are ${RELATIONS.join(', ')}`); continue; }
    (ids ?? []).forEach((id, i) => checkRef(`relations.${r}[${i}]`, id));
  }

  // Fields.
  for (const f of std.fields) {
    const v = p.fields[f.name];
    const at = `fields.${f.name}`;
    // An empty required section is written down and lowers the note; it blocks nothing (broken things still do).
    if (!hasValue(v)) { if (f.required) warn(at, 'required', 'required', { field: f.name }); continue; }
    if (f.type === 'markdown' || f.type === 'text') {
      if (typeof v !== 'string') { err(at, 'bad-type', 'text expected'); continue; }
      if (f.max && v.length > f.max) warn(at, 'too-long', `at most ${f.max} characters (${v.length})`, { max: f.max, length: v.length });
      if (f.diagram === 'required' && !/^```mermaid\b/m.test(v)) warn(at, 'diagram-missing', 'draw it: a fenced ```mermaid block', { field: f.name });
      mermaidBlocks(v).forEach((b, n) => {
        const kind = kindOfCode(b.code, f.kinds as never);
        if (!kind) { warn(`${at}.diagram[${n}]`, 'diagram-unknown', 'this diagram has no class Laru knows: flowchart, sequence, C4, ER, state, class…'); return; }
        for (const d of lintDiagramOfKind(b.code, kind)) warn(`${at}.diagram[${n}]`, `diagram-${d.rule}`, d.fix ? `${d.text} ${d.fix}` : d.text, { kind });
      });
      for (const m of v.matchAll(/\[\[([^\]]+)\]\]/g)) if (!ctx.exists(m[1])) warn(at, 'broken-link', `[[${m[1]}]] does not exist`, { id: m[1] });
      if (isContainer(p.type) && (v.match(/^\s*[-*|]?\s*(GET|POST|PUT|PATCH|DELETE)\s+\/\S*/gm) ?? []).length >= 3)
        warn(at, 'extractable-inventory', 'this lists endpoints; they are extracted from the code and a written copy will drift');
      continue;
    }
    if (!Array.isArray(v)) { err(at, 'bad-type', 'a list expected'); continue; }
    if (f.max && v.length > f.max) warn(at, 'too-many', `at most ${f.max} items (${v.length})`, { max: f.max, length: v.length });
    if (f.type === 'refs') (v as string[]).forEach((id, i) => checkRef(`${at}[${i}]`, id, f.ref));
    if (f.type === 'rows') {
      (v as Array<Record<string, string>>).forEach((row, i) => {
        for (const c of f.columns!) {
          const cell = row[c.name]?.trim();
          const cat = `${at}[${i}].${c.name}`;
          if (!cell) { if (c.required) warn(cat, 'required', 'required', { field: c.name }); continue; }
          if (c.enum && !c.enum.includes(cell)) warn(cat, 'bad-enum', `one of ${c.enum.join(', ')}`, { options: c.enum.join(', ') });
          if (c.date && !/^\d{4}-\d{2}-\d{2}$/.test(cell)) warn(cat, 'bad-date', 'a date as YYYY-MM-DD');
          if (c.ref) checkRef(cat, cell, c.ref);
        }
        for (const k of Object.keys(row)) if (!f.columns!.some((c) => c.name === k)) warn(`${at}[${i}].${k}`, 'unknown-column', `kept as written; the standard's columns are ${f.columns!.map((c) => c.name).join(', ')}`);
      });
    }
  }
  for (const k of Object.keys(p.fields)) if (!std.fields.some((f) => f.name === k)) warn(`fields.${k}`, 'unknown-field', `kept as its own section; the standard fields of a ${p.type} are ${std.fields.map((f) => f.name).join(', ')}`);
  if (p.type === 'convention') (p.fields.check as string[] | undefined)?.forEach((c, i) => {
    const m = c.match(/^(forbid|require):\s*(.+)$/);
    if (!m) err(`fields.check[${i}]`, 'bad-check', '`forbid: <regex>` or `require: <regex>`');
    else try { new RegExp(m[2]); } catch { err(`fields.check[${i}]`, 'bad-check', 'the regular expression does not compile'); }
  });
  return out;
}
