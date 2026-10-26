/**
 * The sheet of a container: «Lo que debe». Two notes, because two things can be wrong. The document's note is the
 * structure of the piece itself (`documentNote`); the sheet's note is the contrast: what its class owes (code anchored,
 * a flow per use case, a contract when its code exposes endpoints…) and the reasons of each stage it is required to cover.
 * Optional points count when they are met and never subtract. An item accepted in `findings.yaml` is met, with its reason.
 */
import type { Graph } from '../graph.ts';
import { loadAccepted } from '../findings.ts';
import type { Workspace } from '../workspace.ts';
import { coverage, endpointOwner, scopeFiles, type ConventionResult } from './coverage.ts';
import { documentNote } from './lint.ts';
import type { Row } from './piece.ts';
import { childrenOf, type Knowledge, type Loaded } from './store.ts';
import type { PieceType, Stage } from './standard.ts';

export interface OwedItem {
  /** stable: the same fault has the same key, so accepting it survives an edit */
  key: string;
  kind: 'structure' | 'contrast' | 'optional';
  at?: string;
  weight: number;
  ok: boolean;
  params?: Record<string, string | number>;
  stage?: Stage;
  /** what the button does: open the form, create a piece, run flows, review the anchored code, or only accept */
  action?: 'complete' | 'create' | 'run' | 'review';
  create?: PieceType;
  accepted?: { reason: string; until?: string };
  /** its key in findings.yaml */
  accept?: string;
}
export interface SheetNote { doc: number; sheet: number | null; shown: number; items: OwedItem[]; owed: OwedItem[] }

export const acceptKey = (id: string, i: Pick<OwedItem, 'key' | 'at'>) => `owed:${id}:${i.key}${i.at ? `@${i.at}` : ''}`;
const pct = (got: number, total: number) => (total ? Math.round((got / total) * 100) : 100);

