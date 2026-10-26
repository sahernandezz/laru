/**
 * Writing by fields. `knowledgeWrite` validates, places the file in its container's folder and renders
 * deterministic Markdown; a piece with an error never reaches disk. `knowledgeShape` is what the AI reads
 * before writing: the fields, their limits and a worked example, with headings in the docs language.
 */
import { checkFlowSpec } from '../flows.ts';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Graph } from '../graph.ts';
import type { Workspace } from '../workspace.ts';
import { documentNote, type DocNote } from './lint.ts';
import { sheetNote } from './sheet.ts';
import { renderPiece, type FieldValue, type Piece } from './piece.ts';
import { anchorResolver, containerOf, DOCS_DIR, fingerprint, freshness, loadKnowledge, type Knowledge, type Loaded } from './store.ts';
import { isContainer, OWN_FOLDER, STANDARD, type Lang, type PieceType } from './standard.ts';
import { EXAMPLE_ES } from './standard-es.ts';
import { validatePiece, type Issue } from './validate.ts';
import { coverage, evaluateConventions } from './coverage.ts';
import { E2E_GUIDE, E2E_RULES } from './e2e.ts';

export const docsLang = (ws: Workspace): Lang => (ws.docsLanguage === 'es' ? 'es' : 'en');
export const slugify = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'piece';

/** What exists, for reference checks: every piece, every node of the map, and what this same write adds. */
function knownIds(k: Knowledge, g: Graph | null, extra: string[] = []) {
  const ids = new Set<string>([...k.byId.keys(), ...(g ? g.nodes.keys() : []), ...extra]);
  return {
    exists: (id: string) => ids.has(id),
    // Same prefix, and a shared start of at least four letters: `svc:files` → `svc:file-service`.
    suggest: (id: string) => {
      const [pre, rest = ''] = id.split(':');
      const head = rest.slice(0, 4);
      return [...ids].filter((x) => x.startsWith(pre + ':') && x !== id && (x.includes(rest) || (head.length === 4 && x.slice(pre.length + 1).startsWith(head)))).slice(0, 3);
    },
  };
}

export function knowledgeShape(ws: Workspace, type: PieceType, withExample = true) {
  const std = STANDARD[type];
  if (!std) return null;
  const lang = docsLang(ws);
  const ex = lang === 'es' && EXAMPLE_ES[type] ? { ...std.example, ...EXAMPLE_ES[type] } : std.example;
  const example: Piece = { id: `${std.prefix}:${slugify(ex.title)}`, type, kind: ex.kind, title: ex.title, status: ex.status, summary: ex.summary, anchors: ex.anchors, meta: ex.meta as Piece['meta'], relations: ex.relations as Piece['relations'], fields: ex.fields as Record<string, FieldValue> };
  return {
    type, prefix: `${std.prefix}:`, question: std.question[lang], livesIn: std.livesIn, kinds: std.kinds, statuses: std.statuses, anchors: std.anchors, stage: std.stage,
    meta: std.meta, expects: std.expects, folder: isContainer(type) ? `${std.folder}/<slug>/${type}.md` : OWN_FOLDER.includes(type) ? `${std.folder}/<slug>/${type}.md` : `${std.folder}/<slug>.md`,
    fields: std.fields.map((f) => ({ name: f.name, heading: f.label[lang], type: f.type, required: Boolean(f.required), max: f.max, hint: lang === 'es' && f.hintEs ? f.hintEs : f.hint, hintEs: f.hintEs, diagram: f.diagram, kinds: f.kinds, minWords: f.minWords, ref: f.ref, columns: f.columns?.map((c) => ({ name: c.name, heading: c.label[lang], required: Boolean(c.required), enum: c.enum, ref: c.ref, date: c.date })) })),
    ...(type === 'flow' ? { standard: { guide: E2E_GUIDE.id, rules: E2E_RULES } } : {}),
    ...(withExample ? { example: { input: { ...example, in: type === 'application' ? undefined : `<${std.livesIn[0]} id>` }, markdown: renderPiece(example, lang) } } : {}),
  };
}

export interface WriteInput {
  type: PieceType;
  id?: string;
  /** the container it lives in; omitted when updating an existing piece */
  in?: string;
  title: string;
  kind?: string;
  status?: string;
  summary: string;
  owner?: string;
  anchors?: string[];
  meta?: Piece['meta'];
  relations?: Piece['relations'];
  fields: Record<string, FieldValue>;
}
export interface WriteResult { ok: boolean; id: string; path?: string; issues: Issue[]; /** how complete the piece is and what it owes */ note?: DocNote }

