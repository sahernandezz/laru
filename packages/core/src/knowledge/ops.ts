/**
 * The edits that are not a write: a piece that does not exist yet (`new`), one that changes container (`move`), one
 * that changes its id (`rename`) and one that goes (`delete`). The folder is the containment, so each is a rename or a
 * removal on disk; `rename` also rewrites every reference to the old id, and `delete` says which pieces still name it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Graph } from '../graph.ts';
import type { Workspace } from '../workspace.ts';
import { evidenceDir } from '../evidence.ts';
import { writeAgentFiles } from '../init.ts';
import { E2E_GUIDE } from './e2e.ts';
import { containerOf, loadKnowledge, type Loaded } from './store.ts';
import { isContainer, OWN_FOLDER, STANDARD, type PieceType } from './standard.ts';
import { knowledgeWrite, slugify, type WriteResult } from './write.ts';

const fail = (id: string, key: string, message: string): WriteResult => ({ ok: false, id, issues: [{ level: 'error', at: 'id', key, message }] });

/** A piece with its title and nothing else: the note says what it still owes. Its place is its container's folder. */
export function newPiece(ws: Workspace, g: Graph | null, input: { type: PieceType; title: string; in?: string; kind?: string }): WriteResult {
  const std = STANDARD[input.type];
  if (!std) return fail('', 'unknown-type', `unknown type "${input.type}"`);
  const app = loadKnowledge(ws).pieces.find((p) => p.type === 'application');
  const parent = input.in ?? (input.type !== 'application' && std.livesIn.includes('application') ? app?.id : undefined);
  return knowledgeWrite(ws, { type: input.type, title: input.title, in: parent, kind: input.kind ?? std.kinds?.[0], summary: input.title, fields: {} }, g);
}

const holds = (p: Loaded) => (isContainer(p.type) || OWN_FOLDER.includes(p.type) ? dirname(join(p.path)) : p.path);

export function movePiece(ws: Workspace, id: string, to: string): WriteResult {
  const k = loadKnowledge(ws);
  const p = k.byId.get(id), isBox = containerOf(k, to), target = isBox ? k.byId.get(to) : undefined;
  if (!p) return fail(id, 'unknown-ref', `no piece "${id}"`);
  if (p.type === 'application') return fail(id, 'wrong-parent', 'the application is the root');
  if (!target || !isBox) return fail(id, 'unknown-ref', `"${to}" is not a documented container`);
  if (!STANDARD[p.type].livesIn.includes(target.type as never)) return fail(id, 'wrong-parent', `a ${p.type} cannot live in a ${target.type}; it lives in ${STANDARD[p.type].livesIn.join(' or ')}`);
  if (p.parent === to) return { ok: true, id, path: p.path, issues: [] };
  if (target.id === id || target.dir.startsWith(`${p.dir}/`)) return fail(id, 'wrong-parent', 'a piece cannot move inside itself');
  const std = STANDARD[p.type];
  const src = holds(p);
  const dest = join(target.dir, std.folder, basename(src));
  if (existsSync(join(ws.root, dest))) return fail(id, 'duplicate-id', `${dest} already exists`);
  mkdirSync(dirname(join(ws.root, dest)), { recursive: true });
  renameSync(join(ws.root, src), join(ws.root, dest));
  const emptied = join(ws.root, dirname(src));
  if (existsSync(emptied) && !readdirSync(emptied).length) rmdirSync(emptied);
  return { ok: true, id, path: isContainer(p.type) || OWN_FOLDER.includes(p.type) ? join(dest, basename(p.path)) : dest, issues: [] };
}

/** `mod:pagos` → `mod:cobros`: the folder or file, the id in its frontmatter and every reference to it. */
export function renamePiece(ws: Workspace, id: string, slug: string): WriteResult & { rewritten?: number } {
  const k = loadKnowledge(ws);
  const p = k.byId.get(id);
  if (!p) return fail(id, 'unknown-ref', `no piece "${id}"`);
  if (p.type === 'application' || OWN_FOLDER.includes(p.type)) return fail(id, 'not-supported', `a ${p.type} keeps its id: its tests and evidence are filed under it`);
  const next = `${STANDARD[p.type].prefix}:${slugify(slug)}`;
  if (k.byId.has(next)) return fail(id, 'duplicate-id', `"${next}" already exists`);
  const re = idIn(id, 'g');
  let rewritten = 0;
  for (const q of k.pieces) {
    const text = q.source.replace(re, next);
    if (text !== q.source) { writeFileSync(join(ws.root, q.path), text); rewritten++; }
  }
  const newSlug = next.split(':')[1];
  const src = holds({ ...p, path: p.path });
  const dest = isContainer(p.type) ? join(dirname(src), newSlug) : join(dirname(src), `${newSlug}.md`);
  if (existsSync(join(ws.root, dest))) return fail(id, 'duplicate-id', `${dest} already exists`);
  renameSync(join(ws.root, src), join(ws.root, dest));
  return { ok: true, id: next, path: isContainer(p.type) ? join(dest, basename(p.path)) : dest, issues: [], rewritten };
}

/** An id where a text names it: whole, not the start of a longer one (`mod:pagos` is not in `mod:pagos-web`). */
const idIn = (id: string, flags = '') => new RegExp(`(?<![\\w.:-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, flags);

/**
 * A piece deleted: its file, or its folder when it has one (a flow goes with its spec and its shared evidence). A
 * container that holds other pieces goes only with `contents`, and they with it. The pieces that still name it are said
 * (`check` reports them as broken references): they are updated, not rewritten here.
 */
export function deletePiece(ws: Workspace, id: string, o: { contents?: boolean; dryRun?: boolean } = {}): WriteResult & { removed?: string[]; named?: string[] } {
  const k = loadKnowledge(ws);
  const p = k.byId.get(id);
  if (!p) return fail(id, 'unknown-ref', `no piece "${id}"`);
  if (p.type === 'application') return fail(id, 'not-supported', 'the application is the root of the documentation: it is not deleted');
  if (id === E2E_GUIDE.id) return fail(id, 'not-supported', `${id} is Laru's e2e standard, which the agent files point to and write again when it is missing: edit it instead`);
  const src = holds(p);
  const held = isContainer(p.type) ? k.pieces.filter((q) => q !== p && q.path.startsWith(`${src}/`)) : [];
  if (held.length && !o.contents) return fail(id, 'not-empty', `${id} holds ${held.length === 1 ? 'a piece' : `${held.length} pieces`} (${held.map((q) => q.id).join(', ')}): delete ${held.length === 1 ? 'it' : 'them'} with it (contents), or move ${held.length === 1 ? 'it' : 'them'} out first`);
  const removed = [p, ...held];
  const named = k.pieces.filter((q) => !removed.includes(q) && removed.some((r) => idIn(r.id).test(q.source))).map((q) => q.id);
  if (!o.dryRun) {
    rmSync(join(ws.root, src), { recursive: true, force: true });
    for (const f of removed.filter((q) => q.type === 'flow')) rmSync(join(evidenceDir(ws), f.id.split(':')[1]), { recursive: true, force: true });
    const emptied = join(ws.root, dirname(src));
    if (existsSync(emptied) && !readdirSync(emptied).length) rmdirSync(emptied);
    // the agent files import the working agreement: gone, they stop pointing at it
    if (p.type === 'agreement') writeAgentFiles(ws);
  }
  return {
    ok: true, id, path: src, removed: removed.map((q) => q.id), named,
    issues: named.map((n) => ({ level: 'warning' as const, at: n, key: 'still-named', message: `${n} still names ${id}: update it`, params: { id: n } })),
  };
}