export function sheetNote(ws: Workspace, k: Knowledge, g: Graph | null, p: Loaded, conventions?: Map<string, ConventionResult>, memo = new Map<string, SheetNote>(), today = new Date().toISOString().slice(0, 10)): SheetNote {
  const hit = memo.get(p.id);
  if (hit) return hit;
  const accepted = loadAccepted(ws);
  const kids = childrenOf(k, p.id);
  const of = (t: string) => kids.filter((x) => x.type === t);
  const doc = documentNote(p);
  const items: OwedItem[] = doc.items.map((i) => ({ key: `doc-${i.key}`, kind: 'structure' as const, at: i.at, weight: i.weight, ok: i.ok, params: i.params, action: 'complete' as const }));
  const add = (i: Omit<OwedItem, 'weight'> & { weight?: number }) => items.push({ weight: 1, ...i });

  const retired = p.status === 'deprecated';
  if (retired) {
    add({ key: 'retired-decision', kind: 'contrast', ok: k.pieces.some((x) => x.type === 'decision' && (x.relations?.supersedes?.includes(p.id) || p.relations?.decided_by?.includes(x.id))), action: 'create', create: 'decision', weight: 2 });
  } else {
    if (p.type === 'module') {
      const area = p.kind === 'area';
      const files = scopeFiles(ws, k, p);
      if (!area) add({ key: 'anchors', kind: 'contrast', ok: Boolean(p.anchors?.length) && files.length > 0, action: 'review', weight: 2 });
      if (!area) ((p.fields.usecases ?? []) as Row[]).forEach((u, n) => add({ key: 'usecase-flow', kind: 'contrast', at: `fields.usecases[${n}]`, ok: Boolean(u.flow && k.byId.has(u.flow)), params: { case: u.case ?? '' }, action: 'create', create: 'flow', weight: 2 }));
      if (!area && g && files.length) {
        const owns = endpointOwner(ws, p);
        const mine = g.ofType('endpoint').filter((ep) => ep.anchor && owns(ep.anchor.repo, ep.anchor.path, String(ep.attrs?.handler ?? '')));
        if (mine.length) add({ key: 'contract', kind: 'contrast', ok: of('contract').length > 0, params: { endpoints: mine.length }, action: 'create', create: 'contract', weight: 2 });
      }
      if (!area) add({ key: 'test-plan', kind: 'contrast', ok: k.pieces.some((x) => x.type === 'test-plan' && (x.parent === p.id || ((x.fields.scope ?? []) as Row[]).some((r) => r.target === p.id))), action: 'create', create: 'test-plan' });
      if (area) {
        const named = new Set((p.fields.submodules ?? []) as string[]);
        const children = kids.filter((x) => x.type === 'module');
        for (const c of children) {
          add({ key: 'submodule-named', kind: 'contrast', at: c.id, ok: named.has(c.id), params: { id: c.id }, action: 'complete' });
          add({ key: 'child-sheet', kind: 'contrast', at: c.id, ok: sheetNote(ws, k, g, c, conventions, memo, today).shown >= 100, params: { id: c.id }, weight: 1 });
        }
        add({ key: 'data-model', kind: 'contrast', ok: of('data-model').length > 0, action: 'create', create: 'data-model' });
      }
      if (p.status === 'draft') add({ key: 'plan', kind: 'contrast', ok: of('plan').length > 0, action: 'create', create: 'plan' });
    }
    if (p.type === 'application') {
      add({ key: 'modules', kind: 'contrast', ok: kids.some((x) => x.type === 'module'), action: 'create', create: 'module', weight: 2 });
      for (const t of ['architecture', 'stack', 'infrastructure', 'versioning', 'test-plan'] as const) add({ key: `has-${t}`, kind: 'contrast', ok: of(t).length > 0, action: 'create', create: t });
    }
    // Each stage the class must cover: met when full, and one item per reason when it is not.
    for (const s of coverage(ws, k, g, p, conventions, today)) {
      if (!s.required) continue;
      if (s.state === 'full') add({ key: `stage-${s.stage}`, kind: 'contrast', ok: true, stage: s.stage, weight: 2 });
      else for (const r of s.reasons) add({ key: `stage-${s.stage}-${r.key}`, kind: 'contrast', ok: false, at: String(r.params?.flow ?? r.params?.id ?? r.params?.op ?? r.params?.table ?? r.params?.name ?? '') || undefined, stage: s.stage, params: r.params, action: /^flow-/.test(r.key) ? 'run' : /^(anchors|convention)/.test(r.key) ? 'review' : /^no-pieces$/.test(r.key) ? 'create' : undefined, create: r.key === 'no-pieces' ? (String(r.params?.pieces ?? '').split(', ')[0] as PieceType) : undefined, weight: 2 });
    }
    // Optional: counted when met, never against.
    if (of('decision').length) add({ key: 'decisions', kind: 'optional', ok: true });
    if (p.type === 'application' && of('secrets').length) add({ key: 'secrets', kind: 'optional', ok: true });
  }

  for (const i of items) {
    const a = accepted[acceptKey(p.id, i)];
    if (a && !i.ok && !(a.until && a.until < today)) { i.ok = true; i.accepted = { reason: a.reason, until: a.until }; }
  }
  for (const i of items) if (i.kind !== 'structure') i.accept = acceptKey(p.id, i);
  const contrast = items.filter((i) => i.kind !== 'structure');
  const sheet = p.type === 'application' || p.type === 'module' || p.type === 'process' || p.type === 'service' || p.type === 'repository' || p.type === 'datastore' || p.type === 'external'
    ? pct(contrast.reduce((n, i) => n + (i.ok ? i.weight : 0), 0), contrast.reduce((n, i) => n + i.weight, 0)) : null;
  const note: SheetNote = { doc: doc.score, sheet, shown: Math.min(doc.score, sheet ?? 100), items, owed: items.filter((i) => !i.ok) };
  memo.set(p.id, note);
  return note;
}

/** An item in one English line, for `laru check --worklist` and the AI. */
export function owedLine(i: OwedItem): string {
  const p = i.params ?? {};
  const at = i.at ? ` (${i.at})` : '';
  if (i.key.startsWith('doc-')) return `${i.key.slice(4)}${at}`;
  if (i.key === 'usecase-flow') return `use case "${p.case}" has no flow${at}`;
  if (i.key === 'contract') return `${p.endpoints} endpoints and no contract`;
  if (i.key.startsWith('stage-')) return `${i.stage}: ${i.key.slice(`stage-${i.stage}-`.length)}${at}`;
  return `${i.key}${at}`;
}