export function knowledgeWrite(ws: Workspace, input: WriteInput, g: Graph | null = null, opts: { dryRun?: boolean; batch?: string[] } = {}): WriteResult {
  const k = loadKnowledge(ws);
  const std = STANDARD[input.type];
  if (!std) return { ok: false, id: input.id ?? '', issues: [{ level: 'error', at: 'type', key: 'unknown-type', message: `types are ${Object.keys(STANDARD).join(', ')}` }] };
  const id = input.id ?? (input.type === 'application' ? `app:${ws.app}` : `${std.prefix}:${slugify(input.title)}`);
  const existing = k.byId.get(id);
  const parentId = input.type === 'application' ? null : input.in ?? existing?.parent ?? null;
  const parent = parentId ? containerOf(k, parentId) : null;
  const issues: Issue[] = [];
  if (parentId && !parent) issues.push({ level: 'error', at: 'in', key: 'unknown-ref', message: k.byId.has(parentId) ? `"${parentId}" is a facet; pieces live in containers` : `"${parentId}" is not a documented container; write it first`, params: { id: parentId } });
  if (existing && existing.type !== input.type) issues.push({ level: 'error', at: 'id', key: 'duplicate-id', message: `"${id}" is already a ${existing.type}` });
  if (existing && input.in && existing.parent !== input.in) issues.push({ level: 'error', at: 'in', key: 'use-move', message: `"${id}" lives in ${existing.parent}; moving it is \`laru move\`, not a write` });
  if (existing?.type === 'decision' && existing.status === 'accepted' && !(input.status === 'superseded' && sameContent(existing, input))) issues.push({ level: 'error', at: 'status', key: 'immutable', message: 'an accepted decision is not edited: write a new one with `supersedes`' });

  // A decision is numbered when it is created: in order, never reused (a deleted file leaves its number spent in git, not here).
  let meta = input.meta;
  if (input.type === 'decision') {
    const used = k.pieces.filter((x) => x.type === 'decision' && x.id !== id).map((x) => String(x.meta?.number ?? '')).filter(Boolean);
    const given = meta?.number ? String(meta.number) : existing?.meta?.number ? String(existing.meta.number) : '';
    if (given && used.includes(given)) issues.push({ level: 'error', at: 'number', key: 'duplicate-number', message: `${given} is already taken by another decision`, params: { number: given } });
    const next = Math.max(0, ...used.map((n) => Number(n.match(/^DEC-(\d+)$/)?.[1] ?? 0))) + 1;
    meta = { ...meta, number: given || `DEC-${String(next).padStart(4, '0')}` };
  }
  const piece: Piece = {
    id, type: input.type, kind: input.kind, title: input.title?.trim() ?? '', status: input.status ?? (std.statuses.includes('proposed') ? 'proposed' : 'draft'),
    summary: input.summary?.trim() ?? '', owner: input.owner, anchors: input.anchors?.length ? input.anchors : undefined, meta, relations: input.relations, fields: input.fields ?? {},
  };
  const known = knownIds(k, g, [id, ...(opts.batch ?? [])]);
  issues.push(...validatePiece(piece, { ...known, parent: input.type === 'application' ? null : parent ?? (parentId ? undefined : null), resolveAnchor: anchorResolver(ws) }));
  if (issues.some((i) => i.level === 'error')) return { ok: false, id, issues };

  if (piece.anchors?.length) { const fp = fingerprint(ws, piece.anchors); piece.verified = { fingerprint: fp.fingerprint, commits: fp.commits, at: new Date().toISOString().slice(0, 10) }; }
  const path = existing?.path ?? pathFor(ws, k, piece, parentId);
  if (!opts.dryRun) {
    const abs = join(ws.root, path);
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    writeFileSync(tmp, renderPiece(piece, docsLang(ws)));
    renameSync(tmp, abs);
    if (piece.type === 'application' && !existing) writeFlowGuide(ws);
  }
  return { ok: true, id, path, issues, note: documentNote(piece) };
}

/**
 * Laru's e2e standard as the workspace's own guide, written once the application exists (its first write, or the
 * agent files of a workspace that has one). Never overwritten: the team owns it after.
 */
export function writeFlowGuide(ws: Workspace): string | null {
  const k = loadKnowledge(ws);
  const app = k.pieces.find((p) => p.type === 'application');
  if (!app || k.byId.has(E2E_GUIDE.id)) return null;
  const r = knowledgeWrite(ws, { ...E2E_GUIDE, in: app.id });
  return r.ok ? r.path ?? null : null;
}

const sameContent = (a: Piece, b: WriteInput) => JSON.stringify(a.fields) === JSON.stringify(b.fields) && a.title === b.title;

function pathFor(ws: Workspace, k: Knowledge, p: Piece, parentId: string | null): string {
  const std = STANDARD[p.type];
  if (p.type === 'application') return join(DOCS_DIR, 'application.md');
  const base = k.byId.get(parentId!)!.dir;
  const slug = p.id.split(':')[1];
  if (isContainer(p.type)) return join(base, std.folder, slug, `${p.type}.md`);
  if (OWN_FOLDER.includes(p.type)) return join(base, std.folder, slug, `${p.type}.md`);
  let file = join(base, std.folder, `${slug}.md`);
  for (let n = 2; existsSync(join(ws.root, file)) && !k.pieces.some((x) => x.path === file && x.id === p.id); n++) file = join(base, std.folder, `${slug}-${n}.md`);
  return file;
}

/** Re-anchors a piece to the code as it is now: the reviewer says it is still true. */
export function verifyPiece(ws: Workspace, id: string): WriteResult {
  const k = loadKnowledge(ws);
  const p = k.byId.get(id);
  if (!p) return { ok: false, id, issues: [{ level: 'error', at: 'id', key: 'unknown-ref', message: `no piece "${id}"` }] };
  if (!p.anchors?.length) return { ok: false, id, issues: [{ level: 'error', at: 'anchors', key: 'no-anchors', message: 'this piece has no code anchors to verify' }] };
  const fp = fingerprint(ws, p.anchors);
  const updated: Piece = { ...p, verified: { fingerprint: fp.fingerprint, commits: fp.commits, at: new Date().toISOString().slice(0, 10) } };
  writeFileSync(join(ws.root, p.path), renderPiece(updated, docsLang(ws)));
  return { ok: true, id, path: p.path, issues: [] };
}

export interface CheckResult { issues: Array<Issue & { path: string; id?: string; block: 'structure' | 'contrast' | 'policy' }>; pieces: number; stale: string[] }
const BLOCK = (key: string): 'structure' | 'contrast' =>
  /^(stale|unverified|coverage|convention-violated|flow-|anchor-empty|unknown-repo)/.test(key) ? 'contrast' : 'structure';

/** Everything `laru check` reports: errors fail CI, warnings do not. */
export async function checkWorkspace(ws: Workspace, g: Graph | null): Promise<CheckResult> {
  const k = loadKnowledge(ws);
  const out: CheckResult['issues'] = k.issues.map((i) => ({ ...i, block: BLOCK(i.key) }));
  const known = knownIds(k, g);
  const resolve = anchorResolver(ws);
  const stale: string[] = [];
  const conventions = await evaluateConventions(ws, k);
  for (const p of k.pieces) {
    const parent = p.parent ? containerOf(k, p.parent) : null;
    for (const i of validatePiece(p, { ...known, parent, resolveAnchor: resolve })) out.push({ ...i, path: p.path, id: p.id, block: BLOCK(i.key) });
    const f = freshness(ws, p);
    if (f === 'stale') { stale.push(p.id); out.push({ level: 'warning', at: 'anchors', key: 'stale', message: 'the anchored code changed since this piece was verified: review it, then `laru docs verify`', path: p.path, id: p.id, block: 'contrast' }); }
    if (f === 'unverified') out.push({ level: 'warning', at: 'anchors', key: 'unverified', message: 'never verified against the code: `laru docs verify`', path: p.path, id: p.id, block: 'contrast' });
    if (p.type === 'convention') for (const v of conventions.get(p.id)?.violations ?? []) out.push({ level: 'warning', at: 'fields.check', key: 'convention-violated', message: `${v.file}${v.line ? `:${v.line}` : ''} breaks "${v.rule}"`, path: p.path, id: p.id, block: 'contrast' });
    if (p.type === 'flow') for (const c of checkFlowSpec(ws, p, k.byId)) out.push({ level: c.level, at: c.line ? `${c.spec}:${c.line}` : c.spec, key: c.key, message: c.message, path: p.path, id: p.id, block: 'contrast' });
    if (['module', 'process', 'application', 'service'].includes(p.type)) {
      for (const c of coverage(ws, k, g, p as Loaded, conventions)) if (c.required && c.state !== 'full') out.push({ level: 'warning', at: `coverage.${c.stage}`, key: 'coverage', message: `${c.stage}: ${c.reasons.map((r) => r.text).join('; ')}`, path: p.path, id: p.id, block: 'contrast' });
    }
  }
  // Policies, only when the workspace turns them on: a note under the minimum breaks the check.
  const memo = new Map();
  for (const p of k.pieces) {
    const note = documentNote(p).score;
    if (ws.policies?.documento !== undefined && note < ws.policies.documento) out.push({ level: 'error', at: 'note', key: 'policy-documento', message: `the document's note is ${note}, the policy asks ${ws.policies.documento}`, params: { note, min: ws.policies.documento }, path: p.path, id: p.id, block: 'policy' });
    if (ws.policies?.hoja !== undefined && (p.type === 'application' || (p.type === 'module' && p.kind === 'feature'))) {
      const sh = sheetNote(ws, k, g, p, conventions, memo).sheet ?? 100;
      if (sh < ws.policies.hoja) out.push({ level: 'error', at: 'sheet', key: 'policy-hoja', message: `the sheet's note is ${sh}, the policy asks ${ws.policies.hoja}`, params: { note: sh, min: ws.policies.hoja }, path: p.path, id: p.id, block: 'policy' });
    }
  }
  return { issues: out, pieces: k.pieces.length, stale };
}
